import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:3100";

test("backoffice authorizes a bounded quota with safe manual retry and mobile controls", async ({
  page,
}, testInfo) => {
  const width = testInfo.project.name === "mobile" ? 320 : 1280;
  await page.setViewportSize({ width, height: 844 });
  const login = await page.request.post("/api/admin/session", {
    headers: { Origin: origin },
    data: { username: "LiliDeco", password: "LiliDeco2026" },
  });
  expect(login.status()).toBe(201);
  await page.route("**/api/admin/overview", (route) =>
    route.fulfill({
      json: {
        products: {
          all: 0,
          draft: 0,
          processing: 0,
          ready: 0,
          archived: 0,
          withPhoto: 0,
        },
        renders: {
          total: 0,
          succeeded: 0,
          failed: 0,
          successRate: 0,
          estimatedCostUsd: 0,
        },
        recentProducts: [],
        attempts: [],
        organization: { name: "ByLiliDeco", slug: "bylilideco" },
        session: { username: "LiliDeco" },
      },
    }),
  );
  let balance = 0;
  let failRead = true;
  let rejectNextGrant = false;
  const applied = new Set<string>();
  const posts: Array<{ credits: number; idempotencyKey: string }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstResponse = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route("**/api/admin/visualization-budget", async (route) => {
    if (route.request().method() === "GET") {
      if (failRead) {
        await route.fulfill({
          status: 503,
          json: { detail: "Quota momentanément indisponible." },
        });
        return;
      }
    } else {
      const body = route.request().postDataJSON() as (typeof posts)[number];
      posts.push(body);
      if (rejectNextGrant) {
        rejectNextGrant = false;
        await route.fulfill({
          status: 503,
          json: { detail: "Autorisation momentanément indisponible." },
        });
        return;
      }
      if (!applied.has(body.idempotencyKey)) {
        balance += body.credits;
        applied.add(body.idempotencyKey);
      }
      // Simulate an allowance committed on the server before its response
      // is lost. The only safe retry is explicit and keeps the same key.
      if (posts.length === 1) {
        await firstResponse;
        await route.abort("connectionfailed");
        return;
      }
    }
    await route.fulfill({
      json: { balance, reserved: 1, maxCostPerRenderUsd: 1 },
    });
  });
  await page.goto("/admin");
  const panel = page.getByRole("region", { name: "Visualisations autorisées" });
  const count = panel.getByLabel("Nombre de visualisations (1 à 3)");
  await expect(panel.getByRole("alert")).toHaveText(
    "Quota momentanément indisponible.",
  );
  await expect(count).toBeDisabled();
  failRead = false;
  await panel.getByRole("button", { name: "Actualiser le quota" }).click();
  await expect(count).toBeEnabled();
  await expect(
    panel.getByText(/Il ne recharge pas le compte IA/),
  ).toBeVisible();
  await expect(panel.getByText("Disponibles", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Réservées aux demandes en cours", { exact: true }),
  ).toBeVisible();
  await count.fill("4");
  await panel.getByRole("button", { name: "Autoriser", exact: true }).click();
  expect(posts).toHaveLength(0);
  await count.fill("2");
  await panel
    .getByRole("button", { name: "Autoriser", exact: true })
    .dblclick();
  await expect.poll(() => posts.length).toBe(1);
  await expect(count).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Autorisation…", exact: true }),
  ).toBeDisabled();
  releaseFirst!();
  await expect(panel.getByRole("alert")).toBeVisible();
  // Verify that a failed request never triggers an automatic mutation retry.
  await page.waitForTimeout(1200);
  expect(posts).toHaveLength(1);
  await panel.getByRole("button", { name: "Autoriser", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "2 visualisations autorisées.",
  );
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]!.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(balance).toBe(2);
  await count.press("Enter");
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2]!.idempotencyKey).not.toBe(posts[1]!.idempotencyKey);
  await expect(panel.getByRole("status")).toHaveText(
    "2 visualisations autorisées.",
  );
  expect(balance).toBe(4);
  await count.fill("3");
  await panel.getByRole("button", { name: "Autoriser", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "3 visualisations autorisées.",
  );
  expect(posts[3]!.credits).toBe(3);
  expect(posts[3]!.idempotencyKey).not.toBe(posts[2]!.idempotencyKey);
  rejectNextGrant = true;
  await panel.getByRole("button", { name: "Autoriser", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    "Autorisation momentanément indisponible.",
  );
  const failedKey = posts[4]!.idempotencyKey;
  await count.fill("1");
  await panel.getByRole("button", { name: "Autoriser", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "1 visualisation autorisée.",
  );
  expect(posts[5]!.credits).toBe(1);
  expect(posts[5]!.idempotencyKey).not.toBe(failedKey);
  for (const control of [
    count,
    panel.getByRole("button", { name: "Autoriser", exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await count.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.screenshot({
    path: `artifacts/admin-visualization-budget-2026-10-01/quota-${width}.png`,
    animations: "disabled",
    style: "nextjs-portal { display: none !important; }",
  });
});
