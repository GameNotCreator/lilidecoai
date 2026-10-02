import sharp from "sharp";
import type { PaddedComposition, SimpleComposition } from "./simple-composite";
import type { StorefrontPerspectiveGuideObject } from "./storefront-perspective-guide";

export const STOREFRONT_ROOM_INTEGRATION_COMPOSITE_VERSION =
  "storefront-room-integration-v5";

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const dimension = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === "number" && value > 0 && value <= 8192;
const angle = (value: unknown, minimum: number, maximum: number) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum);
const invalid = () => new Error("Données d’intégration dans la pièce invalides.");

function validateComposition(composition: SimpleComposition) {
  if (!composition || !dimension(composition.sceneWidth) || !dimension(composition.sceneHeight) ||
      composition.sceneWidth * composition.sceneHeight > 16_000_000 ||
      !Buffer.isBuffer(composition.sceneWebp) || !composition.sceneWebp.length ||
      composition.sceneWebp.length > 32_000_000) throw invalid();
}

/** The model edits the original photograph, never a catalogue sprite. */
export function roomIntegrationEditComposition(
  composition: SimpleComposition,
  objects: StorefrontPerspectiveGuideObject[],
): SimpleComposition {
  validateComposition(composition);
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > 3) throw invalid();
  const { sceneWidth: width, sceneHeight: height } = composition;
  const maskRaw = Buffer.alloc(width * height * 4, 255);
  const indices = new Set<number>();
  const clearRectangle = (left: number, top: number, right: number, bottom: number) => {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y++)
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(right)); x++)
        maskRaw[(y * width + x) * 4 + 3] = 0;
  };
  for (const object of objects) {
    if (!object || !Number.isInteger(object.index) || object.index < 0 || object.index > 2 ||
        indices.has(object.index) || !object.point ||
        ![object.point.x, object.point.y].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) ||
        !["standing", "flat", "wall"].includes(object.kind) ||
        !positive(object.pixelsPerCm) || !positive(object.widthPixelsPerCm) || !object.dimensionsCm ||
        !Object.values(object.dimensionsCm).every(positive) ||
        (object.pose !== undefined && (!object.pose ||
          !angle(object.pose.cameraElevationDegrees, 0, 85) || !angle(object.pose.cameraRollDegrees, -30, 30)))) throw invalid();
    indices.add(object.index);
    const physicalWidth = object.dimensionsCm.width * object.widthPixelsPerCm;
    const physicalHeight = object.dimensionsCm.height * object.pixelsPerCm;
    const physicalDepth = object.dimensionsCm.depth * object.widthPixelsPerCm;
    if (![physicalWidth, physicalHeight, physicalDepth].every(positive)) throw invalid();
    const anchor = {
      x: Math.min(width - 1, Math.round(object.point.x * width)),
      y: Math.min(height - 1, Math.round(object.point.y * height)),
    };
    const elevation = object.pose?.cameraElevationDegrees;
    // Unknown top elevation retains a conservative full-depth envelope.
    const projectedDepth = typeof elevation === "number"
      ? physicalDepth * Math.sin(elevation * Math.PI / 180) : physicalDepth;
    const bodyHeight = object.kind === "flat" ? physicalDepth : physicalHeight;
    const top = object.kind === "standing" ? -bodyHeight - projectedDepth : -bodyHeight / 2;
    const bottom = object.kind === "standing" ? 0 : bodyHeight / 2;
    const roll = object.kind === "standing" ? (object.pose?.cameraRollDegrees ?? 0) * Math.PI / 180 : 0;
    const corners = [[-physicalWidth / 2, top], [physicalWidth / 2, top],
      [-physicalWidth / 2, bottom], [physicalWidth / 2, bottom]].map(([x, y]) => ({
        x: anchor.x + x! * Math.cos(roll) - y! * Math.sin(roll),
        y: anchor.y + x! * Math.sin(roll) + y! * Math.cos(roll),
      }));
    const left = Math.min(...corners.map(corner => corner.x));
    const right = Math.max(...corners.map(corner => corner.x));
    const upper = Math.min(...corners.map(corner => corner.y));
    const lower = Math.max(...corners.map(corner => corner.y));
    if (right - left > width || lower - upper > height) throw invalid();
    const margin = Math.max(3, Math.min(40, Math.max(physicalWidth, bodyHeight, projectedDepth) * 0.12));
    clearRectangle(left - margin, upper - margin, right + margin, lower + margin);
    if (object.kind === "standing") {
      // A small support patch permits contact shading on the real floor/table.
      const rx = Math.max(4, physicalWidth * 0.65);
      const ry = Math.max(4, projectedDepth * 0.2, physicalHeight * 0.06);
      for (let y = Math.max(0, Math.floor(anchor.y - ry)); y <= Math.min(height - 1, Math.ceil(anchor.y + ry)); y++)
        for (let x = Math.max(0, Math.floor(anchor.x - rx)); x <= Math.min(width - 1, Math.ceil(anchor.x + rx)); x++)
          if (((x - anchor.x) / rx) ** 2 + ((y - anchor.y) / ry) ** 2 <= 1)
            maskRaw[(y * width + x) * 4 + 3] = 0;
    }
  }
  return { ...composition, imageWebp: composition.sceneWebp!, baseWebp: composition.sceneWebp!, maskRaw };
}

/** Restore only the allowed full-scene edit, preserving every exterior RGB pixel. */
export async function restoreRoomIntegrationBackground(
  composition: SimpleComposition,
  padded: PaddedComposition,
  generated: Buffer,
): Promise<Buffer> {
  validateComposition(composition);
  const { sceneWidth: width, sceneHeight: height } = composition;
  if (!Buffer.isBuffer(composition.maskRaw) || composition.maskRaw.length !== width * height * 4 ||
      !padded || !dimension(padded.paddedWidth) || !dimension(padded.paddedHeight) ||
      padded.paddedWidth * padded.paddedHeight > 16_000_000 ||
      !Number.isSafeInteger(padded.offsetX) || padded.offsetX < 0 ||
      !Number.isSafeInteger(padded.offsetY) || padded.offsetY < 0 ||
      padded.offsetX + width > padded.paddedWidth || padded.offsetY + height > padded.paddedHeight ||
      !Buffer.isBuffer(generated) || !generated.length || generated.length > 32_000_000) throw invalid();
  for (let pixel = 0; pixel < width * height; pixel++) {
    const alpha = composition.maskRaw[pixel * 4 + 3];
    if (alpha !== 0 && alpha !== 255) throw invalid();
  }
  const source = sharp(generated, { limitInputPixels: 16_000_000 });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) !== 1 || (metadata.orientation !== undefined && metadata.orientation !== 1) ||
      metadata.width * metadata.height > 16_000_000 ||
      Math.abs(metadata.height * padded.paddedWidth / metadata.width - padded.paddedHeight) > 0.5) throw invalid();
  if (metadata.hasAlpha) {
    const stats = await source.stats();
    if (stats.channels.at(-1)?.min !== 255) throw new Error("L’intégration doit retourner une photographie entièrement opaque.");
  }
  const [room, scaled] = await Promise.all([
    sharp(composition.sceneWebp!).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }),
    // Only a width is requested: scale remains uniform, never a fit:fill warp.
    source.resize({ width: padded.paddedWidth }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (room.info.width !== width || room.info.height !== height || room.info.channels !== 3 ||
      scaled.info.width !== padded.paddedWidth || scaled.info.height !== padded.paddedHeight || scaled.info.channels !== 3) throw invalid();
  const edited = await sharp(scaled.data, { raw: { width: scaled.info.width, height: scaled.info.height, channels: 3 } })
    .extract({ left: padded.offsetX, top: padded.offsetY, width, height }).raw().toBuffer();
  const editable = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height &&
    composition.maskRaw[(y * width + x) * 4 + 3] === 0;
  const output = Buffer.from(room.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!editable(x, y)) continue;
      let distance = 3;
      for (let radius = 1; radius <= 3; radius++) {
        if (!editable(x - radius, y) || !editable(x + radius, y) ||
            !editable(x, y - radius) || !editable(x, y + radius)) {
          distance = radius - 1;
          break;
        }
      }
      const blend = distance / 3;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        output[offset + channel] = Math.round(room.data[offset + channel]! * (1 - blend) + edited[offset + channel]! * blend);
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
}
