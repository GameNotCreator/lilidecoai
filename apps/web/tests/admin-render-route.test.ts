import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findOne: vi.fn(), authenticated: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/mongodb", () => ({
  collections: () => ({ renders: { findOne: mocks.findOne } }),
}));
vi.mock("@/lib/server/admin-route", () => ({
  withAdmin: async (
    _request: Request,
    handler: (context: unknown) => Promise<Response>,
  ) => {
    if (!mocks.authenticated) return new Response(null, { status: 401 });
    return handler({ db: {}, organization: { id: "shop" } });
  },
}));

import { GET } from "../app/api/admin/renders/[id]/route";

const id = "6b2cd6f8-3766-478f-8b11-0af4ffba1c81";
const request = new Request(`https://shop.test/api/admin/renders/${id}`);
const context = { params: Promise.resolve({ id }) };
const now = new Date("2026-10-02T09:24:52Z");
const completeOutput = {
  spans: [{ pixelsPerCm: 4 }, { pixelsPerCm: 3 }],
  widthPixelsPerCm: [6, 5],
  poses: [
    { cameraElevationDegrees: 35, cameraRollDegrees: -2, evidence: "private pose evidence" },
    { cameraElevationDegrees: null, cameraRollDegrees: 1, evidence: "private pose evidence" },
  ],
  evidence: "private scene evidence",
  inspections: [{ evidence: "private inspection evidence" }],
  prompt: "private checkpoint prompt",
  checkpoint: { __checkpointImage: "private checkpoint photo" },
};

function realRender(output: unknown = completeOutput, checkpoint = "storefront-scene-preflight") {
  return {
    id, status: "succeeded", publicSessionId: "storefront:private-session",
    createdAt: now, updatedAt: now,
    engineVersions: { mockMode: false, composite: "storefront-isolated-product-v4", scaleEstimation: "storefront-scene-width-pose-v4" },
    requestSnapshot: { input: { userInstructions: "private snapshot prompt" } },
    sceneAssetId: "private source photo", resultAssetId: "private result photo",
    execution: {
      token: "private lease token", workerId: "private worker", sourceAssetIds: ["private source photo"],
      deadlineAt: now, attempts: 1,
      steps: { [checkpoint]: { status: "completed", output } },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticated = true;
});

describe("merchant render diagnostics", () => {
  it("requires a back-office session before querying visitors' renders", async () => {
    mocks.authenticated = false;
    expect((await GET(request, context)).status).toBe(401);
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the managed shop and hides unknown or other-shop renders", async () => {
    mocks.findOne.mockResolvedValue(null);
    const response = await GET(request, context);
    expect(mocks.findOne).toHaveBeenCalledWith({ id, organizationId: "shop" }, {
      projection: expect.objectContaining({ _id: 0, id: 1 }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns the terminal cause without room photographs, session identities or checkpoints", async () => {
    const now = new Date("2026-09-30T09:24:52Z");
    mocks.findOne.mockResolvedValue({
      id,
      status: "failed",
      error: "Scale refused",
      createdAt: now,
      updatedAt: now,
      sceneAssetId: "private-photo",
      publicSessionId: "private-session",
      resultAssetId: "private-result",
      execution: {
        deadlineAt: now,
        attempts: 1,
        errorCode: "input_rejected",
        steps: { secret: true },
      },
      usageTotals: { estimatedCostUsd: 0.02 },
    });
    const response = await GET(request, context);
    const body = await response.json();
    expect(body).toMatchObject({
      id,
      status: "failed",
      error: "Scale refused",
      estimatedCostUsd: 0.02,
    });
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "error",
      "estimatedCostUsd",
      "execution",
      "id",
      "pipelineState",
      "sceneProjection",
      "status",
      "updatedAt",
    ]);
    expect(body.execution).toEqual({
      deadlineAt: now.toISOString(),
      attempts: 1,
      errorCode: "input_rejected",
    });
    expect(body.sceneProjection).toBeNull();
  });

  it.each(["storefront-isolated-product-v4", "storefront-room-integration-v5", "storefront-room-local-integration-v6"].flatMap(composite =>
    ["storefront-scene-preflight", "preflight-v2", "preflight-v3", "preflight-v4", "preflight-v5"].map(checkpoint => [composite, checkpoint] as const),
  ))("exposes only bounded numeric projection evidence from a completed real %s/%s checkpoint", async (composite, checkpoint) => {
    const render = realRender(completeOutput, checkpoint);
    render.engineVersions!.composite = composite;
    mocks.findOne.mockResolvedValue(render);
    const response = await GET(request, context);
    const body = await response.json();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.sceneProjection).toEqual([
      { index: 1, heightPixelsPerCm: 4, widthPixelsPerCm: 6, cameraElevationDegrees: 35, cameraRollDegrees: -2 },
      { index: 2, heightPixelsPerCm: 3, widthPixelsPerCm: 5, cameraElevationDegrees: null, cameraRollDegrees: 1 },
    ]);
    const text = JSON.stringify(body);
    for (const forbidden of ["private", "evidence", "prompt", "checkpoint", "sourceAssetIds", "publicSessionId", "requestSnapshot", "workerId", "token"])
      expect(text).not.toContain(forbidden);
    const projection = mocks.findOne.mock.calls[0]![1].projection;
    expect(Object.keys(projection).sort()).toEqual([
      "_id", "id", "status", "error", "pipelineState", "createdAt", "updatedAt", "estimatedCostUsd",
      "usageTotals.estimatedCostUsd", "publicSessionId", "engineVersions.mockMode", "engineVersions.composite",
      "engineVersions.scaleEstimation", "execution.deadlineAt", "execution.attempts", "execution.errorCode",
      "execution.steps.storefront-scene-preflight.status",
      "execution.steps.storefront-scene-preflight.output.spans.pixelsPerCm",
      "execution.steps.storefront-scene-preflight.output.widthPixelsPerCm",
      "execution.steps.storefront-scene-preflight.output.poses.cameraElevationDegrees",
      "execution.steps.storefront-scene-preflight.output.poses.cameraRollDegrees",
      "execution.steps.preflight-v2.status",
      "execution.steps.preflight-v2.output.spans.pixelsPerCm",
      "execution.steps.preflight-v2.output.widthPixelsPerCm",
      "execution.steps.preflight-v2.output.poses.cameraElevationDegrees",
      "execution.steps.preflight-v2.output.poses.cameraRollDegrees",
      "execution.steps.preflight-v3.status",
      "execution.steps.preflight-v3.output.spans.pixelsPerCm",
      "execution.steps.preflight-v3.output.widthPixelsPerCm",
      "execution.steps.preflight-v3.output.poses.cameraElevationDegrees",
      "execution.steps.preflight-v3.output.poses.cameraRollDegrees",
      "execution.steps.preflight-v4.status",
      "execution.steps.preflight-v4.output.spans.pixelsPerCm",
      "execution.steps.preflight-v4.output.widthPixelsPerCm",
      "execution.steps.preflight-v4.output.poses.cameraElevationDegrees",
      "execution.steps.preflight-v4.output.poses.cameraRollDegrees",
      "execution.steps.preflight-v5.status",
      "execution.steps.preflight-v5.output.spans.pixelsPerCm",
      "execution.steps.preflight-v5.output.widthPixelsPerCm",
      "execution.steps.preflight-v5.output.poses.cameraElevationDegrees",
      "execution.steps.preflight-v5.output.poses.cameraRollDegrees",
      "execution.steps.preflight-v6.status",
      "execution.steps.preflight-v6.output.spans.pixelsPerCm",
      "execution.steps.preflight-v6.output.widthPixelsPerCm",
      "execution.steps.preflight-v6.output.poses.cameraElevationDegrees",
      "execution.steps.preflight-v6.output.poses.cameraRollDegrees",
      "execution.steps.preflight-v7.status",
      "execution.steps.preflight-v7.output.spans.pixelsPerCm",
      "execution.steps.preflight-v7.output.widthPixelsPerCm",
      "execution.steps.preflight-v7.output.poses.cameraElevationDegrees",
      "execution.steps.preflight-v7.output.poses.cameraRollDegrees",
      "execution.steps.preflight-v8.status",
      "execution.steps.preflight-v8.output.spans.pixelsPerCm",
      "execution.steps.preflight-v8.output.widthPixelsPerCm",
      "execution.steps.preflight-v8.output.poses.cameraElevationDegrees",
      "execution.steps.preflight-v8.output.poses.cameraRollDegrees",
    ].sort());
  });

  it.each(["storefront-scene-pose-v3", "storefront-manual-reference-v1"])(
    "never invents horizontal scale for the historical %s contract", async profile => {
      const render = realRender();
      render.engineVersions.scaleEstimation = profile;
      mocks.findOne.mockResolvedValue(render);
      expect((await (await GET(request, context)).json()).sceneProjection).toEqual([
        { index: 1, heightPixelsPerCm: 4, widthPixelsPerCm: null, cameraElevationDegrees: 35, cameraRollDegrees: -2 },
        { index: 2, heightPixelsPerCm: 3, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: 1 },
      ]);
    },
  );

  it("allows inclusive numeric bounds and preserves unknown fields as null", async () => {
    mocks.findOne.mockResolvedValue(realRender({
      spans: [{ pixelsPerCm: 0.2 }, { pixelsPerCm: 200 }, { pixelsPerCm: null }],
      widthPixelsPerCm: [200, 0.2, null],
      poses: [
        { cameraElevationDegrees: 0, cameraRollDegrees: -30 },
        { cameraElevationDegrees: 85, cameraRollDegrees: 30 },
        { cameraElevationDegrees: null, cameraRollDegrees: null },
      ],
    }));
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([
      { index: 1, heightPixelsPerCm: 0.2, widthPixelsPerCm: 200, cameraElevationDegrees: 0, cameraRollDegrees: -30 },
      { index: 2, heightPixelsPerCm: 200, widthPixelsPerCm: 0.2, cameraElevationDegrees: 85, cameraRollDegrees: 30 },
      { index: 3, heightPixelsPerCm: null, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null },
    ]);
  });

  it("does not coerce malformed or out-of-range numeric values into evidence", async () => {
    mocks.findOne.mockResolvedValue(realRender({
      spans: [{ pixelsPerCm: "4" }, { pixelsPerCm: Infinity }, { pixelsPerCm: 0.19 }],
      widthPixelsPerCm: [0, NaN, 201],
      poses: [
        { cameraElevationDegrees: 86, cameraRollDegrees: -31 },
        { cameraElevationDegrees: -1, cameraRollDegrees: "2" },
        { cameraElevationDegrees: { __checkpointImage: "private photo" }, cameraRollDegrees: 31 },
      ],
    }));
    expect((await (await GET(request, context)).json()).sceneProjection).toEqual(
      [1, 2, 3].map(index => ({ index, heightPixelsPerCm: null, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null })),
    );
  });

  it("does not fabricate missing width or pose arrays", async () => {
    mocks.findOne.mockResolvedValue(realRender({ spans: [{ pixelsPerCm: 4 }] }));
    expect((await (await GET(request, context)).json()).sceneProjection).toEqual([
      { index: 1, heightPixelsPerCm: 4, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null },
    ]);
  });

  it("prefers v2 numeric evidence and never merges it with a historical checkpoint", async () => {
    const render = realRender();
    render.execution.steps["preflight-v2"] = { status: "completed", output: { spans: [{ pixelsPerCm: 7 }] } };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toEqual([
      { index: 1, heightPixelsPerCm: 7, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null },
    ]);
  });

  it("prefers v3 evidence without mixing earlier contracts or exposing free-form provider data", async () => {
    const render = realRender();
    render.execution.steps["preflight-v2"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v3"] = { status: "completed", output: { spans: [{ pixelsPerCm: 8 }],
      evidence: "private provider explanation", checkpoint: { __checkpointImage: "private generated view" } } };
    mocks.findOne.mockResolvedValue(render);
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([{ index: 1, heightPixelsPerCm: 8, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null }]);
    expect(JSON.stringify(body)).not.toMatch(/private|checkpoint|evidence|prompt/);
  });

  it("prefers v4 numeric evidence without exposing its generated images or merging v3 estimates", async () => {
    const render = realRender();
    render.execution.steps["preflight-v3"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v4"] = { status: "completed", output: { spans: [{ pixelsPerCm: 9 }],
      evidence: "private explanation", roomImage: { __checkpointImage: "private generated room" } } };
    mocks.findOne.mockResolvedValue(render);
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([{ index: 1, heightPixelsPerCm: 9, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null }]);
    expect(JSON.stringify(body)).not.toMatch(/private|checkpoint|evidence|roomImage/);
  });

  it("prefers v5 projection evidence and exposes no native images, crop or prompt data", async () => {
    const render = realRender();
    render.execution.steps["preflight-v4"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v5"] = { status: "completed", output: { spans: [{ pixelsPerCm: 10 }],
      nativeFrame: { __checkpointImage: "private PNG" }, prompt: "private prompt" } };
    mocks.findOne.mockResolvedValue(render);
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([{ index: 1, heightPixelsPerCm: 10, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null }]);
    expect(JSON.stringify(body)).not.toMatch(/private|nativeFrame|prompt/);
  });

  it("prefers v6 numeric evidence without exposing its placement guide or earlier projection", async () => {
    const render = realRender();
    render.execution.steps["preflight-v5"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v6"] = { status: "completed", output: { spans: [{ pixelsPerCm: 11 }],
      placementGuide: { __checkpointImage: "private native contact guide" }, prompt: "private guide prompt" } };
    mocks.findOne.mockResolvedValue(render);
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([{ index: 1, heightPixelsPerCm: 11, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null }]);
    expect(JSON.stringify(body)).not.toMatch(/private|placementGuide|checkpoint|prompt/);
  });

  it("prefers v7 numeric evidence without exposing the annotated image or clean reference", async () => {
    const render = realRender();
    render.execution.steps["preflight-v6"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v7"] = { status: "completed", output: { spans: [{ pixelsPerCm: 12 }],
      annotatedInput: { __checkpointImage: "private base with guide" }, cleanNativeReference: "private PNG", prompt: "private prompt" } };
    mocks.findOne.mockResolvedValue(render);
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([{ index: 1, heightPixelsPerCm: 12, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null }]);
    expect(JSON.stringify(body)).not.toMatch(/private|annotatedInput|cleanNativeReference|checkpoint|prompt/);
  });

  it("prefers v8 numeric evidence without exposing Responses inputs or earlier geometry", async () => {
    const render = realRender();
    render.execution.steps["preflight-v7"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v8"] = { status: "completed", output: { spans: [{ pixelsPerCm: 13 }],
      responseInput: { __checkpointImage: "private native image" }, mask: "private mask", prompt: "private request" } };
    mocks.findOne.mockResolvedValue(render);
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([{ index: 1, heightPixelsPerCm: 13, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null }]);
    expect(JSON.stringify(body)).not.toMatch(/private|responseInput|checkpoint|mask|prompt/);
  });

  it.each(["running", "unknown", "failed", "retry"])("does not fall back to v7 when the v8 preflight is %s", async status => {
    const render = realRender();
    render.execution.steps["preflight-v7"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v8"] = { status, output: completeOutput };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("fails closed when a v8 checkpoint contains only private image data", async () => {
    const render = realRender();
    render.execution.steps["preflight-v7"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v8"] = { status: "completed", output: { __checkpointImage: "private image" } };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each(["running", "unknown", "failed", "retry"])("does not fall back to v6 when the v7 preflight is %s", async status => {
    const render = realRender();
    render.execution.steps["preflight-v6"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v7"] = { status, output: completeOutput };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("does not substitute an older projection when v7 only contains private images", async () => {
    const render = realRender();
    render.execution.steps["preflight-v6"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v7"] = { status: "completed", output: { __checkpointImage: "private annotated input" } };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each(["running", "unknown", "failed", "retry"])("does not fall back to v5 when the v6 preflight is %s", async status => {
    const render = realRender();
    render.execution.steps["preflight-v5"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v6"] = { status, output: completeOutput };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("does not substitute older evidence when a v6 projection contains only private images", async () => {
    const render = realRender();
    render.execution.steps["preflight-v5"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v6"] = { status: "completed", output: { __checkpointImage: "private contact guide" } };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each(["running", "unknown", "failed", "retry"])("does not fall back to v4 when the v5 preflight is %s", async status => {
    const render = realRender();
    render.execution.steps["preflight-v4"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v5"] = { status, output: completeOutput };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("does not substitute v4 evidence for a malformed v5 preflight", async () => {
    const render = realRender();
    render.execution.steps["preflight-v4"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v5"] = { status: "completed", output: { __checkpointImage: "private native frame" } };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each(["running", "unknown", "failed", "retry"])("does not fall back to a completed v3 checkpoint when v4 is %s", async status => {
    const render = realRender();
    render.execution.steps["preflight-v3"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v4"] = { status, output: completeOutput };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("does not substitute v3 evidence for a malformed v4 projection", async () => {
    const render = realRender();
    render.execution.steps["preflight-v3"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v4"] = { status: "completed", output: { __checkpointImage: "private generated room" } };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each(["running", "unknown", "failed", "retry"])("does not fall back to older evidence when v3 is %s", async status => {
    const render = realRender();
    render.execution.steps["preflight-v2"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v3"] = { status, output: completeOutput };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("fails closed on a malformed v3 checkpoint even if earlier versions contain valid evidence", async () => {
    const render = realRender();
    render.execution.steps["preflight-v2"] = { status: "completed", output: completeOutput };
    render.execution.steps["preflight-v3"] = { status: "completed", output: { __checkpointImage: "private photo" } };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each(["running", "retry", "unknown", "failed"])("does not expose old evidence when a v2 checkpoint is %s", async status => {
    const render = realRender();
    render.execution.steps["preflight-v2"] = { status, output: completeOutput };
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("does not expose malformed v2 fields, checkpoint assets or free-form evidence", async () => {
    mocks.findOne.mockResolvedValue(realRender({
      ...completeOutput, spans: [{ pixelsPerCm: "4" }], widthPixelsPerCm: [{ __checkpointImage: "private photo" }],
      poses: [{ cameraElevationDegrees: 86, cameraRollDegrees: -31, evidence: "private scene" }],
    }, "preflight-v2"));
    const body = await (await GET(request, context)).json();
    expect(body.sceneProjection).toEqual([
      { index: 1, heightPixelsPerCm: null, widthPixelsPerCm: null, cameraElevationDegrees: null, cameraRollDegrees: null },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/private|checkpoint|evidence|prompt/);
  });

  it.each([
    null, "private raw output", [], {}, { spans: [] }, { spans: "private output" },
    { spans: Array.from({ length: 4 }, () => ({ pixelsPerCm: 4 })) },
    { spans: [{ pixelsPerCm: 4 }], poses: [{}, {}] },
    { spans: [{ pixelsPerCm: 4 }], widthPixelsPerCm: [6, 6] },
    { spans: [{ pixelsPerCm: 4 }], poses: "private photo" },
    { spans: [{ pixelsPerCm: 4 }], widthPixelsPerCm: { __checkpointImage: "private photo" } },
  ].map(output => [output] as const))("fails closed on malformed or misaligned checkpoint output %#", async output => {
    mocks.findOne.mockResolvedValue(realRender(output));
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each(["running", "retry", "unknown", "failed"])("hides an unfinished %s checkpoint", async status => {
    const render = realRender();
    render.execution.steps["storefront-scene-preflight"]!.status = status;
    mocks.findOne.mockResolvedValue(render);
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it.each([
    { status: "deleted" }, { status: "cancelled" }, { status: "unexpected" },
    { publicSessionId: "guest:private-session" }, { publicSessionId: "storefront:" }, { publicSessionId: null },
    { engineVersions: { mockMode: true, composite: "storefront-isolated-product-v4", scaleEstimation: "storefront-scene-width-pose-v4" } },
    { engineVersions: { composite: "storefront-isolated-product-v4", scaleEstimation: "storefront-scene-width-pose-v4" } },
    { engineVersions: { mockMode: false, composite: "storefront-other", scaleEstimation: "storefront-scene-width-pose-v4" } },
    { engineVersions: { mockMode: false, composite: "storefront-isolated-product-v4", scaleEstimation: "unknown-profile" } },
    { execution: { deadlineAt: now, attempts: 1, steps: {} } },
  ])("withholds projection for unqualified or withdrawn render %#", async overrides => {
    mocks.findOne.mockResolvedValue({ ...realRender(), ...overrides });
    expect((await (await GET(request, context)).json()).sceneProjection).toBeNull();
  });

  it("retains only completed numeric evidence when a later image stage failed", async () => {
    mocks.findOne.mockResolvedValue({ ...realRender(), status: "failed", error: "Image refused" });
    const body = await (await GET(request, context)).json();
    expect(body.status).toBe("failed");
    expect(body.sceneProjection[0]).toEqual({ index: 1, heightPixelsPerCm: 4, widthPixelsPerCm: 6, cameraElevationDegrees: 35, cameraRollDegrees: -2 });
  });
});
