import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const demoProductId = "11111111-1111-4111-8111-111111111111";
const cartKey = "lilideco-storefront-cart-v1";
// Browser-only catalogue fixture: real public names/dimensions/prices, no claim
// that these photos are qualified for visualization or imported in the test DB.
const products = [
  { id: demoProductId, name: "Grenade décorative noire et blanche", widthCm: 14, heightCm: 14, depthCm: 14, priceCents: 11500, objectType: "other", placementType: "table", material: "Céramique", photo: "grenade-noire-blanche.jpg" },
  { id: "11111111-1111-4111-8111-111111111112", name: "Cache-pot en céramique craquelée", widthCm: 20, heightCm: 16, depthCm: 20, priceCents: 12900, objectType: "vase", placementType: "table", material: "Céramique", photo: "cache-pot.jpg" },
  { id: "11111111-1111-4111-8111-111111111113", name: "Panier à linge en jute avec couvercle", widthCm: 40, heightCm: 40, depthCm: 40, priceCents: 22500, objectType: "other", placementType: "floor", material: "Jute", photo: "panier-jute.jpg" },
].map(({ photo, ...product }) => ({
  ...product,
  description: "Objet de la sélection ByLiliDeco. Disponibilité à confirmer auprès de la boutique.",
  brand: "ByLiliDeco",
  currency: "TND",
  stock: null,
  visualizationAvailable: false,
  assetUrl: `/mobile-layout-fixture/${photo}`,
}));

async function noHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const documentFits = document.documentElement.scrollWidth <= innerWidth + 1;
    const regions = [...document.querySelectorAll<HTMLElement>("main, dialog[open], .store-header-inner, .store-footer-inner")];
    return documentFits && regions.every((region) => region.scrollWidth <= region.clientWidth + 1);
  })).toBe(true);
}

async function comfortableTarget(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
}

test.beforeAll(async ({ request }, info) => {
  if (info.project.name !== "mobile") return;
  // Existing local demo fixture is needed only for the server-rendered product
  // detail page. The storefront below uses the real-name browser fixture.
  expect((await request.get("/v1/products", { timeout: 120_000 })).ok()).toBe(true);
});

for (const width of [320, 375, 430]) {
  test(`mobile ${width}px: visualizer keeps all four steps and upload controls inside the screen`, async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Dedicated mobile viewport checks.");
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/storefront/products", (route) => route.fulfill({
      json: {
        store: { name: "ByLiliDeco" },
        products: products.map((product) => ({ ...product, visualizationAvailable: true })),
        visualization: { available: true },
      },
    }));
    await page.route("**/mobile-layout-fixture/*", async (route) => {
      const buffer = await readFile(path.join(process.cwd(), "apps/web/tests/fixtures/catalogue/grenade-noire-blanche.jpg"));
      await route.fulfill({ contentType: "image/jpeg", body: buffer });
    });
    await page.goto(`/visualiser?products=${demoProductId}`);
    const steps = page.getByRole("list", { name: "Étapes de visualisation" });
    await expect(steps.getByRole("listitem")).toHaveCount(4);
    await expect(steps).toContainText("Photo");
    await expect(steps).toContainText("Échelle");
    await expect(steps).toContainText("Placement");
    await expect(steps).toContainText("Résultat");
    await noHorizontalOverflow(page);
    for (const step of await steps.getByRole("listitem").all()) {
      await expect(step).toBeVisible();
      const bounds = await step.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await step.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await expect(page.getByText("Choisir une photo", { exact: true })).toBeVisible();
    await page.screenshot({ path: `artifacts/mobile-layout-2026-09-30/visualizer-${width}.png`, fullPage: true });
  });

  test(`mobile ${width}px: hero, catalogue dialog, product page, basket and checkout fit and retain usable controls`, async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Dedicated mobile viewport checks.");
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const submitted: string[] = [];
    await page.route("**/api/storefront/orders", async (route) => {
      submitted.push(route.request().method());
      await route.abort();
    });
    await page.route("**/api/storefront/products", (route) => route.fulfill({
      json: { store: { name: "ByLiliDeco" }, products, visualization: { available: true } },
    }));
    await page.route("**/mobile-layout-fixture/*", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop()!;
      const filename = name === "panier-jute.jpg" ? "panier-jute.jpeg" : name;
      const buffer = await readFile(path.join(process.cwd(), "apps/web/tests/fixtures/catalogue", filename));
      await route.fulfill({ contentType: "image/jpeg", body: buffer });
    });
    await page.goto("/");
    await expect(page.locator(".store-product-card")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: /L’art de choisir/ })).toBeVisible();
    const hero = page.locator(".store-hero-visual img");
    await expect(hero).toHaveCount(1);
    await expect.poll(() => hero.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await noHorizontalOverflow(page);
    await comfortableTarget(page.getByRole("link", { name: "Explorer la collection" }));
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: `artifacts/mobile-layout-2026-09-29/home-${width}.png` });
    const search = page.getByLabel("Rechercher un article");
    await search.fill("Grenade");
    await expect(search).toBeFocused();
    expect(await search.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    await comfortableTarget(page.getByRole("button", { name: "Rechercher", exact: true }));
    await page.getByRole("button", { name: `Découvrir ${products[0]!.name}` }).click();
    const detail = page.getByRole("dialog");
    await expect(detail).toBeVisible();
    await noHorizontalOverflow(page);
    await comfortableTarget(detail.getByRole("button", { name: "Fermer les détails" }));
    await comfortableTarget(detail.getByRole("button", { name: "Ajouter au panier", exact: true }));
    await detail.screenshot({ path: `artifacts/mobile-layout-2026-09-29/product-dialog-${width}.png` });
    await detail.getByRole("button", { name: "Fermer les détails" }).click();

    // Server-rendered fixture page, independent of the mocked catalogue API.
    await page.goto(`/produits/${demoProductId}`);
    await expect(page.locator(".store-product-page h1")).toBeVisible();
    await comfortableTarget(page.getByRole("button", { name: "Ajouter au panier", exact: true }));
    await noHorizontalOverflow(page);

    await page.evaluate(({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids.map((productId) => ({ productId, quantity: 1 })))), { key: cartKey, ids: products.map((product) => product.id) });
    await page.goto("/panier");
    await expect(page.locator(".store-basket-item")).toHaveCount(3);
    for (const button of await page.locator(".store-quantity button, .store-remove").all()) await comfortableTarget(button);
    await comfortableTarget(page.getByRole("link", { name: "Demander une commande" }));
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `artifacts/mobile-layout-2026-09-29/basket-${width}.png`, fullPage: true });

    await page.getByRole("link", { name: "Demander une commande" }).click();
    await expect(page.getByRole("heading", { name: "Parlons de vos envies." })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Récapitulatif de votre demande" })).toContainText(products[2]!.name);
    for (const input of await page.locator('input:not([type="checkbox"]):not([name="website"])').all()) {
      await comfortableTarget(input);
      expect(await input.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    }
    const phone = page.getByLabel("Téléphone", { exact: true });
    await expect(phone).toHaveAttribute("type", "tel");
    if (await phone.isEnabled()) {
      await page.getByLabel("Nom complet", { exact: true }).fill("Test mobile");
      await phone.fill("+216 22 000 000");
      await expect(phone).toBeFocused();
    }
    await comfortableTarget(page.getByRole("button", { name: "Transmettre ma demande" }));
    await noHorizontalOverflow(page);
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: `artifacts/mobile-layout-2026-09-29/checkout-${width}.png`, fullPage: true });
    expect(submitted).toEqual([]);
  });
}
