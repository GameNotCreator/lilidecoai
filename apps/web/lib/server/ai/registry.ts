import "server-only";

import {
  routeImageProvider,
  type ImageEditingProvider,
  type OutputQuality,
  type PlacementIntentProvider,
  type ProviderRoute,
  type RenderMode,
  type SceneAnalysisProvider,
  type SegmentationProvider,
} from "@lili/ai-router";

import { serverConfig } from "../config";
import {
  GoogleImageProvider,
  GooglePlacementIntentProvider,
  GooglePointSegmentationProvider,
  GoogleSceneAnalysisProvider,
} from "./google";
import {
  LocalPointSegmentationProvider,
  MockImageProvider,
  MockPlacementIntentProvider,
  MockSceneAnalysisProvider,
} from "./mock";
import { OpenAIImageProvider } from "./openai";

export interface SelectedEditingProvider {
  provider: ImageEditingProvider;
  route: ProviderRoute;
}

export function selectEditingProvider(
  mode: RenderMode,
  outputQuality: OutputQuality,
  preferredProvider?: "openai" | "google",
): SelectedEditingProvider {
  if (serverConfig.aiMockMode) {
    return {
      route: {
        provider: "mock",
        modelRole: "mock",
        degradedMode: false,
        reason: "AI_MOCK_MODE is enabled",
      },
      provider: new MockImageProvider(),
    };
  }
  if (preferredProvider === "openai" && serverConfig.openaiApiKey) {
    return {
      route: {
        provider: "openai",
        modelRole: "final",
        degradedMode: false,
        reason: "The simple point workflow explicitly requires GPT Image 2",
      },
      provider: new OpenAIImageProvider("gpt-image-2"),
    };
  }
  if (preferredProvider === "google" && serverConfig.googleApiKey) {
    return {
      route: {
        provider: "google",
        modelRole: outputQuality === "preview" ? "preview" : "final",
        degradedMode: false,
        reason: "Google was explicitly requested",
      },
      provider: new GoogleImageProvider(
        outputQuality === "preview"
          ? serverConfig.googlePreviewImageModel
          : serverConfig.googleFinalImageModel,
      ),
    };
  }
  const route = routeImageProvider(
    { mode, outputQuality },
    {
      mockMode: serverConfig.aiMockMode,
      googleAvailable: Boolean(serverConfig.googleApiKey),
      openAIAvailable: Boolean(serverConfig.openaiApiKey),
      openAIEnabled: serverConfig.openAIImageEnabled,
    },
  );
  if (route.provider === "google") {
    return {
      route,
      provider: new GoogleImageProvider(
        outputQuality === "preview"
          ? serverConfig.googlePreviewImageModel
          : serverConfig.googleFinalImageModel,
      ),
    };
  }
  if (route.provider === "openai") {
    return { route, provider: new OpenAIImageProvider() };
  }
  return { route, provider: new MockImageProvider() };
}

export function selectSceneAnalysisProvider(): SceneAnalysisProvider {
  if (!serverConfig.aiMockMode && serverConfig.googleApiKey) {
    return new GoogleSceneAnalysisProvider(
      serverConfig.googlePreviewImageModel,
    );
  }
  return new MockSceneAnalysisProvider();
}

export function selectPlacementIntentProvider(): PlacementIntentProvider {
  if (!serverConfig.aiMockMode && serverConfig.googleApiKey) {
    return new GooglePlacementIntentProvider(
      serverConfig.googlePreviewImageModel,
    );
  }
  return new MockPlacementIntentProvider();
}

export function selectSegmentationProvider(): SegmentationProvider {
  if (!serverConfig.aiMockMode && serverConfig.googleApiKey) {
    return new GooglePointSegmentationProvider(
      serverConfig.googlePreviewImageModel,
    );
  }
  return new LocalPointSegmentationProvider();
}
