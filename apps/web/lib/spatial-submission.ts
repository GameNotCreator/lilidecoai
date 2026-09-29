import { renderSchema, type Render } from "@lili/types";
import { ApiError, InvalidApiResponseError, merchantApi } from "./api";
import type { SpatialSubmission } from "./spatial-studio-draft";

function checkedRender(value: unknown, request: SpatialSubmission): Render {
  const parsed = renderSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.engine !== "spatial" ||
    ("kind" in request && parsed.data.id === request.sourceRenderId) ||
    parsed.data.placement?.sceneId !== request.placement.sceneId ||
    parsed.data.placement?.productId !== request.placement.productId
  )
    throw new InvalidApiResponseError();
  return parsed.data;
}

/** Read only: a missing request can still be in transit. */
export async function findSpatialSubmission(
  request: SpatialSubmission,
  api = merchantApi,
  signal?: AbortSignal,
): Promise<Render | null> {
  try {
    return checkedRender(
      await api(
        `/v1/renders/by-request/${encodeURIComponent(request.idempotencyKey)}`,
        { signal, cache: "no-store" },
      ),
      request,
    );
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return null;
    throw reason;
  }
}

/** Called only after a user submits/resends. The persisted key is never replaced. */
export async function sendSpatialSubmission(
  request: SpatialSubmission,
  api = merchantApi,
): Promise<Render> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const existing = await findSpatialSubmission(
      request,
      api,
      controller.signal,
    );
    if (existing) return existing;
    const retry = "kind" in request && request.kind === "retry";
    return checkedRender(
      await api(
        retry
          ? `/v1/renders/${request.sourceRenderId}/retry`
          : "/v1/renders/final",
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify(
            retry ? { idempotencyKey: request.idempotencyKey } : request,
          ),
        },
      ),
      request,
    );
  } finally {
    clearTimeout(timer);
  }
}
