import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";

export interface R2AssetReference {
  bucket: string;
  key: string;
  sha256: string;
}

export function assetChecksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const r2Host =
  /^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/;
const objectKey = /^assets\/[a-f0-9-]{36}$/;
const sha256 = /^[a-f0-9]{64}$/;

export function getR2Storage(): R2Storage | null {
  const endpoint = process.env.R2_ENDPOINT?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  const url = URL.canParse(endpoint) ? new URL(endpoint) : null;
  if (
    !url ||
    url.protocol !== "https:" ||
    !r2Host.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !["/", `/${bucket}`, `/${bucket}/`].includes(url.pathname)
  ) {
    throw new Error("Endpoint S3 ou nom de bucket R2 invalide.");
  }
  return new R2Storage(
    url.origin,
    bucket,
    new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: "auto",
      retries: 2,
    }),
  );
}

export class R2Storage {
  constructor(
    private readonly origin: string,
    private readonly bucket: string,
    private readonly client: AwsClient,
  ) {}

  async put(bytes: Buffer, contentType: string): Promise<R2AssetReference> {
    const ref = {
      bucket: this.bucket,
      key: `assets/${randomUUID()}`,
      sha256: assetChecksum(bytes),
    };
    const response = await this.request(ref, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(bytes),
    });
    if (!response.ok)
      throw new Error(`Écriture R2 refusée (HTTP ${response.status}).`);
    return ref;
  }

  async read(ref: R2AssetReference): Promise<Buffer | null> {
    const response = await this.request(ref, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Lecture R2 refusée (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (assetChecksum(bytes) !== ref.sha256) {
      throw new Error("L’empreinte du fichier R2 ne correspond pas.");
    }
    return bytes;
  }

  async delete(ref: R2AssetReference): Promise<void> {
    const response = await this.request(ref, { method: "DELETE" });
    if (!response.ok)
      throw new Error(`Suppression R2 refusée (HTTP ${response.status}).`);
  }

  private request(ref: R2AssetReference, init: RequestInit): Promise<Response> {
    if (
      ref.bucket !== this.bucket ||
      !objectKey.test(ref.key) ||
      !sha256.test(ref.sha256)
    ) {
      throw new Error("Référence R2 invalide pour le bucket configuré.");
    }
    return this.client.fetch(`${this.origin}/${this.bucket}/${ref.key}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  }
}
