import { z } from "zod";

import { withAdmin } from "@/lib/server/admin-route";
import { collections } from "@/lib/server/mongodb";
import type { RenderDocument } from "@/lib/server/types";
import { STOREFRONT_VISUAL_REPLACEMENT_HYBRID_PROMPT_VERSION, STOREFRONT_PADDED_VISUAL_REPLACEMENT_HYBRID_PROMPT_VERSION } from "@/lib/server/storefront-hybrid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const scaleSchema = z.number().finite().min(0.2).max(200);
const elevationSchema = z.number().finite().min(0).max(85);
const rollSchema = z.number().finite().min(-30).max(30);
const entriesSchema = z.array(z.unknown()).min(1).max(3);
const preflightOutputSchema = z.object({
  spans: entriesSchema,
  widthPixelsPerCm: entriesSchema.optional(),
  poses: entriesSchema.optional(),
});

function sanitizedNumber(value: unknown, schema: z.ZodNumber): number | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function numericField(value: unknown, key: string, schema: z.ZodNumber): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return sanitizedNumber((value as Record<string, unknown>)[key], schema);
}

/** Numbers only: never decode checkpoint assets or expose free-form evidence. */
function sceneProjection(render: RenderDocument) {
  const steps = render.execution?.steps;
  // The current contract is authoritative when present, even while incomplete.
  // Never fill gaps in a newer result from an older checkpoint.
  const step = steps && Object.hasOwn(steps, "manual-placement-v11") ? steps["manual-placement-v11"]
    : steps && Object.hasOwn(steps, "manual-placement-v10") ? steps["manual-placement-v10"]
    : steps && Object.hasOwn(steps, "manual-placement-v9") ? steps["manual-placement-v9"]
    : steps && Object.hasOwn(steps, "preflight-v9") ? steps["preflight-v9"]
    : steps && Object.hasOwn(steps, "preflight-v6") ? steps["preflight-v6"]
    : steps && Object.hasOwn(steps, "preflight-v5") ? steps["preflight-v5"]
    : steps && Object.hasOwn(steps, "preflight-v4") ? steps["preflight-v4"]
    : steps && Object.hasOwn(steps, "preflight-v3") ? steps["preflight-v3"]
    : steps && Object.hasOwn(steps, "preflight-v2") ? steps["preflight-v2"] : steps?.["storefront-scene-preflight"];
  const profile = render.engineVersions?.scaleEstimation;
  if (!["queued", "processing", "succeeded", "failed"].includes(render.status) ||
      render.engineVersions?.mockMode !== false ||
      !["storefront-isolated-product-v4", "storefront-room-integration-v5", "storefront-room-local-integration-v6"].includes(render.engineVersions?.composite ?? "") ||
      !["storefront-scene-width-pose-v4", "storefront-scene-pose-v3", "storefront-manual-reference-v1"].includes(profile ?? "") ||
      typeof render.publicSessionId !== "string" || !render.publicSessionId.startsWith("storefront:") ||
      render.publicSessionId.length <= "storefront:".length || step?.status !== "completed") return null;
  const parsed = preflightOutputSchema.safeParse(step.output);
  if (!parsed.success) return null;
  const { spans, widthPixelsPerCm, poses } = parsed.data;
  if ((widthPixelsPerCm && widthPixelsPerCm.length !== spans.length) ||
      (poses && poses.length !== spans.length)) return null;
  return spans.map((span, index) => ({
    index: index + 1,
    heightPixelsPerCm: numericField(span, "pixelsPerCm", scaleSchema),
    widthPixelsPerCm: profile === "storefront-scene-width-pose-v4"
      ? sanitizedNumber(widthPixelsPerCm?.[index], scaleSchema) : null,
    cameraElevationDegrees: numericField(poses?.[index], "cameraElevationDegrees", elevationSchema),
    cameraRollDegrees: numericField(poses?.[index], "cameraRollDegrees", rollSchema),
  }));
}

const checkpointStatusSchema = z.enum(["running", "completed", "retry", "unknown", "failed"]);
const cleanupImageSchema = z.object({
  width: z.number().finite().int().min(1).max(8192),
  height: z.number().finite().int().min(1).max(8192),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
}).refine(image => image.width * image.height <= 16_000_000);
const cleanupOutputSchema = z.object({ images: z.array(cleanupImageSchema).length(1) });

/** Never decode or select checkpoint image bytes: only their bounded raster
 * metadata and enum states explain a failure to the authorized merchant. */
function replacementCleanupDiagnostic(render: RenderDocument) {
  if (!["queued", "processing", "succeeded", "failed"].includes(render.status) ||
      render.engineVersions?.mockMode !== false ||
      typeof render.publicSessionId !== "string" || !render.publicSessionId.startsWith("storefront:") ||
      render.publicSessionId.length <= "storefront:".length) return null;
  const version = render.engineVersions?.prompt === STOREFRONT_PADDED_VISUAL_REPLACEMENT_HYBRID_PROMPT_VERSION ? "v11"
    : render.engineVersions?.prompt === STOREFRONT_VISUAL_REPLACEMENT_HYBRID_PROMPT_VERSION ? "v10" : null;
  if (!version) return null;
  const steps = render.execution?.steps;
  const step = steps?.[`replacement-clean-${version}`];
  if (!step) return null;
  const status = checkpointStatusSchema.safeParse(step.status);
  const background = checkpointStatusSchema.safeParse(steps?.[`replacement-background-${version}`]?.status);
  const parsed = step.status === "completed" ? cleanupOutputSchema.safeParse(step.output) : null;
  const image = parsed?.success ? parsed.data.images[0]! : null;
  return { version, status: status.success ? status.data : null, backgroundStatus: background.success ? background.data : null,
    width: image?.width ?? null, height: image?.height ?? null, mimeType: image?.mimeType ?? null };
}

/** Merchant diagnostics deliberately exclude visitors' photographs and tokens. */
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return withAdmin(request, async ({ db, organization }) => {
    const id = z.uuid().parse((await context.params).id);
    const render = await collections(db).renders.findOne(
      { id, organizationId: organization.id },
      { projection: {
        _id: 0, id: 1, status: 1, error: 1, pipelineState: 1,
        createdAt: 1, updatedAt: 1, estimatedCostUsd: 1, "usageTotals.estimatedCostUsd": 1,
        publicSessionId: 1, "engineVersions.mockMode": 1, "engineVersions.composite": 1,
        "engineVersions.scaleEstimation": 1, "engineVersions.prompt": 1, "execution.deadlineAt": 1,
        "execution.attempts": 1, "execution.errorCode": 1,
        "execution.steps.storefront-scene-preflight.status": 1,
        "execution.steps.storefront-scene-preflight.output.spans.pixelsPerCm": 1,
        "execution.steps.storefront-scene-preflight.output.widthPixelsPerCm": 1,
        "execution.steps.storefront-scene-preflight.output.poses.cameraElevationDegrees": 1,
        "execution.steps.storefront-scene-preflight.output.poses.cameraRollDegrees": 1,
        "execution.steps.preflight-v2.status": 1,
        "execution.steps.preflight-v2.output.spans.pixelsPerCm": 1,
        "execution.steps.preflight-v2.output.widthPixelsPerCm": 1,
        "execution.steps.preflight-v2.output.poses.cameraElevationDegrees": 1,
        "execution.steps.preflight-v2.output.poses.cameraRollDegrees": 1,
        "execution.steps.preflight-v3.status": 1,
        "execution.steps.preflight-v3.output.spans.pixelsPerCm": 1,
        "execution.steps.preflight-v3.output.widthPixelsPerCm": 1,
        "execution.steps.preflight-v3.output.poses.cameraElevationDegrees": 1,
        "execution.steps.preflight-v3.output.poses.cameraRollDegrees": 1,
        "execution.steps.preflight-v4.status": 1,
        "execution.steps.preflight-v4.output.spans.pixelsPerCm": 1,
        "execution.steps.preflight-v4.output.widthPixelsPerCm": 1,
        "execution.steps.preflight-v4.output.poses.cameraElevationDegrees": 1,
        "execution.steps.preflight-v4.output.poses.cameraRollDegrees": 1,
        "execution.steps.preflight-v5.status": 1,
        "execution.steps.preflight-v5.output.spans.pixelsPerCm": 1,
        "execution.steps.preflight-v5.output.widthPixelsPerCm": 1,
        "execution.steps.preflight-v5.output.poses.cameraElevationDegrees": 1,
        "execution.steps.preflight-v5.output.poses.cameraRollDegrees": 1,
        "execution.steps.replacement-clean-v10.status": 1,
        "execution.steps.replacement-clean-v10.output.images.width": 1,
        "execution.steps.replacement-clean-v10.output.images.height": 1,
        "execution.steps.replacement-clean-v10.output.images.mimeType": 1,
        "execution.steps.replacement-background-v10.status": 1,
        "execution.steps.replacement-clean-v11.status": 1,
        "execution.steps.replacement-clean-v11.output.images.width": 1,
        "execution.steps.replacement-clean-v11.output.images.height": 1,
        "execution.steps.replacement-clean-v11.output.images.mimeType": 1,
        "execution.steps.replacement-background-v11.status": 1,
        "execution.steps.manual-placement-v11.status": 1,
        "execution.steps.manual-placement-v11.output.spans.pixelsPerCm": 1,
        "execution.steps.manual-placement-v11.output.widthPixelsPerCm": 1,
        "execution.steps.manual-placement-v11.output.poses.cameraElevationDegrees": 1,
        "execution.steps.manual-placement-v11.output.poses.cameraRollDegrees": 1,
        "execution.steps.manual-placement-v10.status": 1,
        "execution.steps.manual-placement-v10.output.spans.pixelsPerCm": 1,
        "execution.steps.manual-placement-v10.output.widthPixelsPerCm": 1,
        "execution.steps.manual-placement-v10.output.poses.cameraElevationDegrees": 1,
        "execution.steps.manual-placement-v10.output.poses.cameraRollDegrees": 1,
        "execution.steps.manual-placement-v9.status": 1,
        "execution.steps.manual-placement-v9.output.spans.pixelsPerCm": 1,
        "execution.steps.manual-placement-v9.output.widthPixelsPerCm": 1,
        "execution.steps.manual-placement-v9.output.poses.cameraElevationDegrees": 1,
        "execution.steps.manual-placement-v9.output.poses.cameraRollDegrees": 1,
        "execution.steps.preflight-v9.status": 1,
        "execution.steps.preflight-v9.output.spans.pixelsPerCm": 1,
        "execution.steps.preflight-v9.output.widthPixelsPerCm": 1,
        "execution.steps.preflight-v9.output.poses.cameraElevationDegrees": 1,
        "execution.steps.preflight-v9.output.poses.cameraRollDegrees": 1,
        "execution.steps.preflight-v6.status": 1,
        "execution.steps.preflight-v6.output.spans.pixelsPerCm": 1,
        "execution.steps.preflight-v6.output.widthPixelsPerCm": 1,
        "execution.steps.preflight-v6.output.poses.cameraElevationDegrees": 1,
        "execution.steps.preflight-v6.output.poses.cameraRollDegrees": 1,
      } },
    );
    const headers = { "Cache-Control": "no-store" };
    if (!render) {
      return Response.json(
        { detail: "Rendu introuvable" },
        { status: 404, headers },
      );
    }
    return Response.json(
      {
        id: render.id,
        status: render.status,
        error: render.error ?? null,
        pipelineState: render.pipelineState ?? null,
        sceneProjection: sceneProjection(render),
        replacementCleanup: replacementCleanupDiagnostic(render),
        execution: render.execution
          ? {
              deadlineAt: render.execution.deadlineAt.toISOString(),
              attempts: render.execution.attempts,
              errorCode: render.execution.errorCode ?? null,
            }
          : null,
        createdAt: render.createdAt.toISOString(),
        updatedAt: render.updatedAt.toISOString(),
        estimatedCostUsd:
          render.usageTotals?.estimatedCostUsd ?? render.estimatedCostUsd ?? 0,
      },
      { headers },
    );
  });
}
