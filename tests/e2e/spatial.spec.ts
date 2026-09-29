import { expect, test } from "@playwright/test";
import { SignJWT } from "jose";
import sharp from "sharp";

const organizationId = "00000000-0000-4000-8000-000000000001";
test("anonymous demo cannot open the internal spatial pilot", async ({
  request,
}) => {
  expect((await request.get("/app/spatial")).status()).toBe(404);
  expect(
    await (await request.get("/v1/render-capabilities")).json(),
  ).toMatchObject({ spatial: false });
});

for (const objectType of ["furniture", "rug"] as const)
  test(`internal ${objectType} preview rotates, measures and blocks overflow`, async ({
    page,
    context,
  }) => {
    const token = await new SignJWT({ organizationId, role: "owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("spatial-test")
      .setIssuer("lilidecoai")
      .setAudience("lilidecoai-web")
      .setExpirationTime("1h")
      .sign(
        new TextEncoder().encode("spatial-e2e-isolated-test-secret-only-2026"),
      );
    await context.addCookies([
      { name: "lili_session", value: token, url: "http://127.0.0.1:3100" },
    ]);
    const room = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "#d0c0a0" },
    })
      .png()
      .toBuffer();
    await page.route("**/spatial-fixture.png", (route) =>
      route.fulfill({ contentType: "image/png", body: room }),
    );
    const requests: Array<Record<string, any>> = [];
    let fits = true;
    let sceneUnavailable = false;
    let sceneExpired = false;
    let renderStatus = "queued";
    let submissions = 0;
    let admittedKey: string | null = null;
    let admittedRetryKey: string | null = null;
    let retrySubmissions = 0;
    const retryBodies: string[] = [];
    const readIds: string[] = [];
    const submittedBodies: string[] = [];
    let renderReads = 0;
    let analyses = 0;
    const sceneId = "22222222-2222-4222-8222-222222222222";
    const renderId = "33333333-3333-4333-8333-333333333333";
    const retryId = "44444444-4444-4444-8444-444444444444";
    await page.route("**/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = {};
      if (path === "/v1/products")
        json = [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Chaise test",
            objectType,
            widthCm: 42,
            heightCm: 80,
            depthCm: 45,
            material: "wood",
            placementType: objectType === "rug" ? "floor" : "shelf",
            status: "ready",
            assetUrl: "/spatial-fixture.png",
          },
        ];
      else if (path === "/v1/credits")
        json = { balance: renderStatus === "succeeded" ? 9 : 10 };
      else if (path === "/v1/render-capabilities") json = { spatial: true };
      else if (path === "/v1/scenes" || path === `/v1/scenes/${sceneId}`) {
        if (sceneUnavailable) {
          await route.fulfill({
            status: 503,
            json: { detail: "Connexion interrompue" },
          });
          return;
        }
        json = {
          id: sceneId,
          status: "ready",
          expiresAt: new Date(
            Date.now() + (sceneExpired ? -1000 : 3600_000),
          ).toISOString(),
          imageUrl: "/spatial-fixture.png",
          widthPx: 600,
          heightPx: 400,
          analysis: {},
        };
      } else if (
        path === "/v1/renders/final" ||
        path === `/v1/renders/${renderId}` ||
        path === `/v1/renders/${retryId}` ||
        path === `/v1/renders/${renderId}/retry` ||
        path.startsWith("/v1/renders/by-request/")
      ) {
        if (
          path.startsWith("/v1/renders/by-request/") &&
          ![admittedKey, admittedRetryKey].includes(
            decodeURIComponent(path.split("/").at(-1)!),
          )
        ) {
          await route.fulfill({
            status: 404,
            json: { detail: "Not recorded yet" },
          });
          return;
        }
        if (route.request().method() === "POST") {
          const isRetry = path.endsWith("/retry");
          if (isRetry) {
            retrySubmissions++;
            retryBodies.push(route.request().postData()!);
            renderStatus = "queued";
          } else {
            submissions++;
            submittedBodies.push(route.request().postData()!);
          }
          const body = route.request().postDataJSON();
          const storedBeforeSend = await page.evaluate(() =>
            JSON.parse(
              sessionStorage.getItem(
                "lili:spatial-studio:v1:00000000-0000-4000-8000-000000000001:spatial-test",
              )!,
            ),
          );
          if (isRetry) {
            expect(storedBeforeSend.pendingRequest).toMatchObject({
              kind: "retry",
              sourceRenderId: renderId,
              idempotencyKey: body.idempotencyKey,
            });
            expect(Object.keys(body)).toEqual(["idempotencyKey"]);
            if (objectType === "furniture" || retrySubmissions > 1)
              admittedRetryKey = body.idempotencyKey;
          } else {
            expect(storedBeforeSend.pendingRequest).toEqual(body);
            if (objectType === "furniture" || submissions > 1)
              admittedKey = body.idempotencyKey;
          }
          if ((isRetry ? retrySubmissions : submissions) === 1) {
            await route.abort("failed");
            return;
          }
        } else renderReads++;
        const responseId =
          path === `/v1/renders/${retryId}` ||
          path.endsWith("/retry") ||
          (path.startsWith("/v1/renders/by-request/") &&
            decodeURIComponent(path.split("/").at(-1)!) === admittedRetryKey)
            ? retryId
            : renderId;
        if (route.request().method() === "GET") readIds.push(responseId);
        json = {
          id: responseId,
          engine: "spatial",
          status: renderStatus,
          provider: "mock",
          model: "fixture",
          requestedSize: "auto",
          resultUrl:
            renderStatus === "succeeded" ? "/spatial-fixture.png" : null,
          qualityScore: null,
          creditCharged: renderStatus === "succeeded",
          createdAt: new Date().toISOString(),
          placement: {
            sceneId,
            productId: "11111111-1111-4111-8111-111111111111",
          },
        };
      } else if (path.endsWith("/spatial-analysis")) {
        analyses++;
        json = { ready: true };
      } else if (path.endsWith("/spatial-preview")) {
        const body = route.request().postDataJSON();
        requests.push(body);
        json = {
          sceneFingerprint: "a".repeat(64),
          surfaceId: "surface-0",
          calibration: body.reference ? "reference_scaled" : "approximate",
          corners: Array.from({ length: 8 }, (_, i) => ({
            x: 0.4 + (i % 2) * 0.2,
            y: 0.3 + (i % 4) * 0.1,
          })),
          fits,
          supportFits: true,
          assumptions: ["Synthetic browser fixture"],
        };
      }
      await route.fulfill({ json });
    });
    await page.goto("/app/spatial");
    await page
      .getByLabel("Photo de votre pièce")
      .setInputFiles({ name: "room.png", mimeType: "image/png", buffer: room });
    const photo = page.getByRole("button", {
      name: "Placer le point rouge sur la pièce",
    });
    await expect(photo).toBeVisible();
    if (objectType === "rug")
      await expect(
        page.getByText(/le point rouge indique le centre du tapis/),
      ).toBeVisible();
    const bounds = (await photo.boundingBox())!;
    if (objectType === "furniture") {
      await expect(
        page.getByRole("button", { name: "Étagère", exact: true }),
      ).toHaveClass(/active/);
      await page.getByRole("button", { name: "Table", exact: true }).click();
    }
    await photo.click({
      position: { x: bounds.width * 0.5, y: bounds.height * 0.8 },
    });
    await expect(
      page.getByLabel("Aperçu géométrique provisoire"),
    ).toBeVisible();
    if (objectType === "furniture") {
      await expect(
        page.getByRole("button", { name: "Table", exact: true }),
      ).toHaveClass(/active/);
      await expect.poll(() => requests.at(-1)?.surfaceType).toBe("tabletop");
    }
    const generate = page.getByRole("button", {
      name: "Créer le rendu final · 1 crédit",
    });
    await expect(generate).toBeEnabled();
    await page.getByRole("slider", { name: /Orientation/ }).fill("45");
    await expect.poll(() => requests.at(-1)?.yawDegrees).toBe(45);
    await page
      .getByRole("button", { name: "Indiquer une longueur connue" })
      .click();
    await expect(generate).toBeDisabled();
    await photo.click({
      position: { x: bounds.width * 0.3, y: bounds.height * 0.8 },
    });
    await photo.click({
      position: { x: bounds.width * 0.6, y: bounds.height * 0.8 },
    });
    await page.getByLabel("Longueur réelle en cm").fill("100");
    await page.getByRole("button", { name: "Appliquer la référence" }).click();
    await expect.poll(() => requests.at(-1)?.reference?.lengthCm).toBe(100);
    await expect(
      page.getByText(/Échelle ajustée à votre longueur/),
    ).toBeVisible();
    await expect(generate).toBeEnabled();
    const savedPlacement = requests.at(-1);
    await page.reload();
    await expect(page.getByRole("slider", { name: /Orientation/ })).toHaveValue(
      "45",
    );
    await expect(
      page.getByText(/Échelle ajustée à votre longueur/),
    ).toBeVisible();
    await expect(generate).toBeEnabled();
    await expect.poll(() => requests.at(-1)).toEqual(savedPlacement);
    fits = false;
    await page.getByRole("slider", { name: /Orientation/ }).fill("90");
    await expect(page.getByText(/Le produit dépasse la photo/)).toBeVisible();
    await expect(generate).toBeDisabled();
    fits = true;
    await page.getByRole("slider", { name: /Orientation/ }).fill("45");
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(
      page.getByRole("button", { name: "Réessayer la récupération" }),
    ).toBeVisible();
    expect(submissions).toBe(1);
    const pending = await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem(
          "lili:spatial-studio:v1:00000000-0000-4000-8000-000000000001:spatial-test",
        )!,
      ),
    );
    expect(pending.pendingRequest).toEqual(JSON.parse(submittedBodies[0]!));
    await page.reload();
    if (objectType === "rug") {
      await expect(
        page.getByRole("button", { name: "Renvoyer la demande enregistrée" }),
      ).toBeVisible();
      expect(submissions).toBe(1);
      // A read-only retry still cannot create a request.
      await page
        .getByRole("button", { name: "Réessayer la récupération" })
        .click();
      await expect(
        page.getByRole("button", { name: "Renvoyer la demande enregistrée" }),
      ).toBeVisible();
      expect(submissions).toBe(1);
      await page
        .getByRole("button", { name: "Renvoyer la demande enregistrée" })
        .click();
      await expect.poll(() => submittedBodies.length).toBe(2);
      expect(submittedBodies[1]).toBe(submittedBodies[0]);
    }
    await expect(page.locator('.studio-shell[data-step="3"]')).toBeVisible();
    const expectedSubmissions = objectType === "furniture" ? 1 : 2;
    expect(submissions).toBe(expectedSubmissions);
    const analysisCount = analyses;
    const previewCount = requests.length;
    await page.reload();
    await expect(page.locator('.studio-shell[data-step="3"]')).toBeVisible();
    expect(renderReads).toBeGreaterThan(0);
    expect(submissions).toBe(expectedSubmissions);
    expect(analyses).toBe(analysisCount);
    expect(requests).toHaveLength(previewCount);
    sceneUnavailable = true;
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Réessayer la récupération" }),
    ).toBeVisible();
    await expect(page.getByLabel("Photo de votre pièce")).toHaveCount(0);
    expect(submissions).toBe(expectedSubmissions);
    sceneUnavailable = false;
    await page
      .getByRole("button", { name: "Réessayer la récupération" })
      .click();
    await expect(page.locator('.studio-shell[data-step="3"]')).toBeVisible();
    renderStatus = "succeeded";
    await expect(page.getByRole("link", { name: "Télécharger" })).toBeVisible();
    await expect(page.getByLabel("Crédits disponibles")).toContainText(
      "9 crédits",
    );
    await page.reload();
    await expect(page.getByRole("link", { name: "Télécharger" })).toBeVisible();
    await expect(page.getByLabel("Crédits disponibles")).toContainText(
      "9 crédits",
    );
    expect(submissions).toBe(expectedSubmissions);
    expect(analyses).toBe(analysisCount);
    expect(requests).toHaveLength(previewCount);
    await page
      .getByRole("button", { name: "Nouvelle tentative", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Réessayer la récupération" }),
    ).toBeVisible();
    expect(retrySubmissions).toBe(1);
    expect(JSON.parse(retryBodies[0]!).idempotencyKey).not.toBe(
      JSON.parse(submittedBodies[0]!).idempotencyKey,
    );
    await page.reload();
    if (objectType === "rug") {
      await expect(
        page.getByRole("button", { name: "Renvoyer la demande enregistrée" }),
      ).toBeVisible();
      expect(retrySubmissions).toBe(1);
      await page
        .getByRole("button", { name: "Renvoyer la demande enregistrée" })
        .click();
      await expect.poll(() => retryBodies.length).toBe(2);
      expect(retryBodies[1]).toBe(retryBodies[0]);
    }
    await expect(page.locator('.studio-shell[data-step="3"]')).toBeVisible();
    await expect.poll(() => readIds.includes(retryId)).toBe(true);
    expect(retrySubmissions).toBe(expectedSubmissions);
    renderStatus = "succeeded";
    await expect(page.getByRole("link", { name: "Télécharger" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: "Télécharger" })).toBeVisible();
    expect(retrySubmissions).toBe(expectedSubmissions);
    expect(submissions).toBe(expectedSubmissions);
    expect(analyses).toBe(analysisCount);
    expect(requests).toHaveLength(previewCount);
    if (objectType === "furniture") {
      const otherToken = await new SignJWT({ organizationId, role: "owner" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("another-user")
        .setIssuer("lilidecoai")
        .setAudience("lilidecoai-web")
        .setExpirationTime("1h")
        .sign(
          new TextEncoder().encode(
            "spatial-e2e-isolated-test-secret-only-2026",
          ),
        );
      await context.addCookies([
        {
          name: "lili_session",
          value: otherToken,
          url: "http://127.0.0.1:3100",
        },
      ]);
      const previousReads = renderReads;
      await page.reload();
      await expect(page.getByLabel("Photo de votre pièce")).toBeVisible();
      expect(renderReads).toBe(previousReads);
    } else {
      sceneExpired = true;
      await page.reload();
      await expect(
        page.locator(".studio-shell").getByRole("alert"),
      ).toContainText("expiré");
      await page
        .getByRole("button", { name: "Ouvrir un nouveau studio" })
        .click();
      await expect(page.getByLabel("Photo de votre pièce")).toBeVisible();
      expect(submissions).toBe(expectedSubmissions);
    }
  });
