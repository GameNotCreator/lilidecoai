import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

const origin = "http://127.0.0.1:3100";

test.beforeAll(async ({ request }) => {
  // Seed the shared demo identity before fixed-admin login can create its slug.
  const seeded = await request.get("/v1/products", { timeout: 120_000 });
  expect(seeded.ok(), await seeded.text()).toBe(true);
});

test("backoffice imports a source-bound coverage mask with usable mobile controls", async ({ page }) => {
  const login = await page.request.post("/api/admin/session", {
    headers: { Origin: origin }, data: { username: "LiliDeco", password: "LiliDeco2026" },
  });
  expect(login.status()).toBe(201);
  const created = await page.request.post("/api/admin/products", {
    headers: { Origin: origin }, data: {
      name: `Vase masque ${test.info().project.name}`, objectType: "vase", material: "Grès",
      widthCm: 20, heightCm: 20, depthCm: 20, placementType: "table",
      priceCents: 4500, currency: "TND", stock: 6,
      visualizationBlockedReason: "Masque à vérifier",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const product = await created.json();
  const photo = await sharp(Buffer.from(
    '<svg width="400" height="400"><rect width="400" height="400" fill="white"/><circle cx="200" cy="200" r="135" fill="#716b58"/></svg>',
  )).png().toBuffer();
  const upload = await page.request.post(`/api/admin/products/${product.id}/views`, {
    headers: { Origin: origin }, multipart: {
      viewType: "front", file: { name: "source.png", mimeType: "image/png", buffer: photo },
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const withPhoto = await upload.json();
  const source = await page.request.get(withPhoto.assetUrl);
  expect(source.ok()).toBe(true);
  const sourceHash = createHash("sha256").update(await source.body()).digest("hex");
  if (test.info().project.name === "mobile") await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`/admin/produits/${product.id}`);
  await page.getByText("Importer un détourage vérifié", { exact: true }).click();
  await expect(page.getByLabel("Choisir le masque PNG")).toBeDisabled();
  // An import cannot itself override a merchant veto.
  const cleared = await page.request.patch(`/api/admin/products/${product.id}`, {
    headers: { Origin: origin }, data: { visualizationBlockedReason: "" },
  });
  expect(cleared.status(), await cleared.text()).toBe(200);
  await page.reload();
  const disclosure = page.getByText("Importer un détourage vérifié", { exact: true });
  await disclosure.click();
  const input = page.getByLabel("Choisir le masque PNG");
  await expect(input).toBeEnabled();
  const layout = await page.evaluate(() => ({
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("body *")].map(element => ({
      tag: element.tagName, className: element.getAttribute("class"),
      right: Math.round(element.getBoundingClientRect().right),
      width: Math.round(element.getBoundingClientRect().width),
    })).filter(element => element.right > innerWidth + 1 && element.width > 0).slice(0, 25),
  }));
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1);
  for (const control of [disclosure, input]) {
    const bounds = await control.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await input.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  const mask = await sharp(Buffer.from(
    '<svg width="400" height="400"><rect width="400" height="400" fill="black"/><circle cx="200" cy="200" r="135" fill="white"/></svg>',
  )).removeAlpha().toColourspace("b-w").png().toBuffer();
  const imported = page.waitForResponse(response => response.url().endsWith(`/products/${product.id}/cutout-mask`)
    && response.request().method() === "POST");
  await input.setInputFiles({ name: "coverage-mask.png", mimeType: "image/png", buffer: mask });
  const result = await imported;
  expect(result.status(), await result.text()).toBe(200);
  expect(result.request().headers()["x-source-asset-id"]).toBe(withPhoto.sourceAssetId);
  expect(result.request().headers()["x-source-sha256"]).toBe(sourceHash);
  // Chromium omits a File/Blob body from its protocol postData; the server
  // response and source-binding headers verify this real upload instead.
  expect(result.request().headers()["content-type"]).toBe("image/png");
  const prepared = await result.json();
  expect(prepared.preparation.status).toBe("ready");
  expect(prepared.status).toBe("draft");
  await expect(page.getByText("Détourage importé. Vérifiez l’aperçu, puis publiez la fiche pour activer la visualisation.", { exact: true })).toBeVisible();
  const preview = page.getByRole("img", { name: `Détourage préparé de ${product.name}`, exact: true });
  await expect(preview).toHaveAttribute("src", prepared.cutoutUrl);
  await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `artifacts/catalogue-mask-2026-09-29/import-${test.info().project.name}.png`, fullPage: true });
});
