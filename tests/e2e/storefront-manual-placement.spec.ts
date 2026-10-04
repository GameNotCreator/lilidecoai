import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { manualPlacementQuad, type ManualPlacement } from "../../packages/geometry/src/index";

const productId = "11111111-1111-4111-8111-111111111111";
const sceneId = "22222222-2222-4222-8222-222222222222";
const renderId = "33333333-3333-4333-8333-333333333333";
const roomSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="#efe6dc"/><path d="M0 440H1000V800H0Z" fill="#c4a07e"/><path d="M500 440L100 800M500 440L900 800M0 620H1000" stroke="#9d7b5c"/><rect x="90" y="130" width="260" height="270" fill="#fff6ed" stroke="#aa8165" stroke-width="12"/><rect x="700" y="470" width="200" height="40" fill="#835a3e"/><path d="M750 430v-75h80v75Z" fill="#ab7749"/></svg>';

async function fixture(page: Page, kind: "standing" | "wall" | "flat") {
  const room = await sharp(Buffer.from(roomSvg)).png().toBuffer();
  const cutoutSvg = kind === "standing"
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="280"><path d="M55 0h50l-8 80c60 55 73 155 25 190-25 16-60 16-85 0-48-35-35-135 25-190Z" fill="#917b58"/><path d="M60 10h38" stroke="#e6d1aa" stroke-width="7"/></svg>'
    : kind === "flat"
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" rx="6" fill="#75593d"/><rect x="12" y="12" width="276" height="176" fill="#eee2c4"/><path d="M40 40h220v120H40Z" fill="none" stroke="#927043" stroke-width="6"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260"><rect width="200" height="260" rx="4" fill="#7b4d30"/><rect x="12" y="12" width="176" height="236" fill="#f9e5bc"/><path d="M25 225L90 90L120 160L165 75L175 225Z" fill="#a9a182"/></svg>';
  const cutout = await sharp(Buffer.from(cutoutSvg)).trim().png().toBuffer();
  const metadata = await sharp(cutout).metadata();
  const posts: Array<{ simplePlacements: Array<{ manualPlacement: ManualPlacement }>; replacementRegion?: ManualPlacement["box"]; scaleReference?: unknown }> = [];
  await page.route("**/manual-fixture-room.png", route => route.fulfill({ contentType: "image/png", body: room }));
  await page.route("**/manual-fixture-cutout.png", route => route.fulfill({ contentType: "image/png", body: cutout }));
  await page.route("**/api/storefront/products", route => route.fulfill({ json: {
    store: { name: "LiliDéco" }, visualization: { available: true }, products: [{
      id: productId, name: "Objet manuel", objectType: kind === "flat" ? "rug" : kind === "wall" ? "frame" : "vase",
      widthCm: 20, heightCm: 30, depthCm: 15, material: "Fixture", placementType: kind === "wall" ? "wall" : kind === "flat" ? "floor" : "table",
      visualizationAvailable: true, stock: 4, assetUrl: "/manual-fixture-cutout.png", cutoutUrl: "/manual-fixture-cutout.png",
      cutout: { widthPx: metadata.width, heightPx: metadata.height },
    }],
  } }));
  await page.route("**/api/storefront/session", route => route.fulfill({ json: { accessToken: "manual-ui-fixture" } }));
  await page.route(/\/v1\/scenes(?:\/[^/]+)?$/, route => route.fulfill({ status: route.request().method() === "POST" ? 201 : 200,
    json: { id: sceneId, imageUrl: "/manual-fixture-room.png", widthPx: 1000, heightPx: 800 } }));
  await page.route("**/v1/renders/final", route => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { id: renderId, status: "succeeded", provider: "mock-ui", model: "mock-ui", requestedSize: "1000x800",
      resultUrl: "/manual-fixture-room.png", qualityScore: 1, creditCharged: false, createdAt: new Date().toISOString() } });
  });
  await page.goto(`/visualiser?products=${productId}`);
  await page.getByRole("checkbox", { name: /J’autorise/ }).check();
  await page.getByLabel("Choisir une photo").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: room });
  await expect(page.locator(".store-placement-frame")).toBeEnabled();
  return posts;
}

async function clickPoint(page: Page, x: number, y: number) {
  const frame = page.locator(".store-placement-frame");
  const bounds = await frame.boundingBox();
  await frame.click({ position: { x: bounds!.width * x, y: bounds!.height * y } });
}

test("two corners work in reverse; alpha preview, slider, move and reload preserve placement", async ({ page }) => {
  const posts = await fixture(page, "standing");
  await expect(page.getByRole("button", { name: "Affiner la taille avec une hauteur connue" })).toHaveCount(0);
  await clickPoint(page, 0.6, 0.35); await clickPoint(page, 0.4, 0.7);
  const preview = page.locator('.store-placement-frame span > img');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("src", "/manual-fixture-cutout.png");
  const slider = page.getByRole("slider", { name: "Taille visuelle de Objet manuel" });
  await slider.fill("0.24");
  await page.getByRole("button", { name: "Droite", exact: true }).click();
  await page.reload();
  await expect(slider).toHaveValue("0.24");
  expect(posts).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath("manual-standing.png"), fullPage: true });
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
  await expect.poll(() => posts.length).toBe(1);
  const placement = posts[0]!.simplePlacements[0]!.manualPlacement;
  expect(placement.box.xMax - placement.box.xMin).toBeCloseTo(0.24);
  expect((placement.box.xMin + placement.box.xMax) / 2).toBeCloseTo(0.52, 2);
  expect(posts[0]!.scaleReference).toBeUndefined();
});

test("replacement selects deletion independently without moving or resizing the product", async ({ page }) => {
  const posts = await fixture(page, "standing");
  await clickPoint(page, 0.3, 0.4); await clickPoint(page, 0.5, 0.7);
  await page.getByRole("checkbox", { name: /Retirer un objet/ }).check();
  await clickPoint(page, 0.9, 0.6); await clickPoint(page, 0.72, 0.43);
  await page.getByRole("button", { name: "Confirmer la zone à retirer" }).click();
  await page.getByRole("button", { name: "Créer ma visualisation" }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]!.replacementRegion!.xMin).toBeGreaterThan(0.7);
  expect(posts[0]!.simplePlacements[0]!.manualPlacement.box.xMax).toBeCloseTo(0.5, 2);
});

for (const kind of ["flat", "wall"] as const) {
  test(`${kind}: four guided corners and a projected product share a perspective plane`, async ({ page }) => {
    const posts = await fixture(page, kind);
    const plane: NonNullable<ManualPlacement["plane"]> = kind === "flat"
      ? [{ x: 0.3, y: 0.45 }, { x: 0.7, y: 0.45 }, { x: 0.95, y: 0.95 }, { x: 0.05, y: 0.95 }]
      : [{ x: 0.15, y: 0.1 }, { x: 0.65, y: 0.2 }, { x: 0.7, y: 0.6 }, { x: 0.1, y: 0.7 }];
    for (let i = 0; i < 4; i++) {
      await expect(page.locator("#store-placement-help")).toContainText(`${i + 1}/4`);
      await clickPoint(page, plane[i]!.x, plane[i]!.y);
    }
    const photoQuad = manualPlacementQuad({ plane, box: { xMin: 0.2, yMin: 0.2, xMax: 0.8, yMax: 0.8 } });
    await clickPoint(page, photoQuad[2].x, photoQuad[2].y);
    await clickPoint(page, photoQuad[0].x, photoQuad[0].y);
    const preview = page.locator('.store-placement-frame span > img');
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate(node => getComputedStyle(node).transform)).toContain("matrix3d");
    await expect(page.getByRole("button", { name: "Créer ma visualisation" })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath(`manual-${kind}.png`), fullPage: true });
    await page.getByRole("button", { name: "Créer ma visualisation" }).click();
    await expect.poll(() => posts.length).toBe(1);
    const placement = posts[0]!.simplePlacements[0]!.manualPlacement;
    expect(placement.plane).toHaveLength(4);
    expect(placement.box.xMin).toBeCloseTo(0.2, 2);
    expect(placement.box.yMax).toBeCloseTo(0.8, 2);
    expect(posts[0]!.scaleReference).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
