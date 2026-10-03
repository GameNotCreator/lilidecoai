import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { projectPoint, solveHomography, type Quad } from "@lili/geometry";
import {
  clipTexturePolygon,
  createPlanarAreaSampler,
} from "./planar-area-sampling";
import {
  footprintOnSupport,
  insidePolygon,
  type SpatialSurface,
} from "../spatial-scene";

/** Four clockwise corners in image coordinates, starting at the texture's top-left.
 * Convexity checks also reject bow-ties, mirrored order and near-degenerate quads. */
export function validateTextureQuad(quad: Quad, width: number, height: number) {
  if (
    quad.length !== 4 ||
    quad.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.x > width ||
        p.y < 0 ||
        p.y > height,
    )
  )
    throw new Error("Coins de texture hors image.");
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!,
      b = quad[(i + 1) % 4]!,
      c = quad[(i + 2) % 4]!;
    if (
      (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 1e-4 ||
      Math.hypot(b.x - a.x, b.y - a.y) < 2
    )
      throw new Error(
        "La texture exige quatre coins distincts, convexes et ordonnés sans miroir.",
      );
  }
}
/** Deterministic inverse homography. Original samples only; no generative redraw,
 * lighting synthesis, reflection or foreground-occlusion inference. */
export async function projectPlanarTexture(input: {
  room: Buffer;
  texture: Buffer;
  sourceCorners: Quad;
  targetCorners: Quad;
  support: SpatialSurface;
  reflectiveRegions?: Array<Array<{ x: number; y: number }>>;
  version?: "planar-texture-v1" | "planar-texture-v2";
}) {
  const room = await sharp(input.room)
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const texture = await sharp(input.texture)
    .rotate()
    .ensureAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = room.info,
    tw = texture.info.width,
    th = texture.info.height;
  if (
    width * height > 16_000_000 ||
    tw * th > 16_000_000 ||
    Math.min(tw, th) < 16
  )
    throw new Error("Dimensions de texture ou de scène hors limites.");
  validateTextureQuad(input.sourceCorners, tw, th);
  validateTextureQuad(input.targetCorners, width, height); // No automatic crop/shrink.
  const normalized = input.targetCorners.map((p) => ({
    x: p.x / width,
    y: p.y / height,
  }));
  if (!footprintOnSupport(normalized, input.support))
    throw new Error(
      "Le tapis dépasse le support libre ou recouvre un obstacle.",
    );
  const protectedSurface = {
    ...input.support,
    holes: [...input.support.holes, ...(input.reflectiveRegions ?? [])],
  };
  if (!footprintOnSupport(normalized, protectedSurface))
    throw new Error(
      "Le tapis recouvre une zone réfléchissante non prise en charge.",
    );
  const inverse = solveHomography(input.targetCorners, input.sourceCorners);
  // On remonte du pixel de destination vers la texture réelle : la projection
  // conserve la provenance du motif sans déléguer son dessin au fournisseur.
  const version = input.version ?? "planar-texture-v1";
  const areaSample =
    version === "planar-texture-v2"
      ? createPlanarAreaSampler(texture.data, tw, th, input.sourceCorners)
      : undefined;
  const output = Buffer.from(room.data),
    mask = Buffer.alloc(width * height);
  const left = Math.max(
      0,
      Math.floor(Math.min(...input.targetCorners.map((p) => p.x))),
    ),
    right = Math.min(
      width,
      Math.ceil(Math.max(...input.targetCorners.map((p) => p.x))),
    );
  const top = Math.max(
      0,
      Math.floor(Math.min(...input.targetCorners.map((p) => p.y))),
    ),
    bottom = Math.min(
      height,
      Math.ceil(Math.max(...input.targetCorners.map((p) => p.y))),
    );
  let modifiedPixels = 0,
    filteredPixels = 0;
  // Bilinear interpolation in premultiplied alpha prevents transparent source
  // colours from bleeding into the rug. Coordinates refer to pixel edges.
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const point = { x: x + 0.5, y: y + 0.5 };
      if (!insidePolygon(point, [...input.targetCorners])) continue;
      const mapped = projectPoint(inverse, point);
      let filtered: ReturnType<NonNullable<typeof areaSample>>;
      if (areaSample) {
        // Largest singular value of the inverse mapping's local Jacobian.
        // This also detects one-axis reductions and oblique/sheared footprints.
        const denominator =
          inverse[6] * point.x + inverse[7] * point.y + inverse[8];
        const a = (inverse[0] - mapped.x * inverse[6]) / denominator;
        const b = (inverse[1] - mapped.x * inverse[7]) / denominator;
        const c = (inverse[3] - mapped.y * inverse[6]) / denominator;
        const d = (inverse[4] - mapped.y * inverse[7]) / denominator;
        const trace = a * a + b * b + c * c + d * d;
        const determinant = (a * d - b * c) ** 2;
        const maximumScaleSquared =
          (trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant))) / 2;
        if (maximumScaleSquared > 1 + 1e-6) {
          const pixel = [
            { x, y },
            { x: x + 1, y },
            { x: x + 1, y: y + 1 },
            { x, y: y + 1 },
          ];
          // Clip before mapping so a border pixel never crosses the homography's horizon.
          filtered = areaSample(
            clipTexturePolygon(pixel, input.targetCorners).map((p) =>
              projectPoint(inverse, p),
            ),
          );
          if (!filtered) continue;
          filteredPixels++;
        }
      }
      const sx = Math.max(0, Math.min(tw - 1, mapped.x - 0.5)),
        sy = Math.max(0, Math.min(th - 1, mapped.y - 0.5));
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        dx = sx - x0,
        dy = sy - y0;
      let alpha = filtered?.alpha ?? 0,
        validWeight = 0;
      const premultiplied = filtered?.premultiplied ?? [0, 0, 0];
      if (!filtered) {
        for (const [xx, yy, weight] of [
          [x0, y0, (1 - dx) * (1 - dy)],
          [Math.min(tw - 1, x0 + 1), y0, dx * (1 - dy)],
          [x0, Math.min(th - 1, y0 + 1), (1 - dx) * dy],
          [Math.min(tw - 1, x0 + 1), Math.min(th - 1, y0 + 1), dx * dy],
        ]) {
          if (
            !insidePolygon({ x: xx! + 0.5, y: yy! + 0.5 }, [
              ...input.sourceCorners,
            ])
          )
            continue;
          validWeight += weight!;
          const offset = (yy! * tw + xx!) * 4,
            a = (texture.data[offset + 3]! / 255) * weight!;
          alpha += a;
          for (let c = 0; c < 3; c++)
            premultiplied[c]! += texture.data[offset + c]! * a;
        }
        if (alpha <= 0 || validWeight <= 0) continue;
        alpha /= validWeight;
        for (let c = 0; c < 3; c++) premultiplied[c]! /= validWeight;
      }
      if (alpha <= 0) continue;
      const offset = (y * width + x) * 3;
      for (let c = 0; c < 3; c++)
        output[offset + c] = Math.round(
          premultiplied[c]! + room.data[offset + c]! * (1 - alpha),
        );
      mask[y * width + x] = Math.round(alpha * 255);
      modifiedPixels++;
    }
  if (!modifiedPixels) throw new Error("La texture projetée est vide.");
  return {
    image: await sharp(output, { raw: { width, height, channels: 3 } })
      .webp({ lossless: true })
      .toBuffer(),
    mask: await sharp(mask, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer(),
    evidence: {
      version,
      ...(areaSample
        ? { filtering: "source-area-v1" as const, filteredPixels }
        : {}),
      sourceFingerprint: createHash("sha256")
        .update(input.texture)
        .digest("hex"),
      roomFingerprint: createHash("sha256").update(input.room).digest("hex"),
      sourceCorners: input.sourceCorners,
      targetCorners: input.targetCorners,
      inverseHomography: inverse,
      modifiedPixels,
      qualification: "geometry-only" as const,
      limitations: [
        "Coins de texture fournis, non vérifiés automatiquement",
        "Éclairage et ombres de la référence conservés",
        "Pas de synthèse des ombres, occultations ou reflets",
        ...(areaSample
          ? [
              "Réduction pondérée par aire source ; approximation locale sous perspective, couverture des bords au centre du pixel",
            ]
          : []),
      ],
    },
  };
}
