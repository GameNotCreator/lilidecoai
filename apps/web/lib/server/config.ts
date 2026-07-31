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

export const serverConfig = {
  mongodbUri:
    clean(process.env.MONGODB_URI) ?? "mongodb://127.0.0.1:27017/lilidecoai",
  mongodbDb: clean(process.env.MONGODB_DB) ?? "lilidecoai",
  demoMode: clean(process.env.DEMO_MODE) !== "false",
  openaiApiKey: clean(process.env.OPENAI_API_KEY),
  openaiModel: clean(process.env.OPENAI_MODEL) ?? "gpt-image-2",
  openaiQuality: clean(process.env.OPENAI_QUALITY) ?? "medium",
  openaiBaseUrl:
    clean(process.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
  openaiMaxCostUsd: Number(clean(process.env.OPENAI_MAX_COST_USD) ?? "0.25"),
  konnectApiKey: clean(process.env.KONNECT_API_KEY),
  konnectWalletId: clean(process.env.KONNECT_WALLET_ID),
  konnectBaseUrl:
    clean(process.env.KONNECT_BASE_URL) ?? "https://api.konnect.network/api/v2",
  appUrl: clean(process.env.NEXT_PUBLIC_APP_URL) ?? "http://localhost:3000",
  sessionSecret: clean(process.env.APP_SESSION_SECRET),
  blobToken: clean(process.env.BLOB_READ_WRITE_TOKEN),
  cronSecret: clean(process.env.CRON_SECRET),
  maxUploadBytes: Math.min(
    Number(clean(process.env.MAX_UPLOAD_BYTES) ?? "4000000"),
    4_000_000,
  ),
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
  if (!serverConfig.blobToken && !process.env.VERCEL) {
    throw new Error(
      "Vercel Blob OIDC or BLOB_READ_WRITE_TOKEN is required in production",
    );
  }
}
