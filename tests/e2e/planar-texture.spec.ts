import { expect, test } from "@playwright/test";
import sharp from "sharp";
import type { AdminProduct } from "../../apps/web/lib/admin-client";
test("texture selection requires an administrator", async ({ request }) => {
  const response = await request.put(
    "/api/admin/products/11111111-1111-4111-8111-111111111111/planar-texture",
    { headers: { Origin: "http://127.0.0.1:3100" }, data: { assetId: "photo", corners: [] } },
  );
  expect(response.status()).toBe(401);
});
test("merchant marks, saves, reloads and removes four texture corners", async ({
  page,
}) => {
  expect(
    (
      await page.request.post("/api/admin/session", {
        headers: { Origin: "http://127.0.0.1:3100" },
        data: {
          username: "LiliDeco",
          password: "LiliDeco2026",
        },
      })
    ).ok(),
  ).toBe(true);
  const image = await sharp({
    create: { width: 400, height: 500, channels: 3, background: "#ba614a" },
  })
    .png()
    .toBuffer();
  await page.route("**/texture-fixture.png", (route) =>
    route.fulfill({ body: image, contentType: "image/png" }),
  );
  let product: AdminProduct = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Tapis test",
    objectType: "rug",
    placementType: "floor",
    widthCm: 80,
    heightCm: 1,
    depthCm: 100,
    description: "",
    material: "Laine",
    sku: null,
    buyUrl: null,
    brand: "",
    collection: "",
    tags: [],
    priceCents: null,
    currency: "CHF",
    stock: null,
    weightKg: null,
    variants: [],
    status: "draft",
    assetUrl: "/texture-fixture.png",
    sourceAssetId: "photo",
    cutoutUrl: null,
    thumbnailUrl: null,
    views: [],
    viewCount: 0,
    hasCutout: false,
    temporary: false,
    expiresAt: null,
    archivedAt: null,
    lightingSource: "front",
    reflectance: "matte",
    generationInstructions: "",
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
  let mutations = 0;
  await page.route("**/api/admin/products/**", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      mutations++;
      expect(body.assetId).toBe("photo");
      expect(body.corners).toHaveLength(4);
      product = {
        ...product,
        updatedAt: `2026-09-26T00:00:0${mutations}.000Z`,
        planarTexture: {
          ...body,
          version: 1,
          fingerprint: "a".repeat(64),
          widthPx: 400,
          heightPx: 500,
          productWidthCm: 80,
          productDepthCm: 100,
          confirmedAt: "2026-09-26T00:00:00.000Z",
        },
      };
    } else if (route.request().method() === "DELETE") {
      mutations++;
      product = {
        ...product,
        planarTexture: null,
        updatedAt: `2026-09-26T00:00:0${mutations}.000Z`,
      };
    }
    await route.fulfill({ json: product });
  });
  await page.goto(`/admin/produits/${product.id}`);
  const section = page.getByRole("region", { name: "Texture du tapis" });
  await expect(section).toBeVisible();
  const photo = section.getByRole("button", {
    name: "Choisir les quatre coins du tapis",
  });
  const save = section.getByRole("button", { name: "Confirmer les coins" });
  await expect(save).toBeDisabled();
  const rect = (await photo.boundingBox())!;
  for (const [x, y] of [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ])
    await photo.click({
      position: { x: rect.width * x!, y: rect.height * y! },
    });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    section.getByText("Une sélection est enregistrée", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    section.getByText("Une sélection est enregistrée", { exact: false }),
  ).toBeVisible();
  await section
    .getByRole("button", { name: "Supprimer la sélection enregistrée" })
    .click();
  await expect(save).toBeDisabled();
  await section
    .getByRole("button", { name: "Recommencer", exact: true })
    .click();
  const newRect = (await photo.boundingBox())!;
  for (const [x, y] of [
    [0.1, 0.1],
    [0.9, 0.9],
    [0.9, 0.1],
    [0.1, 0.9],
  ])
    await photo.click({
      position: { x: newRect.width * x!, y: newRect.height * y! },
    });
  await expect(save).toBeDisabled();
  await expect(section.getByText(/Les côtés se croisent/)).toBeVisible();
  expect(mutations).toBe(2);
});
