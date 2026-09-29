import sharp from "sharp";
import { dilateBinary, erodeBinary } from "./simple-composite";

/** A solid mirror can reflect white without being transparent. Only use this
 * for an explicitly identified mirror, never foliage, handles or chair legs. */
export async function fillMirrorInterior(mask: Buffer): Promise<Buffer> {
  const metadata = await sharp(mask, {
    limitInputPixels: 2048 ** 2,
  }).metadata();
  if (metadata.format !== "png" || metadata.hasAlpha)
    throw new Error("Invalid matting mask format");
  const { data, info } = await sharp(mask)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width,
    height = info.height;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++)
    alpha[i] = data[i * info.channels]! >= 128 ? 1 : 0;
  const closed = erodeBinary(
    dilateBinary(alpha, width, height, 1),
    width,
    height,
    1,
  );
  const outside = new Uint8Array(alpha.length),
    queue = new Int32Array(alpha.length);
  let head = 0,
    tail = 0;
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (outside[i] || closed[i]) return;
    outside[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    add(0, y);
    add(width - 1, y);
  }
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width,
      y = Math.floor(i / width);
    add(x - 1, y);
    add(x + 1, y);
    add(x, y - 1);
    add(x, y + 1);
  }
  // Restore partially transparent glass too. Keep the outer anti-aliased
  // boundary; filling only fully transparent holes leaves a visible seam.
  const solid = Uint8Array.from(outside, (value) => (value ? 0 : 1));
  const interior = erodeBinary(solid, width, height, 1);
  const repaired = Buffer.alloc(alpha.length);
  for (let i = 0; i < alpha.length; i++)
    repaired[i] = interior[i] ? 255 : data[i * info.channels]!;
  return sharp(repaired, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

/** Two large disconnected subjects separated by a broad empty gap cannot
 * serve as the silhouette of one object. Tiny leaves/cords are not subjects. */
export async function hasSeparatedSubjects(image: Buffer): Promise<boolean> {
  const { data, info } = await sharp(image)
    .resize({
      width: 512,
      height: 512,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width,
    height = info.height,
    count = width * height;
  const seen = new Uint8Array(count),
    queue = new Int32Array(count);
  const parts: Array<{
    size: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }> = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (seen[i] || data[i * 4 + 3]! < 128) continue;
    let head = 0,
      tail = 1,
      size = 0,
      left = width,
      right = 0,
      top = height,
      bottom = 0;
    queue[0] = i;
    seen[i] = 1;
    while (head < tail) {
      const at = queue[head++]!,
        x = at % width,
        y = Math.floor(at / width);
      size++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (seen[next] || data[next * 4 + 3]! < 128) continue;
          seen[next] = 1;
          queue[tail++] = next;
        }
    }
    total += size;
    parts.push({ size, left, right, top, bottom });
  }
  const large = parts.filter((p) => p.size >= total * 0.18);
  return large.some((a, i) =>
    large
      .slice(i + 1)
      .some(
        (b) =>
          Math.max(a.left - b.right, b.left - a.right) > width * 0.12 ||
          Math.max(a.top - b.bottom, b.top - a.bottom) > height * 0.12,
      ),
  );
}
