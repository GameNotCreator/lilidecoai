export interface AdminProductVariant {
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

export interface AdminProductView {
  id: string;
  assetId: string;
  type: "front" | "three_quarter" | "side" | "back" | "detail";
  widthPx: number;
  heightPx: number;
  validationStatus: string;
  url: string | null;
}

export interface AdminProduct {
  id: string;
  name: string;
  description: string;
  objectType: string;
  sku: string | null;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  material: string;
  placementType: string;
  generationInstructions: string;
  buyUrl: string | null;
  brand: string;
  collection: string;
  tags: string[];
  priceCents: number | null;
  currency: string;
  stock: number | null;
  weightKg: number | null;
  variants: AdminProductVariant[];
  status: "draft" | "processing" | "ready" | "archived";
  assetUrl: string | null;
  cutoutUrl: string | null;
  thumbnailUrl: string | null;
  views: AdminProductView[];
  viewCount: number;
  hasCutout: boolean;
  temporary: boolean;
  expiresAt: string | null;
  archivedAt: string | null;
  lightingSource: string;
  reflectance: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminProductList {
  items: AdminProduct[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  counts: Record<string, number>;
}

export interface AdminOverview {
  products: {
    all: number;
    draft: number;
    processing: number;
    ready: number;
    archived: number;
    withPhoto: number;
  };
  renders: {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    estimatedCostUsd: number;
  };
  recentProducts: AdminProduct[];
  attempts: Array<{
    id: string;
    provider: string;
    model: string;
    status: string;
    stage: string | null;
    latencyMs: number;
    estimatedCostUsd: number;
    error: string | null;
    createdAt: string;
  }>;
  organization: { name: string; slug: string };
  session: { username: string };
}

export async function adminApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = `/admin/login?next=${encodeURIComponent(
      window.location.pathname,
    )}`;
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(payload?.detail ?? `Erreur ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const objectTypeLabels: Record<string, string> = {
  vase: "Vase ou pot",
  lamp: "Lampe",
  frame: "Cadre ou tableau",
  mirror: "Miroir",
  rug: "Tapis",
  furniture: "Meuble",
  plant: "Plante",
  clock: "Horloge",
  other: "Autre objet",
};

export const placementLabels: Record<string, string> = {
  table: "Table",
  nightstand: "Table de nuit",
  shelf: "Étagère",
  niche: "Niche",
  wall: "Mur",
  floor: "Sol",
};

export const statusLabels: Record<string, string> = {
  draft: "Brouillon",
  processing: "À préparer",
  ready: "Publié",
  archived: "Archivé",
};

export const viewLabels: Record<string, string> = {
  front: "Face",
  three_quarter: "Trois-quarts",
  side: "Côté",
  back: "Arrière",
  detail: "Détail",
};

export function formatPrice(
  priceCents: number | null,
  currency: string,
): string {
  if (priceCents === null || priceCents === undefined) return "—";
  return `${(priceCents / 100).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
