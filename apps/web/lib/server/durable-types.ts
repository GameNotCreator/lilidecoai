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
  /** Rate limit for re-awakening a queued job from its authenticated status request. */
  lastDispatchedAt?: Date;
  attempts: number;
  token?: string;
  leaseUntil?: Date;
  workerId?: string;
  errorCode?: string;
  lastError?: string;
  sourceAssetIds: string[];
  /** Library frozen at admission; selection happens once in the worker. */
  preparedViews?: import("@lili/types").RenderViewSnapshot[];
  scene: SceneDocument;
  products: ProductDocument[];
  segmentation?: SegmentationDocument;
  steps: Record<string, DurableStep>;
}
