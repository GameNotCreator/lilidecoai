import { describe, expect, it, vi } from "vitest";
import type { RenderDocument } from "../lib/server/types";

vi.mock("../lib/server/assets", () => ({ assetUrl: () => undefined }));
import { renderResponse } from "../lib/server/serializers";

describe("render usage summary", () => {
  const render = {
    engine: "spatial",
    status: "failed",
    createdAt: new Date(),
    estimatedCostUsd: 0,
    usageTotals: {
      calls: 5,
      estimatedCostUsd: 0.307579,
      unknownOutcomeCalls: 3,
    },
  } as RenderDocument;

  it("reports journaled costs even for an older failed spatial render", () => {
    expect(renderResponse(render).estimatedCostUsd).toBe(0.307579);
    expect(renderResponse(render).usageTotals.unknownOutcomeCalls).toBe(3);
  });

  it("preserves the historical summary for legacy renders", () => {
    expect(
      renderResponse({ ...render, engine: "legacy", estimatedCostUsd: 0.1 })
        .estimatedCostUsd,
    ).toBe(0.1);
  });

  it("keeps a recorded cost when no usage totals exist", () => {
    expect(
      renderResponse({
        ...render,
        usageTotals: undefined,
        estimatedCostUsd: 0.2,
      }).estimatedCostUsd,
    ).toBe(0.2);
  });
});
