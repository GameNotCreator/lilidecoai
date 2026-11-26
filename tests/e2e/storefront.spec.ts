import { expect, test } from "@playwright/test";
import sharp from "sharp";

const origin = "http://127.0.0.1:3100";
const productId = "11111111-1111-4111-8111-111111111111";

test.beforeAll(async ({ request }) => {
  // Explicit local fixture setup. The storefront itself must not seed or refill.
  const seeded = await request.get("/v1/products", { timeout: 120_000 });
  expect(seeded.ok(), await seeded.text()).toBe(true);
});

test("storefront categories filter products and can be reassigned in the back office", async ({
  page,
}) => {
  const sculpturePath = "/categories/sculptures-objets-deco";
  await page.goto(sculpturePath);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  expect(await (await page.request.get("/sitemap.xml")).text()).not.toContain(`${sculpturePath}</loc>`);
  await page.goto("/");
  const category = page.getByRole("combobox", { name: "Catégorie", exact: true });
  await expect(category.locator("option")).toHaveText([
    "Toutes les catégories",
    "Coffrets Cadeaux",
    "Sculptures & Objets Déco",
    "Vases & Cache-pots",
    "Art de la Table",
    "Lampes & Luminaires",
    "Décoration Murale",
    "Bougeoirs & Photophores",
    "Tapis & Textiles",
    "Petit Mobilier",
    "Autres Accessoires Déco",
  ]);
  const titles = page.locator(".store-product-card h3");
  await category.selectOption("vases-cache-pots");
  await expect(titles).toHaveText(["Vase Sable"]);

  const headers = { Origin: origin };
  const login = await page.request.post("/api/admin/session", {
    headers,
    data: { username: "LiliDeco", password: "LiliDeco2026" },
  });
  expect(login.status()).toBe(201);
  const endpoint = `/api/admin/products/${productId}`;
  const existing = await page.request.get(endpoint);
  expect(existing.ok()).toBe(true);
  const { storefrontCategory } = await existing.json();
  try {
    await page.goto(`/admin/produits/${productId}`);
    await page.getByLabel("Catégorie boutique").selectOption("sculptures-objets-deco");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.getByText("Fiche enregistrée.")).toBeVisible();

    await page.goto(sculpturePath);
    await expect(page.locator(".store-product-card h3")).toHaveText(["Vase Sable"]);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    expect(await (await page.request.get("/sitemap.xml")).text()).toContain(`${sculpturePath}</loc>`);

    await page.goto("/?categorie=sculptures-objets-deco");
    await expect(category).toHaveValue("sculptures-objets-deco");
    await expect(titles).toHaveText(["Vase Sable"]);
    await category.selectOption("vases-cache-pots");
    await expect(titles).toHaveCount(0);
    await page.getByRole("button", { name: "Voir toute la collection" }).click();
    await expect(category).toHaveValue("");
    await expect(titles.first()).toBeVisible();
  } finally {
    const restored = await page.request.patch(endpoint, {
      headers,
      data: { storefrontCategory: storefrontCategory ?? null },
    });
    expect(restored.ok()).toBe(true);
  }
});

test("product images reserve space while loading and the preview opens centered", async ({
  page,
  request,
}) => {
  const catalog = await (await request.get("/api/storefront/products")).json();
  const { assetUrl } = catalog.products.find((product: { id: string }) => product.id === productId);
  let release = () => {};
  const download = new Promise<void>((resolve) => { release = resolve; });
  await page.route(assetUrl, async (route) => {
    await download;
    await route.continue();
  });

  const open = page.getByRole("button", { name: "Découvrir Vase Sable" });
  const image = open.getByRole("img", { name: "Vase Sable" });
  const skeleton = open.locator(".store-image-skeleton");
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await open.scrollIntoViewIfNeeded();
    await expect(skeleton).toBeVisible();
    expect((await skeleton.boundingBox())?.height).toBeGreaterThan(0);
  } finally {
    release();
  }
  await expect(skeleton).toHaveCount(0);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await open.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return Math.max(
      Math.abs(x + width / 2 - window.innerWidth / 2),
      Math.abs(y + height / 2 - window.innerHeight / 2),
    );
  })).toBeLessThan(2);
  await expect(dialog.getByRole("button", { name: "Fermer les détails" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("the saved shop order aligns cards and shows the staged product photo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const headers = { Origin: origin };
  const login = await page.request.post("/api/admin/session", {
    headers,
    data: { username: "LiliDeco", password: "LiliDeco2026" },
  });
  expect(login.status()).toBe(201);
  const endpoint = "/api/admin/products/storefront-order";
  const initial = await (await page.request.get(endpoint)).json();
  expect(initial.products.length).toBeGreaterThan(1);
  const second = initial.products[1];
  const stagedRoute = `/api/admin/products/${second.id}/views`;
  const photo = await sharp({
    create: { width: 400, height: 400, channels: 3, background: "#b79572" },
  })
    .png()
    .toBuffer();

  await page.goto("/admin/produits/ordre");
  const preview = page.getByRole("list", {
    name: "Produits dans l’ordre de la boutique",
  });
  const previewColumns = () =>
    preview.evaluate(
      (grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length,
    );
  await expect.poll(previewColumns).toBe(3);
  await page.getByRole("button", { name: "Mobile · 2 colonnes" }).click();
  await expect.poll(previewColumns).toBe(2);
  await expect(preview.getByRole("listitem").nth(1)).toContainText(second.name);
  await page.getByRole("button", { name: "PC · 3 colonnes" }).click();
  const first = initial.products[0];
  const handle = page.getByRole("button", {
    name: `Déplacer ${second.name}`,
    exact: true,
  });
  const target = page.getByRole("button", {
    name: `Déplacer ${first.name}`,
    exact: true,
  });
  await expect(handle).toBeVisible();
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(preview.getByRole("listitem").first()).toContainText(
    second.name,
  );
  expect((await (await page.request.get(endpoint)).json()).products[0].id).toBe(
    first.id,
  );
  await page.getByRole("button", { name: "Enregistrer l’ordre" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "L’ordre a été enregistré dans la boutique." }),
  ).toBeVisible();
  const ids = initial.products.map((product: { id: string }) => product.id);
  const stale = await page.request.put(endpoint, {
    headers,
    data: { ids, revision: initial.revision },
  });
  expect(stale.status()).toBe(409);

  try {
    const upload = await page.request.post(stagedRoute, {
      headers,
      multipart: {
        viewType: "staged",
        file: {
          name: "mise-en-scene.png",
          mimeType: "image/png",
          buffer: photo,
        },
      },
    });
    expect(upload.status(), await upload.text()).toBe(201);

    await page.goto("/");
    const cards = page.locator(".store-product-card");
    await expect(cards.first().getByRole("heading")).toHaveText(second.name);
    const prices = page
      .locator(".store-product-price")
      .filter({ visible: true });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 820 });
      const columns = await page
        .locator(".store-product-grid")
        .evaluate(
          (grid) =>
            getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        );
      expect(columns).toBe(width > 760 ? 3 : 2);
      const first = await prices.nth(0).boundingBox();
      const next = await prices.nth(1).boundingBox();
      expect(first).not.toBeNull();
      expect(next).not.toBeNull();
      expect(Math.abs(first!.y - next!.y)).toBeLessThan(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
    }
    await cards
      .first()
      .getByRole("button", { name: `Découvrir ${second.name}` })
      .click();
    const dialog = page.getByRole("dialog");
    const staged = dialog.getByRole("img", {
      name: `${second.name} en mise en scène`,
    });
    await expect(staged).toBeVisible();
    await expect
      .poll(() => staged.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Photo de l’article" }).click();
    await expect(
      dialog.getByRole("img", { name: second.name, exact: true }),
    ).toBeVisible();
  } finally {
    await page.request.delete(`${stagedRoute}?type=staged`, { headers });
    await page.request.put(endpoint, {
      headers,
      data: { ids, revision: initial.revision + 1 },
    });
  }
});

test("categories can be reordered with the keyboard and appear in that order on the storefront", async ({
  page,
}) => {
  const headers = { Origin: origin };
  const login = await page.request.post("/api/admin/session", {
    headers,
    data: { username: "LiliDeco", password: "LiliDeco2026" },
  });
  expect(login.status()).toBe(201);
  const endpoint = "/api/admin/products/storefront-order";
  const initial = (await (await page.request.get(endpoint)).json()) as {
    categoryRevision: number;
    categories: { id: string; label: string; productCount: number }[];
  };
  const visible = initial.categories.filter(
    ({ productCount }) => productCount > 0,
  );
  expect(visible.length).toBeGreaterThan(1);
  const [first, second] = visible;
  await page.goto("/admin/produits/ordre");
  await page.getByRole("button", { name: "Catégories", exact: true }).click();
  const moveUp = page.getByRole("button", {
    name: `Monter ${second!.label}`,
    exact: true,
  });
  const hops =
    initial.categories.indexOf(second!) - initial.categories.indexOf(first!);
  for (let i = 0; i < hops; i++) await moveUp.press("Enter");
  const visiblePreview = page.getByRole("group", {
    name: "Aperçu des catégories visibles",
  });
  await expect(visiblePreview.getByRole("listitem").first()).toHaveText(
    second!.label,
  );
  await page.getByRole("button", { name: "Enregistrer l’ordre" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "L’ordre des catégories a été enregistré." }),
  ).toBeVisible();
  const ids = initial.categories.map(({ id }) => id);
  try {
    const stale = await page.request.put(endpoint, {
      headers,
      data: { scope: "categories", ids, revision: initial.categoryRevision },
    });
    expect(stale.status()).toBe(409);
    await page.goto("/");
    const links = page
      .getByRole("navigation", { name: "Parcourir les catégories" })
      .getByRole("link");
    await expect(links.first()).toHaveText(second!.label);
    const options = await page
      .getByRole("combobox", { name: "Catégorie", exact: true })
      .locator("option")
      .evaluateAll((rows) =>
        rows.map((row) => (row as HTMLOptionElement).value),
      );
    expect(options.indexOf(second!.id)).toBeGreaterThan(0);
    expect(options.indexOf(second!.id)).toBeLessThan(
      options.indexOf(first!.id),
    );
  } finally {
    const restored = await page.request.put(endpoint, {
      headers,
      data: {
        scope: "categories",
        ids,
        revision: initial.categoryRevision + 1,
      },
    });
    expect(restored.ok()).toBe(true);
  }
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
    await page
      .getByRole("link", { name: "Continuer sur cet appareil" })
      .click();
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
  await page.getByRole("navigation", { name: "Parcourir les catégories" })
    .getByRole("link", { name: "Vases & Cache-pots" }).click();
  await expect(page.getByRole("heading", { name: "Vases & Cache-pots", exact: true })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/categories\/vases-cache-pots$/);
  await expect(page.locator(".store-product-card h3")).toHaveText(["Vase Sable"]);
  await expect(page.getByRole("link", { name: "Toute la collection" })).toHaveAttribute("href", "/#collection");
  await page.goto("/");
  const label = page.getByText("Rechercher un article", { exact: true });
  await label.click();
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("searchbox").fill("Vase Sable");
  await page.getByRole("combobox", { name: "Catégorie", exact: true }).selectOption("vases-cache-pots");
  await page.getByRole("searchbox").press("Enter");
  await expect(page).toHaveURL(/\?q=Vase\+Sable&categorie=vases-cache-pots/);
  await expect(page.locator(".store-product-card")).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
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
  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain(`/produits/${productId}</loc>`);
  expect(sitemap).toContain("/categories/vases-cache-pots</loc>");
  expect(sitemap).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}/);
  expect(sitemap).toMatch(/<image:loc>https?:\/\/[^<]+\/api\/assets\//);
  expect(
    (
      await request.get("/produits/00000000-0000-4000-8000-000000000999")
    ).status(),
  ).toBe(404);
  expect((await request.get("/categories/categorie-inconnue")).status()).toBe(404);
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
  const frame = page.locator(".store-placement-frame");
  await expect(frame).toBeEnabled();
  await expect(page.getByRole("button", { name: "Affiner la taille avec une hauteur connue" })).toHaveCount(0);
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
  const bounds = await frame.boundingBox();
  await frame.click({ position: { x: bounds!.width * 0.65, y: bounds!.height * 0.4 } });
  await frame.click({ position: { x: bounds!.width * 0.35, y: bounds!.height * 0.6 } });
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
