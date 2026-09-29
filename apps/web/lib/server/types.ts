import type { CutoutMetadata, QualityDecision } from "@lili/types";
import type { RenderRequestSnapshot } from "./render-request";
import type { Binary } from "mongodb";
import type { DurableExecution } from "./durable-types";

export const DEMO_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000002";
export const DEMO_CATALOG_USER_ID = "demo-catalog";
export const DEMO_PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_MERCHANT_SLUG = "atelier-lili";

export interface OrganizationDocument {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface AssetDocument {
  id: string;
  organizationId: string;
  kind: "product" | "product_view" | "cutout" | "scene" | "render" | "mask";
  /**
   * Whether the image is part of a published catalogue (readable by anyone)
   * or private. Optional only for documents written before the field existed;
   * `asset-access.ts` reads a missing value as private.
   */
  visibility?: "published" | "private";
  /**
   * The visitor session that owns a private upload, when one does. Absent
   * means the asset belongs to the organization itself.
   */
  ownerSessionId?: string;
  contentType: string;
  bytes?: Binary;
  cloudinaryPublicId?: string;
  cloudinaryFormat?: string;
  cloudinaryVersion?: number;
  cloudinaryDeliveryType?: "private" | "authenticated";
  size: number;
  createdAt: Date;
  expiresAt?: Date;
  /** Set by the purge when it claims this asset for destruction. */
  purgeClaimedAt?: Date;
}

export type ProductViewType =
  "front" | "three_quarter" | "side" | "back" | "detail" | "top";

export interface ProductViewDocument {
  id: string;
  assetId: string;
  type: ProductViewType;
  widthPx: number;
  heightPx: number;
  validationStatus: "pending" | "valid" | "rejected";
  createdAt: Date;
}

/** One purchasable size of a product, e.g. « Grand modèle — 120 cm ». */
export interface ProductVariantDocument {
  id: string;
  label: string;
  sku: string | null;
  widthCm: number | null;
  heightCm: number | null;
  depthCm: number | null;
  priceCents: number | null;
  stock: number | null;
  available: boolean;
}

export interface ProductDocument {
  spatialMetadata?: import("zod").infer<
    typeof import("@lili/types").spatialProductMetadataSchema
  >;
  id: string;
  organizationId: string;
  createdByUserId?: string;
  name: string;
  description: string;
  objectType?: string;
  sku: string | null;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  material: string;
  placementType: string;
  generationInstructions: string;
  /** Explicit catalog veto; does not change commercial publication. */
  visualizationBlockedReason?: string | null;
  lightingProfile: Record<string, unknown>;
  buyUrl: string | null;
  brand?: string;
  collection?: string;
  tags?: string[];
  priceCents?: number | null;
  currency?: string;
  stock?: number | null;
  weightKg?: number | null;
  variants?: ProductVariantDocument[];
  archivedAt?: Date | null;
  imageSourceUrl?: string;
  imageCredit?: string;
  status: "draft" | "processing" | "ready" | "archived";
  assetId?: string;
  cutoutAssetId?: string;
  /** Measurements and provenance of the stored cutout (set by /prepare). */
  cutout?: CutoutMetadata;
  /** Idempotent local back-office preparation and its fenced in-flight lease. */
  productPreparation?: import("./product-preparation").ProductPreparationState;
  views?: ProductViewDocument[];
  planarTexture?: import("@lili/types").PlanarTexture | null;
  spatialPreparation?: import("@lili/types").ProductGeometry | null;
  anchor?: {
    anchorType: string;
    xNormalized: number;
    yNormalized: number;
  };
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface SceneDocument {
  id: string;
  organizationId: string;
  assetId: string;
  status: "uploaded" | "analysed" | "deleted";
  widthPx: number;
  heightPx: number;
  analysis: Record<string, unknown>;
  publicSessionId?: string;
  consentAt: Date;
  createdAt: Date;
  expiresAt: Date;
}

export interface CalibrationDocument {
  id: string;
  organizationId: string;
  sceneId: string;
  mode: "quick" | "wall" | "surface";
  label: string;
  parameters: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: Date;
}

/** Provenance summary of a simple_point render, for support and QA. */
export interface RenderAuditDocument {
  scaleSources: string[];
  scaleFallbackFired: boolean;
  cutoutSources: string[];
  cutoutWarnings: string[];
  obstaclesRemoved: number;
  obstaclesSkipped: number;
}

export interface RenderDocument {
  engine?: "legacy" | "spatial";
  spatialEvidence?: import("@lili/types").RenderEvidence;
  execution?: DurableExecution;
  id: string;
  organizationId: string;
  sceneId: string;
  productId: string;
  calibrationId?: string;
  idempotencyKey: string;
  requestSnapshot?: RenderRequestSnapshot;
  qualityDecision?: QualityDecision;
  finalizationToken?: string;
  finalizationStartedAt?: Date;
  status:
    "queued" | "processing" | "succeeded" | "failed" | "cancelled" | "deleted";
  pipelineState?:
    | "uploaded"
    | "analyzing_scene"
    | "segmenting_target"
    | "awaiting_mask_confirmation"
    | "computing_geometry"
    | "removing_target"
    | "building_prompt"
    | "generating_preview"
    | "generating_final"
    | "quality_check"
    | "retrying"
    | "completed"
    | "failed"
    | "refunded";
  mode?: "insert" | "replace";
  outputQuality?: "preview" | "final";
  surfaceType?: string;
  placementPoint?: { x: number; y: number };
  targetPoint?: { x: number; y: number };
  targetMaskId?: string;
  targetMaskAssetId?: string;
  targetMaskConfirmedAt?: Date;
  dimensionsCm?: { width: number; height: number; depth: number; unit: "cm" };
  lighting?: Record<string, unknown>;
  calibration?: Record<string, unknown>;
  productViews?: Array<{
    assetId: string;
    type: ProductViewType;
    widthPx: number;
    heightPx: number;
    validationStatus: "pending" | "valid" | "rejected";
  }>;
  modelChain?: Array<{ provider: string; model: string; role: string }>;
  attemptCount?: number;
  qualityChecks?: Array<{ name: string; score: number; reason: string }>;
  latencyMs?: number;
  estimatedCostUsd?: number;
  promptVersion?: string;
  /**
   * The engine that produced this render, resolved at runtime rather than read
   * from configuration defaults — every model id is environment-overridable,
   * and `aiMockMode` is derived and fails toward mock. Without this a corpus
   * baseline compares runs whose engine may silently differ (PRO-007).
   */
  engineVersions?: {
    placementGeometry: string;
    composite: string;
    scaleEstimation: string;
    quality: string;
    prompt: string;
    /** True when no paid provider ran: the images are synthetic. */
    mockMode: boolean;
    imageQuality: string;
    editModel: string;
    visionModel: string;
    /** Absent on admitted historical jobs: preserve their original allowance. */
    visionCostPolicy?: "astra-token-allowance-v1";
    volumeIntegrationPolicy?: "spatial-volume-local-matte-v1";
    volumeRepairPolicy?: "spatial-volume-numeric-repair-v1";
  };
  selectedResultAssetId?: string;
  feedback?: { rating?: number; comment?: string; createdAt: Date };
  preserveBackground?: boolean;
  userInstructions?: string;
  degradedMode?: boolean;
  cancelledAt?: Date;
  provider: string | null;
  model: string | null;
  requestedSize: "1024x1024" | "1536x1024" | "1024x1536";
  resultAssetId?: string;
  /** Deterministic composite stored before the paid edit (simple_point). */
  compositeAssetId?: string;
  /**
   * Intermediate images kept when stage capture is on, by stage name. Present
   * only for a run started with `RENDER_STAGE_CAPTURE=true`; see
   * `render-capture.ts`.
   */
  stages?: Partial<Record<string, string>>;
  audit?: RenderAuditDocument;
  /**
   * Running total of every paid provider call this render made, including the
   * ones that failed. `estimatedCostUsd` above stays the cost of the final
   * image edit alone, for the responses that already read it.
   */
  usageTotals?: {
    calls: number;
    estimatedCostUsd: number;
    unknownOutcomeCalls: number;
  };
  /** Provider events already included in usageTotals, atomically recorded with it. */
  usageCallIds?: string[];
  error?: string;
  qualityScore: number | null;
  creditCharged: boolean;
  placement: Record<string, unknown>;
  publicSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderAttemptDocument {
  id: string;
  usageAccountingVersion?: 2;
  organizationId: string;
  renderId: string;
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  requestId?: string;
  stage?: string;
  attemptNumber?: number;
  promptVersion?: string;
  safety?: Record<string, unknown>;
  errorCode?: string;
  retryable?: boolean;
  degradedMode?: boolean;
  outputAssetIds?: string[];
  /**
   * `unknown` marks a call whose provider-side outcome could not be
   * established — a timeout or a lost response. Absent on rows written before
   * this field existed, where `status` was the whole story.
   */
  usageOutcome?: "succeeded" | "failed" | "unknown";
  usage?: Record<string, unknown>;
  latencyMs: number;
  estimatedCostUsd: number;
  error?: string;
  createdAt: Date;
}

export interface SegmentationDocument {
  id: string;
  organizationId: string;
  sceneId: string;
  publicSessionId?: string;
  point: { x: number; y: number };
  maskAssetId: string;
  label: string;
  confidence: number;
  box: { xMin: number; yMin: number; xMax: number; yMax: number };
  status: "proposed" | "confirmed" | "rejected";
  provider: string;
  model: string;
  createdAt: Date;
  confirmedAt?: Date;
}

export interface RenderFeedbackDocument {
  id: string;
  organizationId: string;
  renderId: string;
  publicSessionId?: string;
  rating: number;
  comment?: string;
  createdAt: Date;
}

export interface RateLimitDocument {
  id: string;
  organizationId: string;
  action: string;
  windowStartedAt: Date;
  expiresAt: Date;
  count: number;
}

export interface WalletDocument {
  organizationId: string;
  /** Spendable now: excludes anything held by a render in flight. */
  balance: number;
  /** Held for renders in flight; equals `holds.length`. */
  reserved?: number;
  holds?: Array<{ key: string; reservedAt: Date }>;
  /**
   * Keys already captured. Append-only, so a replayed capture is refused
   * forever; it grows with every render and is never pruned.
   */
  processedKeys: string[];
  updatedAt: Date;
}

export interface CreditTransactionDocument {
  id: string;
  organizationId: string;
  idempotencyKey: string;
  type: string;
  amount: number;
  status: "captured" | "released";
  balanceAfter: number;
  createdAt: Date;
}

export interface UserDocument {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  organizationId: string;
  role: "owner" | "admin" | "member" | "viewer" | "platform_admin";
  createdAt: Date;
}
