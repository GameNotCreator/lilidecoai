import { expect, test } from "@playwright/test";
import sharp from "sharp";

async function productFixture(): Promise<Buffer> {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="720">
      <rect width="640" height="720" fill="white"/>
      <path d="M245 90h150l-15 120c100 100 120 360 25 430-55 40-115 40-170 0-95-70-75-330 25-430z" fill="#b28c68"/>
      <ellipse cx="320" cy="92" rx="75" ry="20" fill="#3c2a20"/>
    </svg>`);
  return sharp(svg).png().toBuffer();
}

async function roomFixture(): Promise<Buffer> {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900">
      <rect width="1280" height="900" fill="#eee5d8"/>
      <rect y="570" width="1280" height="330" fill="#c6ad8f"/>
      <rect x="170" y="455" width="940" height="55" rx="8" fill="#72533d"/>
      <rect x="220" y="510" width="45" height="280" fill="#654934"/>
      <rect x="1015" y="510" width="45" height="280" fill="#654934"/>
      <rect x="70" y="85" width="430" height="280" fill="#d3c2ab"/>
    </svg>`);
  return sharp(svg).png().toBuffer();
}

async function largeRoomFixture(): Promise<Buffer> {
  const width = 1600;
  const height = 1600;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[index] = state >>> 24;
  }
  return sharp(pixels, {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

test("MongoDB signup, logout and login keep a signed session", async ({
  request,
}) => {
  const email = `merchant-${test.info().project.name}-${Date.now()}@example.com`;
  const password = "LiliDeco-E2E-2026!";

  const signup = await request.post("/v1/auth/signup", {
    data: {
      name: "Marchand E2E",
      studio: "Atelier E2E",
      email,
      password,
    },
  });
  expect(signup.status()).toBe(201);

  const signedIn = await request.get("/v1/auth/me");
  expect(signedIn.ok()).toBeTruthy();
  const tenant = (await signedIn.json()) as {
    organizationId: string;
    role: string;
  };
  expect(tenant.organizationId).not.toBe(
    "00000000-0000-4000-8000-000000000001",
  );
  expect(tenant.role).toBe("owner");

  expect((await request.post("/v1/auth/logout")).ok()).toBeTruthy();
  const afterLogout = (await (await request.get("/v1/auth/me")).json()) as {
    organizationId: string;
  };
  expect(afterLogout.organizationId).toBe(
    "00000000-0000-4000-8000-000000000001",
  );

  expect(
    (
      await request.post("/v1/auth/login", {
        data: { email, password },
      })
    ).ok(),
  ).toBeTruthy();
  const afterLogin = (await (await request.get("/v1/auth/me")).json()) as {
    organizationId: string;
  };
  expect(afterLogin.organizationId).toBe(tenant.organizationId);
});

test("landing and merchant dashboard expose the core promise", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Voyez vos objets chez vous/i }),
  ).toBeVisible();
  await expect(page.getByLabel("Image de l’objet 1")).toBeVisible();
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: /Bonjour, Lili/i }),
  ).toBeVisible();
  await expect(page.getByText("Vase Sable")).toBeVisible();
});

test("public demo starts without a preselected product catalog", async ({
  page,
}) => {
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: /Voyez vos objets chez vous/i }),
  ).toBeVisible();
  await expect(page.getByLabel("Image de l’objet 1")).toBeVisible();
  await expect(page.getByRole("button", { name: /Vase Sable/i })).toHaveCount(
    0,
  );
  await expect(page.locator(".simple-demo-error")).toHaveCount(0);
});

test("guest access exposes the demo catalog but keeps admin protected", async ({
  request,
}) => {
  const session = await request.post("/v1/auth/guest");
  expect(session.status()).toBe(201);

  const me = (await (await request.get("/v1/auth/me")).json()) as {
    role: string;
  };
  expect(me.role).toBe("guest");

  const products = (await (await request.get("/v1/products")).json()) as Array<{
    id: string;
    name: string;
    objectType: string;
  }>;
  expect(products.length).toBeGreaterThanOrEqual(8);
  expect(products.map((product) => product.name)).toEqual(
    expect.arrayContaining([
      "Vase Sable",
      "Lampe Boman",
      "Miroir Rococo",
      "Table basse Noyer",
      "Plante Plectranthus",
      "Tapis Sienne",
      "Horloge Blanche",
      "Affiche Mucha",
    ]),
  );
  expect(
    products.find((product) => product.name === "Plante Plectranthus")
      ?.objectType,
  ).toBe("plant");

  expect((await request.get("/v1/admin/overview")).status()).toBe(403);
  expect(
    (
      await request.patch("/v1/products/11111111-1111-4111-8111-111111111111", {
        data: { name: "Interdit" },
      })
    ).status(),
  ).toBe(404);

  const created = await request.post("/v1/products", {
    data: {
      name: "Objet invité E2E",
      description: "Objet créé avec les droits limités de la page publique.",
      objectType: "plant",
      widthCm: 30,
      heightCm: 60,
      depthCm: 30,
      material: "Terre cuite",
      generationInstructions: "Conserver le feuillage.",
      placementType: "floor",
      lightingProfile: {},
      buyUrl: null,
    },
  });
  expect(created.status()).toBe(201);
});

test("object form adapts dimensions to the selected object type", async ({
  page,
}) => {
  await page.goto("/objet");
  await expect(
    page.getByRole("heading", { name: /Préparez votre objet/i }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Tapis/i }).check();
  await expect(
    page.getByRole("spinbutton", { name: "Longueur", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Épaisseur", exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Meuble/i }).check();
  await expect(
    page.getByRole("spinbutton", { name: "Profondeur", exact: true }),
  ).toBeVisible();

  await page.getByRole("radio", { name: /Plante en pot/i }).check();
  await page.getByLabel("Image PNG de l’objet").setInputFiles({
    name: "plante-invitee.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  const productName = `Plante invitée ${test.info().project.name} ${Date.now()}`;
  await page.getByLabel("Nom").fill(productName);
  await page.getByLabel("Matière principale").fill("Terre cuite");
  await page
    .getByRole("spinbutton", { name: "Diamètre", exact: true })
    .fill("32");
  await page
    .getByRole("spinbutton", { name: "Hauteur", exact: true })
    .fill("58");
  await page.getByRole("button", { name: /Préparer cet objet/i }).click();
  await expect(page).toHaveURL(/\?product=/, { timeout: 60_000 });
  await expect(
    page.getByRole("heading", { name: /Voyez vos objets chez vous/i }),
  ).toBeVisible();
  await expect(page.getByText("Droits marchand requis")).toHaveCount(0);
});

test("a source photo over 4 MB is optimized before upload", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/demo");
  await page.getByLabel("Image de l’objet 1").setInputFiles({
    name: "vase-demo.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  await page.getByLabel("Hauteur de l’objet 1 en centimètres").fill("42");
  await page.getByLabel("Longueur de l’objet 1 en centimètres").fill("24");
  await page.getByRole("button", { name: "Continuer avec 1 objet" }).click();
  await expect(
    page.getByRole("heading", { name: /Ajoutez la photo du lieu/i }),
  ).toBeVisible({ timeout: 60_000 });
  const largePhoto = await largeRoomFixture();
  expect(largePhoto.length).toBeGreaterThan(4_500_000);
  await page.getByLabel("Photo du lieu de réception").setInputFiles({
    name: "piece-telephone.png",
    mimeType: "image/png",
    buffer: largePhoto,
  });
  await expect(
    page.getByRole("button", { name: "Placer le point 1 dans l’image" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".simple-demo-error")).toHaveCount(0);
});

test("required customer journey reaches a successful mock render", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/app/products/new");
  await page.getByLabel("Image PNG de l’objet").setInputFiles({
    name: "vase-e2e.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  await page.getByLabel("Vue trois-quarts").setInputFiles({
    name: "vase-e2e-trois-quarts.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  const productName = `Vase E2E ${Date.now()}`;
  await page.getByLabel("Nom").fill(productName);
  await page.getByText("Options facultatives").click();
  await page.getByLabel("SKU").fill(`E2E-${Date.now()}`);
  await page.getByLabel("Matière principale").fill("céramique mate");
  await page
    .getByRole("spinbutton", { name: "Diamètre", exact: true })
    .fill("24");
  await page
    .getByRole("spinbutton", { name: "Hauteur", exact: true })
    .fill("42");
  await page
    .getByLabel("Indications pour le rendu IA")
    .fill("Ambiance naturelle, ombre douce et photographie éditoriale.");
  await page.getByRole("button", { name: /Préparer cet objet/i }).click();
  await expect(page).toHaveURL(/\/app\/catalog/);
  await expect(page.getByText(productName)).toBeVisible();

  const createdProduct = await page.evaluate(async (name) => {
    const response = await fetch("/v1/products");
    const products = (await response.json()) as Array<{
      id: string;
      name: string;
      generationInstructions: string;
      views: Array<{ type: string }>;
    }>;
    return products.find((product) => product.name === name);
  }, productName);
  const productId = createdProduct?.id;
  expect(productId).toBeTruthy();
  expect(createdProduct?.generationInstructions).toContain("ombre douce");
  expect(createdProduct?.views.map((view) => view.type)).toEqual(
    expect.arrayContaining(["front", "three_quarter"]),
  );

  await page.goto(`/app/products/${productId}`);
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
  await expect(page.getByLabel("Instructions de génération IA")).toHaveValue(
    /ombre douce/,
  );

  await page.goto(`/visualizer/atelier-lili/${productId}`);
  await expect(
    page.getByRole("heading", { name: /Montrez\. Demandez\. Visualisez/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(productName) }),
  ).toBeVisible();
  const viewerAccess = await page.evaluate(async () => {
    const productsResponse = await fetch("/v1/products");
    const products = (await productsResponse.json()) as Array<{ id: string }>;
    const mutation = await fetch("/v1/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return {
      productIds: products.map((product) => product.id),
      mutationStatus: mutation.status,
    };
  });
  expect(viewerAccess.productIds).toEqual([productId]);
  expect(viewerAccess.mutationStatus).toBe(403);

  await page.getByLabel("Photo de votre pièce").setInputFiles({
    name: "piece-e2e.png",
    mimeType: "image/png",
    buffer: await roomFixture(),
  });
  await expect(
    page.getByRole("heading", {
      name: "Dites simplement ce que vous voulez.",
    }),
  ).toBeVisible();
  await page
    .getByLabel("Votre demande")
    .fill("Pose ce vase sur la table à l’endroit le plus naturel.");
  await page.getByRole("button", { name: /Créer le rendu/i }).click();
  await expect(
    page.getByRole("heading", { name: "Voilà le résultat." }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Acheter" })).toBeVisible();
});

test("simple demo records the clicked coordinates and adds the object", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/demo");
  await page.getByLabel("Image de l’objet 1").setInputFiles({
    name: "vase-simple.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  await page
    .getByRole("button", { name: "Longueur + largeur", exact: true })
    .click();
  await page.getByLabel("Longueur de l’objet 1 en centimètres").fill("30");
  await page.getByLabel("Largeur de l’objet 1 en centimètres").fill("18");
  await page.getByRole("button", { name: "Continuer avec 1 objet" }).click();
  await expect(page.getByText(/Reculez d’au moins 1,5 mètre/i)).toBeVisible({
    timeout: 60_000,
  });
  await page.getByLabel("Photo du lieu de réception").setInputFiles({
    name: "piece-ajout.png",
    mimeType: "image/png",
    buffer: await roomFixture(),
  });
  const picker = page.getByRole("button", {
    name: "Placer le point 1 dans l’image",
  });
  await expect(picker).toBeVisible();
  await picker.click({ position: { x: 320, y: 230 } });
  await expect(page.getByText(/Point 1 : x \d+ · y \d+/)).toBeVisible();

  const renderResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/v1/renders/final",
  );
  await page.getByRole("button", { name: /Générer avec GPT Image 2/i }).click();
  const response = await renderResponse;
  const body = response.request().postDataJSON() as {
    workflow: string;
    mode: string;
    placementPoint: { x: number; y: number };
    simplePlacements: Array<{
      productId: string;
      placementPoint: { x: number; y: number };
      dimensionPair:
        | { mode: "height_length"; heightCm: number; lengthCm: number }
        | { mode: "length_width"; lengthCm: number; widthCm: number };
    }>;
  };
  expect(response.status()).toBe(201);
  expect(body).toMatchObject({
    workflow: "simple_point",
    mode: "insert",
  });
  expect(body.placementPoint.x).toBeGreaterThan(0);
  expect(body.placementPoint.y).toBeGreaterThan(0);
  expect(body.simplePlacements).toHaveLength(1);
  expect(body.simplePlacements[0]?.dimensionPair).toEqual({
    mode: "length_width",
    lengthCm: 30,
    widthCm: 18,
  });
  await expect(
    page.getByRole("heading", { name: "Votre visualisation" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByAltText("Visualisation après")).toBeVisible();
});

test("simple demo supports three numbered points and can reposition them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/demo");
  await page.getByLabel("Image de l’objet 1").setInputFiles({
    name: "vase-1.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  await page.getByLabel("Hauteur de l’objet 1 en centimètres").fill("42");
  await page.getByLabel("Longueur de l’objet 1 en centimètres").fill("24");

  await page.getByRole("button", { name: /Ajouter un objet/ }).click();
  await page.getByLabel("Image de l’objet 2").setInputFiles({
    name: "vase-2.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  await page
    .getByRole("button", { name: "Longueur + largeur", exact: true })
    .nth(1)
    .click();
  await page.getByLabel("Longueur de l’objet 2 en centimètres").fill("28");
  await page.getByLabel("Largeur de l’objet 2 en centimètres").fill("16");

  await page.getByRole("button", { name: /Ajouter un objet/ }).click();
  await page.getByLabel("Image de l’objet 3").setInputFiles({
    name: "vase-3.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  await page.getByLabel("Hauteur de l’objet 3 en centimètres").fill("36");
  await page.getByLabel("Longueur de l’objet 3 en centimètres").fill("20");
  await expect(
    page.getByRole("button", { name: /Ajouter un objet/ }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Continuer avec 3 objets" }).click();
  await page.getByLabel("Photo du lieu de réception").setInputFiles({
    name: "piece-multi-objets.png",
    mimeType: "image/png",
    buffer: await roomFixture(),
  });
  await page
    .getByRole("button", { name: "Placer le point 1 dans l’image" })
    .click({ position: { x: 90, y: 120 } });
  await page
    .getByRole("button", { name: "Placer le point 2 dans l’image" })
    .click({ position: { x: 170, y: 150 } });
  await page
    .getByRole("button", { name: "Placer le point 3 dans l’image" })
    .click({ position: { x: 240, y: 180 } });
  await expect(page.getByTestId("placement-dot")).toHaveCount(3);

  await page.getByRole("button", { name: "Replacer les points" }).click();
  await expect(page.getByTestId("placement-dot")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Placer le point 1 dans l’image" })
    .click({ position: { x: 100, y: 125 } });
  await page
    .getByRole("button", { name: "Placer le point 2 dans l’image" })
    .click({ position: { x: 180, y: 155 } });
  await page
    .getByRole("button", { name: "Placer le point 3 dans l’image" })
    .click({ position: { x: 250, y: 185 } });

  const renderResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/v1/renders/final",
  );
  await page.getByRole("button", { name: /Générer avec GPT Image 2/i }).click();
  const response = await renderResponse;
  const body = response.request().postDataJSON() as {
    workflow: string;
    mode: string;
    simplePlacements: Array<{
      productId: string;
      placementPoint: { x: number; y: number };
      dimensionPair:
        | { mode: "height_length"; heightCm: number; lengthCm: number }
        | { mode: "length_width"; lengthCm: number; widthCm: number };
    }>;
  };
  expect(response.status()).toBe(201);
  expect(body).toMatchObject({
    workflow: "simple_point",
    mode: "insert",
  });
  expect(body.simplePlacements).toHaveLength(3);
  expect(
    body.simplePlacements.map((placement) => placement.dimensionPair),
  ).toEqual([
    { mode: "height_length", heightCm: 42, lengthCm: 24 },
    { mode: "length_width", lengthCm: 28, widthCm: 16 },
    { mode: "height_length", heightCm: 36, lengthCm: 20 },
  ]);
  await expect(
    page.getByRole("heading", { name: "Votre visualisation" }),
  ).toBeVisible({ timeout: 30_000 });
});
