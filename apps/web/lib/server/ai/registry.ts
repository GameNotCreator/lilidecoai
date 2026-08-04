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
): SelectedEditingProvider {
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
