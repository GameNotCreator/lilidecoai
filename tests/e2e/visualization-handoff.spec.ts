import { expect, test } from "@playwright/test";

const productId = "11111111-1111-4111-8111-111111111111";
const cartKey = "lilideco-storefront-cart-v1";

test.beforeAll(async ({ request }) => {
  expect((await request.get("/v1/products", { timeout: 120_000 })).ok()).toBe(true);
});

test("desktop handoff has a local QR, accessible close and exact product URL; mobile goes directly", async ({ page }) => {
  const generated: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(scenes|renders)/.test(request.url()))
      generated.push(request.url());
  });
  await page.goto(`/produits/${productId}`);
  const visualize = page.getByRole("link", { name: "Visualiser chez moi" });
  await visualize.click();
  if (test.info().project.name === "mobile") {
    await expect(page).toHaveURL(new RegExp(`/visualiser\\?products=${productId}`));
    await expect(page.locator(".store-selected-unit")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    const dialog = page.getByRole("dialog", { name: "Continuez sur votre téléphone." });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/produits/${productId}$`));
    // Localhost would point to the phone itself: require an explicit network origin.
    await page.getByLabel("Adresse accessible au téléphone").fill("http://localhost:3100");
    await page.getByRole("button", { name: "Créer le QR code" }).click();
    await expect(dialog.getByRole("img")).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toContainText("adresse réseau privée");
    await page.getByLabel("Adresse accessible au téléphone").fill("http://192.168.1.20:3100");
    await page.getByRole("button", { name: "Créer le QR code" }).click();
    await expect(dialog.getByRole("img", { name: "QR code pour ouvrir votre sélection sur téléphone" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: /^http:\/\/192\.168/ })).toHaveAttribute(
      "href",
      `http://192.168.1.20:3100/visualiser?products=${productId}`,
    );
    // No remote QR image endpoint: modules are drawn in an inline SVG.
    await expect(dialog.locator("svg[role=img] path")).not.toHaveCount(0);
    await expect(dialog.locator("img")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(visualize).toBeFocused();
  }
  expect(generated).toEqual([]);
});

test("three identical units retain their quantities when the mobile handoff URL is opened in a fresh context", async ({ page, browser }) => {
  await page.goto("/");
  await page.evaluate(({ key, id }) => {
    localStorage.setItem(key, JSON.stringify([{ productId: id, quantity: 3 }]));
  }, { key: cartKey, id: productId });
  await page.goto("/panier");
  await page.getByRole("link", { name: "Visualiser chez moi" }).click();
  if (test.info().project.name === "chromium") {
    await page.getByLabel("Adresse accessible au téléphone").fill("http://192.168.1.20:3100");
    await page.getByRole("button", { name: "Créer le QR code" }).click();
    const url = await page.getByRole("dialog").getByRole("link", { name: /^http:\/\/192\.168/ }).getAttribute("href");
    const selection = new URL(url!).searchParams.get("products")!;
    expect(selection.split(",")).toEqual([productId, productId, productId]);
    // A new device has no browser cart or merchant session.
    const phone = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    const phonePage = await phone.newPage();
    await phonePage.goto(`http://127.0.0.1:3100/visualiser?${new URLSearchParams({ products: selection })}`);
    await expect(phonePage.locator(".store-selected-unit")).toHaveCount(3);
    expect(await phonePage.evaluate((key) => localStorage.getItem(key), cartKey)).toBeNull();
    await phone.close();
  } else {
    await expect(page.locator(".store-selected-unit")).toHaveCount(3);
  }
});

test("a product blocked after the page loads cannot receive a shareable QR", async ({ page, request }) => {
  test.skip(test.info().project.name !== "chromium", "QR is a desktop handoff.");
  const catalog = await (await request.get("/api/storefront/products")).json();
  await page.goto(`/produits/${productId}`);
  await page.route("**/api/storefront/products", async (route) => {
    await route.fulfill({
      json: {
        ...catalog,
        products: catalog.products.map((product: { id: string }) =>
          product.id === productId ? { ...product, visualizationAvailable: false } : product),
      },
    });
  });
  await page.getByRole("link", { name: "Visualiser chez moi" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status").filter({ hasText: "pas disponible" })).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copier le lien" })).toHaveCount(0);
  await dialog.getByRole("link", { name: "Continuer sur cet appareil" }).click();
  await expect(page.getByText("La visualisation n’est pas disponible pour Vase Sable.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Choisir une photo")).toHaveCount(0);
});
