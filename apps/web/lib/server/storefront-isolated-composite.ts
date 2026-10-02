import sharp from "sharp";
import type { SimplePlacementKind } from "@lili/geometry";

export const STOREFRONT_ISOLATED_COMPOSITE_VERSION = "storefront-isolated-product-v4";

export interface StorefrontIsolatedObject {
  index: number;
  point: { x: number; y: number };
  kind: SimplePlacementKind;
  dimensionsCm: { width: number; height: number; depth: number };
  pixelsPerCm: number;
  /** The generated product already carries this pose; never rotate it twice. */
  pose?: unknown;
}

export interface StorefrontIsolatedPlacement {
  objectIndex: number;
  left: number;
  top: number;
  widthPx: number;
  heightPx: number;
  contactX: number;
  contactY: number;
}

interface AlphaBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function invalid(message: string): never {
  throw new Error(message);
}

/** Require one complete connected silhouette, retaining its anti-aliased edge. */
function productBox(data: Buffer, width: number, height: number): { box: AlphaBox; coreWidth: number } {
  const area = width * height;
  let first = -1;
  let solid = 0;
  let clear = 0;
  for (let pixel = 0; pixel < area; pixel++) {
    // Native alpha outputs can carry invisible numerical dust. It must not
    // enlarge the physical silhouette or copy RGB hidden beneath alpha zero.
    if (data[pixel * 4 + 3]! <= 2) data[pixel * 4 + 3] = 0;
    const alpha = data[pixel * 4 + 3]!;
    if (alpha === 0) clear++;
    if (alpha >= 128) {
      solid++;
      if (first < 0) first = pixel;
    }
  }
  if (clear < Math.max(1, Math.ceil(area * 0.01)))
    invalid("Le produit généré n’a pas un fond réellement transparent.");
  if (first < 0 || solid < Math.max(8, Math.ceil(area * 0.0002)))
    invalid("Une colonne générée ne contient pas de produit visible complet.");

  // Connectivity uses actual alpha, so a thin anti-aliased handle is retained.
  // Separate objects, opaque debris and detached shadows cannot be pasted along.
  const visited = new Uint8Array(area);
  const queue = new Int32Array(area);
  let head = 0, tail = 1;
  queue[0] = first; visited[first] = 1;
  while (head < tail) {
    const pixel = queue[head++]!;
    const x = pixel % width, y = Math.floor(pixel / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (visited[next] || data[next * 4 + 3] === 0) continue;
        visited[next] = 1; queue[tail++] = next;
      }
    }
  }
  let detachedAlpha = 0, detachedPeak = 0;
  for (let pixel = 0; pixel < area; pixel++) {
    if (visited[pixel]) continue;
    const alpha = data[pixel * 4 + 3]!;
    detachedAlpha += alpha; detachedPeak = Math.max(detachedPeak, alpha);
  }
  // Removing the <=2 bridges can isolate a few equally faint edge samples.
  // Never discard a visible component (alpha >=8), or a broad faint region.
  const noiseBudget = Math.min(512, Math.max(32, solid * 255 * 0.00001));
  if (detachedPeak >= 8 || detachedAlpha > noiseBudget)
    invalid("La colonne générée contient des éléments séparés du produit.");
  let left = width, right = -1, top = height, bottom = -1;
  let coreLeft = width, coreRight = -1;
  for (let pixel = 0; pixel < area; pixel++) {
    if (!visited[pixel]) data[pixel * 4 + 3] = 0;
    const alpha = data[pixel * 4 + 3]!;
    if (alpha === 0) continue;
    const x = pixel % width, y = Math.floor(pixel / width);
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
    if (alpha >= 128) { coreLeft = Math.min(coreLeft, x); coreRight = Math.max(coreRight, x); }
  }
  if (left === 0 || top === 0 || right === width - 1 || bottom === height - 1)
    invalid("Le produit généré est tronqué par une frontière de colonne ou de l’image.");
  return { box: { left, top, width: right - left + 1, height: bottom - top + 1 },
    coreWidth: coreRight - coreLeft + 1 };
}

function visibleAnchor(data: Buffer, width: number, height: number, standing: boolean) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! < 128) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (bottom < 0) invalid("Le produit devient illisible à cette échelle.");
  if (!standing) return { x: (left + right) / 2, y: (top + bottom) / 2 };
  left = width; right = -1;
  for (let x = 0; x < width; x++) {
    if (data[(bottom * width + x) * 4 + 3]! < 128) continue;
    left = Math.min(left, x); right = Math.max(right, x);
  }
  return { x: (left + right) / 2, y: bottom };
}

/**
 * Isolated generated columns are uniformly scaled and alpha-composited onto
 * the untouched photograph. Generation never supplies any room pixels.
 */
export async function composeStorefrontIsolatedProducts(input: {
  room: Buffer;
  width: number;
  height: number;
  generated: Buffer;
  objects: readonly StorefrontIsolatedObject[];
}): Promise<{ image: Buffer; placements: StorefrontIsolatedPlacement[] }> {
  const { width, height, objects } = input;
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 8192) ||
      width * height > 16_777_216 || objects.length < 1 || objects.length > 3)
    invalid("Dimensions ou nombre de produits invalides.");
  const indices = new Set<number>();
  for (const object of objects) {
    const { dimensionsCm: dimensions, point, pixelsPerCm, kind } = object;
    if (!Number.isInteger(object.index) || object.index < 0 || indices.has(object.index) ||
        ![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
        ![dimensions.width, dimensions.height, pixelsPerCm].every(value => Number.isFinite(value) && value > 0) ||
        !Number.isFinite(dimensions.depth) || dimensions.depth < 0 ||
        !["standing", "wall", "flat"].includes(kind) || (kind === "flat" && dimensions.depth === 0))
      invalid("L’emplacement ou les dimensions du produit sont invalides.");
    indices.add(object.index);
  }
  const generatedMetadata = await sharp(input.generated).metadata();
  if (!generatedMetadata.hasAlpha) invalid("Le produit généré n’a pas de transparence réelle.");
  if (!generatedMetadata.width || !generatedMetadata.height ||
      generatedMetadata.width * generatedMetadata.height > 16_777_216 ||
      (generatedMetadata.pages ?? 1) !== 1)
    invalid("Le format du produit généré est invalide.");
  const [room, generated] = await Promise.all([
    sharp(input.room).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }),
    sharp(input.generated).ensureAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (room.info.width !== width || room.info.height !== height || room.info.channels !== 3 ||
      generated.info.channels !== 4)
    invalid("Les dimensions de la photographie originale sont incohérentes.");

  const placements: StorefrontIsolatedPlacement[] = [];
  const overlays: Array<{ data: Buffer; placement: StorefrontIsolatedPlacement; object: StorefrontIsolatedObject; order: number }> = [];
  for (const [order, object] of objects.entries()) {
    // Rounding partitions every source pixel exactly once, including 1024 / 3.
    const start = Math.round(order * generated.info.width / objects.length);
    const end = Math.round((order + 1) * generated.info.width / objects.length);
    const columnWidth = end - start;
    if (columnWidth < 3 || generated.info.height < 3) invalid("Une colonne générée est trop petite.");
    const column = await sharp(generated.data, { raw: generated.info })
      .extract({ left: start, top: 0, width: columnWidth, height: generated.info.height })
      .raw().toBuffer();
    const { box, coreWidth } = productBox(column, columnWidth, generated.info.height);
    // Width is the physical scale anchor. Height follows the generated pose
    // through a single uniform resize, including flat/wall foreshortening.
    const physicalWidthPx = Math.round(object.dimensionsCm.width * object.pixelsPerCm);
    const widthPx = Math.round(box.width * physicalWidthPx / coreWidth);
    const predictedHeight = Math.round(box.height * widthPx / box.width);
    if (physicalWidthPx < 1 || widthPx < 1 || predictedHeight < 1 || widthPx > width || predictedHeight > height)
      invalid("Le produit à cette échelle ne tient pas dans la photographie.");
    const resized = await sharp(column, { raw: { width: columnWidth, height: generated.info.height, channels: 4 } })
      .extract(box).resize({ width: widthPx, kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
    const anchor = visibleAnchor(resized.data, resized.info.width, resized.info.height, object.kind === "standing");
    const targetX = Math.round(object.point.x * width), targetY = Math.round(object.point.y * height);
    const left = Math.round(targetX - anchor.x), top = Math.round(targetY - anchor.y);
    if (left < 0 || top < 0 || left + resized.info.width > width || top + resized.info.height > height)
      invalid("Le produit déborderait de la photographie à cet emplacement.");
    const placement = { objectIndex: object.index, left, top,
      widthPx: resized.info.width, heightPx: resized.info.height,
      contactX: left + anchor.x, contactY: top + anchor.y };
    placements.push(placement);
    overlays.push({ data: resized.data, placement, object, order });
  }
  const ranks = { wall: 0, flat: 1, standing: 2 };
  overlays.sort((a, b) => a.object.point.y - b.object.point.y ||
    ranks[a.object.kind] - ranks[b.object.kind] ||
    a.object.dimensionsCm.depth - b.object.dimensionsCm.depth || a.order - b.order);
  const output = Buffer.from(room.data);
  for (const { data, placement } of overlays) {
    for (let y = 0; y < placement.heightPx; y++) {
      for (let x = 0; x < placement.widthPx; x++) {
        const source = (y * placement.widthPx + x) * 4;
        const alpha = data[source + 3]!;
        if (alpha === 0) continue;
        const target = ((placement.top + y) * width + placement.left + x) * 3;
        for (let channel = 0; channel < 3; channel++)
          output[target + channel] = Math.round((data[source + channel]! * alpha + output[target + channel]! * (255 - alpha)) / 255);
      }
    }
  }
  return { image: await sharp(output, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer(), placements };
}
