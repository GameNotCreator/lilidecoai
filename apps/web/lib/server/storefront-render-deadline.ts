import type { RenderDocument } from "./types";

export const STOREFRONT_RENDER_MAX_MS = 180_000;
export const STOREFRONT_RENDER_DEADLINE_MESSAGE =
  "La visualisation n’a pas pu être terminée en 3 minutes. Le traitement a été arrêté ; vous pouvez essayer une autre photo.";

/** The public shop has a shorter promise than the merchant and spatial tools. */
export function isTimedStorefrontRender(render: RenderDocument): boolean {
  return (
    render.publicSessionId?.startsWith("storefront:") === true &&
    render.engine !== "spatial" &&
    render.requestSnapshot?.input.workflow === "simple_point"
  );
}

/** Includes queue time and preserves an earlier source/configuration deadline. */
export function effectiveRenderDeadline(render: RenderDocument): number {
  const configured = render.execution?.deadlineAt.getTime() ?? Infinity;
  return isTimedStorefrontRender(render)
    ? Math.min(
        configured,
        render.createdAt.getTime() + STOREFRONT_RENDER_MAX_MS,
      )
    : configured;
}

export function storefrontRenderDeadlineExpired(
  render: RenderDocument,
  now = Date.now(),
): boolean {
  return (
    isTimedStorefrontRender(render) && effectiveRenderDeadline(render) <= now
  );
}
