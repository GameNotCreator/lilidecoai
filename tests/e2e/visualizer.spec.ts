import path from "node:path";
import { expect, test } from "@playwright/test";

test("landing and merchant dashboard expose the core promise", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Imaginez-le chez vous/i })).toBeVisible();
  await expect(page.getByText(/Aucune génération OpenAI/i)).toBeVisible();
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /Bonjour, Lili/i })).toBeVisible();
  await expect(page.getByText("Vase Sable")).toBeVisible();
});

test("required customer journey reaches a successful mock render", async ({ page }) => {
  await page.goto("/app/products/new");
  const productImage = path.resolve("services/api/storage/demo/vase-sable.png");
  await page.locator('input[type="file"]').setInputFiles(productImage);
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

  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: /Voyez l’objet/i })).toBeVisible();
  const demoImage = path.resolve("services/api/storage/demo/demo-room.png");
  await page.locator('input[type="file"]').setInputFiles(demoImage);
  await expect(page.getByRole("heading", { name: "Surface & échelle" })).toBeVisible();
  await page.getByRole("button", { name: /Mode rapide/i }).click();
  await page.getByRole("button", { name: /Valider la surface/i }).click();
  await expect(page.getByRole("heading", { name: "Ajustez le placement" })).toBeVisible();
  await page.getByRole("button", { name: /Générer l’aperçu/i }).click();
  await expect(page.getByText("Rendu accepté")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Acheter" })).toBeVisible();
});
