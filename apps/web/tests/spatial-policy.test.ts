import { describe, expect, it } from "vitest";
import {
  prepareProductGeometry,
  validateSpatialAdmission,
  canUseSpatialPilot,
  spatialVersionForProduct,
  isSupportedSolidBaseProduct,
} from "../lib/server/spatial-policy";
import type { ProductDocument } from "../lib/server/types";
import type { RenderInput } from "../lib/server/render-request";

const product = {
  id: "p",
  assetId: "photo",
  widthCm: 40,
  heightCm: 80,
  depthCm: 45,
  objectType: "furniture",
  placementType: "floor",
} as ProductDocument;
const input: RenderInput = {
  engine: "spatial",
  placement: { productId: "p", sceneId: "s", surfaceType: "floor" },
  placementPoint: { x: 0.5, y: 0.8 },
  idempotencyKey: "request",
};
describe("spatial admission", () => {
  const solidBase = (): ProductDocument => ({
    ...product,
    objectType: "other",
    spatialMetadata: {
      measurementConvention: "Complete basket dimensions, handles included",
      dimensionSource: "catalog",
      supports: ["floor"],
      characteristicParts: ["open basket rim"],
      contactProfile: "solid-base",
      volumeFamily: "basket",
    },
  });
  it("selects v11 without a profile and v13 only through explicit solid-base metadata", () => {
    expect(spatialVersionForProduct(product)).toBe("spatial-v11");
    const source = solidBase();
    expect(spatialVersionForProduct(source)).toBe("spatial-v13");
    expect(isSupportedSolidBaseProduct(source)).toBe(true);
    expect(validateSpatialAdmission(input, source, true)).toMatchObject({
      contactProfile: "solid-base",
      volumeFamily: "basket",
      shape: "volume",
    });
    const disabled = {
      ...source,
      spatialMetadata: { ...source.spatialMetadata! },
    };
    delete disabled.spatialMetadata.contactProfile;
    delete disabled.spatialMetadata.volumeFamily;
    expect(spatialVersionForProduct(disabled)).toBe("spatial-v11");
    expect(prepareProductGeometry(disabled).fingerprint).not.toBe(
      prepareProductGeometry(source).fingerprint,
    );
  });
  it("admits a measured full-base vase with the corresponding family", () => {
    const source = solidBase();
    source.objectType = "vase";
    source.spatialMetadata!.volumeFamily = "vase";
    source.spatialMetadata!.dimensionSource = "measured";
    expect(isSupportedSolidBaseProduct(source)).toBe(true);
    expect(validateSpatialAdmission(input, source, true)).toMatchObject({
      contactProfile: "solid-base",
      volumeFamily: "vase",
      dimensionSource: "measured",
    });
  });
  it.each([
    "other-without-family",
    "other-vase",
    "chair-profile",
    "lamp-profile",
    "vase-basket",
    "estimated",
  ])("refuses explicit but unsupported solid-base declaration %s", (kind) => {
    const source = solidBase();
    if (kind === "other-without-family")
      delete source.spatialMetadata!.volumeFamily;
    if (kind === "other-vase") source.spatialMetadata!.volumeFamily = "vase";
    if (kind === "chair-profile") source.objectType = "furniture";
    if (kind === "lamp-profile") source.objectType = "lamp";
    if (kind === "vase-basket") source.objectType = "vase";
    if (kind === "estimated")
      source.spatialMetadata!.dimensionSource = "estimated";
    expect(isSupportedSolidBaseProduct(source)).toBe(false);
    expect(() => validateSpatialAdmission(input, source, true)).toThrow(
      /base pleine/,
    );
  });
  it("never turns a solid-base profile into public or unauthorized access", () => {
    expect(() => validateSpatialAdmission(input, solidBase(), false)).toThrow(
      /internes/,
    );
    expect(() =>
      validateSpatialAdmission(input, solidBase(), true, "public-session"),
    ).toThrow(/internes/);
  });
  it("admits only thin floor rugs with a current texture, without enabling public access", () => {
    const rug: ProductDocument = {
      ...product,
      objectType: "rug",
      heightCm: 1,
      planarTexture: {
        version: 1,
        assetId: "photo",
        fingerprint: "a".repeat(64),
        widthPx: 600,
        heightPx: 400,
        corners: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        productWidthCm: 40,
        productDepthCm: 45,
        confirmedAt: new Date().toISOString(),
      },
    };
    expect(validateSpatialAdmission(input, rug, true).shape).toBe("plane");
    expect(() =>
      validateSpatialAdmission(input, { ...rug, widthCm: 41 }, true),
    ).toThrow(/texture/);
    expect(() =>
      validateSpatialAdmission(input, { ...rug, heightCm: 10 }, true),
    ).toThrow(/épais/);
    expect(() =>
      validateSpatialAdmission({ ...input, surfaceType: "table" }, rug, true),
    ).toThrow(/sol/);
    expect(() => validateSpatialAdmission(input, rug, true, "public")).toThrow(
      /internes/,
    );
    expect(() => validateSpatialAdmission(input, rug, false)).toThrow(
      /internes/,
    );
  });
  it("deduplicates references and invalidates stored preparation when a view changes", () => {
    const main = {
      id: "front",
      assetId: "photo",
      type: "front" as const,
      widthPx: 600,
      heightPx: 400,
      validationStatus: "valid" as const,
      createdAt: new Date(),
    };
    const source = {
      ...product,
      views: [
        main,
        { ...main, id: "top", assetId: "top", type: "top" as const },
      ],
    };
    const prepared = prepareProductGeometry(source);
    expect(prepared.references.map((item) => item.assetId)).toEqual([
      "photo",
      "top",
    ]);
    expect(
      prepareProductGeometry({ ...source, spatialPreparation: prepared }),
    ).toEqual(prepared);
    const changed = prepareProductGeometry({
      ...source,
      spatialPreparation: prepared,
      views: [main],
    });
    expect(changed.fingerprint).not.toBe(prepared.fingerprint);
    expect(changed.references).toHaveLength(1);
  });
  it("requires a signed eligible merchant even when the demo organization is enabled", () => {
    const tenant = {
      organizationId: "org",
      userId: "user",
      role: "owner" as const,
    };
    expect(canUseSpatialPilot(tenant, ["org"])).toBe(true);
    expect(canUseSpatialPilot({ ...tenant, synthetic: true }, ["org"])).toBe(
      false,
    );
    expect(
      canUseSpatialPilot({ ...tenant, publicSessionId: "session" }, ["org"]),
    ).toBe(false);
    expect(canUseSpatialPilot({ ...tenant, role: "viewer" }, ["org"])).toBe(
      false,
    );
    expect(canUseSpatialPilot(tenant, ["other"])).toBe(false);
  });
  it("does not enable a tenant or public session by client request", () => {
    expect(() => validateSpatialAdmission(input, product, false)).toThrow(
      /internes/,
    );
    expect(() =>
      validateSpatialAdmission(input, product, true, "guest"),
    ).toThrow(/internes/);
    expect(
      validateSpatialAdmission(input, product, true).dimensions.heightCm,
    ).toBe(80);
  });
  it.each(["wall", "ceiling", "existing_object", "niche"])(
    "rejects unsupported %s",
    (surfaceType) => {
      expect(() =>
        validateSpatialAdmission({ ...input, surfaceType }, product, true),
      ).toThrow();
    },
  );
  it("rejects substitution, rug generation and dimension changes", () => {
    expect(() =>
      validateSpatialAdmission({ ...input, mode: "replace" }, product, true),
    ).toThrow();
    expect(() =>
      validateSpatialAdmission(input, { ...product, objectType: "rug" }, true),
    ).toThrow(/plans/);
    expect(() =>
      validateSpatialAdmission(
        {
          ...input,
          dimensionsCm: { width: 4, height: 8, depth: 4.5, unit: "cm" },
        },
        product,
        true,
      ),
    ).toThrow(/catalogue/);
    expect(() =>
      validateSpatialAdmission(
        { ...input, surfaceType: "table" },
        product,
        true,
      ),
    ).toThrow(/compatible/);
  });
  it("invalidates preparation when dimensions or references change without inventing measurements", () => {
    const first = prepareProductGeometry(product);
    expect(
      prepareProductGeometry({ ...product, depthCm: 46 }).fingerprint,
    ).not.toBe(first.fingerprint);
    expect(
      prepareProductGeometry({ ...product, assetId: "new" }).fingerprint,
    ).not.toBe(first.fingerprint);
    expect(() => prepareProductGeometry({ ...product, depthCm: 0 })).toThrow(
      /dimensions/,
    );
    expect(first.limitations).toContain(
      "Convention de mesure et parties caractéristiques à compléter",
    );
  });
});
