import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSimplePointImageProvider } from "../lib/server/simple-point-provider";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.resetModules();
  for (const name of [
    "OPENAI_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GEMINI_API_KEY",
    "MYARCHITECTAI_API_KEY",
    "AI_MOCK_MODE",
    "OPENAI_IMAGE_ENABLED",
    "SIMPLE_POINT_IMAGE_PROVIDER",
    "MYARCHITECTAI_TIMEOUT_MS",
    "MYARCHITECTAI_EDIT_COST_USD",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RENDER_WORKER_REVISION", "local");
  vi.stubEnv("STOREFRONT_VISUALIZATION_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("explicit MyArchitectAI image selection", () => {
  it("selects by object-count capability before admission without a failure fallback", () => {
    const config = {
      simplePointImageProvider: "myarchitectai" as const,
      aiMockMode: false,
      openaiApiKey: "vision-and-image-test-key",
      openAIImageEnabled: true,
      myArchitectAIApiKey: "image-test-key",
    };
    expect(resolveSimplePointImageProvider(1, config)).toBe("myarchitectai");
    expect(resolveSimplePointImageProvider(2, config)).toBe("openai");
    expect(resolveSimplePointImageProvider(3, config)).toBe("openai");
    expect(() => resolveSimplePointImageProvider(1, { ...config, myArchitectAIApiKey: undefined })).toThrow(/MyArchitectAI/);
    expect(() => resolveSimplePointImageProvider(2, { ...config, openAIImageEnabled: false })).toThrow(/OpenAI/);
    expect(resolveSimplePointImageProvider(1, { ...config, openAIImageEnabled: false })).toBe("myarchitectai");
    expect(() => resolveSimplePointImageProvider(1, { ...config, openaiApiKey: undefined })).toThrow(/contrôle visuel/);
    expect(resolveSimplePointImageProvider(1, { ...config, simplePointImageProvider: "openai" })).toBe("openai");
  });
  it("selects the real editor with only its key instead of silently simulating", async () => {
    vi.stubEnv("SIMPLE_POINT_IMAGE_PROVIDER", "myarchitectai");
    vi.stubEnv("MYARCHITECTAI_API_KEY", "test-key");
    const { serverConfig, paidImageProviderConfigured } =
      await import("../lib/server/config");
    const { selectEditingProvider } = await import("../lib/server/ai/registry");
    expect(serverConfig.aiMockMode).toBe(false);
    expect(paidImageProviderConfigured()).toBe(true);
    expect(
      selectEditingProvider("insert", "final", "myarchitectai"),
    ).toMatchObject({
      route: { provider: "myarchitectai", degradedMode: false },
      provider: { name: "myarchitectai", model: "edit-by-prompt" },
    });
    expect(() => selectEditingProvider("insert", "final")).toThrow(
      /parcours photo simple/,
    );
  });

  it("never falls back when the explicitly selected key is absent", async () => {
    vi.stubEnv("SIMPLE_POINT_IMAGE_PROVIDER", "myarchitectai");
    vi.stubEnv("OPENAI_API_KEY", "other-provider-key");
    vi.stubEnv("OPENAI_IMAGE_ENABLED", "true");
    const { selectEditingProvider } = await import("../lib/server/ai/registry");
    expect(() =>
      selectEditingProvider("insert", "final", "myarchitectai"),
    ).toThrow(/MYARCHITECTAI_API_KEY/);
  });

  it("honors explicit mock mode even when a real key is configured", async () => {
    vi.stubEnv("SIMPLE_POINT_IMAGE_PROVIDER", "myarchitectai");
    vi.stubEnv("MYARCHITECTAI_API_KEY", "test-key");
    vi.stubEnv("AI_MOCK_MODE", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { selectEditingProvider } = await import("../lib/server/ai/registry");
    expect(
      selectEditingProvider("insert", "final", "myarchitectai").route.provider,
    ).toBe("mock");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires OpenAI image availability for the public manual workflow regardless of the historical provider preference", async () => {
    vi.stubEnv("SIMPLE_POINT_IMAGE_PROVIDER", "myarchitectai");
    vi.stubEnv("MYARCHITECTAI_API_KEY", "test-key");
    const { serverConfig } = await import("../lib/server/config");
    const { storefrontVisualization } =
      await import("../lib/server/storefront");
    expect(storefrontVisualization().available).toBe(false);
    serverConfig.openaiApiKey = "vision-only-key";
    expect(serverConfig.openAIImageEnabled).toBe(false);
    expect(storefrontVisualization().available).toBe(false);
    serverConfig.openAIImageEnabled = true;
    expect(storefrontVisualization().available).toBe(true);
    serverConfig.myArchitectAIApiKey = undefined;
    expect(storefrontVisualization().available).toBe(true);
  }, 15_000);

  it("fences jobs when the chosen image service or its allowance changes", async () => {
    vi.stubEnv("SIMPLE_POINT_IMAGE_PROVIDER", "myarchitectai");
    vi.stubEnv("MYARCHITECTAI_API_KEY", "test-key");
    const { serverConfig } = await import("../lib/server/config");
    const { workerFingerprint } = await import("../lib/server/durable-queue");
    const first = workerFingerprint();
    serverConfig.myArchitectAIEditCostUsd = 0.05;
    expect(workerFingerprint()).not.toBe(first);
    serverConfig.myArchitectAIEditCostUsd = 0.03;
    expect(workerFingerprint()).toBe(first);
    serverConfig.simplePointImageProvider = "openai";
    expect(workerFingerprint()).not.toBe(first);
  });

  it("bounds malformed timeout and cost settings", async () => {
    vi.stubEnv("MYARCHITECTAI_TIMEOUT_MS", "NaN");
    vi.stubEnv("MYARCHITECTAI_EDIT_COST_USD", "-1");
    const { serverConfig } = await import("../lib/server/config");
    expect(serverConfig.myArchitectAITimeoutMs).toBe(120_000);
    expect(serverConfig.myArchitectAIEditCostUsd).toBe(0.03);
    expect(serverConfig.simplePointImageProvider).toBe("openai");
  });
});
