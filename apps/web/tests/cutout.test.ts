import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// `assets.ts` is a server module; the marker package is not installed for the
// test runner.
vi.mock("server-only", () => ({}));

import { prepareCutout } from "../lib/server/assets";

const SIZE = 400;

/** Renders an SVG and flattens it so the fixture reaches the cutout opaque. */
async function render(body: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${body}</svg>`;
  return sharp(Buffer.from(svg))
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

const whiteBackdrop = `<rect width="${SIZE}" height="${SIZE}" fill="rgb(255,255,255)"/>`;

/** Light grey product on white: the case the old flood fill used to eat. */
function greyDisc(): Promise<Buffer> {
  return render(
    `${whiteBackdrop}<circle cx="200" cy="200" r="170" fill="rgb(200,200,200)"/>`,
  );
}

/** Product plus the contact shadow it casts on the shooting surface. */
function discWithContactShadow(): Promise<Buffer> {
  return render(
    `${whiteBackdrop}<ellipse cx="200" cy="170" rx="120" ry="90" fill="rgb(200,200,200)"/><rect x="110" y="266" width="180" height="22" fill="rgb(150,150,150)"/>`,
  );
}

/** Disc plus a ~0.09 % speck in the corner (a price label, dust, a logo). */
function discWithIsland(): Promise<Buffer> {
  return render(
    `${whiteBackdrop}<circle cx="200" cy="200" r="170" fill="rgb(200,200,200)"/><rect x="0" y="0" width="12" height="12" fill="rgb(120,120,120)"/>`,
  );
}

/** Ring: the hole is real background enclosed by the silhouette. */
function annulus(): Promise<Buffer> {
  return render(
    `${whiteBackdrop}<circle cx="200" cy="200" r="115" fill="none" stroke="rgb(60,120,200)" stroke-width="70"/>`,
  );
}

/** Dark product with a specular highlight: must not read as a hole. */
function darkDiscWithHighlight(): Promise<Buffer> {
  return render(
    `${whiteBackdrop}<circle cx="200" cy="200" r="150" fill="rgb(35,35,50)"/><circle cx="160" cy="155" r="12" fill="rgb(255,255,255)"/>`,
  );
}

/** Saturated dark product: its anti-aliased edge must not keep a pale fringe. */
function navyDisc(): Promise<Buffer> {
  return render(
    `${whiteBackdrop}<circle cx="200" cy="200" r="150" fill="rgb(20,20,110)"/>`,
  );
}

/** Gentle radial vignette: removable, but only into a very soft matte. */
function radialGradientBackground(): Promise<Buffer> {
  return render(
    `<defs><radialGradient id="v" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="rgb(255,255,255)"/><stop offset="100%" stop-color="rgb(215,215,215)"/></radialGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#v)"/><circle cx="200" cy="200" r="60" fill="rgb(40,40,50)"/>`,
  );
}

/** Deterministic noise: a photo shot against a busy, textured background. */
async function noisePhoto(): Promise<Buffer> {
  const data = Buffer.alloc(SIZE * SIZE * 3);
  let seed = 20240827;
  for (let index = 0; index < data.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[index] = seed >>> 24;
  }
  return sharp(data, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .png()
    .toBuffer();
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

async function rawRgba(image: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function alphaAt(image: RawImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3] ?? 0;
}

describe("prepareCutout", () => {
  it("does not mistake a rounded photo's transparent corners for a product matte", async () => {
    const photo = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" rx="70" fill="white"/><circle cx="200" cy="200" r="90" fill="#14146e"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const result = await prepareCutout(photo);
    expect(result.widthPx).toBeLessThan(190);
    expect(result.heightPx).toBeLessThan(190);
    expect(result.quality.opaque).toBe(false);
    expect(result.quality.vanished).toBe(false);
    const image = await rawRgba(result.buffer);
    expect(
      alphaAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2)),
    ).toBe(255);
  });

  it("never cuts a grey base from an existing matte based on invisible white RGB", async () => {
    const rgba = Buffer.alloc(SIZE * SIZE * 4, 255);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const index = (y * SIZE + x) * 4;
        if (x < 120 || x >= 280 || y < 70 || y >= 330) {
          rgba[index + 3] = 0;
        } else {
          const colour = y >= 300 ? 150 : 35;
          rgba[index] = colour;
          rgba[index + 1] = colour;
          rgba[index + 2] = colour;
        }
      }
    }
    const matte = await sharp(rgba, {
      raw: { width: SIZE, height: SIZE, channels: 4 },
    })
      .png()
      .toBuffer();
    const result = await prepareCutout(matte);
    expect(result.shadowRemoved).toBe(false);
    expect(result.heightPx).toBe(260);
    expect(result.widthPx).toBe(160);
    expect(result.baseRowFraction).toBe(1);
    const image = await rawRgba(result.buffer);
    expect(alphaAt(image, 80, 255)).toBe(255);
    expect(image.data[(255 * 160 + 80) * 4]).toBe(150);
  });

  it("keeps a light grey product on white intact", async () => {
    const result = await prepareCutout(await greyDisc());
    const image = await rawRgba(result.buffer);

    const centerX = Math.floor(image.width / 2);
    const centerY = Math.floor(image.height / 2);
    expect(alphaAt(image, centerX, centerY)).toBe(255);
    expect(alphaAt(image, centerX - 60, centerY)).toBe(255);
    expect(alphaAt(image, centerX, centerY + 60)).toBe(255);

    expect(result.quality.hollowed).toBe(false);
    expect(result.quality.opaque).toBe(false);
    expect(result.quality.busyBackground).toBe(false);
    expect(result.needsModelIsolation).toBe(false);
    expect(result.baseRowFraction).toBeGreaterThan(0.9);
    expect(result.baseRowFraction).toBeLessThanOrEqual(1);
    // The disc, not the frame: the white background really was removed.
    expect(result.widthPx).toBeGreaterThan(330);
    expect(result.widthPx).toBeLessThan(350);
  });

  it("erases the contact shadow under the object", async () => {
    const result = await prepareCutout(await discWithContactShadow());

    expect(result.shadowRemoved).toBe(true);
    expect(result.quality.shadowBand).toBe(false);
    // The ellipse spans 180 rows, the ellipse plus its band 208.
    expect(result.heightPx).toBeGreaterThan(168);
    expect(result.heightPx).toBeLessThan(196);
    expect(result.baseRowFraction).toBeGreaterThan(0.9);
  });

  it("drops a speck in the corner and trims to the product", async () => {
    const clean = await prepareCutout(await greyDisc());
    const result = await prepareCutout(await discWithIsland());

    expect(result.widthPx).toBeLessThan(clean.widthPx + 6);
    expect(result.heightPx).toBeLessThan(clean.heightPx + 6);
    expect(result.widthPx).toBeGreaterThan(330);

    // Nothing survives where the island was.
    const image = await rawRgba(result.buffer);
    expect(alphaAt(image, 1, 1)).toBe(0);
    expect(alphaAt(image, 4, 4)).toBe(0);
  });

  it("reports the hole of a ring as enclosed background", async () => {
    const result = await prepareCutout(await annulus());

    expect(result.quality.enclosedBackground).toBe(true);
    expect(result.needsModelIsolation).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not mistake a specular highlight for a hole", async () => {
    const result = await prepareCutout(await darkDiscWithHighlight());

    expect(result.quality.enclosedBackground).toBe(false);
    expect(result.quality.busyBackground).toBe(false);
    expect(result.shadowRemoved).toBe(false);
  });

  it("decontaminates the anti-aliased edge of a dark product", async () => {
    const result = await prepareCutout(await navyDisc());
    const image = await rawRgba(result.buffer);

    const reds: number[] = [];
    const greens: number[] = [];
    for (let index = 0; index < image.width * image.height; index += 1) {
      const alpha = image.data[index * 4 + 3] ?? 0;
      if (alpha < 118 || alpha > 138) continue;
      reds.push(image.data[index * 4] ?? 0);
      greens.push(image.data[index * 4 + 1] ?? 0);
    }
    expect(reds.length).toBeGreaterThan(20);
    expect(Math.max(...reds)).toBeLessThan(80);
    expect(Math.max(...greens)).toBeLessThan(80);
  });

  it("refuses to flood fill a busy background and asks for the model", async () => {
    const result = await prepareCutout(await noisePhoto());

    expect(result.quality.busyBackground).toBe(true);
    expect(result.quality.opaque).toBe(true);
    expect(result.needsModelIsolation).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.widthPx).toBe(SIZE);
    expect(result.warnings).toContain(
      "Fond chargé : un détourage précis est nécessaire avant la mise en scène.",
    );
  });

  it("flags a gradient background as a ragged cutout", async () => {
    const result = await prepareCutout(await radialGradientBackground());

    expect(result.quality.busyBackground).toBe(false);
    expect(result.quality.ragged).toBe(true);
    expect(result.warnings).toContain(
      "Détourage imparfait : reprenez la photo sur un fond uni et bien éclairé.",
    );
  });
  it("does not call a perfectly cut rectangular product opaque", async () => {
    // A rug, a picture frame or a wardrobe is a solid rectangle once cropped
    // to its alpha bounds. Measuring transparency after the crop called every
    // one of them opaque and sent the merchant's real pixels to be redrawn by
    // a generative model. The measurement belongs on the full frame.
    const rectangle = await render(
      `${whiteBackdrop}<rect x="90" y="60" width="220" height="280" fill="rgb(40,70,150)"/>`,
    );
    const result = await prepareCutout(rectangle);

    expect(result.quality.opaque).toBe(false);
    expect(result.needsModelIsolation).toBe(false);
    // Cropped tight to the rectangle, so the cutout itself is fully opaque.
    expect(result.widthPx).toBeLessThanOrEqual(230);
    expect(result.heightPx).toBeLessThanOrEqual(290);
  });
  it("flags a product that vanished into its own background", async () => {
    // A near-white product on white: the flood fill reaches the whole frame
    // and nothing solid is left. Without a flag this shipped as "ready" and
    // the customer paid for a render of their empty room.
    const ghost = await render(
      `${whiteBackdrop}<circle cx="200" cy="200" r="120" fill="rgb(252,252,252)"/>`,
    );
    const result = await prepareCutout(ghost);

    expect(result.quality.vanished).toBe(true);
    expect(result.needsModelIsolation).toBe(true);
    expect(result.warnings).toContain(
      "L’objet se confond avec le fond de sa photo : reprenez-la sur un fond bien contrasté.",
    );
  });

  it("does not call a healthy cutout vanished", async () => {
    const result = await prepareCutout(await navyDisc());

    expect(result.quality.vanished).toBe(false);
    expect(result.needsModelIsolation).toBe(false);
  });
});
