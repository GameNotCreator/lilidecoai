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

test("public demo establishes a restricted viewer session", async ({ page }) => {
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: /Voyez l’objet/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Vase Sable/i }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: /Créer et préparer/i }).click();
  await expect(page).toHaveURL(/\/app\/catalog/);
  await expect(page.getByText(productName)).toBeVisible();

  const productId = await page.evaluate(async (name) => {
    const response = await fetch("/v1/products");
    const products = (await response.json()) as Array<{
      id: string;
      name: string;
    }>;
    return products.find((product) => product.name === name)?.id;
  }, productName);
  expect(productId).toBeTruthy();

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
    page.getByRole("heading", { name: "Surface & échelle" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Mode rapide/i }).click();
  await page.getByRole("button", { name: /Valider la surface/i }).click();
  await expect(
    page.getByRole("heading", { name: "Ajustez le placement" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Générer l’aperçu/i }).click();
  await expect(page.getByText("Rendu accepté")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("link", { name: "Acheter" })).toBeVisible();
});
