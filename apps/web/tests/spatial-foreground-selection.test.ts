import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { selectSpatialForeground } from "../lib/server/spatial-foreground-selection";

function fixture() {
  const width = 16,
    height = 12,
    alpha = Buffer.alloc(width * height);
  const projectedRegion = Buffer.alloc(alpha.length),
    authorization = Buffer.alloc(alpha.length, 255);
  for (let y = 3; y < 8; y++)
    for (let x = 2; x < 6; x++) {
      alpha[y * width + x] = 254;
      projectedRegion[y * width + x] = 255;
    }
  // Larger unrelated furniture, disconnected and wholly outside the projection.
  for (let y = 1; y < 11; y++)
    for (let x = 11; x < 16; x++) alpha[y * width + x] = 255;
  return { width, height, alpha, projectedRegion, authorization };
}
function run(input: ReturnType<typeof fixture>) {
  return selectSpatialForeground({
    ...input,
    alphaFingerprint: createHash("sha256").update(input.alpha).digest("hex"),
  });
}
describe("experimental foreground component selection", () => {
  it("selects the projected component rather than the largest, keeps holes and exact alpha, and does not mutate inputs", () => {
    const input = fixture();
    input.alpha[5 * input.width + 3] = 0;
    const before = structuredClone(input),
      result = run(input);
    expect(structuredClone(input)).toEqual(before);
    expect(result.evidence).toMatchObject({
      status: "selected",
      qualification: "not-qualified",
      discardedPixels: 50,
      interactionBlockers: ["unreviewed-foreground-selection"],
    });
    for (let i = 0; i < input.alpha.length; i++)
      expect(result.alpha![i]).toBe(i % input.width >= 11 ? 0 : input.alpha[i]);
  });
  it("keeps diagonal one-alpha details and detached weak fragments, including outside the projected volume", () => {
    const input = fixture();
    input.alpha[8 * input.width + 6] = 1;
    input.alpha[9 * input.width + 7] = 17;
    input.alpha[1 * input.width + 7] = 3;
    const result = run(input);
    expect(result.evidence.status).toBe("selected");
    expect(result.alpha![8 * input.width + 6]).toBe(1);
    expect(result.alpha![9 * input.width + 7]).toBe(17);
    expect(result.alpha![input.width + 7]).toBe(3);
  });
  it("never cuts even a one-alpha bridge to erase furniture or a cable reaching the crop", () => {
    const input = fixture();
    for (let x = 6; x <= 11; x++) input.alpha[5 * input.width + x] = 1;
    const result = run(input);
    expect(result.alpha).toBeNull();
    expect(result.evidence.reasons).toContain(
      "retained-foreground-touches-crop-edge",
    );
  });
  it("refuses multiple projected components instead of discarding a detached product part", () => {
    const input = fixture();
    input.projectedRegion[5 * input.width + 12] = 255;
    expect(run(input)).toMatchObject({
      alpha: null,
      evidence: {
        status: "blocked",
        reasons: ["ambiguous-projected-components"],
      },
    });
  });
  it("can select a hollow chair with an empty projection centre without guessing another seed", () => {
    const input = fixture();
    input.alpha[5 * input.width + 3] = 0;
    expect(run(input).evidence.status).toBe("selected");
  });
  it("refuses a weak fragment at the frame rather than silently deleting it", () => {
    const input = fixture();
    input.alpha[0] = 1;
    expect(run(input).evidence.reasons).toContain(
      "retained-foreground-touches-crop-edge",
    );
  });
  it("refuses selected opaque foreground outside authorization before clipping", () => {
    const input = fixture();
    input.authorization[4 * input.width + 3] = 0;
    const result = run(input);
    expect(result.alpha).toBeNull();
    expect(result.evidence.reasons).toContain(
      "retained-opaque-foreground-outside-authorization",
    );
  });
  it("does not invent adjacency by wrapping between rows", () => {
    const width = 4,
      height = 4,
      alpha = Buffer.alloc(16),
      projectedRegion = Buffer.alloc(16),
      authorization = Buffer.alloc(16, 255);
    alpha[3] = 255;
    alpha[4] = 255;
    projectedRegion[3] = 255;
    projectedRegion[4] = 255;
    const result = run({
      width,
      height,
      alpha,
      projectedRegion,
      authorization,
    });
    expect(result.evidence.components).toHaveLength(2);
    expect(result.evidence.reasons).toEqual(["ambiguous-projected-components"]);
  });
  it.each(["empty-mask", "empty-region", "only-weak"])(
    "refuses %s without an arbitrary fallback",
    (scenario) => {
      const input = fixture();
      if (scenario === "empty-mask") input.alpha.fill(0);
      if (scenario === "empty-region") input.projectedRegion.fill(0);
      if (scenario === "only-weak") input.alpha.fill(1);
      expect(run(input)).toMatchObject({
        alpha: null,
        evidence: { reasons: ["no-strong-projected-component"] },
      });
    },
  );
  it.each([
    "fractional-grid",
    "oversized-grid",
    "mask-length",
    "soft-region",
    "soft-authorization",
  ])("rejects %s", (scenario) => {
    const input = fixture();
    if (scenario === "fractional-grid") input.width = 1.5;
    if (scenario === "oversized-grid") input.width = 4_000_001;
    if (scenario === "mask-length") input.alpha = Buffer.alloc(1);
    if (scenario === "soft-region") input.projectedRegion[0] = 1;
    if (scenario === "soft-authorization") input.authorization[0] = 1;
    expect(() => run(input)).toThrow(/Invalid foreground/);
  });
  it("rejects a mask bound to different bytes", () => {
    expect(() =>
      selectSpatialForeground({
        ...fixture(),
        alphaFingerprint: "0".repeat(64),
      }),
    ).toThrow(/fingerprint differs/);
  });
});
