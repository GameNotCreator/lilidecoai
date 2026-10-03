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
import { MyArchitectAIImageProvider } from "./myarchitectai";

export interface SelectedEditingProvider {
  provider: ImageEditingProvider;
  route: ProviderRoute;
}

export function selectEditingProvider(
  mode: RenderMode,
  outputQuality: OutputQuality,
  preferredProvider?: "openai" | "google" | "myarchitectai",
  imageModelOverride?: string,
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
  if (preferredProvider === "myarchitectai") {
    const provider = new MyArchitectAIImageProvider();
    if (!provider.isAvailable()) {
      throw new Error(
        "La clé MYARCHITECTAI_API_KEY est requise pour le moteur d’image sélectionné.",
      );
    }
    return {
      provider,
      route: {
        provider: "myarchitectai",
        modelRole: "final",
        degradedMode: false,
        reason: "MyArchitectAI was explicitly selected for the photo workflow",
      },
    };
  }
  if (preferredProvider === "openai") {
    if (!serverConfig.openaiApiKey || !serverConfig.openAIImageEnabled) {
      throw new Error(
        "Le parcours photo nécessite un service OpenAI activé et configuré.",
      );
    }
    return {
      route: {
        provider: "openai",
        modelRole: "final",
        degradedMode: false,
        reason:
          "The simple point workflow uses the configured OpenAI image model",
      },
      provider: new OpenAIImageProvider(imageModelOverride),
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
  if (serverConfig.simplePointImageProvider === "myarchitectai") {
    throw new Error(
      "MyArchitectAI est disponible pour le parcours photo simple. Ce parcours exige un autre fournisseur configuré.",
    );
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
