import { describe, expect, it } from "vitest";

import {
  elapsedRenderTime,
  renderProgress,
  renderTerminalAnnouncement,
} from "../lib/render-progress";

function input(
  overrides: Partial<Parameters<typeof renderProgress>[0]> = {},
): Parameters<typeof renderProgress>[0] {
  return { status: "processing", ...overrides };
}

describe("truthful render progress", () => {
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
