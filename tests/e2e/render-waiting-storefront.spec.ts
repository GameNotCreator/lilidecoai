import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const productId = "93908557-302a-4ddb-8e8a-9dd1709b4e18";
const renderId = "11111111-1111-4111-8111-111111111115";
const roomUrl = "/render-waiting-ui/room.png";

for (const width of [320, 375, 1280]) {
  test(`storefront waiting ${width}px: photo skeleton, honest steps and tracking recovery`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== (width === 1280 ? "chromium" : "mobile"),
      "One browser project per viewport.",
    );
    await page.setViewportSize({ width, height: 844 });
    const room = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#ece9e4" },
    })
      .png()
      .toBuffer();
    const productPhoto = await readFile(
      "apps/web/tests/fixtures/catalogue/grenade-noire-blanche.jpg",
    );
    await page.route("**/api/storefront/products", (route) =>
      route.fulfill({
        json: {
          store: { name: "ByLiliDeco" },
          products: [
            {
              id: productId,
              name: "Grenade décorative noire et blanche",
              description: "Objet ByLiliDeco.",
              objectType: "other",
              widthCm: 14,
              heightCm: 14,
              depthCm: 14,
              material: "Céramique",
              placementType: "table",
              priceCents: 11500,
              currency: "TND",
              stock: null,
              brand: "ByLiliDeco",
              assetUrl: "/render-waiting-ui/product.jpg",
              visualizationAvailable: true,
            },
          ],
          visualization: { available: true },
        },
      }),
    );
    await page.route("**/render-waiting-ui/*", (route) =>
      route.fulfill({
        body: route.request().url().endsWith("product.jpg")
          ? productPhoto
          : room,
        contentType: route.request().url().endsWith("product.jpg")
          ? "image/jpeg"
          : "image/png",
      }),
    );
    await page.route("**/api/storefront/session", (route) =>
      route.fulfill({
        json: { accessToken: "browser-ui-fixture-no-provider" },
      }),
    );
    await page.route("**/v1/scenes", (route) =>
      route.fulfill({
        status: 201,
        json: {
          id: "11111111-1111-4111-8111-111111111116",
          imageUrl: roomUrl,
          widthPx: 800,
          heightPx: 600,
        },
      }),
    );
    let stage = "compositing";
    let acceptedAt = new Date(Date.now() - 120_000).toISOString();
    let expired = false;
    let trackingAvailable = true;
    let admissions = 0;
    const render = () => ({
      id: renderId,
      status: expired
        ? "failed"
        : stage === "completed"
          ? "succeeded"
          : "processing",
      provider: "browser-fixture",
      model: "no-provider",
      requestedSize: "800x600",
      resultUrl: stage === "completed" ? roomUrl : null,
      compositeUrl: roomUrl,
      pipelineState:
        stage === "completed"
          ? "completed"
          : stage === "quality_check"
            ? "quality_check"
            : "analyzing_scene",
      placement: { pipelineStage: stage },
      qualityScore: null,
      creditCharged: false,
      promptVersion: "storefront-placement-review-v1",
      engineVersions: {
        placementGeometry: "simple-placement-v1",
        composite: "composite-v3/contact-light-v6",
        scaleEstimation: "scale-v3/storefront-placement-v1",
        quality: "storefront-placement-review-v1",
        prompt: "storefront-placement-review-v1",
        mockMode: false,
        imageQuality: "n/a",
        editModel: "deterministic-source-composite",
        visionModel: "vision-fixture-no-provider",
      },
      createdAt: acceptedAt,
      execution: {
        version: "v1",
        deadlineAt: new Date(Date.parse(acceptedAt) + 180_000).toISOString(),
        attempts: 1,
        retrying: false,
      },
      error: expired ? "Le délai maximal de 3 minutes est atteint." : null,
    });
    // Every render request is intercepted: this is UI behavior validation,
    // without a worker, paid provider, real order, or qualified output claim.
    await page.route("**/v1/renders/**", async (route) => {
      if (route.request().method() === "POST") {
        admissions += 1;
        await route.fulfill({ status: 201, json: render() });
      } else if (!trackingAvailable) {
        await route.fulfill({
          status: 503,
          json: { detail: "Temporary UI fixture outage" },
        });
      } else await route.fulfill({ json: render() });
    });
    await page.goto(`/visualiser?products=${productId}`);
    await page.getByRole("checkbox", { name: /J’autorise/ }).check();
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: "room.png", mimeType: "image/png", buffer: room });
    const placement = page.getByRole("button", { name: /Placer Grenade/ });
    await expect(placement).toBeVisible();
    await placement.click({ position: { x: 60, y: 90 } });
    await page.getByRole("button", { name: "Créer ma visualisation" }).click();
    const panel = page.locator(".render-progress-panel");
    await expect(
      panel.getByRole("heading", { name: "Placement de vos objets" }),
    ).toBeVisible();
    await expect(
      panel.getByAltText("Aperçu provisoire du placement de vos objets"),
    ).toBeVisible();
    await expect(panel.locator(".render-progress-image")).toHaveAttribute(
      "data-loaded",
      "true",
    );
    const skeleton = panel.locator(".skeleton");
    await expect(skeleton).toBeVisible();
    await expect(panel.getByText(/Temps écoulé/)).not.toBeVisible();
    await expect(panel.locator('[data-state="complete"]')).toHaveCount(1);
    await expect(panel.locator('[data-state="active"]')).toHaveCount(1);
    await expect(panel.getByRole("listitem")).toHaveCount(3);
    expect(await panel.innerText()).not.toMatch(/lumière|ombres|réaliste/);
    await expect(panel.getByText(/Jusqu’à 3 minutes/)).toBeVisible();
    await panel.getByText("Détails de la demande", { exact: true }).click();
    await expect(panel.getByText(/Temps écoulé/)).toBeVisible();
    await panel.getByText("Détails de la demande", { exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await skeleton.evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");
    expect(
      await panel
        .locator(".render-progress-heading .loading")
        .evaluate((node) => getComputedStyle(node).maskImage),
    ).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await panel.screenshot({
      path: `artifacts/render-waiting-2026-09-30/storefront-${width}.png`,
      animations: "disabled",
    });
    trackingAvailable = false;
    await expect(
      panel.getByText("Dernière étape confirmée", { exact: true }),
    ).toBeVisible();
    await expect(panel.locator(".render-progress-image-label")).toHaveText(
      "Reconnexion au suivi",
    );
    expect(
      await skeleton.evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");
    await expect(
      panel.getByRole("heading", { name: "Placement de vos objets" }),
    ).toBeVisible();
    trackingAvailable = true;
    stage = "quality_check";
    await panel.getByRole("button", { name: "Vérifier maintenant" }).click();
    await expect(
      panel.getByRole("heading", { name: "Vérification du placement" }),
    ).toBeVisible();
    await expect(
      panel.getByText("Dernière étape confirmée", { exact: true }),
    ).toHaveCount(0);
    if (width === 320) {
      // A server response with an already exhausted request budget must stop
      // the waiting clock, request its latest state, and never invent failure.
      acceptedAt = new Date(Date.now() - 181_000).toISOString();
      await expect(
        panel.getByText("Le délai de 3 minutes est atteint.", { exact: true }),
      ).toBeVisible();
      await expect(panel.locator(".render-progress-image-label")).toHaveText(
        "Vérification de la demande",
      );
      expect(
        await skeleton.evaluate((node) => getComputedStyle(node).animationName),
      ).toBe("none");
      await expect(
        page.getByRole("heading", {
          name: "Nous n’avons pas pu terminer cette visualisation.",
        }),
      ).toHaveCount(0);
      await panel.getByText("Détails de la demande", { exact: true }).click();
      await expect(
        panel.getByText("Limite atteinte · 3 min", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByText(/Temps écoulé/)).toHaveCount(0);
      await panel.screenshot({
        path: "artifacts/render-waiting-2026-09-30/deadline-320.png",
        animations: "disabled",
      });
      expired = true;
      await panel.getByRole("button", { name: "Vérifier maintenant" }).click();
      await expect(
        page.getByRole("heading", {
          name: "Nous n’avons pas pu terminer cette visualisation.",
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Le délai maximal de 3 minutes est atteint.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(panel).toHaveCount(0);
      expect(admissions).toBe(1);
      return;
    }
    stage = "completed";
    await expect(
      page.getByRole("heading", { name: "Bienvenue chez vous." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Bienvenue chez vous." }),
    ).toBeFocused();
    await expect(panel).toHaveCount(0);
    expect(admissions).toBe(1);
  });
}
