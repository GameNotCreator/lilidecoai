import { expect, test } from "@playwright/test";

const productId = "11111111-1111-4111-8111-111111111111";

test("checkout validates, preserves a retry key, confirms without sending email and keeps personal data out of URLs and storage", async ({
  page,
}) => {
  // UI-only simulation. The server order endpoint is never reached by this test.
  const payloads: Record<string, unknown>[] = [];
  await page.route("**/api/storefront/products", async (route) => {
    await route.fulfill({
      json: {
        store: { name: "ByLiliDeco" },
        visualization: { available: false },
        products: [
          {
            id: productId,
            name: "Grenade céramique",
            description: "Objet décoratif",
            objectType: "vase",
            widthCm: 14,
            heightCm: 14,
            depthCm: 14,
            material: "Céramique",
            placementType: "table",
            priceCents: 11500,
            currency: "TND",
            stock: null,
            visualizationAvailable: false,
          },
        ],
      },
    });
  });
  await page.route("**/api/storefront/orders", async (route) => {
    expect(route.request().method()).toBe("POST");
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) await route.abort("failed");
    else
      await route.fulfill({
        status: 201,
        json: {
          reference: "BLD-TEST-LOCAL",
          recorded: true,
          notification: "sent",
        },
      });
  });
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem(
        "lilideco-storefront-cart-v1",
        JSON.stringify([{ productId: id, quantity: 2 }]),
      );
    },
    { id: productId },
  );
  await page.goto("/checkout");
  await expect(
    page.getByRole("heading", { name: "Parlons de vos envies." }),
  ).toBeVisible();
  await expect(
    page.getByText("Grenade céramique", { exact: true }),
  ).toBeVisible();
  const submit = page.getByRole("button", { name: "Transmettre ma demande" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
  await expect(page.locator("#checkout-fullName")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(payloads).toHaveLength(0);
  await page
    .getByLabel("Nom complet", { exact: true })
    .fill("Client test navigateur");
  await page.getByLabel("Téléphone", { exact: true }).fill("+216 22 000 099");
  await page.getByLabel("Ville", { exact: true }).fill("Tunis");
  await page
    .getByLabel("Email (facultatif)", { exact: true })
    .fill("browser-test@example.test");
  await page.getByRole("checkbox").check();
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "connexion a été interrompue",
  );
  await expect(page.getByLabel("Nom complet", { exact: true })).toHaveValue(
    "Client test navigateur",
  );
  await submit.click();
  await expect(
    page.getByRole("heading", { name: "Votre demande est enregistrée." }),
  ).toBeFocused();
  await expect(page.getByText("BLD-TEST-LOCAL", { exact: true })).toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[0]!.idempotencyKey).toBe(payloads[1]!.idempotencyKey);
  expect(payloads[0]).not.toHaveProperty("subtotalCents");
  expect(payloads[0]!.items).toEqual([{ productId, quantity: 2 }]);
  expect(page.url()).toMatch(/\/checkout$/);
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(storage).not.toContain("Client test navigateur");
  expect(storage).not.toContain("browser-test@example.test");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
