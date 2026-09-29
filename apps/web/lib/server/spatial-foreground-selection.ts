import "server-only";
import { createHash } from "node:crypto";

export const SPATIAL_FOREGROUND_SELECTION_POLICY = Object.freeze({
  version: "spatial-foreground-selection-v1" as const,
  maxPixels: 4_000_000,
  strongAlpha: 128,
  opaqueAlpha: 250,
});

/** Experimental component selection, never semantic recognition or approval.
 * Traverse every nonzero alpha, including diagonal one-alpha wires. Select only
 * a unique strong component intersecting the projected volume. Never cut a
 * bridge or pick the largest component to force a result. Keep weak detached
 * fragments verbatim rather than erasing possible fine details.
 */
export function selectSpatialForeground(input: {
  alpha: Uint8Array;
  alphaFingerprint: string;
  projectedRegion: Uint8Array;
  authorization: Uint8Array;
  width: number;
  height: number;
}) {
  const { alpha, projectedRegion, authorization, width, height } = input;
  const policy = SPATIAL_FOREGROUND_SELECTION_POLICY,
    length = width * height;
  if (
    ![width, height].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    length > policy.maxPixels ||
    [alpha, projectedRegion, authorization].some(
      (mask) => mask.length !== length,
    ) ||
    [projectedRegion, authorization].some((mask) =>
      mask.some((value) => value !== 0 && value !== 255),
    )
  )
    throw new Error("Invalid foreground-selection grid or binary region");
  const hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  if (hash(alpha) !== input.alphaFingerprint)
    throw new Error("Foreground mask fingerprint differs");
  const labels = new Int32Array(length),
    queue = new Int32Array(length);
  const components: Array<{
    id: number;
    pixels: number;
    maximumAlpha: number;
    projectedPixels: number;
    cropEdgePixels: number;
    opaqueOutsideAuthorization: number;
  }> = [];
  for (let i = 0; i < length; i++) {
    if (!alpha[i] || labels[i]) continue;
    const component = {
      id: components.length + 1,
      pixels: 0,
      maximumAlpha: 0,
      projectedPixels: 0,
      cropEdgePixels: 0,
      opaqueOutsideAuthorization: 0,
    };
    let head = 0,
      tail = 1;
    queue[0] = i;
    labels[i] = component.id;
    while (head < tail) {
      const at = queue[head++]!,
        x = at % width,
        y = Math.floor(at / width),
        value = alpha[at]!;
      component.pixels++;
      component.maximumAlpha = Math.max(component.maximumAlpha, value);
      if (projectedRegion[at]) component.projectedPixels++;
      if (!x || !y || x === width - 1 || y === height - 1)
        component.cropEdgePixels++;
      if (!authorization[at] && value >= policy.opaqueAlpha)
        component.opaqueOutsideAuthorization++;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!alpha[next] || labels[next]) continue;
          labels[next] = component.id;
          queue[tail++] = next;
        }
    }
    components.push(component);
  }
  const possible = components.filter(
    (component) =>
      component.maximumAlpha >= policy.strongAlpha &&
      component.projectedPixels > 0,
  );
  const base = {
    version: policy.version,
    qualification: "not-qualified" as const,
    policy,
    fingerprints: {
      alpha: hash(alpha),
      projectedRegion: hash(projectedRegion),
      authorization: hash(authorization),
    },
    components,
    interactionBlockers: ["unreviewed-foreground-selection"],
    limitations: [
      "The projected volume is an estimate, not an object annotation.",
      "Connected neighbouring objects or reflections cannot be separated by topology.",
      "Discarded disconnected regions may contain legitimate detached product parts.",
      "All weak detached fragments are kept; no independent identity or interaction review.",
    ],
  };
  if (possible.length !== 1)
    return {
      alpha: null,
      evidence: {
        ...base,
        status: "blocked" as const,
        reasons: [
          possible.length
            ? "ambiguous-projected-components"
            : "no-strong-projected-component",
        ],
      },
    };
  const selectedId = possible[0]!.id;
  const retained = new Set(
    components
      .filter(
        (component) =>
          component.id === selectedId ||
          component.maximumAlpha < policy.strongAlpha,
      )
      .map((component) => component.id),
  );
  const kept = components.filter((component) => retained.has(component.id));
  const reasons = [];
  if (kept.some((component) => component.cropEdgePixels > 0))
    reasons.push("retained-foreground-touches-crop-edge");
  if (kept.some((component) => component.opaqueOutsideAuthorization > 0))
    reasons.push("retained-opaque-foreground-outside-authorization");
  const selection = {
    selectedComponentId: selectedId,
    discardedComponentIds: components
      .filter((component) => !retained.has(component.id))
      .map((component) => component.id),
    discardedPixels: components
      .filter((component) => !retained.has(component.id))
      .reduce((sum, component) => sum + component.pixels, 0),
    preservedWeakPixels: kept
      .filter((component) => component.id !== selectedId)
      .reduce((sum, component) => sum + component.pixels, 0),
  };
  if (reasons.length)
    return {
      alpha: null,
      evidence: { ...base, ...selection, status: "blocked" as const, reasons },
    };
  const selected = Uint8Array.from(alpha, (value, i) =>
    retained.has(labels[i]!) ? value : 0,
  );
  return {
    alpha: selected,
    evidence: {
      ...base,
      ...selection,
      status: "selected" as const,
      reasons: [],
      selectedAlphaFingerprint: hash(selected),
    },
  };
}
