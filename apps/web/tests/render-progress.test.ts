import { describe, expect, it } from "vitest";

import {
  elapsedRenderTime,
  isStorefrontPlacementRender,
  renderProgress,
  renderTerminalAnnouncement,
} from "../lib/render-progress";

function input(
  overrides: Partial<Parameters<typeof renderProgress>[0]> = {},
): Parameters<typeof renderProgress>[0] {
  return { status: "processing", ...overrides };
}

describe("truthful render progress", () => {
  it("recognizes manual photographic placement and describes the chosen selection", () => {
    const versions = { quality: "storefront-manual-integration-review-v6", placementGeometry: "manual", composite: "manual",
      scaleEstimation: "visual", prompt: "manual-photographic-edit-v1", mockMode: false, imageQuality: "high", editModel: "image", visionModel: "vision" };
    expect(isStorefrontPlacementRender({ engineVersions: versions })).toBe(true);
    const result = renderProgress(input({ engineVersions: versions, placement: { pipelineStage: "computing_geometry" } }));
    expect(result.title).toBe("Préparation du placement choisi");
    expect(result.detail).toContain("taille visuelle");
  });
  it("announces only confirmed terminal states, including cancellation", () => {
    expect(renderTerminalAnnouncement("processing")).toBe("");
    expect(renderTerminalAnnouncement("queued")).toBe("");
    expect(renderTerminalAnnouncement(undefined)).toBe("");
    expect(renderTerminalAnnouncement("succeeded")).toBe(
      "Votre visualisation est prête.",
    );
    expect(renderTerminalAnnouncement("failed")).toContain("n’a pas abouti");
    expect(renderTerminalAnnouncement("cancelled")).toContain("annulée");
    expect(renderTerminalAnnouncement("deleted")).toContain("supprimée");
  });
  it("shows no work completed while the initial request is queued", () => {
    const result = renderProgress(
      input({ status: "queued", pipelineState: "uploaded" }),
    );
    expect(result.title).toContain("file d’attente");
    expect(result.steps.every((step) => step.state === "pending")).toBe(true);
  });

  it("uses the detailed placement stage instead of a broad scene-analysis state", () => {
    const result = renderProgress(
      input({
        pipelineState: "analyzing_scene",
        placement: { pipelineStage: "checking_composition" },
      }),
    );
    expect(result.title).toBe("Vérification du placement");
    expect(result.steps.map((step) => step.state)).toEqual([
      "complete",
      "active",
      "pending",
      "pending",
    ]);
  });

  it("recognizes per-object cleanup without showing internal stage names", () => {
    const result = renderProgress(
      input({ placement: { pipelineStage: "removing_object_2" } }),
    );
    expect(result.title).toBe("Préparation de l’emplacement");
    expect(result.steps[0]?.state).toBe("active");
  });

  it("prioritizes a quality-check transition over a stale placement field", () => {
    const result = renderProgress(
      input({
        pipelineState: "quality_check",
        placement: { pipelineStage: "generating_final" },
      }),
    );
    expect(result.steps.map((step) => step.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "active",
    ]);
    expect(result.title).toBe("Vérification du résultat");
  });

  it("distinguishes a scheduled provider retry from an active image correction", () => {
    const queued = renderProgress(
      input({
        status: "queued",
        pipelineState: "generating_final",
        execution: {
          version: "v1",
          deadlineAt: "2026-09-22T12:30:00Z",
          attempts: 1,
          retrying: true,
        },
      }),
    );
    expect(queued.title).toBe("Reprise en attente");
    expect(queued.steps[2]?.state).toBe("waiting");
    const repair = renderProgress(
      input({
        pipelineState: "retrying",
        placement: { pipelineStage: "repairing_integration" },
      }),
    );
    expect(repair.title).toBe("Affinement de l’intégration");
    expect(repair.steps[2]?.state).toBe("active");
    expect(repair.steps[3]?.state).toBe("pending");
  });

  it("does not invent progress for an unknown stage or just an available preview", () => {
    const result = renderProgress(
      input({
        placement: { pipelineStage: "future_stage" },
        compositeUrl: "/preview.webp",
      }),
    );
    expect(result.title).toBe("Traitement de votre image");
    expect(result.steps.every((step) => step.state === "pending")).toBe(true);
  });
});

describe("elapsed time", () => {
  const start = "2026-09-22T12:00:00Z";
  const epoch = Date.parse(start);
  it("shows elapsed wall time without estimating remaining time", () => {
    expect(elapsedRenderTime(start, epoch + 13_000)).toBe("13 s");
    expect(elapsedRenderTime(start, epoch + 125_000)).toBe("2 min 05 s");
    expect(elapsedRenderTime(start, epoch + 3_720_000)).toBe("1 h 02 min");
  });
  it("withholds the clock when dates cannot be trusted", () => {
    expect(elapsedRenderTime(start, null)).toBeNull();
    expect(elapsedRenderTime("bad-date", epoch)).toBeNull();
    expect(elapsedRenderTime(start, epoch - 1000)).toBeNull();
  });
});

describe("storefront source-photo placement progress", () => {
  const engineVersions = {
    placementGeometry: "simple-placement-v1",
    composite: "composite-v3/contact-light-v6",
    scaleEstimation: "scale-v3/storefront-placement-v1",
    quality: "storefront-placement-review-v1",
    prompt: "storefront-placement-review-v1",
    mockMode: false,
    imageQuality: "n/a",
    editModel: "deterministic-source-composite",
    visionModel: "vision-test",
  };

  it("uses the server's resolved contract, leaving legacy progress unchanged", () => {
    expect(isStorefrontPlacementRender({ engineVersions })).toBe(true);
    expect(isStorefrontPlacementRender({})).toBe(false);
    expect(
      isStorefrontPlacementRender({
        engineVersions: { ...engineVersions, quality: "visual-review-v2" },
      }),
    ).toBe(false);
    expect(renderProgress(input()).steps).toHaveLength(4);
  });

  it.each([
    ["estimating_scale", ["active", "pending", "pending"]],
    ["compositing", ["complete", "active", "pending"]],
    ["checking_placement", ["complete", "complete", "active"]],
    ["complete", ["complete", "complete", "complete"]],
  ] as const)(
    "shows the three real stages for %s without fictitious image generation",
    (stage, states) => {
      const result = renderProgress(
        input({ engineVersions, placement: { pipelineStage: stage } }),
      );
      expect(result.steps.map((step) => step.state)).toEqual(states);
      expect(result.steps.map((step) => step.label)).toEqual([
        "Lecture de l’intérieur",
        "Placement des objets",
        "Vérification du placement",
      ]);
      expect(`${result.title} ${result.detail}`).not.toMatch(
        /lumière|ombres|réaliste/,
      );
    },
  );

  it("uses a new quality-check event over an older composition field", () => {
    const result = renderProgress(
      input({
        engineVersions,
        pipelineState: "quality_check",
        placement: { pipelineStage: "compositing" },
      }),
    );
    expect(result.title).toBe("Vérification du placement");
    expect(result.steps.map((step) => step.state)).toEqual([
      "complete",
      "complete",
      "active",
    ]);
  });

  it("does not reinterpret a generation stage as completed fast-profile work", () => {
    const result = renderProgress(
      input({
        engineVersions,
        placement: { pipelineStage: "generating_final" },
      }),
    );
    expect(result.steps.every((step) => step.state === "pending")).toBe(true);
    expect(result.sourcePixelPlacement).toBe(true);
  });

  it.each([
    ["estimating_scale", ["active", "pending", "pending", "pending"]],
    ["compositing", ["complete", "active", "pending", "pending"]],
    ["generating_final", ["complete", "complete", "active", "pending"]],
    ["checking_placement", ["complete", "complete", "complete", "active"]],
    ["complete", ["complete", "complete", "complete", "complete"]],
  ] as const)("shows the perspective profile's four actual stages for %s", (stage, states) => {
    const result = renderProgress(input({
      engineVersions: { ...engineVersions, quality: "storefront-realistic-placement-v2" },
      placement: { pipelineStage: stage },
    }));
    expect(result.steps.map((step) => step.state)).toEqual(states);
    expect(result.sourcePixelPlacement).toBe(false);
    expect(result.steps.map((step) => step.label)).toEqual([
      "Lecture de l’intérieur", "Placement des objets",
      "Adaptation de la perspective", "Vérification du placement",
    ]);
    expect(`${result.title} ${result.detail}`).not.toMatch(/lumière|ombres/);
    if (stage === "generating_final") {
      expect(result.detail).toContain("orientation");
      expect(result.detail).toContain("apparence");
    }
  });

  it("prioritizes the perspective profile's final control over stale image adaptation evidence", () => {
    const result = renderProgress(input({
      engineVersions: { ...engineVersions, quality: "storefront-realistic-placement-v2" },
      pipelineState: "quality_check", placement: { pipelineStage: "generating_final" },
    }));
    expect(result.title).toBe("Vérification du placement");
    expect(result.steps.map((step) => step.state)).toEqual(["complete", "complete", "complete", "active"]);
  });
  it("shows the v3 provisional perspective image while its final check is pending", () => {
    const result = renderProgress(input({
      engineVersions: { ...engineVersions, quality: "storefront-realistic-placement-v3" },
      pipelineState: "quality_check", placement: { pipelineStage: "checking_placement" },
      compositeUrl: "/api/assets/private-provisional",
    }));
    expect(result.title).toBe("Vérification du placement");
    expect(result.sourcePixelPlacement).toBe(false);
    expect(result.steps.map(step => step.state)).toEqual(["complete", "complete", "complete", "active"]);
  });
  it.each([
    ["estimating_scale", ["active", "pending", "pending", "pending"]],
    ["compositing", ["complete", "active", "pending", "pending"]],
    ["generating_final", ["complete", "complete", "active", "pending"]],
    ["checking_placement", ["complete", "complete", "complete", "active"]],
    ["complete", ["complete", "complete", "complete", "complete"]],
  ] as const)("uses the native-detail v4 contract's perspective phases for %s", (stage, states) => {
    const resolved = { ...engineVersions, quality: "storefront-realistic-detail-v4",
      prompt: "storefront-isolated-camera-detail-v8", imageQuality: "high" };
    const result = renderProgress(input({ engineVersions: resolved, placement: { pipelineStage: stage } }));
    expect(isStorefrontPlacementRender({ engineVersions: resolved })).toBe(true);
    expect(result.steps.map(step => step.state)).toEqual(states);
    expect(result.sourcePixelPlacement).toBe(false);
    expect(result.steps.map(step => step.label)).toEqual([
      "Lecture de l’intérieur", "Placement des objets", "Adaptation de la perspective", "Vérification du placement",
    ]);
    expect(`${result.title} ${result.detail}`).not.toMatch(/lumière|ombres/);
    if (stage === "generating_final") {
      expect(result.title).toBe("Adaptation de la perspective");
      expect(result.detail).toContain("orientation");
      expect(result.detail).toContain("apparence");
    }
  });
  it("keeps native-detail review pending at the three-minute deadline until the server confirms a terminal state", () => {
    const start = "2026-10-02T12:00:00Z";
    const deadline = "2026-10-02T12:03:00Z";
    const resolved = { ...engineVersions, quality: "storefront-realistic-detail-v4", prompt: "storefront-isolated-camera-detail-v8" };
    const render = input({ engineVersions: resolved, pipelineState: "quality_check",
      placement: { pipelineStage: "generating_final" }, compositeUrl: "/api/assets/private-provisional",
      execution: { version: "v1", deadlineAt: deadline, attempts: 1, retrying: false } });
    expect(elapsedRenderTime(start, Date.parse(deadline))).toBe("3 min 00 s");
    const result = renderProgress(render);
    expect(result.title).toBe("Vérification du placement");
    expect(result.steps.map(step => step.state)).toEqual(["complete", "complete", "complete", "active"]);
    expect(renderTerminalAnnouncement(render.status)).toBe("");
  });
  it("does not infer native-detail progress from the prompt without its resolved quality contract", () => {
    const unresolved = { ...engineVersions, quality: "unknown-review", prompt: "storefront-isolated-camera-detail-v8" };
    expect(isStorefrontPlacementRender({ engineVersions: unresolved })).toBe(false);
    const result = renderProgress(input({ engineVersions: unresolved, placement: { pipelineStage: "generating_final" } }));
    expect(result.steps[2]!.label).toBe("Lumière et ombres");
  });
  it.each([
    ["estimating_scale", ["active", "pending", "pending", "pending"]],
    ["compositing", ["complete", "active", "pending", "pending"]],
    ["generating_final", ["complete", "complete", "active", "pending"]],
    ["checking_placement", ["complete", "complete", "complete", "active"]],
    ["complete", ["complete", "complete", "complete", "complete"]],
  ] as const)("recognizes V9 room integration and reports only its real server phase for %s", (stage, states) => {
    const resolved = { ...engineVersions, quality: "storefront-room-integration-review-v5",
      composite: "storefront-room-integration-v5", prompt: "storefront-room-integration-v9", imageQuality: "high" };
    const result = renderProgress(input({ engineVersions: resolved, placement: { pipelineStage: stage } }));
    expect(isStorefrontPlacementRender({ engineVersions: resolved })).toBe(true);
    expect(result.sourcePixelPlacement).toBe(false);
    expect(result.steps.map(step => step.state)).toEqual(states);
    expect(result.steps).toHaveLength(4);
    expect(result.steps[2]!.label).toMatch(/perspective|intégration/i);
    expect(`${result.title} ${result.detail}`).not.toMatch(/V9|sprite|alpha|storefront-room/);
  });
  it("keeps V9 final review active at the hard deadline despite stale generation evidence", () => {
    const resolved = { ...engineVersions, quality: "storefront-room-integration-review-v5",
      composite: "storefront-room-integration-v5", prompt: "storefront-room-integration-v9" };
    const render = input({ engineVersions: resolved, pipelineState: "quality_check",
      placement: { pipelineStage: "generating_final" }, compositeUrl: "/api/assets/private-provisional",
      execution: { version: "v1", deadlineAt: "2026-10-02T12:03:00Z", attempts: 1, retrying: false } });
    expect(renderProgress(render).steps.map(step => step.state)).toEqual(["complete", "complete", "complete", "active"]);
    expect(renderProgress(render).title).toContain("Vérification");
    expect(renderTerminalAnnouncement(render.status)).toBe("");
  });
  it("keeps all V9 phases pending while queued and does not infer its quality from the prompt", () => {
    const resolved = { ...engineVersions, quality: "storefront-room-integration-review-v5", prompt: "storefront-room-integration-v9" };
    const queued = renderProgress(input({ status: "queued", engineVersions: resolved, placement: { pipelineStage: "generating_final" } }));
    expect(queued.steps.every(step => step.state === "pending")).toBe(true);
    const unresolved = { ...resolved, quality: "unknown-review" };
    expect(isStorefrontPlacementRender({ engineVersions: unresolved })).toBe(false);
    expect(renderProgress(input({ engineVersions: unresolved, placement: { pipelineStage: "generating_final" } })).steps[2]!.label).toBe("Lumière et ombres");
  });
  it.each([
    ["estimating_scale", ["active", "pending", "pending", "pending"]],
    ["compositing", ["complete", "active", "pending", "pending"]],
    ["generating_final", ["complete", "complete", "active", "pending"]],
    ["checking_placement", ["complete", "complete", "complete", "active"]],
    ["complete", ["complete", "complete", "complete", "complete"]],
  ] as const)("recognizes V10 local room integration for the real server phase %s", (stage, states) => {
    const resolved = { ...engineVersions, quality: "storefront-room-integration-review-v5",
      composite: "storefront-room-local-integration-v6", prompt: "storefront-room-local-integration-v10", imageQuality: "high" };
    const result = renderProgress(input({ engineVersions: resolved, placement: { pipelineStage: stage } }));
    expect(isStorefrontPlacementRender({ engineVersions: resolved })).toBe(true);
    expect(result.sourcePixelPlacement).toBe(false);
    expect(result.steps.map(step => step.state)).toEqual(states);
    expect(result.steps).toHaveLength(4);
    expect(result.steps[2]!.label).toMatch(/perspective|intégration/i);
    expect(`${result.title} ${result.detail}`).not.toMatch(/V10|sprite|alpha|storefront-room/);
  });
  it("keeps V10 review active at the deadline and leaves queued local edits pending", () => {
    const resolved = { ...engineVersions, quality: "storefront-room-integration-review-v5",
      composite: "storefront-room-local-integration-v6", prompt: "storefront-room-local-integration-v10" };
    const render = input({ engineVersions: resolved, pipelineState: "quality_check",
      placement: { pipelineStage: "generating_final" }, compositeUrl: "/api/assets/private-provisional",
      execution: { version: "v1", deadlineAt: "2026-10-02T12:03:00Z", attempts: 1, retrying: false } });
    expect(renderProgress(render).steps.map(step => step.state)).toEqual(["complete", "complete", "complete", "active"]);
    expect(renderProgress(render).title).toContain("Vérification");
    expect(renderTerminalAnnouncement(render.status)).toBe("");
    const queued = renderProgress(input({ status: "queued", engineVersions: resolved, placement: { pipelineStage: "generating_final" } }));
    expect(queued.steps.every(step => step.state === "pending")).toBe(true);
    const unresolved = { ...resolved, quality: "unknown-review" };
    expect(isStorefrontPlacementRender({ engineVersions: unresolved })).toBe(false);
    expect(renderProgress(input({ engineVersions: unresolved, placement: { pipelineStage: "generating_final" } })).steps[2]!.label).toBe("Lumière et ombres");
  });
});
