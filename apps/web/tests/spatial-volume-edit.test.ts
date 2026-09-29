import { beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import sharp from "sharp";
import { projectSpatialBox } from "@lili/geometry";
import {
  assembleSpatialVolumeEdit,
  prepareSpatialVolumeEdit,
  type SpatialVolumeEditInput,
} from "../lib/server/spatial-volume-edit";
import {
  planVolumeCrop,
  validateVolumeTransform,
  validateVolumePolygon,
  volumeFootprintOnSupport,
  volumeMaskBounds,
  volumeModelProtection,
  volumeToFrame,
  volumeToModel,
  volumeUncertaintyAxis,
} from "../lib/server/spatial-volume-geometry";

const rect = (x: number, y: number, width: number, height: number) => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];
const width = 800,
  height = 600;
let room: Buffer;
beforeAll(async () => {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = i % 251;
    rgb[i * 3 + 1] = Math.floor(i / width) % 251;
    rgb[i * 3 + 2] = 121;
  }
  room = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
});
function fixture(): SpatialVolumeEditInput {
  const camera = {
    width,
    height,
    focalPx: width * 0.7,
    heightAboveSupportCm: 150,
    pitchDownDegrees: 12,
  };
  const dimensions = {
    widthCm: 26,
    heightCm: 30,
    depthCm: 25,
    unit: "cm" as const,
  };
  const contact = { x: 0.6, y: 0.75 },
    yawDegrees = 40;
  const projection = projectSpatialBox(
    camera,
    { x: contact.x * width, y: contact.y * height },
    dimensions,
    yawDegrees,
  );
  const boundary = rect(0, 0.3, 1, 0.7);
  return {
    room,
    solidBase: true,
    product: {
      version: 1,
      fingerprint: "product-one",
      productId: "product-id",
      dimensions,
      measurementConvention: "Complete envelope including rim",
      dimensionSource: "catalog",
      shape: "volume",
      supports: ["floor"],
      characteristicParts: ["open rim", "woven walls"],
      references: [
        { assetId: "asset-one", view: "three-quarter", supplied: true },
      ],
      limitations: [],
    },
    scene: {
      version: 1,
      fingerprint: "scene-one",
      camera,
      transform: {
        offsetX: 0,
        offsetY: 0,
        paddedWidth: width,
        paddedHeight: height,
      },
      support: "floor",
      supportBoundary: boundary,
      supportHoles: [],
      observations: [],
      calibration: "approximate",
      cameraUncertainty: {
        source: "model_estimate_not_statistical",
        focalLengthInImageWidths: [0.65, 0.75],
        heightAboveSupportCm: [140, 160],
        pitchDownDegrees: [10, 14],
      },
    },
    plan: {
      version: 1,
      productFingerprint: "product-one",
      sceneFingerprint: "scene-one",
      contact,
      origin: projection.origin,
      projectedCorners: projection.points,
      yawDegrees,
      calibration: "approximate",
      assumptions: [],
      interactionPolicy: "volume-and-contact-v1",
    },
    support: { boundary, holes: [], obstacles: [] },
    reflectiveRegions: [],
  };
}
const rawMask = async (b: Buffer) =>
  sharp(b).toColourspace("b-w").raw().toBuffer();

it("retains extrema and nominal for every uncertainty axis without a hardcoded scenario count", () => {
  expect(volumeUncertaintyAxis([0.43, 0.75], 0.55, true)).toHaveLength(9);
  expect(volumeUncertaintyAxis([95, 220], 150, true)).toHaveLength(10);
  expect(volumeUncertaintyAxis([0, 9], 4.8, false)).toHaveLength(10);
  expect(volumeUncertaintyAxis([150, 150], 150, true)).toEqual([150]);
  expect(() => volumeUncertaintyAxis([2, 1], 1.5, true)).toThrow();
  expect(() => volumeUncertaintyAxis([0, 1], 0.5, true)).toThrow();
  expect(() => volumeUncertaintyAxis([1, 2], 3, true)).toThrow();
});
it("roundtrips crop coordinates, keeps one scale and protects all padding", () => {
  const t = planVolumeCrop(
    300,
    200,
    { left: 95, top: 70, right: 205, bottom: 180 },
    { left: 100, top: 75, right: 200, bottom: 175 },
  );
  expect(t.window).toEqual({ left: -106, top: -156, width: 512, height: 512 });
  const p = { x: 133.41, y: 147.83 };
  expect(volumeToFrame(volumeToModel(p, t), t).x).toBeCloseTo(p.x, 12);
  expect(volumeToFrame(volumeToModel(p, t), t).y).toBeCloseTo(p.y, 12);
  const authorized = Buffer.alloc(300 * 200, 255),
    mask = volumeModelProtection(authorized, t);
  let editable = 0;
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const p = volumeToFrame({ x: x + 0.5, y: y + 0.5 }, t);
      const expected = p.x >= 0 && p.x < 300 && p.y >= 0 && p.y < 200 ? 0 : 255;
      if (mask[(y * 1024 + x) * 4 + 3] !== expected)
        throw new Error("Unprotected crop padding or changed valid pixel");
      if (!expected) editable++;
    }
  expect(editable).toBe(300 * 200 * 4);
});
it("refuses a crop that would require shrinking or altered transform padding", () => {
  expect(() =>
    planVolumeCrop(
      3000,
      2000,
      { left: 10, top: 10, right: 2400, bottom: 1300 },
      { left: 20, top: 20, right: 2000, bottom: 1200 },
    ),
  ).toThrow(/shrinking/);
  const t = planVolumeCrop(
    800,
    600,
    { left: 400, top: 250, right: 500, bottom: 400 },
    { left: 410, top: 260, right: 490, bottom: 390 },
  );
  expect(() =>
    validateVolumeTransform({ ...t, scale: t.scale + 0.001 }),
  ).toThrow();
  expect(() =>
    validateVolumeTransform({ ...t, padding: { ...t.padding, left: 1 } }),
  ).toThrow();
  expect(() => volumeMaskBounds(Buffer.from([0, 1, 0, 255]), 2, 2)).toThrow(
    /binary/,
  );
});
it("rejects degenerate, crossing and touching support boundaries", () => {
  expect(() =>
    validateVolumePolygon([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]),
  ).toThrow();
  expect(
    volumeFootprintOnSupport(rect(0.1, 0.1, 0.2, 0.2), rect(0, 0, 1, 1), []),
  ).toBe(true);
  expect(
    volumeFootprintOnSupport(rect(0, 0.1, 0.2, 0.2), rect(0, 0, 1, 1), []),
  ).toBe(false);
  expect(
    volumeFootprintOnSupport(rect(0.1, 0.1, 0.4, 0.4), rect(0, 0, 1, 1), [
      rect(0.2, 0.2, 0.1, 0.1),
    ]),
  ).toBe(false);
});
it("prepares generic immutable nominal geometry, encoded durable masks and distinct extraction authorization", async () => {
  const input = fixture(),
    old = JSON.stringify({
      scene: input.scene,
      product: input.product,
      plan: input.plan,
    });
  const result = await prepareSpatialVolumeEdit(input);
  expect(
    JSON.stringify({
      scene: input.scene,
      product: input.product,
      plan: input.plan,
    }),
  ).toBe(old);
  expect(result.metadata).toMatchObject({
    policy: "spatial-volume-local-proxy-v1",
    hypothesesCount: 729,
    metricVerified: false,
    continuousRangeGuaranteed: false,
    statisticalConfidenceInterval: false,
    candidateOrAlphaUsedForSizing: false,
  });
  expect(result.metadata.projectedCorners).toEqual(input.plan.projectedCorners);
  expect(result.metadata.visibleFaces).toHaveLength(3);
  for (const key of [
    "objectRegion",
    "contactRegion",
    "freeSupport",
    "protectedRegion",
    "nominalObjectRegion",
  ] as const) {
    const metadata = await sharp(result[key]).metadata();
    expect(metadata).toMatchObject({
      format: "png",
      width,
      height,
      channels: 1,
      hasAlpha: false,
    });
    const decoded = await rawMask(result[key]);
    expect([...new Set(decoded)].every((v) => v === 0 || v === 255)).toBe(true);
    // A durable image roundtrip can decode all masks directly; raw buffers cannot pass this.
    const decodedAgain = await sharp(
      Buffer.from(result[key].toString("base64"), "base64"),
    )
      .raw()
      .toBuffer();
    expect(decodedAgain.equals(await sharp(result[key]).raw().toBuffer())).toBe(
      true,
    );
  }
  const [object, nominal, contact, free, protectedMask] = await Promise.all(
    [
      result.objectRegion,
      result.nominalObjectRegion,
      result.contactRegion,
      result.freeSupport,
      result.protectedRegion,
    ].map(rawMask),
  );
  expect(object!.filter(Boolean).length).toBeGreaterThan(
    nominal!.filter(Boolean).length,
  );
  expect(
    contact!.every(
      (v, i) =>
        !v || (free![i] === 255 && object![i] === 0 && protectedMask![i] === 0),
    ),
  ).toBe(true);
  expect(nominal!.every((v, i) => !v || object![i] === 255)).toBe(true);
  expect(await sharp(result.apiMask).metadata()).toMatchObject({
    width: 1024,
    height: 1024,
    channels: 4,
    hasAlpha: true,
  });
  expect(result.prompt).toContain("ALREADY applied");
  expect(result.prompt).toContain("Never rotate the camera or apply yaw twice");
  expect(result.prompt).toContain('["open rim","woven walls"]');
  expect(JSON.parse(JSON.stringify(result.metadata))).toEqual(result.metadata);
}, 20000);
it("creates opaque three-color proxy faces and never writes protected crop pixels", async () => {
  const result = await prepareSpatialVolumeEdit(fixture());
  const rgb = await sharp(result.composition).removeAlpha().raw().toBuffer();
  const counts = new Map([
    ["210,204,194", 0],
    ["155,150,141", 0],
    ["182,175,164", 0],
  ]);
  for (let i = 0; i < rgb.length; i += 3) {
    const key = `${rgb[i]},${rgb[i + 1]},${rgb[i + 2]}`;
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  expect([...counts.values()].every((v) => v > 100)).toBe(true);
  expect(result.metadata.proxyPixels).toBeGreaterThan(1000);
}, 20000);
it.each(["missing", "unordered", "outside", "nonpositive"])(
  "refuses %s uncertainty before producing an edit",
  async (kind) => {
    const input = fixture();
    if (kind === "missing") delete input.scene.cameraUncertainty;
    if (kind === "unordered")
      input.scene.cameraUncertainty!.focalLengthInImageWidths = [0.8, 0.6];
    if (kind === "outside")
      input.scene.cameraUncertainty!.heightAboveSupportCm = [160, 170];
    if (kind === "nonpositive")
      input.scene.cameraUncertainty!.heightAboveSupportCm = [-10, 160];
    await expect(prepareSpatialVolumeEdit(input)).rejects.toThrow(
      /uncertainty/,
    );
  },
);
it("refuses a single invalid camera hypothesis without dropping it from the grid", async () => {
  const input = fixture();
  input.scene.cameraUncertainty!.heightAboveSupportCm = [20, 160];
  await expect(prepareSpatialVolumeEdit(input)).rejects.toThrow(
    /frame|project|support/,
  );
});
it("refuses rooms outside the matting grid limit before image preparation", async () => {
  const input = fixture();
  input.scene.camera.width = 2049;
  await expect(prepareSpatialVolumeEdit(input)).rejects.toThrow(/2048/);
});
it.each(["obstacle", "reflection", "hole"])(
  "refuses %s overlap including a margin-only collision",
  async (kind) => {
    const input = fixture();
    input.scene.cameraUncertainty = {
      source: "model_estimate_not_statistical",
      focalLengthInImageWidths: [0.7, 0.7],
      heightAboveSupportCm: [150, 150],
      pitchDownDegrees: [12, 12],
    };
    const corners = input.plan.projectedCorners;
    const rightmost = corners.reduce((best, p) => (p.x > best.x ? p : best));
    // Starts one pixel beyond a corner: nominal outline is clear but its >= 2px margin is not.
    const polygon = rect(
      (rightmost.x + 1) / width,
      (rightmost.y - 1) / height,
      1 / width,
      2 / height,
    );
    if (kind === "obstacle") input.support.obstacles.push(polygon);
    if (kind === "reflection") input.reflectiveRegions.push(polygon);
    if (kind === "hole") input.support.holes.push(polygon);
    await expect(prepareSpatialVolumeEdit(input)).rejects.toThrow(
      /Expanded uncertain volume/,
    );
  },
);
it("refuses disappeared support exclusions, plan drift, non-volume and missing full-base declaration", async () => {
  const input = fixture();
  input.scene.supportHoles = [rect(0.1, 0.6, 0.1, 0.1)];
  await expect(prepareSpatialVolumeEdit(input)).rejects.toThrow(/exclusion/);
  const drift = fixture();
  drift.plan.projectedCorners[0]!.x += 0.01;
  await expect(prepareSpatialVolumeEdit(drift)).rejects.toThrow(
    /geometry changed/,
  );
  const flat = fixture();
  flat.product.shape = "plane";
  await expect(prepareSpatialVolumeEdit(flat)).rejects.toThrow(/full-base/);
  const undeclared = fixture();
  delete (undeclared as Partial<SpatialVolumeEditInput>).solidBase;
  await expect(prepareSpatialVolumeEdit(undeclared)).rejects.toThrow(
    /full-base/,
  );
});
it("refuses unsupported two-face geometry instead of inventing a hidden face", async () => {
  const input = fixture();
  input.plan.yawDegrees = 0;
  input.plan.contact.x = 0.5;
  const projection = projectSpatialBox(
    input.scene.camera,
    { x: width * 0.5, y: height * input.plan.contact.y },
    input.product.dimensions,
    0,
  );
  input.plan.origin = projection.origin;
  input.plan.projectedCorners = projection.points;
  await expect(prepareSpatialVolumeEdit(input)).rejects.toThrow(
    /three visible faces/,
  );
});
it("assembles the entire patch uniformly and preserves every pixel outside its frozen window", async () => {
  const t = planVolumeCrop(
    width,
    height,
    { left: 400, top: 300, right: 510, bottom: 470 },
    { left: 410, top: 310, right: 500, bottom: 450 },
  );
  const generated = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#112233" },
  })
    .png()
    .toBuffer();
  const aligned = await assembleSpatialVolumeEdit({
    originalRoom: room,
    generated,
    transform: JSON.parse(JSON.stringify(t)),
  });
  const rgb = await sharp(aligned).raw().toBuffer(),
    original = await sharp(room).raw().toBuffer();
  let outside = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3,
        inside =
          x >= t.intersection.left &&
          x < t.intersection.left + t.intersection.width &&
          y >= t.intersection.top &&
          y < t.intersection.top + t.intersection.height;
      if (inside) {
        if (rgb[i] !== 17 || rgb[i + 1] !== 34 || rgb[i + 2] !== 51)
          throw new Error("Patch moved or fitted");
      } else {
        if (
          rgb[i] !== original[i] ||
          rgb[i + 1] !== original[i + 1] ||
          rgb[i + 2] !== original[i + 2]
        )
          throw new Error("Original pixels changed");
        outside++;
      }
    }
  expect(outside).toBe(
    width * height - t.intersection.width * t.intersection.height,
  );
});
it("removes only fixed padding on assembly and refuses wrong-size or transparent generated data", async () => {
  const t = planVolumeCrop(
    300,
    200,
    { left: 95, top: 70, right: 205, bottom: 180 },
    { left: 100, top: 75, right: 200, bottom: 175 },
  );
  const smallRoom = await sharp({
    create: { width: 300, height: 200, channels: 3, background: "#445566" },
  })
    .png()
    .toBuffer();
  const generated = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  const aligned = await assembleSpatialVolumeEdit({
    originalRoom: smallRoom,
    generated,
    transform: t,
  });
  expect(await sharp(aligned).metadata()).toMatchObject({
    width: 300,
    height: 200,
    channels: 3,
  });
  const transparent = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  await expect(
    assembleSpatialVolumeEdit({
      originalRoom: smallRoom,
      generated: transparent,
      transform: t,
    }),
  ).rejects.toThrow(/opaque/);
  await expect(
    assembleSpatialVolumeEdit({
      originalRoom: smallRoom,
      generated: smallRoom,
      transform: t,
    }),
  ).rejects.toThrow(/geometry/);
});
