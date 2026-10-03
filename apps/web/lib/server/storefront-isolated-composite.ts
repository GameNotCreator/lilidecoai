import sharp from "sharp";
import type { SimplePlacementKind } from "@lili/geometry";
import { pasteBackOutsideMask, type PaddedComposition, type PlacedOverlay } from "./simple-composite";
import type { StorefrontRoomIntegrationWindow } from "./storefront-room-integration";

export const STOREFRONT_ISOLATED_COMPOSITE_VERSION = "storefront-isolated-product-v4";
export const STOREFRONT_HYBRID_RGB_VERSION = "storefront-hybrid-bounded-rgb-v1";
export const STOREFRONT_NATIVE_TEXTURE_VERSION = "storefront-native-texture-relight-v1";
/** Ambient contact is a geometric approximation from the actual native foot. */
export const STOREFRONT_NATIVE_CONTACT_MAX_DARKENING = 0.34;
export const STOREFRONT_HYBRID_RGB_HALO_PX = 4;
export const STOREFRONT_HYBRID_RGB_CONTACT_PROFILE_RATIO = 0.12;

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

export interface StorefrontIsolatedComposition {
  image: Buffer;
  placements: StorefrontIsolatedPlacement[];
  /** The generated view after ONE uniform resize, with its complete native alpha. */
  overlays: PlacedOverlay[];
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
}): Promise<StorefrontIsolatedComposition> {
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
  return { image: await sharp(output, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer(), placements,
    overlays: await Promise.all(overlays.map(async ({ data, placement, object }) => ({
      png: await sharp(data, { raw: { width: placement.widthPx, height: placement.heightPx, channels: 4 } }).png().toBuffer(),
      left: placement.left, top: placement.top, widthPx: placement.widthPx, heightPx: placement.heightPx,
      baseX: placement.contactX, baseY: placement.contactY, kind: object.kind,
      depthKey: object.point.y, objectIndex: object.index,
    }))),
  };
}

/** Historical callers retain native RGB. The opt-in storefront mode accepts
 * local provider RGB; final visual QA must independently verify its geometry. */
export async function harmonizeStorefrontIsolatedProducts(input: {
  room: Buffer;
  width: number;
  height: number;
  isolated: StorefrontIsolatedComposition;
  window: StorefrontRoomIntegrationWindow;
  padded: PaddedComposition;
  generated: Buffer;
  maskRaw: Buffer;
  transferMode?: "contact-light" | "bounded-rgb";
  /** Restore native material detail inside the product, preserving provider edges/contact. */
  preserveProductTexture?: boolean;
}): Promise<Buffer> {
  const { room, width, height, isolated, window, padded, generated, maskRaw } = input;
  if (![width, height, window.width, window.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) ||
      width * height > 16_777_216 || ![window.left, window.top].every(value => Number.isSafeInteger(value) && value >= 0) ||
      window.left + window.width > width || window.top + window.height > height ||
      maskRaw.length !== width * height * 4 || isolated.overlays.length < 1 || isolated.overlays.length > 3 ||
      isolated.overlays.some(overlay => ![overlay.left, overlay.top, overlay.widthPx, overlay.heightPx, overlay.baseX, overlay.baseY].every(Number.isFinite) ||
        overlay.left < window.left || overlay.top < window.top ||
        overlay.left + overlay.widthPx > window.left + window.width ||
        overlay.top + overlay.heightPx > window.top + window.height))
    invalid("La vue complète du produit ne tient pas dans la fenêtre d’intégration.");
  const source = sharp(generated, { limitInputPixels: 16_777_216 });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation !== undefined && metadata.orientation !== 1) ||
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      ![padded.paddedWidth, padded.paddedHeight].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) ||
      padded.paddedWidth * padded.paddedHeight > 16_777_216 ||
      padded.paddedWidth < window.width || padded.paddedHeight < window.height ||
      ![padded.offsetX, padded.offsetY].every(value => Number.isSafeInteger(value) && value >= 0) ||
      padded.offsetX + window.width > padded.paddedWidth || padded.offsetY + window.height > padded.paddedHeight ||
      Math.abs(metadata.height * padded.paddedWidth / metadata.width - padded.paddedHeight) > 0.5)
    invalid("Le cadrage retourné ne correspond pas à la photographie envoyée.");
  if (metadata.hasAlpha && (await source.stats()).channels.at(-1)?.min !== 255)
    invalid("L’harmonisation doit retourner une photographie opaque.");
  const [localRoom, localComposite, localMask] = await Promise.all([
    sharp(room).extract(window).webp({ lossless: true }).toBuffer(),
    sharp(isolated.image).extract(window).webp({ lossless: true }).toBuffer(),
    sharp(maskRaw, { raw: { width, height, channels: 4 } }).extract(window).raw().toBuffer(),
  ]);
  const localOverlays = isolated.overlays.map(overlay => ({ ...overlay,
    left: overlay.left - window.left, top: overlay.top - window.top,
    baseX: overlay.baseX - window.left, baseY: overlay.baseY - window.top,
  }));
  if (input.transferMode === "bounded-rgb") {
    const aligned = await source.resize({ width: padded.paddedWidth })
      .extract({ left: padded.offsetX, top: padded.offsetY, width: window.width, height: window.height })
      .removeAlpha().toColourspace("srgb").raw().toBuffer();
    const local = await boundedHybridRgb({ room: localRoom, generated: aligned,
      width: window.width, height: window.height, overlays: localOverlays, maskRaw: localMask,
      preserveProductTexture: input.preserveProductTexture });
    return sharp(room).composite([{ input: local, left: window.left, top: window.top }])
      .webp({ lossless: true }).toBuffer();
  }
  const transferred = await pasteBackOutsideMask({
    sceneWebp: localRoom, imageWebp: localComposite, baseWebp: localComposite,
    sceneWidth: window.width, sceneHeight: window.height, maskRaw: localMask,
    overlays: localOverlays, lighting: null,
  }, padded, generated, { transferMode: "contact-light", relightStrength: 1 });
  const local = await nativeContactOcclusion({ room: localRoom, transferred,
    width: window.width, height: window.height, overlays: localOverlays, maskRaw: localMask });
  return sharp(room).composite([{ input: local, left: window.left, top: window.top }])
    .webp({ lossless: true }).toBuffer();
}

/** Permit the provider to integrate the placed object instead of stamping the
 * original catalogue RGB back over its work. The complete native silhouette
 * defines the target region, not a guarantee that the returned object has kept
 * its identity or pose: the final visual review remains mandatory. */
async function boundedHybridRgb(input: {
  room: Buffer; generated: Buffer; width: number; height: number;
  overlays: PlacedOverlay[]; maskRaw: Buffer;
  preserveProductTexture?: boolean;
}): Promise<Buffer> {
  const { width, height, overlays, maskRaw, generated } = input;
  const [room, tiles] = await Promise.all([
    sharp(input.room).removeAlpha().toColourspace("srgb").raw().toBuffer(),
    Promise.all(overlays.map(async overlay => ({ overlay,
      alpha: await sharp(overlay.png).extractChannel("alpha").raw().toBuffer() }))),
  ]);
  const area = width * height;
  const body = new Uint8Array(area);
  const allowance = new Float32Array(area);
  const editable = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && maskRaw[(y * width + x) * 4 + 3] === 0;
  for (const { overlay, alpha } of tiles)
    for (let y = 0; y < overlay.heightPx; y++)
      for (let x = 0; x < overlay.widthPx; x++) {
        if (alpha[y * overlay.widthPx + x]! === 0) continue;
        const gx = overlay.left + x, gy = overlay.top + y;
        // Never clip a generated handle or base to a stale approximate mask.
        if (!editable(gx, gy)) invalid("Le masque d’intégration ne contient pas la silhouette complète du produit.");
        body[gy * width + gx] = 1;
        allowance[gy * width + gx] = 1;
      }
  const halo = STOREFRONT_HYBRID_RGB_HALO_PX;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!body[i] || (x > 0 && x < width - 1 && y > 0 && y < height - 1 &&
          body[i - 1] && body[i + 1] && body[i - width] && body[i + width])) continue;
      // Expand only boundary pixels; a large opaque product does not incur a
      // radius-squared loop for every interior pixel.
      for (let dy = -halo; dy <= halo; dy++)
        for (let dx = -halo; dx <= halo; dx++) {
          const distance = Math.hypot(dx, dy);
          if (distance >= halo || !editable(x + dx, y + dy)) continue;
          const target = (y + dy) * width + x + dx;
          allowance[target] = Math.max(allowance[target]!, distance <= 2 ? 1 : (halo - distance) / (halo - 2));
        }
    }
  for (const { overlay, alpha } of tiles) {
    if (overlay.kind !== "standing") continue;
    const baseRow = Math.max(0, Math.min(overlay.heightPx - 1, Math.round(overlay.baseY - overlay.top)));
    const band = Math.max(1, Math.ceil(overlay.heightPx * STOREFRONT_HYBRID_RGB_CONTACT_PROFILE_RATIO));
    // This field only authorises a real provider shadow. It does not draw an
    // ellipse or add a synthetic AO when the provider has produced no contact.
    const radiusX = Math.min(32, Math.max(6, Math.ceil(overlay.widthPx * 0.16)));
    const radiusY = Math.min(24, Math.max(6, Math.ceil(overlay.heightPx * 0.09)));
    for (let x = 0; x < overlay.widthPx; x++) {
      let foot = -1;
      for (let y = baseRow; y >= Math.max(0, baseRow - band + 1); y--)
        if (alpha[y * overlay.widthPx + x]! >= 128) { foot = y; break; }
      if (foot < 0) continue;
      const seedX = overlay.left + x, seedY = overlay.top + foot + 1;
      for (let dy = -2; dy <= radiusY; dy++)
        for (let dx = -radiusX; dx <= radiusX; dx++) {
          if (!editable(seedX + dx, seedY + dy)) continue;
          const distance = Math.max(Math.abs(dx) / radiusX, Math.max(0, dy) / radiusY);
          const target = (seedY + dy) * width + seedX + dx;
          allowance[target] = Math.max(allowance[target]!, Math.max(0, Math.min(1, (1 - distance) * 3)));
        }
    }
  }
  const smooth = await sharp(Buffer.from(allowance.map(value => Math.round(value * 255))),
    { raw: { width, height, channels: 1 } }).blur(2).toColourspace("b-w").raw().toBuffer();
  const output = Buffer.from(room);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x, offset = i * 3;
      // Smoothing may soften an allowed pixel, never expand the geometry that
      // authorises provider influence into an unrelated part of the room.
      if (!editable(x, y) || (!body[i] && (allowance[i]! <= 0 || smooth[i] === 0))) continue;
      let weight = body[i] ? 1 : smooth[i]! / 255;
      if (!body[i]) {
        // Feather the outside of the allowed region, including irregular locks.
        // The product itself remains full strength, right through its base.
        for (let distance = 1; distance <= 3; distance++)
          if (!editable(x - distance, y) || !editable(x + distance, y) ||
              !editable(x, y - distance) || !editable(x, y + distance)) {
            weight *= distance / 3; break;
          }
        const originalLuma = 0.2126 * room[offset]! + 0.7152 * room[offset + 1]! + 0.0722 * room[offset + 2]!;
        const generatedLuma = 0.2126 * generated[offset]! + 0.7152 * generated[offset + 1]! + 0.0722 * generated[offset + 2]!;
        // A contact shadow cannot emit light. Suppress the provider's luminous
        // floor halos and preserve the original floor colour at every pixel.
        if (originalLuma <= 0 || generatedLuma >= originalLuma) continue;
        const gain = 1 - weight * (1 - generatedLuma / originalLuma);
        for (let channel = 0; channel < 3; channel++) output[offset + channel] = Math.round(room[offset + channel]! * gain);
      } else {
        for (let channel = 0; channel < 3; channel++) output[offset + channel] = generated[offset + channel]!;
      }
    }
  if (input.preserveProductTexture)
    await restoreNativeMaterialTexture({ output, generated, width, height, tiles });
  return sharp(output, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
}

/** Transfer only the provider's low-frequency illumination into the opaque
 * interior of the already oriented native product. Original material colour
 * and high-frequency detail survive; the provider's final contour and contact
 * remain untouched. This cannot validate or repair an incorrect 3D pose. */
async function restoreNativeMaterialTexture(input: {
  output: Buffer; generated: Buffer; width: number; height: number;
  tiles: Array<{ overlay: PlacedOverlay; alpha: Buffer }>;
}): Promise<void> {
  const { output, generated, width, height, tiles } = input;
  // Overlays are already sorted back to front. Do not reintroduce a rear
  // product's texture through a foreground product or its antialiased edge.
  const owner = new Uint8Array(width * height);
  for (const [order, { overlay, alpha }] of tiles.entries())
    for (let y = 0; y < overlay.heightPx; y++)
      for (let x = 0; x < overlay.widthPx; x++)
        if (alpha[y * overlay.widthPx + x]! > 0)
          owner[(overlay.top + y) * width + overlay.left + x] = order + 1;
  for (const [order, { overlay }] of tiles.entries()) {
    const decoded = await sharp(overlay.png).ensureAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const native = decoded.data;
    const tileWidth = overlay.widthPx, tileHeight = overlay.heightPx, area = tileWidth * tileHeight;
    if (decoded.info.width !== tileWidth || decoded.info.height !== tileHeight || decoded.info.channels !== 4)
      invalid("Les dimensions de la texture native ne correspondent pas au produit placé.");
    const alphaWeight = Buffer.alloc(area), sourceLuma = Buffer.alloc(area), targetLuma = Buffer.alloc(area);
    const distance = new Uint16Array(area);
    for (let y = 0; y < tileHeight; y++)
      for (let x = 0; x < tileWidth; x++) {
        const i = y * tileWidth + x, originalOffset = i * 4;
        const targetPixel = (overlay.top + y) * width + overlay.left + x;
        const alpha = native[originalOffset + 3]!;
        if (alpha < 250 || owner[targetPixel] !== order + 1) continue;
        const targetOffset = targetPixel * 3;
        alphaWeight[i] = alpha;
        distance[i] = 65535;
        sourceLuma[i] = Math.round((0.2126 * native[originalOffset]! + 0.7152 * native[originalOffset + 1]! + 0.0722 * native[originalOffset + 2]!) * alpha / 255);
        targetLuma[i] = Math.round((0.2126 * generated[targetOffset]! + 0.7152 * generated[targetOffset + 1]! + 0.0722 * generated[targetOffset + 2]!) * alpha / 255);
      }
    // Two-pixel erosion, followed by a two-pixel interior transition. Pixels
    // with low native alpha, small handles and the visible foot are excluded.
    for (let y = 0; y < tileHeight; y++)
      for (let x = 0; x < tileWidth; x++) {
        const i = y * tileWidth + x;
        if (alphaWeight[i] === 0) continue;
        distance[i] = Math.min(distance[i]!, x === 0 ? 1 : distance[i - 1]! + 1, y === 0 ? 1 : distance[i - tileWidth]! + 1);
      }
    for (let y = tileHeight - 1; y >= 0; y--)
      for (let x = tileWidth - 1; x >= 0; x--) {
        const i = y * tileWidth + x;
        if (alphaWeight[i] === 0) continue;
        distance[i] = Math.min(distance[i]!, x === tileWidth - 1 ? 1 : distance[i + 1]! + 1,
          y === tileHeight - 1 ? 1 : distance[i + tileWidth]! + 1);
      }
    const blur = (data: Buffer) => sharp(data, { raw: { width: tileWidth, height: tileHeight, channels: 1 } })
      .blur(2).toColourspace("b-w").raw().toBuffer();
    const [sourceLow, targetLow, weightLow] = await Promise.all([blur(sourceLuma), blur(targetLuma), blur(alphaWeight)]);
    for (let y = 0; y < tileHeight; y++)
      for (let x = 0; x < tileWidth; x++) {
        const i = y * tileWidth + x;
        if (alphaWeight[i] === 0 || distance[i]! <= 2 || weightLow[i]! < 8) continue;
        const sourceLight = sourceLow[i]! * 255 / weightLow[i]!;
        const targetLight = targetLow[i]! * 255 / weightLow[i]!;
        // Normalise by opacity before comparing illumination. An all-black
        // native region has no ratio to estimate and remains finite and black.
        const gain = sourceLight > 0 ? Math.max(0.5, Math.min(1.6, targetLight / sourceLight)) : 1;
        const blend = Math.min(1, (distance[i]! - 2) / 2);
        const targetOffset = ((overlay.top + y) * width + overlay.left + x) * 3;
        for (let channel = 0; channel < 3; channel++) {
          const relitNative = Math.min(255, native[i * 4 + channel]! * gain);
          output[targetOffset + channel] = Math.round(relitNative * blend + output[targetOffset + channel]! * (1 - blend));
        }
      }
  }
}

/** The photometric transfer intentionally rejects very dark provider pixels:
 * they can belong to a moved/cloned object. Recover a restrained contact from
 * native-alpha foot samples instead, without trusting those generated RGBs.
 * Disjoint feet remain disjoint; no bounding-box ellipse or cast direction is
 * invented. Existing transferred shadow and this field combine by maximum. */
async function nativeContactOcclusion(input: {
  room: Buffer; transferred: Buffer; width: number; height: number;
  overlays: PlacedOverlay[]; maskRaw: Buffer;
}): Promise<Buffer> {
  const { width, height, overlays, maskRaw } = input;
  const [room, transferred, tiles] = await Promise.all([
    sharp(input.room).removeAlpha().raw().toBuffer(),
    sharp(input.transferred).removeAlpha().raw().toBuffer(),
    Promise.all(overlays.map(async overlay => ({ overlay,
      alpha: await sharp(overlay.png).extractChannel("alpha").raw().toBuffer() }))),
  ]);
  const protectedProduct = new Uint8Array(width * height);
  const contact = new Float32Array(width * height);
  for (const { overlay, alpha } of tiles)
    for (let y = 0; y < overlay.heightPx; y++)
      for (let x = 0; x < overlay.widthPx; x++)
        if (alpha[y * overlay.widthPx + x]! > 0)
          protectedProduct[(overlay.top + y) * width + overlay.left + x] = 1;
  for (const { overlay, alpha } of tiles) {
    if (overlay.kind !== "standing") continue;
    const baseRow = Math.max(0, Math.min(overlay.heightPx - 1, Math.round(overlay.baseY - overlay.top)));
    const band = Math.max(1, Math.min(6, Math.round(overlay.heightPx * 0.04)));
    const sigmaX = Math.max(0.65, Math.min(2, overlay.widthPx * 0.018));
    const sigmaY = Math.max(0.8, Math.min(2, overlay.heightPx * 0.025));
    const radiusX = Math.ceil(sigmaX * 2), radiusY = Math.ceil(sigmaY * 2);
    for (let x = 0; x < overlay.widthPx; x++) {
      let foot = -1;
      for (let y = baseRow; y >= Math.max(0, baseRow - band + 1); y--)
        if (alpha[y * overlay.widthPx + x]! >= 128) { foot = y; break; }
      if (foot < 0) continue;
      const seedX = overlay.left + x, seedY = overlay.top + foot + 1;
      for (let y = Math.max(0, Math.ceil(overlay.baseY - 1), seedY - radiusY); y <= Math.min(height - 1, seedY + radiusY); y++)
        for (let px = Math.max(0, seedX - radiusX); px <= Math.min(width - 1, seedX + radiusX); px++) {
          const i = y * width + px;
          if (protectedProduct[i] || maskRaw[i * 4 + 3] !== 0) continue;
          const distance = ((px - seedX) / sigmaX) ** 2 + ((y - seedY) / sigmaY) ** 2;
          contact[i] = Math.max(contact[i]!, STOREFRONT_NATIVE_CONTACT_MAX_DARKENING * Math.exp(-0.5 * distance));
        }
    }
  }
  const output = Buffer.from(transferred);
  for (let i = 0; i < contact.length; i++) {
    if (contact[i]! <= 0 || protectedProduct[i] || maskRaw[i * 4 + 3] !== 0) continue;
    const offset = i * 3;
    const before = 0.2126 * room[offset]! + 0.7152 * room[offset + 1]! + 0.0722 * room[offset + 2]!;
    const after = 0.2126 * transferred[offset]! + 0.7152 * transferred[offset + 1]! + 0.0722 * transferred[offset + 2]!;
    const existing = before > 0 ? Math.max(0, 1 - after / before) : 0;
    if (existing >= contact[i]!) continue;
    const gain = 1 - contact[i]!;
    for (let channel = 0; channel < 3; channel++) output[offset + channel] = Math.round(room[offset + channel]! * gain);
  }
  return sharp(output, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
}
