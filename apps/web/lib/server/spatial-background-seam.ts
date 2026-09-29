/** Experimental veto for a hard compositing seam, never an acceptance test.
 * Compare only boundaries where BOTH the original and uncomposited generated
 * image are locally continuous. Product edges and existing decor edges are not
 * evidence of a background colour jump. Thresholds require corpus calibration. */
export const SPATIAL_BOUNDARY_POLICY = Object.freeze({
  version: "spatial-boundary-v1" as const,
  smoothDifference: 6,
  colourJump: 12,
  minimumEligiblePixels: 24,
  minimumAffectedFraction: 0.25,
  minimumConnectedPixels: 12,
});

export function inspectSpatialBackgroundSeam(input: {
  original: Buffer;
  generated: Buffer;
  maskRaw: Buffer;
  width: number;
  height: number;
}) {
  const { original, generated, maskRaw, width, height } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 3 ||
    height < 3 ||
    width * height > 25_000_000 ||
    original.length !== width * height * 3 ||
    generated.length !== original.length ||
    maskRaw.length !== width * height * 4
  )
    throw new Error("Invalid spatial boundary inputs");
  const policy = SPATIAL_BOUNDARY_POLICY;
  const mean = (pixels: Buffer, x: number, y: number) => {
    const result = [0, 0, 0];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const offset = ((y + dy) * width + x + dx) * 3;
        for (let c = 0; c < 3; c++) result[c]! += pixels[offset + c]! / 9;
      }
    return result;
  };
  const difference = (a: number[], b: number[]) =>
    Math.max(...a.map((v, c) => Math.abs(v - b[c]!)));
  const affected = new Uint8Array(width * height),
    points: number[] = [];
  let boundaryPixels = 0,
    eligiblePixels = 0,
    maximumJump = 0;
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      const index = y * width + x;
      if (maskRaw[index * 4 + 3] !== 0) continue;
      const outside = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].filter(([xx, yy]) => maskRaw[(yy! * width + xx!) * 4 + 3] !== 0);
      if (!outside.length) continue;
      boundaryPixels++;
      const originalInside = mean(original, x, y),
        generatedInside = mean(generated, x, y);
      let eligible = false,
        bad = false;
      for (const [xx, yy] of outside) {
        const originalOutside = mean(original, xx!, yy!),
          generatedOutside = mean(generated, xx!, yy!);
        if (
          difference(originalInside, originalOutside) >
            policy.smoothDifference ||
          difference(generatedInside, generatedOutside) >
            policy.smoothDifference
        )
          continue;
        eligible = true;
        // The background residual is smooth in the uncomposited source; hard
        // restoration removes it abruptly outside the mask. Measure that residual.
        const jump = difference(generatedInside, originalInside);
        maximumJump = Math.max(maximumJump, jump);
        if (jump >= policy.colourJump) bad = true;
      }
      if (eligible) eligiblePixels++;
      if (bad) {
        affected[index] = 1;
        points.push(index);
      }
    }
  let largestConnectedBoundary = 0;
  for (const start of points) {
    if (!affected[start]) continue;
    const stack = [start];
    affected[start] = 0;
    let size = 0;
    while (stack.length) {
      const index = stack.pop()!;
      size++;
      const x = index % width,
        y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (
            (!dx && !dy) ||
            x + dx < 0 ||
            x + dx >= width ||
            y + dy < 0 ||
            y + dy >= height
          )
            continue;
          const next = index + dy * width + dx;
          if (affected[next]) {
            affected[next] = 0;
            stack.push(next);
          }
        }
    }
    largestConnectedBoundary = Math.max(largestConnectedBoundary, size);
  }
  const affectedFraction = eligiblePixels ? points.length / eligiblePixels : 0;
  const requiredConnectedPixels = Math.max(
    policy.minimumConnectedPixels,
    Math.round(Math.min(width, height) * 0.025),
  );
  const sufficient = eligiblePixels >= policy.minimumEligiblePixels;
  const rejected =
    sufficient &&
    affectedFraction >= policy.minimumAffectedFraction &&
    largestConnectedBoundary >= requiredConnectedPixels;
  return {
    version: policy.version,
    status: rejected
      ? ("rejected" as const)
      : sufficient
        ? ("not-detected" as const)
        : ("insufficient-evidence" as const),
    boundaryPixels,
    eligiblePixels,
    affectedPixels: points.length,
    affectedFraction,
    largestConnectedBoundary,
    requiredConnectedPixels,
    maximumJump,
    thresholds: policy,
    limitation:
      "Contrôle expérimental de raccord local, sans segmentation de l’objet ni qualification de fidélité ou de réalisme.",
  };
}
export type SpatialBackgroundSeam = ReturnType<
  typeof inspectSpatialBackgroundSeam
>;
export const SPATIAL_BOUNDARY_FEEDBACK =
  "Une rupture de couleur du décor apparaît au bord de la zone modifiée. Le rendu n’est pas validé.";
export const SPATIAL_BOUNDARY_REPAIR =
  "A deterministic boundary check detected a hard colour seam in the room background at the edit-mask edge. Preserve the original room exposure, wall colours, texture and cables, including the empty space inside and around the product. Do not redraw the background or add a polygonal patch. Keep the product geometry and identity unchanged; preserve its contact shadow. The edit mask is an authorization boundary, not an object silhouette.";
