import { expect, test } from "@playwright/test";
import sharp from "sharp";

const origin = "http://127.0.0.1:3100";
const productId = "11111111-1111-4111-8111-111111111111";

test.beforeAll(async ({ request }) => {
  // Explicit local fixture setup. The storefront itself must not seed or refill.
  expect((await request.get("/v1/products", { timeout: 120_000 })).ok()).toBe(
    true,
  );
});

test("storefront catalogue, details, cart persistence and three-unit limit", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /L’art de choisir/ }),
  ).toBeVisible();
  await expect(page.locator(".store-product-card").first()).toBeVisible();
  for (const image of await page.locator(".store-product-image img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate(
          (node) =>
            (node as HTMLImageElement).complete &&
            (node as HTMLImageElement).naturalWidth > 0,
        ),
      )
      .toBe(true);
  }
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: `artifacts/boutique-redesign-2026-09-29/catalogue-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByLabel("Rechercher un article").fill("Vase Sable");
  await expect(page.locator(".store-product-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Découvrir Vase Sable" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Dimensions", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Fermer les détails" }).click();
  await page
    .getByRole("button", { name: "Ajouter Vase Sable au panier" })
    .click();
  await page.goto("/panier");
  await expect(
    page.getByRole("heading", { name: "Vase Sable", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Augmenter Vase Sable" }).click();
  await page.getByRole("button", { name: "Augmenter Vase Sable" }).click();
  await expect(page.getByLabel("Quantité", { exact: true })).toHaveText("3");
  await expect(
    page.getByRole("link", { name: "Visualiser chez moi" }),
  ).toHaveAttribute(
    "href",
    new RegExp(`${productId}%2C${productId}%2C${productId}`),
  );
  await page.getByRole("button", { name: "Augmenter Vase Sable" }).click();
  await expect(
    page.getByRole("button", { name: "Visualiser chez moi" }),
  ).toBeDisabled();
  await expect(page.getByText(/quantités comprises/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Quantité", { exact: true })).toHaveText("4");
  await page.getByRole("button", { name: "Diminuer Vase Sable" }).click();
  await page.getByRole("link", { name: "Visualiser chez moi" }).click();
  if (test.info().project.name === "chromium")
    await page.getByRole("link", { name: "Continuer sur cet appareil" }).click();
  await expect(page.locator(".store-selected-unit")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("catalogue and product pages remain readable with JavaScript disabled", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator(".store-product-card").first()).toBeVisible();
  const label = page.getByText("Rechercher un article", { exact: true });
  await label.click();
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("searchbox").fill("Vase Sable");
  await page.getByRole("searchbox").press("Enter");
  await expect(page).toHaveURL(/\?q=Vase\+Sable/);
  await expect(page.locator(".store-product-card")).toHaveCount(1);
  await page.getByRole("link", { name: "Vase Sable", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Vase Sable", exact: true }),
  ).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    new RegExp(`/produits/${productId}$`),
  );
  const markup = await page.content();
  expect(markup).toContain("application/ld+json");
  expect(
    (
      await request.get("/produits/00000000-0000-4000-8000-000000000999")
    ).status(),
  ).toBe(404);
  await context.close();
});

test("catalogue product flows through a private photo and a mock render", async ({
  page,
  browser,
}) => {
  await page.goto(`/visualiser?products=${productId}`);
  await page.getByRole("checkbox").check();
  const photo = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="#eee4d5"/><rect y="460" width="1000" height="340" fill="#bd9d80"/><rect x="180" y="480" width="640" height="60" fill="#80624a"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const uploaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/scenes") &&
      response.request().method() === "POST",
  );
  await page
    .getByLabel("Choisir une photo")
    .setInputFiles({ name: "room.png", mimeType: "image/png", buffer: photo });
  const sceneResponse = await uploaded;
  expect(sceneResponse.status()).toBe(201);
  const scene = await sceneResponse.json();
  await expect(
    page.getByRole("button", { name: /^Placer Vase Sable/ }),
  ).toBeVisible();
  const stranger = await browser.newContext();
  const session = await stranger.request.post(
    `${origin}/api/storefront/session`,
    { headers: { Origin: origin } },
  );
  const token = (await session.json()).accessToken;
  expect(
    (await stranger.request.get(`${origin}${scene.imageUrl}`)).status(),
  ).toBe(403);
  expect(
    (
      await stranger.request.get(`${origin}/v1/scenes/${scene.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(404);
  await stranger.close();
  const frame = page.getByRole("button", { name: /^Placer Vase Sable/ });
  const bounds = await frame.boundingBox();
  await frame.click({
    position: { x: bounds!.width * 0.5, y: bounds!.height * 0.6 },
  });
  const create = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/renders/final") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
  const response = await create;
  expect(response.status(), await response.text()).toBe(201);
  await expect(
    page.getByRole("heading", { name: "Bienvenue chez vous." }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(
    page.getByRole("img", {
      name: "Votre sélection visualisée dans votre pièce",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Comparer avec ma photo" }).click();
  await expect(
    page.getByRole("img", { name: "Votre pièce avant la visualisation" }),
  ).toBeVisible();
  await page.screenshot({
    path: `artifacts/storefront-opening-2026-09-29/visualisation-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("requested administrator login opens product management", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Le catalogue LiliDeco." }),
  ).toBeVisible();
  await page.getByLabel("Identifiant", { exact: true }).fill("LiliDeco");
  await page.getByLabel("Mot de passe", { exact: true }).fill("LiliDeco2026");
  await page
    .getByRole("button", { name: "Entrer dans le back office" })
    .click();
  await expect(page).toHaveURL(/\/admin(?:\/produits)?$/);
  await expect(
    page.getByRole("link", { name: "Ajouter un produit", exact: true }),
  ).toBeVisible();
});

test("backoffice prepares once, reuses the cutout after dimension changes and publishes", async ({
  page,
}) => {
  const login = await page.request.post("/api/admin/session", {
    headers: { Origin: origin },
    data: { username: "LiliDeco", password: "LiliDeco2026" },
  });
  expect(login.status()).toBe(201);
  const created = await page.request.post("/api/admin/products", {
    headers: { Origin: origin },
    data: {
      name: `Vase préparé ${test.info().project.name}`,
      description: "Objet de test de préparation",
      objectType: "vase",
      widthCm: 20,
      heightCm: 30,
      depthCm: 20,
      material: "Grès",
      placementType: "table",
      priceCents: 4500,
      currency: "TND",
      stock: 6,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const product = await created.json();
  const photo = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="720"><rect width="640" height="720" fill="white"/><path d="M245 90h150l-15 120c100 100 120 360 25 430-55 40-115 40-170 0-95-70-75-330 25-430z" fill="#b28c68"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const upload = await page.request.post(
    `/api/admin/products/${product.id}/views`,
    {
      headers: { Origin: origin },
      multipart: {
        viewType: "front",
        file: { name: "vase.png", mimeType: "image/png", buffer: photo },
      },
    },
  );
  expect(upload.status(), await upload.text()).toBe(201);
  const prepare = () =>
    page.request.post(`/api/admin/products/${product.id}/actions`, {
      headers: { Origin: origin },
      data: { action: "prepare" },
    });
  const firstResponse = await prepare();
  expect(firstResponse.status(), await firstResponse.text()).toBe(200);
  const first = await firstResponse.json();
  expect(first.preparation.status).toBe("ready");
  const second = await (await prepare()).json();
  expect(second.cutoutUrl).toBe(first.cutoutUrl);
  expect(second.preparation.preparedAt).toBe(first.preparation.preparedAt);
  const changed = await page.request.patch(
    `/api/admin/products/${product.id}`,
    { headers: { Origin: origin }, data: { heightCm: 35 } },
  );
  expect(changed.status()).toBe(200);
  expect((await changed.json()).preparation.status).toBe("stale");
  const updated = await (await prepare()).json();
  expect(updated.cutoutUrl).toBe(first.cutoutUrl);
  expect(updated.preparation.status).toBe("ready");
  const published = await page.request.post(
    `/api/admin/products/${product.id}/actions`,
    { headers: { Origin: origin }, data: { action: "publish" } },
  );
  expect(published.status(), await published.text()).toBe(200);
  const catalogue = await (
    await page.request.get("/api/storefront/products")
  ).json();
  expect(
    catalogue.products.find((p: { id: string }) => p.id === product.id)
      ?.heightCm,
  ).toBe(35);
  await page.goto(`/admin/produits/${product.id}`);
  await expect(
    page.getByText("Photo et fiche préparées.", { exact: false }),
  ).toBeVisible();
  const sourcePhoto = page.getByRole("img", { name: "Face", exact: true });
  const preparedPhoto = page.getByRole("img", {
    name: `Détourage préparé de ${product.name}`,
    exact: true,
  });
  await expect(sourcePhoto).toHaveAttribute("src", updated.assetUrl);
  await expect(preparedPhoto).toHaveAttribute("src", updated.cutoutUrl);
  for (const image of [sourcePhoto, preparedPhoto]) {
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate(
          (node) =>
            (node as HTMLImageElement).complete &&
            (node as HTMLImageElement).naturalWidth > 0,
        ),
      )
      .toBe(true);
  }
  await page.screenshot({
    path: `artifacts/storefront-opening-2026-09-29/preparation-${test.info().project.name}.png`,
    fullPage: true,
  });
});
