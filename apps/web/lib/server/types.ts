import type { Binary } from "mongodb";

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
  contentType: string;
  bytes?: Binary;
  cloudinaryPublicId?: string;
  cloudinaryFormat?: string;
  cloudinaryVersion?: number;
  cloudinaryDeliveryType?: "private" | "authenticated";
  size: number;
  createdAt: Date;
  expiresAt?: Date;
}

export type ProductViewType =
  "front" | "three_quarter" | "side" | "back" | "detail";

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
  views?: ProductViewDocument[];
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

export interface RenderDocument {
  id: string;
  organizationId: string;
  sceneId: string;
  productId: string;
  calibrationId?: string;
  idempotencyKey: string;
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
  balance: number;
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
