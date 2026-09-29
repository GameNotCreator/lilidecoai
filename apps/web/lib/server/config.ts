import "server-only";

import { DEMO_MERCHANT_SLUG } from "./types";
import { renderWorkerRevision } from "../render-worker-revision.mjs";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function uploadLimit(): number {
  const requested = Number(clean(process.env.MAX_UPLOAD_BYTES) ?? "4000000");
  if (!Number.isFinite(requested) || requested <= 0) return 4_000_000;
  return Math.min(requested, 4_000_000);
}

const googleApiKey =
  clean(process.env.GOOGLE_AI_API_KEY) ?? clean(process.env.GEMINI_API_KEY);
const openAIEnabled = clean(process.env.OPENAI_IMAGE_ENABLED) === "true";
const explicitMockMode = clean(process.env.AI_MOCK_MODE);

// In production the shared demo organization must be an explicit opt-in: a
// missing or empty DEMO_MODE previously enabled it (fail-open).
function demoModeEnabled(): boolean {
  const requested = clean(process.env.DEMO_MODE);
  if (process.env.NODE_ENV === "production") return requested === "true";
  return requested !== "false";
}

function openAIQuality(): "low" | "medium" | "high" | "xhigh" | "max" {
  const requested = clean(process.env.OPENAI_QUALITY);
  if (
    requested === "low" ||
    requested === "medium" ||
    requested === "high" ||
    requested === "xhigh" ||
    requested === "max"
  )
    return requested;
  return "max";
}

export const serverConfig = {
  merchantSignupEnabled: clean(process.env.MERCHANT_SIGNUP_ENABLED) === "true" ||
    (process.env.NODE_ENV !== "production" && clean(process.env.MERCHANT_SIGNUP_ENABLED) !== "false"),
  // Internal opt-in only; anonymous storefront sessions remain excluded.
  spatialOrganizationIds: (clean(process.env.SPATIAL_ORGANIZATION_IDS) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  // New admission is narrow by default; already admitted jobs keep their version.
  spatialAdmissionMode:
    clean(process.env.SPATIAL_ADMISSION_MODE) === "internal-all"
      ? "internal-all"
      : "solid-base-only",
  mattingUrl: clean(process.env.MATTING_URL),
  mattingToken: clean(process.env.MATTING_TOKEN),
  mattingTimeoutMs: Math.min(
    120_000,
    Math.max(1_000, Number(clean(process.env.MATTING_TIMEOUT_MS)) || 60_000),
  ),
  mongodbUri:
    clean(process.env.MONGODB_URI) ?? "mongodb://127.0.0.1:27017/lilidecoai",
  mongodbDb: clean(process.env.MONGODB_DB) ?? "lilidecoai",
  demoMode: demoModeEnabled(),
  googleApiKey,
  googlePreviewImageModel:
    clean(process.env.GOOGLE_PREVIEW_IMAGE_MODEL) ?? "gemini-3.1-flash-image",
  googleFinalImageModel:
    clean(process.env.GOOGLE_FINAL_IMAGE_MODEL) ?? "gemini-3-pro-image",
  googleApiBaseUrl:
    clean(process.env.GOOGLE_AI_BASE_URL) ??
    "https://generativelanguage.googleapis.com/v1",
  googleTimeoutMs: Number(
    clean(process.env.GOOGLE_IMAGE_TIMEOUT_MS) ?? "240000",
  ),
  googleMaxRetries: Math.min(
    2,
    Math.max(0, Number(clean(process.env.GOOGLE_IMAGE_MAX_RETRIES) ?? "1")),
  ),
  googleMaxCostUsd: Number(
    clean(process.env.GOOGLE_IMAGE_MAX_COST_USD) ?? "0.45",
  ),
  imagePipelineMode: clean(process.env.IMAGE_PIPELINE_MODE) ?? "google_hybrid",
  openAIImageEnabled: openAIEnabled,
  aiMockMode:
    explicitMockMode === "true" ||
    (explicitMockMode !== "false" && !googleApiKey && !openAIEnabled),
  openaiApiKey: clean(process.env.OPENAI_API_KEY),
  openaiModel: clean(process.env.OPENAI_MODEL) ?? "gpt-image-2.5-sunburst",
  openaiVisionModel: clean(process.env.OPENAI_VISION_MODEL) ?? "gpt-6-astra",
  openaiVisionReasoning:
    clean(process.env.OPENAI_VISION_REASONING) === "medium"
      ? ("medium" as const)
      : ("high" as const),
  openaiServiceTier: clean(process.env.OPENAI_SERVICE_TIER) ?? "default",
  openaiQuality: openAIQuality(),
  openaiBaseUrl:
    clean(process.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
  openaiMaxCostUsd: Number(clean(process.env.OPENAI_MAX_COST_USD) ?? "5"),
  cloudinaryUrl: clean(process.env.CLOUDINARY_URL),
  cloudinaryCloudName: clean(process.env.CLOUDINARY_CLOUD_NAME),
  cloudinaryApiKey: clean(process.env.CLOUDINARY_API_KEY),
  cloudinaryApiSecret: clean(process.env.CLOUDINARY_API_SECRET),
  cloudinaryUploadFolder:
    clean(process.env.CLOUDINARY_UPLOAD_FOLDER) ?? "lilidecoai",
  sessionSecret: clean(process.env.APP_SESSION_SECRET),
  cronSecret: clean(process.env.CRON_SECRET),
  maxUploadBytes: uploadLimit(),
  roomRetentionHours: Number(clean(process.env.ROOM_RETENTION_HOURS) ?? "24"),
  /**
   * Keep the intermediate images of a render (PRO-007). Off unless explicitly
   * enabled: it multiplies stored copies of the customer's own photos, and is
   * meant for a corpus run or a support investigation, never for production.
   */
  renderStageCapture: clean(process.env.RENDER_STAGE_CAPTURE) === "true",
  adminUsername: clean(process.env.ADMIN_USERNAME),
  adminPassword: clean(process.env.ADMIN_PASSWORD),
  adminPasswordHash: clean(process.env.ADMIN_PASSWORD_HASH),
  adminSessionSecret: clean(process.env.ADMIN_SESSION_SECRET),
  adminSessionHours: sessionHours(),
  adminOrganizationSlug:
    clean(process.env.ADMIN_ORGANIZATION_SLUG) ?? DEMO_MERCHANT_SLUG,
  adminOrganizationName:
    clean(process.env.ADMIN_ORGANIZATION_NAME) ?? "LiliDeco",
};

function sessionHours(): number {
  const requested = Number(clean(process.env.ADMIN_SESSION_HOURS) ?? "12");
  if (!Number.isFinite(requested) || requested <= 0) return 12;
  return Math.min(requested, 168);
}

export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.RENDER_EXECUTION_MODE === "durable")
    renderWorkerRevision(process.env, true);
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required in production");
  }
  if (!serverConfig.sessionSecret || serverConfig.sessionSecret.length < 32) {
    throw new Error("APP_SESSION_SECRET must contain at least 32 characters");
  }
}

export function paidImageProviderConfigured(): boolean {
  if (serverConfig.aiMockMode) return false;
  return Boolean(
    serverConfig.googleApiKey ||
    (serverConfig.openAIImageEnabled && serverConfig.openaiApiKey),
  );
}

export function cloudinaryStorageConfigured(): boolean {
  return Boolean(
    serverConfig.cloudinaryUrl ||
    (serverConfig.cloudinaryCloudName &&
      serverConfig.cloudinaryApiKey &&
      serverConfig.cloudinaryApiSecret),
  );
}
