import "server-only";
import type { Db } from "mongodb";
import sharp from "sharp";
import { privateVisibility, readAsset, storeAsset } from "./assets";
import { collections } from "./mongodb";
import {
  durableContext,
  DurableExecutionError,
  executionFence,
} from "./durable-context";
import { assertExecutionActive } from "./durable-queue";
import type { DurableStep } from "./durable-types";

/** The queue stores asset IDs, never encoded image payloads. */
async function encode(db: Db, value: unknown): Promise<unknown> {
  if (value instanceof Uint8Array) {
    const { render } = durableContext.getStore()!;
    const data = Buffer.from(value);
    const contentType =
      data[0] === 137 && data[1] === 80
        ? "image/png"
        : data[0] === 255 && data[1] === 216
          ? "image/jpeg"
          : "image/webp";
    const asset = await storeAsset(db, {
      organizationId: render.organizationId,
      kind: "render",
      visibility: privateVisibility(render.publicSessionId),
      buffer: data,
      contentType,
      expiresAt: render.execution!.scene.expiresAt,
    });
    return { __checkpointImage: asset.id, buffer: Buffer.isBuffer(value) };
  }
  if (Array.isArray(value))
    return Promise.all(value.map((item) => encode(db, item)));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = await Promise.all(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(async ([k, v]) => {
          if (
            (k === "maskRaw" || k === "mask") &&
            v instanceof Uint8Array &&
            record.sceneWidth &&
            record.sceneHeight
          ) {
            const png = await sharp(Buffer.from(v), {
              raw: {
                width: Number(record.sceneWidth),
                height: Number(record.sceneHeight),
                channels: 4,
              },
            })
              .png()
              .toBuffer();
            return [k, { __rawMask: await encode(db, png) }];
          }
          return [k, await encode(db, v)];
        }),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

async function decode(db: Db, value: unknown): Promise<unknown> {
  if (Array.isArray(value))
    return Promise.all(value.map((item) => decode(db, item)));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__rawMask)
      return sharp((await decode(db, record.__rawMask)) as Buffer)
        .ensureAlpha()
        .raw()
        .toBuffer();
    if (typeof record.__checkpointImage === "string") {
      const { render } = durableContext.getStore()!;
      const meta = await collections(db).assets.findOne({
        id: record.__checkpointImage,
        organizationId: render.organizationId,
      });
      if (
        !meta ||
        meta.purgeClaimedAt ||
        (render.publicSessionId &&
          meta.ownerSessionId !== render.publicSessionId)
      )
        throw new DurableExecutionError(
          "Point de reprise inaccessible.",
          "permanent",
        );
      const image = await readAsset(db, record.__checkpointImage);
      if (!image)
        throw new DurableExecutionError(
          "Point de reprise expiré.",
          "permanent",
        );
      return record.buffer ? image.buffer : new Uint8Array(image.buffer);
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(record).map(async ([k, v]) => [k, await decode(db, v)]),
      ),
    );
  }
  return value;
}

/** Read-only analysis is retryable; an interrupted image edit is never replayed. */
export async function durableStep<T>(
  db: Db,
  key: string,
  policy: "analysis" | "image",
  call: () => Promise<T>,
): Promise<T> {
  const context = durableContext.getStore();
  if (!context) return call();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
    throw new Error("Invalid checkpoint key");
  const { render } = context;
  await assertExecutionActive(db, render.id);
  const current = await collections(db).renders.findOne({
    id: render.id,
    ...executionFence(render.id),
  });
  const previous = current?.execution?.steps[key];
  if (previous?.status === "completed")
    return (await decode(db, previous.output)) as T;
  if (
    policy === "image" &&
    (previous?.status === "running" || previous?.status === "unknown")
  )
    throw new DurableExecutionError(
      "Le résultat du fournisseur est incertain. Aucun nouvel appel d’image n’a été lancé.",
      "provider_unknown",
    );
  const attempts = (previous?.attempts ?? 0) + 1;
  if (attempts > 3)
    throw new DurableExecutionError(
      "Cette étape reste indisponible après trois tentatives.",
      "permanent",
    );
  const startedAt = new Date();
  async function save(step: DurableStep) {
    const saved = await collections(db).renders.updateOne(
      { id: render.id, status: "processing", ...executionFence(render.id) },
      { $set: { [`execution.steps.${key}`]: step, updatedAt: new Date() } },
    );
    if (!saved.matchedCount)
      throw new DurableExecutionError(
        "Le bail du rendu a expiré.",
        "lease_lost",
      );
  }
  await save({ status: "running", attempts, startedAt });
  let output: T;
  try {
    output = await call();
  } catch (reason) {
    if (reason instanceof DurableExecutionError) {
      if (reason.code === "retry")
        await save({ status: "retry", attempts, startedAt });
      throw reason;
    }
    const status =
      typeof reason === "object" && reason !== null && "status" in reason
        ? Number(reason.status)
        : 0;
    if ([400, 401, 402, 403, 404, 422].includes(status)) {
      await save({ status: "unknown", attempts, startedAt });
      throw new DurableExecutionError(
        reason instanceof Error ? reason.message : "Demande refusée.",
        "permanent",
      );
    }
    const retry = policy === "analysis" || status === 429;
    await save({ status: retry ? "retry" : "unknown", attempts, startedAt });
    throw new DurableExecutionError(
      reason instanceof Error ? reason.message : "Fournisseur indisponible.",
      retry ? "retry" : "provider_unknown",
    );
  }
  // If persistence fails after a paid call, leave 'running': recovery must not
  // mistake a lost result for permission to spend again.
  const encoded = await encode(db, output);
  await save({ status: "completed", attempts, startedAt, output: encoded });
  return output;
}
