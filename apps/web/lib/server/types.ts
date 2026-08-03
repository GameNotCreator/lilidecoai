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
  kind: "product" | "cutout" | "scene" | "render" | "mask";
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
  imageSourceUrl?: string;
  imageCredit?: string;
  status: "draft" | "processing" | "ready" | "archived";
  assetId?: string;
  cutoutAssetId?: string;
  anchor?: {
    anchorType: string;
    xNormalized: number;
    yNormalized: number;
  };
  createdAt: Date;
  updatedAt: Date;
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
  status: "queued" | "processing" | "succeeded" | "failed" | "deleted";
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
  latencyMs: number;
  estimatedCostUsd: number;
  error?: string;
  createdAt: Date;
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
