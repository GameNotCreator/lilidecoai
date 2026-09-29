import { expect, it } from "vitest";
import { inspectSpatialBackgroundSeam } from "../lib/server/spatial-background-seam";

function fixture() {
  const width = 100,
    height = 100;
  const original = Buffer.alloc(width * height * 3, 180);
  const maskRaw = Buffer.alloc(width * height * 4, 255);
  for (let y = 20; y < 80; y++)
    for (let x = 20; x < 80; x++) maskRaw[(y * width + x) * 4 + 3] = 0;
  return { width, height, original, generated: Buffer.from(original), maskRaw };
}
it("rejects a broad smooth colour residual revealed by hard restoration", () => {
  const input = fixture();
  input.generated.fill(164);
  expect(inspectSpatialBackgroundSeam(input)).toMatchObject({
    status: "rejected",
    affectedFraction: 1,
  });
  expect(
    inspectSpatialBackgroundSeam(input).largestConnectedBoundary,
  ).toBeGreaterThan(100);
});
it("does not infer acceptance from an unchanged background or small encoding noise", () => {
  const input = fixture();
  expect(inspectSpatialBackgroundSeam(input).status).toBe("not-detected");
  for (let i = 0; i < input.generated.length; i++)
    input.generated[i] = 180 + (i % 7) - 3;
  expect(inspectSpatialBackgroundSeam(input).status).toBe("not-detected");
});
it("excludes a sharp product contour at the boundary and preserves an interior object", () => {
  const input = fixture();
  for (let y = 25; y < 75; y++)
    for (let x = 20; x < 60; x++)
      input.generated.set([190, 70, 30], (y * input.width + x) * 3);
  expect(inspectSpatialBackgroundSeam(input)).toMatchObject({
    status: "not-detected",
    affectedPixels: 0,
  });
});
it("detects seams at protected holes as well as the outer boundary", () => {
  const input = fixture();
  // Only a protected island has a residual; the outer edit boundary matches.
  for (let y = 30; y < 70; y++)
    for (let x = 30; x < 70; x++)
      input.generated.fill(150, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
  for (let y = 35; y < 65; y++)
    for (let x = 35; x < 65; x++) input.maskRaw[(y * 100 + x) * 4 + 3] = 255;
  expect(inspectSpatialBackgroundSeam(input).status).toBe("rejected");
});
it("requires a connected boundary rather than isolated changed pixels", () => {
  const input = fixture();
  for (let y = 18; y <= 22; y++)
    for (let x = 40; x <= 44; x++)
      input.generated.fill(150, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
  expect(inspectSpatialBackgroundSeam(input).status).toBe("not-detected");
});
it("reports missing evidence without approving a frame-wide edit", () => {
  const input = fixture();
  for (let i = 0; i < 10000; i++) input.maskRaw[i * 4 + 3] = 0;
  input.generated.fill(150);
  expect(inspectSpatialBackgroundSeam(input)).toMatchObject({
    status: "insufficient-evidence",
    eligiblePixels: 0,
  });
});
it("refuses inconsistent buffers", () => {
  expect(() =>
    inspectSpatialBackgroundSeam({ ...fixture(), generated: Buffer.alloc(1) }),
  ).toThrow(/inputs/);
});
