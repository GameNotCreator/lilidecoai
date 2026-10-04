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
      adjustmentPreviewUrl: null as string | null,
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
  const frame = page.getByRole("button", { name: /^Placer Vase Sable/ });
  await expect(frame).toBeEnabled();
  const bounds = await frame.boundingBox();
  await frame.click({
    position: { x: bounds!.width * 0.5, y: bounds!.height * 0.7 },
  });
  if (replaceExisting) {
    await page.getByRole("checkbox", { name: /Remplacer un objet/ }).check();
    const region = page.getByRole("button", { name: /^Entourer l’objet/ });
    await region.click({ position: { x: bounds!.width * 0.35, y: bounds!.height * 0.3 } });
    await region.click({ position: { x: bounds!.width * 0.65, y: bounds!.height * 0.75 } });
    await page.getByRole("button", { name: "Confirmer la zone à remplacer" }).click();
    await page.screenshot({ path: test.info().outputPath(`replacement-confirmed-${test.info().project.name}.png`), fullPage: true });
  }
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
    page.getByRole("checkbox", { name: /Remplacer un objet/ }),
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


test("photo opens direct placement without a mandatory measurement, and manual size survives reload", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/visualiser?products=${productId}`);
  await page.getByRole("checkbox").check();
  await page.getByLabel("Choisir une photo").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: await sharp(image).png().toBuffer() });
  const frame = page.getByRole("button", { name: /^Placer Vase Sable/ });
  await expect(frame).toBeEnabled();
  await expect(page.getByText("Hauteur réelle de votre référence (cm)")).toHaveCount(0);
  expect(await page.locator(".store-steps li").allTextContents()).toHaveLength(3);
  const bounds = await frame.boundingBox();
  await frame.click({ position: { x: bounds!.width * 0.5, y: bounds!.height * 0.7 } });
  const size = page.getByRole("slider", { name: "Taille visuelle de Vase Sable" });
  await size.fill("0.24");
  await expect(page.locator(".store-visual-footprint")).toBeVisible();
  await expect(size).toHaveValue("0.24");
  await page.screenshot({ path: test.info().outputPath(`visual-placement-${test.info().project.name}.png`), fullPage: true });
  await page.reload();
  await expect(size).toHaveValue("0.24");
  expect(state.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
  await expect(page.locator(".render-progress-panel")).toBeVisible();
  expect(JSON.parse(state.posts[0]!).simplePlacements[0].visualWidthNormalized).toBeCloseTo(0.24);
  expect(JSON.parse(state.posts[0]!).scaleReference).toBeUndefined();
});

test("replacement is explicitly boxed and confirmed before generating", async ({ page }) => {
  const state = await fixture(page);
  await placeAndSubmit(page, true);
  const request = JSON.parse(state.posts[0]!);
  expect(request.replacementRegion).toMatchObject({ xMin: expect.any(Number), yMin: expect.any(Number), xMax: expect.any(Number), yMax: expect.any(Number) });
  expect(request.replacementRegion.xMin).toBeCloseTo(0.35, 2);
  expect(request.replacementRegion.yMin).toBeCloseTo(0.3, 2);
  expect(request.replacementRegion.xMax).toBeCloseTo(0.65, 2);
  expect(request.replacementRegion.yMax).toBeCloseTo(0.75, 2);
  expect(request.simplePlacements[0].placementPoint.x).toBeCloseTo(0.5, 2);
  expect(request.simplePlacements[0].placementPoint.y).toBeCloseTo(0.75, 2);
  expect(request.simplePlacements[0].visualWidthNormalized).toBeCloseTo(0.3, 2);
  expect(request.replaceExisting).toBe(true);
});

test("replacement can be selected entirely with the keyboard and an oversized region stays editable", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/visualiser?products=${productId}`);
  await page.getByRole("checkbox").check();
  await page.getByLabel("Choisir une photo").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: await sharp(image).png().toBuffer() });
  await page.getByRole("checkbox", { name: /Remplacer un objet/ }).check();
  const region = page.getByRole("button", { name: /^Entourer l’objet/ });
  await expect(region).toBeEnabled();
  await region.focus();
  await region.press("Enter");
  await region.press("ArrowLeft"); await region.press("ArrowLeft");
  await region.press("ArrowUp"); await region.press("ArrowUp");
  await region.press("Enter");
  await expect(page.getByRole("button", { name: "Créer ma visualisation" })).toBeDisabled();
  await page.getByRole("button", { name: "Confirmer la zone à remplacer" }).click();
  await expect(page.getByRole("button", { name: "Créer ma visualisation" })).toBeEnabled();
  await page.getByRole("button", { name: "Modifier la zone" }).click();
  const bounds = await region.boundingBox();
  await region.click({ position: { x: bounds!.width * 0.05, y: bounds!.height * 0.05 } });
  await region.click({ position: { x: bounds!.width * 0.95, y: bounds!.height * 0.95 } });
  await page.getByRole("button", { name: "Confirmer la zone à remplacer" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Entourez seulement l’objet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Créer ma visualisation" })).toBeDisabled();
  expect(state.posts).toHaveLength(0);
});

test("a failed composite is hidden unless the server authorizes an adjustment preview", async ({ page }) => {
  const state = await fixture(page);
  state.render.status = "failed";
  state.render.error = "Un détail de placement doit être ajusté.";
  await placeAndSubmit(page);
  await expect(page.getByRole("heading", { name: "Nous n’avons pas pu terminer cette visualisation." })).toBeVisible();
  await expect(page.locator(".store-result-image")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ouvrir l’image" })).toHaveCount(0);
  await page.getByRole("button", { name: "Revenir aux emplacements" }).click();
  state.render.adjustmentPreviewUrl = "/fixture-room.svg";
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
  await expect(page.getByRole("heading", { name: "Aperçu à ajuster." })).toBeVisible();
  await expect(page.getByRole("img", { name: "Aperçu de votre article, taille et placement à ajuster" })).toBeVisible();
  await expect(page.getByText("Cette tentative n’a pas utilisé de crédit.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bienvenue chez vous." })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ouvrir l’image" })).toHaveCount(0);
  await page.getByRole("button", { name: "Ajuster placement et taille" }).click();
  await expect(page.getByRole("slider", { name: "Taille visuelle de Vase Sable" })).toBeVisible();
  expect(state.posts).toHaveLength(2);
});

async function openCamera(page: Page) {
  await page.goto(`/visualiser?products=${productId}`);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Prendre une photo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Cadrez votre intérieur." });
  await expect(dialog).toBeVisible();
  const box = dialog.locator(".modal-box");
  await expect(dialog.getByRole("heading", { name: "Cadrez votre intérieur." })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Fermer la caméra", exact: true })).toBeInViewport();
  await expect(box).toHaveCSS("overflow-y", "auto");
  const bounds = await box.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(7);
  expect(bounds!.y).toBeGreaterThanOrEqual(7);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 7);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 7);
}

async function fakeCamera(page: Page, delayed = false) {
  await page.addInitScript(({ delayed }) => {
    const counters = { stops: 0, calls: 0, audio: true, release: null as null | (() => void) };
    (window as unknown as { cameraTest: typeof counters }).cameraTest = counters;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async (constraints: MediaStreamConstraints) => {
      counters.calls++; counters.audio = constraints.audio as boolean;
      const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 800;
      const context = canvas.getContext("2d")!; context.fillStyle = "#e6d5bb"; context.fillRect(0, 0, 1000, 800);
      const stream = canvas.captureStream(15);
      stream.getTracks().forEach(track => { const original = track.stop.bind(track); track.stop = () => { counters.stops++; original(); }; });
      if (delayed) await new Promise<void>(resolve => { counters.release = resolve; });
      // Keep a canvas frame source alive until the receiving video plays.
      let frames = 0; const draw = () => { context.fillRect(0, 0, 1000, 800); if (frames++ < 80) requestAnimationFrame(draw); }; draw();
      return stream;
    }});
  }, { delayed });
}

test("denied camera permission keeps gallery upload available without a paid request", async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    const fixture = { calls: 0 };
    (window as unknown as { deniedCamera: typeof fixture }).deniedCamera = fixture;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
      fixture.calls++; throw new DOMException("denied", "NotAllowedError");
    } } });
  });
  await openCamera(page);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("La caméra n’est pas accessible");
  expect(await page.evaluate(() => (window as unknown as { deniedCamera: { calls: number } }).deniedCamera.calls)).toBe(1);
  await expect(page.getByRole("button", { name: "Utiliser cette photo" })).toBeDisabled();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choisir dans la galerie" }).click();
  await (await chooser).setFiles({ name: "room.png", mimeType: "image/png", buffer: await sharp(image).png().toBuffer() });
  await expect(page.getByRole("button", { name: /^Placer Vase Sable/ })).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});

test("closing the camera stops every acquired video track", async ({ page, browserName }) => {
  test.skip(browserName === "webkit" && process.platform === "win32", "The Windows Playwright WebKit runtime exposes neither getUserMedia nor canvas.captureStream. This case runs on desktop and mobile Chromium; a physical iPhone remains unverified.");
  await fixture(page); await fakeCamera(page);
  await openCamera(page);
  await expect(page.getByRole("button", { name: "Utiliser cette photo" })).toBeEnabled();
  await page.getByRole("button", { name: "Fermer la caméra", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { cameraTest: { stops: number; calls: number; audio: boolean } }).cameraTest)).toMatchObject({ stops: 1, calls: 1, audio: false });
});

test("late camera access is stopped after the dialog was closed", async ({ page, browserName }) => {
  test.skip(browserName === "webkit" && process.platform === "win32", "The Windows Playwright WebKit runtime exposes neither getUserMedia nor canvas.captureStream. This case runs on desktop and mobile Chromium; a physical iPhone remains unverified.");
  await fixture(page); await fakeCamera(page, true); await openCamera(page);
  await page.getByRole("button", { name: "Fermer la caméra", exact: true }).click();
  await page.evaluate(() => (window as unknown as { cameraTest: { release: () => void } }).cameraTest.release());
  await expect.poll(() => page.evaluate(() => (window as unknown as { cameraTest: { stops: number } }).cameraTest.stops)).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("camera captures a clean JPEG through the existing upload and releases the stream", async ({ page, browserName }) => {
  test.skip(browserName === "webkit" && process.platform === "win32", "The Windows Playwright WebKit runtime exposes neither getUserMedia nor canvas.captureStream. This case runs on desktop and mobile Chromium; a physical iPhone remains unverified.");
  const state = await fixture(page); await fakeCamera(page);
  let uploaded: Buffer | null = null;
  page.on("request", (request) => { if (request.method() === "POST" && /\/v1\/scenes$/.test(new URL(request.url()).pathname)) uploaded = request.postDataBuffer(); });
  await openCamera(page);
  await page.getByRole("button", { name: "Angle de mur", exact: true }).click();
  await expect(page.getByRole("button", { name: "Angle de mur", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Utiliser cette photo" })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath(`camera-guide-${test.info().project.name}.png`), fullPage: true });
  await page.getByRole("button", { name: "Utiliser cette photo" }).click();
  await expect(page.getByRole("button", { name: /^Placer Vase Sable/ })).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { cameraTest: { stops: number } }).cameraTest.stops)).toBe(1);
  expect(uploaded!.toString("latin1")).toContain('filename="mon-interieur.jpg"');
  expect(uploaded!.toString("latin1")).toContain("Content-Type: image/jpeg");
  const jpegStart = uploaded!.indexOf(Buffer.from([0xff, 0xd8]));
  const jpegEnd = uploaded!.indexOf(Buffer.from([0xff, 0xd9]), jpegStart) + 2;
  const pixels = await sharp(uploaded!.subarray(jpegStart, jpegEnd)).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.round(pixels.info.height * 0.4) * pixels.info.width + Math.round(pixels.info.width * 0.5)) * pixels.info.channels;
  expect(Math.abs(pixels.data[at]! - 230)).toBeLessThan(5);
  expect(Math.abs(pixels.data[at + 1]! - 213)).toBeLessThan(5);
  expect(state.posts).toHaveLength(0);
});


test("multiple articles keep their visual sizes without requiring a height reference", async ({ page }) => {
  const state = await fixture(page);
  const second = "55555555-5555-4555-8555-555555555555";
  await page.route("**/api/storefront/products", route => route.fulfill({ json: {
    store: { name: "LiliDéco" }, visualization: { available: true },
    products: [productId, second].map((id, index) => ({ id, name: index ? "Vase Terre" : "Vase Sable", objectType: "vase", widthCm: 18, heightCm: 26, depthCm: 18, material: "Grès", placementType: "table", visualizationAvailable: true, priceCents: 5600, currency: "TND", stock: 4, assetUrl: "/fixture-room.svg" })),
  }}));
  await page.goto(`/visualiser?products=${productId},${second}`);
  await page.getByRole("checkbox").check();
  await page.getByLabel("Choisir une photo").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: await sharp(image).png().toBuffer() });
  const first = page.getByRole("button", { name: /^Placer Vase Sable/ });
  const bounds = await first.boundingBox();
  await first.click({ position: { x: bounds!.width * 0.3, y: bounds!.height * 0.7 } });
  await page.getByRole("button", { name: /^Placer Vase Terre/ }).click({ position: { x: bounds!.width * 0.7, y: bounds!.height * 0.7 } });
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
  await expect(page.locator(".render-progress-panel")).toBeVisible();
  const request = JSON.parse(state.posts[0]!);
  expect(request.simplePlacements).toHaveLength(2);
  expect(request.simplePlacements.every((item: { visualWidthNormalized: number }) => item.visualWidthNormalized >= 0.02 && item.visualWidthNormalized <= 0.75)).toBe(true);
  expect(request.replacementRegion).toBeUndefined(); expect(request.scaleReference).toBeUndefined();
});

test("closing during JPEG encoding discards the late capture without uploading", async ({ page, browserName }) => {
  test.skip(browserName === "webkit" && process.platform === "win32", "The Windows Playwright WebKit runtime exposes neither getUserMedia nor canvas.captureStream. This case runs on desktop and mobile Chromium; a physical iPhone remains unverified.");
  const state = await fixture(page); await fakeCamera(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      original.call(this, blob => setTimeout(() => callback(blob), 350), type, quality);
    };
  });
  let uploads = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/v1\/scenes$/.test(new URL(request.url()).pathname)) uploads++; });
  await openCamera(page);
  await page.getByRole("button", { name: "Utiliser cette photo" }).click();
  await page.getByRole("button", { name: "Fermer la caméra", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(uploads).toBe(0); expect(state.posts).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { cameraTest: { stops: number } }).cameraTest.stops)).toBe(1);
});


test("a historical placed draft sends its displayed visual width in a new request", async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(({ productId, sceneId }) => sessionStorage.setItem(`lili:storefront-visualization:v1:${productId}`, JSON.stringify({
    version: 1, savedAt: Date.now(), productIds: [productId], sceneId, points: [{ x: 0.5, y: 0.7 }],
    referenceBase: null, referenceTop: null, referenceHeight: "", sameDepth: false, referenceReady: true,
    useMeasurement: false, replaceExisting: false,
  })), { productId, sceneId });
  await page.goto(`/visualiser?products=${productId}`);
  await expect(page.getByRole("slider", { name: "Taille visuelle de Vase Sable" })).toHaveValue("0.18");
  expect(state.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
  await expect(page.locator(".render-progress-panel")).toBeVisible();
  expect(JSON.parse(state.posts[0]!).simplePlacements[0].visualWidthNormalized).toBeCloseTo(0.18);
});

test("a historical uncertain request keeps its original body and key without adding visual controls", async ({ page }) => {
  const state = await fixture(page);
  const body = JSON.stringify({ engine: "legacy", workflow: "simple_point", mode: "insert", replaceExisting: true,
    simplePlacements: [{ productId, placementPoint: { x: 0.5, y: 0.7 }, dimensionPair: { mode: "height_length", heightCm: 26, lengthCm: 18 }, placementKind: "standing" }],
    placement: { sceneId, productId, mode: "insert", surfaceType: "tabletop", xNormalized: 0.5, yNormalized: 0.7 },
    placementPoint: { x: 0.5, y: 0.7 }, surfaceType: "tabletop", outputQuality: "final", preserveBackground: true,
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
  });
  await page.addInitScript(({ productId, sceneId, body }) => sessionStorage.setItem(`lili:storefront-visualization:v1:${productId}`, JSON.stringify({
    version: 1, savedAt: Date.now(), productIds: [productId], sceneId, points: [{ x: 0.5, y: 0.7 }],
    referenceBase: null, referenceTop: null, referenceHeight: "", sameDepth: false, referenceReady: true,
    useMeasurement: false, replaceExisting: true, pendingBody: body,
  })), { productId, sceneId, body });
  await page.goto(`/visualiser?products=${productId}`);
  const verify = page.getByRole("button", { name: "Vérifier ma demande" });
  await expect(verify).toBeEnabled(); expect(state.posts).toHaveLength(0);
  await verify.click();
  await expect(page.locator(".render-progress-panel")).toBeVisible();
  expect(state.posts).toEqual([body]);
  expect(JSON.parse(state.posts[0]!).simplePlacements[0].visualWidthNormalized).toBeUndefined();
  expect(JSON.parse(state.posts[0]!).replacementRegion).toBeUndefined();
});


test("an unavailable camera API keeps the guide and gallery usable", async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined }));
  await openCamera(page);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("La caméra n’est pas accessible");
  await expect(page.getByRole("button", { name: "Utiliser cette photo" })).toBeDisabled();
  await page.getByRole("button", { name: "Sans guide", exact: true }).click();
  await expect(page.locator(".store-camera-guide")).toHaveCount(0);
  await page.getByRole("button", { name: "Angle de mur", exact: true }).click();
  await expect(page.locator(".store-camera-guide")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(`camera-unavailable-${test.info().project.name}.png`), fullPage: true });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choisir dans la galerie" }).click();
  await (await chooser).setFiles({ name: "room.png", mimeType: "image/png", buffer: await sharp(image).png().toBuffer() });
  await expect(page.getByRole("button", { name: /^Placer Vase Sable/ })).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});
