import { expect, it, vi } from "vitest";
import sharp from "sharp";
import { projectPoint, solveHomography, type Quad } from "@lili/geometry";
vi.mock("server-only", () => ({}));
import { projectPlanarTexture } from "../lib/server/spatial-planar";
import { globalRoom } from "./fixtures/spatial-room";
const quad = (x: number, y: number, w: number, h: number): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
async function fixture() {
  const data = Buffer.alloc(32 * 32 * 4);
  const colours = [
    [240, 20, 30],
    [20, 230, 40],
    [30, 40, 220],
    [220, 200, 30],
  ];
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const offset = (y * 32 + x) * 4;
      const c = colours[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)]!;
      data.set([...c, 255], offset);
    }
  const texture = await sharp(data, {
    raw: { width: 32, height: 32, channels: 4 },
  })
    .png()
    .toBuffer();
  const room = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();
  return {
    version: "planar-texture-v2" as const,
    texture,
    room,
    sourceCorners: quad(0, 0, 32, 32),
    targetCorners: quad(30, 30, 32, 32),
    support: globalRoom.surfaces[0]!,
    colours,
  };
}
it.each(["planar-texture-v1", "planar-texture-v2"] as const)(
  "preserves original samples and outside pixels in an identity projection (%s)",
  async (version) => {
    const args = await fixture(),
      result = await projectPlanarTexture({ ...args, version });
    const output = await sharp(result.image).raw().toBuffer(),
      source = await sharp(args.texture).removeAlpha().raw().toBuffer();
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const actual = [
          ...output.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3),
        ];
        expect(actual).toEqual(
          x >= 30 && x < 62 && y >= 30 && y < 62
            ? [
                ...source.subarray(
                  ((y - 30) * 32 + x - 30) * 3,
                  ((y - 30) * 32 + x - 30) * 3 + 3,
                ),
              ]
            : [10, 20, 30],
        );
      }
    expect(result.evidence.qualification).toBe("geometry-only");
  },
);

async function stripes(
  width: number,
  height: number,
  phase = 0,
  alpha = false,
) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dark = (x + phase) % 8 < 3;
      data.set(
        alpha
          ? dark
            ? [255, 0, 0, 255]
            : [0, 0, 255, 0]
          : [dark ? 0 : 255, dark ? 0 : 255, dark ? 0 : 255, 255],
        (y * width + x) * 4,
      );
    }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

it.each([0, 1, 3, 7])(
  "preserves the fine pattern mean under 8x reduction, phase %s",
  async (phase) => {
    const args = {
      ...(await fixture()),
      texture: await stripes(256, 256, phase),
      sourceCorners: quad(0, 0, 256, 256),
    };
    const result = await projectPlanarTexture(args),
      pixels = await sharp(result.image).raw().toBuffer();
    for (let y = 30; y < 62; y++)
      for (let x = 30; x < 62; x++) {
        const offset = (y * 100 + x) * 3;
        expect([...pixels.subarray(offset, offset + 3)]).toEqual([
          159, 159, 159,
        ]);
      }
    expect(result.evidence).toMatchObject({
      version: "planar-texture-v2",
      filteredPixels: 1024,
    });
    if (phase === 0) {
      const historical = await projectPlanarTexture({
        ...args,
        version: "planar-texture-v1",
      });
      expect(
        (await sharp(historical.image).raw().toBuffer())[(46 * 100 + 46) * 3],
      ).toBe(255);
    }
  },
);

it("averages strong reductions without bleeding hidden transparent colours", async () => {
  const args = {
    ...(await fixture()),
    texture: await stripes(256, 256, 0, true),
    sourceCorners: quad(0, 0, 256, 256),
    targetCorners: quad(30, 30, 16, 16),
  };
  const result = await projectPlanarTexture(args),
    pixels = await sharp(result.image).raw().toBuffer(),
    mask = await sharp(result.mask).greyscale().raw().toBuffer();
  for (let y = 30; y < 46; y++)
    for (let x = 30; x < 46; x++) {
      const offset = (y * 100 + x) * 3;
      for (const [channel, expected] of [101.875, 12.5, 18.75].entries())
        expect(
          Math.abs(pixels[offset + channel]! - expected),
        ).toBeLessThanOrEqual(0.50001);
      expect(mask[y * 100 + x]).toBe(96);
    }
});

it("keeps detail on the unreduced axis while filtering the reduced axis", async () => {
  const data = Buffer.alloc(256 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 256; x++)
      data.set(
        [x % 8 < 3 ? 0 : 255, y % 2 ? 230 : 20, 70, 255],
        (y * 256 + x) * 4,
      );
  const texture = await sharp(data, {
    raw: { width: 256, height: 32, channels: 4 },
  })
    .png()
    .toBuffer();
  const result = await projectPlanarTexture({
    ...(await fixture()),
    texture,
    sourceCorners: quad(0, 0, 256, 32),
  });
  const pixels = await sharp(result.image).raw().toBuffer();
  for (let y = 30; y < 62; y++)
    expect([
      ...pixels.subarray((y * 100 + 46) * 3, (y * 100 + 46) * 3 + 3),
    ]).toEqual([159, y % 2 ? 230 : 20, 70]);
});

it("excludes the catalogue background at fractional crop borders during reduction", async () => {
  const data = Buffer.alloc(259 * 257 * 4);
  for (let y = 0; y < 257; y++)
    for (let x = 0; x < 259; x++)
      data.set(
        x >= 16 && x < 244 && y >= 16 && y < 242
          ? [200, 40, 10, 255]
          : [0, 0, 255, 255],
        (y * 259 + x) * 4,
      );
  const texture = await sharp(data, {
    raw: { width: 259, height: 257, channels: 4 },
  })
    .png()
    .toBuffer();
  const result = await projectPlanarTexture({
    ...(await fixture()),
    texture,
    sourceCorners: quad(16.25, 16.25, 227.5, 225.5),
    targetCorners: [
      { x: 45, y: 25 },
      { x: 61, y: 30 },
      { x: 55, y: 57 },
      { x: 27, y: 54 },
    ],
  });
  const pixels = await sharp(result.image).raw().toBuffer(),
    mask = await sharp(result.mask).greyscale().raw().toBuffer();
  for (let i = 0; i < 10000; i++)
    expect([...pixels.subarray(i * 3, i * 3 + 3)]).toEqual(
      mask[i] ? [200, 40, 10] : [10, 20, 30],
    );
});

it("agrees with dense independent destination sampling for an oblique perspective reduction", async () => {
  const targetCorners: Quad = [
    { x: 44, y: 22 },
    { x: 68, y: 34 },
    { x: 72, y: 73 },
    { x: 21, y: 59 },
  ];
  const sourceCorners = quad(0, 0, 256, 256);
  const result = await projectPlanarTexture({
    ...(await fixture()),
    texture: await stripes(256, 256),
    sourceCorners,
    targetCorners,
  });
  const pixels = await sharp(result.image).raw().toBuffer();
  const inverse = solveHomography(targetCorners, sourceCorners);
  // Independent oracle: average 4096 equally spaced destination subpixels,
  // not the production polygon clipping, block sums or source-area weights.
  for (let y = 37; y <= 55; y += 3)
    for (let x = 43; x <= 58; x += 3) {
      let sum = 0;
      for (let sy = 0; sy < 64; sy++)
        for (let sx = 0; sx < 64; sx++) {
          const p = projectPoint(inverse, {
            x: x + (sx + 0.5) / 64,
            y: y + (sy + 0.5) / 64,
          });
          sum += Math.floor(p.x) % 8 < 3 ? 0 : 255;
        }
      expect(Math.abs(pixels[(y * 100 + x) * 3]! - sum / 4096)).toBeLessThan(3);
    }
});
it("keeps the four asymmetric motif regions in order under perspective", async () => {
  const args = await fixture();
  args.targetCorners = [
    { x: 35, y: 20 },
    { x: 65, y: 20 },
    { x: 85, y: 80 },
    { x: 15, y: 80 },
  ];
  const result = await projectPlanarTexture(args),
    output = await sharp(result.image).raw().toBuffer();
  const matrix = solveHomography(args.sourceCorners, args.targetCorners);
  for (const [i, p] of [
    { x: 8, y: 8 },
    { x: 24, y: 8 },
    { x: 8, y: 24 },
    { x: 24, y: 24 },
  ].entries()) {
    const mapped = projectPoint(matrix, p),
      offset = (Math.floor(mapped.y) * 100 + Math.floor(mapped.x)) * 3;
    expect([...output.subarray(offset, offset + 3)]).toEqual(args.colours[i]);
  }
});
it("refuses mirrored/bow-tie corners, frame overflow and holes fully covered by the rug", async () => {
  const args = await fixture();
  await expect(
    projectPlanarTexture({
      ...args,
      sourceCorners: [...args.sourceCorners].reverse() as unknown as Quad,
    }),
  ).rejects.toThrow(/miroir/);
  await expect(
    projectPlanarTexture({ ...args, targetCorners: quad(90, 90, 32, 32) }),
  ).rejects.toThrow(/hors image/);
  await expect(
    projectPlanarTexture({
      ...args,
      support: { ...args.support, holes: [[...quad(0.4, 0.4, 0.05, 0.05)]] },
    }),
  ).rejects.toThrow(/obstacle/);
  await expect(
    projectPlanarTexture({
      ...args,
      reflectiveRegions: [[...quad(0.4, 0.4, 0.05, 0.05)]],
    }),
  ).rejects.toThrow(/réfléchissante/);
});
it("keeps room pixels visible through transparent texture", async () => {
  const args = await fixture();
  args.texture = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  await expect(projectPlanarTexture(args)).rejects.toThrow(/vide/);
});
it("does not sample the source background outside the declared four corners", async () => {
  const args = await fixture(),
    data = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      data.set(
        x >= 8 && x < 24 && y >= 8 && y < 24
          ? [255, 0, 0, 255]
          : [0, 0, 255, 255],
        (y * 32 + x) * 4,
      );
  args.texture = await sharp(data, {
    raw: { width: 32, height: 32, channels: 4 },
  })
    .png()
    .toBuffer();
  args.sourceCorners = quad(8.25, 8.25, 15.5, 15.5);
  const result = await projectPlanarTexture(args),
    pixels = await sharp(result.image).raw().toBuffer();
  for (let y = 30; y < 62; y++)
    for (let x = 30; x < 62; x++)
      expect([
        ...pixels.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3),
      ]).toEqual([255, 0, 0]);
});
