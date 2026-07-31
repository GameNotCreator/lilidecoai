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
    page.getByRole("heading", { name: /Imaginez-le chez vous/i }),
  ).toBeVisible();
  await expect(page.getByText(/Aucune génération OpenAI/i)).toBeVisible();
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: /Bonjour, Lili/i }),
  ).toBeVisible();
  await expect(page.getByText("Vase Sable")).toBeVisible();
});

test("public demo establishes a restricted viewer session", async ({
  page,
}) => {
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: /Voyez l’objet/i }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Vase Sable/i })).toBeVisible();
  await expect(page.locator(".studio-error")).toHaveCount(0);
});

test("a source photo over 4 MB is optimized before upload", async ({
  page,
}) => {
  await page.goto("/demo");
  const largePhoto = await largeRoomFixture();
  expect(largePhoto.length).toBeGreaterThan(4_500_000);
  await page.locator('input[type="file"]').setInputFiles({
    name: "piece-telephone.png",
    mimeType: "image/png",
    buffer: largePhoto,
  });
  await expect(
    page.getByRole("heading", { name: "Placez le point rouge" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".studio-error")).toHaveCount(0);
});

test("required customer journey reaches a successful mock render", async ({
  page,
}) => {
  await page.goto("/app/products/new");
  await page.locator('input[type="file"]').setInputFiles({
    name: "vase-e2e.png",
    mimeType: "image/png",
    buffer: await productFixture(),
  });
  const productName = `Vase E2E ${Date.now()}`;
  await page.getByLabel("Nom").fill(productName);
  await page.getByLabel("SKU").fill(`E2E-${Date.now()}`);
  await page.getByLabel("Matériau").fill("céramique mate");
  await page.getByLabel("Largeur").fill("24");
  await page.getByLabel("Hauteur").fill("42");
  await page.getByLabel("Profondeur").fill("24");
  await page
    .getByLabel("Instructions de génération IA")
    .fill("Ambiance naturelle, ombre douce et photographie éditoriale.");
  await page.getByRole("button", { name: /Créer et préparer/i }).click();
  await expect(page).toHaveURL(/\/app\/catalog/);
  await expect(page.getByText(productName)).toBeVisible();

  const createdProduct = await page.evaluate(async (name) => {
    const response = await fetch("/v1/products");
    const products = (await response.json()) as Array<{
      id: string;
      name: string;
      generationInstructions: string;
    }>;
    return products.find((product) => product.name === name);
  }, productName);
  const productId = createdProduct?.id;
  expect(productId).toBeTruthy();
  expect(createdProduct?.generationInstructions).toContain("ombre douce");

  await page.goto(`/app/products/${productId}`);
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
  await expect(page.getByLabel("Instructions de génération IA")).toHaveValue(
    /ombre douce/,
  );

  await page.goto(`/visualizer/atelier-lili/${productId}`);
  await expect(
    page.getByRole("heading", { name: /Voyez l’objet/i }),
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

  await page.locator('input[type="file"]').setInputFiles({
    name: "piece-e2e.png",
    mimeType: "image/png",
    buffer: await roomFixture(),
  });
  await expect(
    page.getByRole("heading", { name: "Placez le point rouge" }),
  ).toBeVisible();
  const roomPlacement = page.getByRole("button", {
    name: "Placer le point rouge sur la pièce",
  });
  await roomPlacement.click({ position: { x: 100, y: 100 } });
  await expect(page.getByTestId("placement-dot")).toBeVisible();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("button", { name: /Générer à cet endroit/i }).click();
  await expect(page.getByText("Rendu accepté")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("link", { name: "Acheter" })).toBeVisible();
});
