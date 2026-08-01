import "server-only";

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

export const serverConfig = {
  mongodbUri:
    clean(process.env.MONGODB_URI) ?? "mongodb://127.0.0.1:27017/lilidecoai",
  mongodbDb: clean(process.env.MONGODB_DB) ?? "lilidecoai",
  demoMode: clean(process.env.DEMO_MODE) !== "false",
  openaiApiKey: clean(process.env.OPENAI_API_KEY),
  openaiModel: clean(process.env.OPENAI_MODEL) ?? "gpt-image-2",
  openaiVisionModel: clean(process.env.OPENAI_VISION_MODEL) ?? "gpt-5.6",
  openaiQuality: clean(process.env.OPENAI_QUALITY) ?? "high",
  openaiBaseUrl:
    clean(process.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
  openaiMaxCostUsd: Number(clean(process.env.OPENAI_MAX_COST_USD) ?? "0.25"),
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
};

export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required in production");
  }
  if (!serverConfig.sessionSecret || serverConfig.sessionSecret.length < 32) {
    throw new Error("APP_SESSION_SECRET must contain at least 32 characters");
  }
}

export function cloudinaryStorageConfigured(): boolean {
  return Boolean(
    serverConfig.cloudinaryUrl ||
    (serverConfig.cloudinaryCloudName &&
      serverConfig.cloudinaryApiKey &&
      serverConfig.cloudinaryApiSecret),
  );
}
