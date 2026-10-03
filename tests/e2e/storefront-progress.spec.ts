import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

const productId = "11111111-1111-4111-8111-111111111111";
const sceneId = "22222222-2222-4222-8222-222222222222";
const renderId = "33333333-3333-4333-8333-333333333333";
const image = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="#eee4d5"/><rect y="460" width="1000" height="340" fill="#bd9d80"/></svg>',
);

async function fixture(page: Page) {
  const createdAt = new Date().toISOString();
  const state = {
    broken: false,
    dropFirst: false,
    posts: [] as string[],
    render: {
      id: renderId,
      status: "processing",
      provider: "myarchitectai",
      model: "edit-by-prompt",
      requestedSize: "1024x1024",
      resultUrl: null as string | null,
      compositeUrl: "/fixture-room.svg",
      qualityScore: null,
      creditCharged: false,
      createdAt,
      pipelineState: "analyzing_scene",
      placement: { pipelineStage: "estimating_scale" },
      execution: {
        version: "v1",
        deadlineAt: new Date(Date.parse(createdAt) + 180_000).toISOString(),
        attempts: 1,
        retrying: false,
      },
      error: null as string | null,
    },
  };
  await page.route("**/fixture-room.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: image }),
  );
  await page.route("**/api/storefront/products", (route) =>
    route.fulfill({
      json: {
        store: { name: "LiliDéco" },
        visualization: { available: true },
        products: [
          {
            id: productId,
            name: "Vase Sable",
            objectType: "vase",
            widthCm: 18,
            heightCm: 26,
            depthCm: 18,
            material: "Grès",
            placementType: "table",
            visualizationAvailable: true,
            priceCents: 5600,
            currency: "TND",
            stock: 4,
            assetUrl: "/fixture-room.svg",
          },
        ],
      },
    }),
  );
  await page.route("**/api/storefront/session", (route) =>
    route.fulfill({ json: { accessToken: "local-ui-test-token" } }),
  );
  await page.route(/\/v1\/scenes(?:\/[^/]+)?$/, (route) =>
    route.fulfill({
      status: route.request().method() === "POST" ? 201 : 200,
      json: {
        id: sceneId,
        imageUrl: "/fixture-room.svg",
        widthPx: 1000,
        heightPx: 800,
      },
    }),
  );
  await page.route("**/v1/renders/final", (route) => {
    state.posts.push(route.request().postData()!);
    if (state.dropFirst && state.posts.length === 1)
      return route.abort("failed");
    return route.fulfill({ status: 201, json: state.render });
  });
  await page.route(`**/v1/renders/${renderId}`, (route) =>
    route.fulfill({ json: state.broken ? { malformed: true } : state.render }),
  );
  return state;
}

async function placeAndSubmit(page: Page, replaceExisting = false) {
  await page.goto(`/visualiser?products=${productId}`);
  await page.getByRole("checkbox").check();
  await page.getByLabel("Choisir une photo").setInputFiles({
    name: "room.png",
    mimeType: "image/png",
    buffer: await sharp(image).png().toBuffer(),
  });
  await page
    .getByRole("button", { name: "Continuer avec une échelle estimée" })
    .click();
  const frame = page.getByRole("button", { name: /^Placer Vase Sable/ });
  await expect(frame).toBeEnabled();
  const bounds = await frame.boundingBox();
  await frame.click({
    position: { x: bounds!.width * 0.5, y: bounds!.height * 0.7 },
  });
  if (replaceExisting)
    await page.getByRole("checkbox", { name: /Remplacer l’objet/ }).check();
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
}

test("submission immediately shows a skeleton before the request is accepted", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const state = await fixture(page);
  let accept!: () => void;
  const acceptance = new Promise<void>((resolve) => {
    accept = resolve;
  });
  await page.route("**/v1/renders/final", async (route) => {
    state.posts.push(route.request().postData()!);
    await acceptance;
    await route.fulfill({ status: 201, json: state.render });
  });
  await placeAndSubmit(page);
  await expect(
    page.getByRole("heading", { name: "Envoi de votre demande…" }),
  ).toBeVisible();
  const skeleton = page.locator('[aria-busy="true"] .skeleton');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveCSS("animation-name", "skeleton");
  await expect(skeleton).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(JSON.parse(state.posts[0]!).replaceExisting).toBe(false);
  accept();
  await expect(page.locator(".render-progress-panel")).toBeVisible();
});

test("progress stays visible through a malformed update and reload without a second render", async ({
  page,
}) => {
  const state = await fixture(page);
  state.broken = true;
  await placeAndSubmit(page);
  await expect(
    page.getByText("Reconnexion au suivi…", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".render-progress-image-skeleton")).toBeVisible();
  await expect(page.locator(".store-skip-link")).not.toBeInViewport();
  await expect(
    page.getByRole("heading", { name: "Vérification de l’échelle" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actualiser le suivi", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath(`reconnection-${test.info().project.name}.png`),
    fullPage: true,
  });
  state.broken = false;
  await page
    .getByRole("button", { name: "Actualiser le suivi", exact: true })
    .click();
  await expect(
    page.getByText("Reconnexion au suivi…", { exact: true }),
  ).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".render-progress-panel")).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  state.render.status = "succeeded";
  state.render.resultUrl = "/fixture-room.svg";
  // Automatic polling may deliver the result before a manual click. The
  // refresh action was already exercised above while the render was pending.
  await expect(
    page.getByRole("heading", { name: "Bienvenue chez vous." }),
  ).toBeVisible();
  expect(state.posts).toHaveLength(1);
});

test("a lost acceptance response survives reload and reuses exactly one idempotency key", async ({
  page,
}) => {
  const state = await fixture(page);
  state.dropFirst = true;
  await placeAndSubmit(page, true);
  await expect(
    page.getByRole("button", { name: "Vérifier ma demande" }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: /Remplacer l’objet/ }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Vérifier ma demande" }),
  ).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  await page.getByRole("button", { name: "Vérifier ma demande" }).click();
  await expect(page.locator(".render-progress-panel")).toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1]).toBe(state.posts[0]);
  expect(JSON.parse(state.posts[0]!).replaceExisting).toBe(true);
});

test("deadline feedback never announces success without a server result", async ({
  page,
}) => {
  const state = await fixture(page);
  state.render.createdAt = new Date(Date.now() - 181_000).toISOString();
  state.render.execution.deadlineAt = new Date(
    Date.parse(state.render.createdAt) + 180_000,
  ).toISOString();
  await placeAndSubmit(page);
  await expect(
    page.getByText("Le délai de 3 minutes est atteint."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Bienvenue chez vous." }),
  ).not.toBeVisible();
  state.render.status = "failed";
  state.render.error =
    "La limite de trois minutes est atteinte. Vous pouvez ajuster votre placement et réessayer.";
  await expect(
    page.getByRole("heading", {
      name: "Nous n’avons pas pu terminer cette visualisation.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revenir aux emplacements" }),
  ).toBeVisible();
  expect(state.posts).toHaveLength(1);
});

for (const status of [403, 404, 410]) {
  test(`an inaccessible saved scene (${status}) can be abandoned explicitly without generating or cancelling anything`, async ({ page }) => {
    const state = await fixture(page);
    const mutations: string[] = [];
    page.on("request", request => {
      if (request.url().includes("/v1/renders/") && request.method() !== "GET")
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await placeAndSubmit(page);
    await expect(page.locator(".render-progress-panel")).toBeVisible();
    const key = `lili:storefront-visualization:v1:${productId}`;
    await page.evaluate(() => sessionStorage.setItem("unrelated-draft", "keep"));
    await page.route(`**/v1/scenes/${sceneId}`, route => route.fulfill({
      status, json: { detail: status === 403 ? "Accès refusé" : "Photo indisponible" },
    }));
    await page.reload();
    const restart = page.getByRole("button", { name: "Recommencer avec une photo", exact: true });
    await expect(restart).toBeVisible();
    await expect(page.getByRole("button", { name: "Actualiser le suivi", exact: true })).toBeVisible();
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).not.toBeNull();
    expect(state.posts).toHaveLength(1);
    await restart.click();
    await expect(page.getByRole("heading", { name: "Montrez-nous votre intérieur." })).toBeVisible();
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem("unrelated-draft"))).toBe("keep");
    expect(mutations).toEqual(["POST /v1/renders/final"]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Montrez-nous votre intérieur." })).toBeVisible();
    expect(state.posts).toHaveLength(1);
    expect(mutations).toEqual(["POST /v1/renders/final"]);
  });
}

for (const outage of ["network", "503"] as const) {
  test(`a ${outage} restoration failure preserves an uncertain request and never offers to discard it`, async ({ page }) => {
    const state = await fixture(page);
    state.dropFirst = true;
    await placeAndSubmit(page);
    await expect(page.getByRole("button", { name: "Vérifier ma demande" })).toBeEnabled();
    const key = `lili:storefront-visualization:v1:${productId}`;
    const saved = await page.evaluate(key => sessionStorage.getItem(key), key);
    expect(JSON.parse(saved!).pendingBody).toBe(state.posts[0]);
    const preserved = { ...JSON.parse(saved!), savedAt: expect.any(Number) };
    const sceneUrl = `**/v1/scenes/${sceneId}`;
    let failedReads = 0;
    await page.route(sceneUrl, route => {
      failedReads++;
      return outage === "network" ? route.abort("failed") : route.fulfill({ status: 503, json: { detail: "Service indisponible" } });
    });
    await page.reload();
    const refresh = page.getByRole("button", { name: "Actualiser le suivi", exact: true });
    await expect(refresh).toBeVisible();
    await expect(page.getByRole("button", { name: "Recommencer avec une photo", exact: true })).toHaveCount(0);
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!)).toEqual(preserved);
    const previousReads = failedReads;
    await refresh.click();
    await expect.poll(() => failedReads).toBeGreaterThan(previousReads);
    await expect(refresh).toBeVisible();
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!)).toEqual(preserved);
    expect(state.posts).toHaveLength(1);
    await page.unroute(sceneUrl);
    await refresh.click();
    await expect(page.getByRole("button", { name: "Vérifier ma demande" })).toBeEnabled();
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!).pendingBody).toBe(state.posts[0]);
    expect(state.posts).toHaveLength(1);
  });
}
