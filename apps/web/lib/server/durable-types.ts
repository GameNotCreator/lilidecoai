import type {
  ProductDocument,
  SceneDocument,
  SegmentationDocument,
} from "./types";

export interface DurableStep {
  status: "running" | "completed" | "retry" | "unknown" | "failed";
  attempts: number;
  output?: unknown;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  /** Terminal execution failure; provider billing can still be unknown. */
  failure?: string;
}

export interface DurableExecution {
  version: "simple-durable-v1" | "render-durable-v2";
  configFingerprint: string;
  deadlineAt: Date;
  availableAt: Date;
  attempts: number;
  token?: string;
  leaseUntil?: Date;
  workerId?: string;
  errorCode?: string;
  lastError?: string;
  sourceAssetIds: string[];
  scene: SceneDocument;
  products: ProductDocument[];
  segmentation?: SegmentationDocument;
  steps: Record<string, DurableStep>;
}
