import {
  productSchema,
  storefrontScaleReferenceSchema,
  type StorefrontScaleReference,
} from "@lili/types";
import type { SimpleDimensionPair, SimplePlacementKind } from "@lili/geometry";
import { z } from "zod";

export const storefrontProductSchema = productSchema
  .pick({
    id: true,
    name: true,
    description: true,
    objectType: true,
    widthCm: true,
    heightCm: true,
    depthCm: true,
    material: true,
    placementType: true,
    sku: true,
    brand: true,
    collection: true,
    tags: true,
    priceCents: true,
    currency: true,
    stock: true,
    assetUrl: true,
    cutoutUrl: true,
    buyUrl: true,
  })
  .extend({ visualizationAvailable: z.boolean() });
export type StorefrontProduct = z.infer<typeof storefrontProductSchema>;
export const storefrontCatalogSchema = z.object({
  store: z.object({ name: z.string() }),
  products: z.array(storefrontProductSchema),
  visualization: z.object({
    available: z.boolean(),
    reason: z.string().optional(),
  }),
});
export type StorefrontCatalog = z.infer<typeof storefrontCatalogSchema>;
/** Pure validation shared with the UI; the server recomputes from encoded pixels. */
export function computeStorefrontReferenceScale(
  value: unknown,
  sceneWidth: number,
  sceneHeight: number,
  placementPoints: ReadonlyArray<{ x: number; y: number }> = [],
): {
  reference: StorefrontScaleReference;
  pixelsPerCm: number;
  referencePixels: number;
} {
  const parsed = storefrontScaleReferenceSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Indiquez une hauteur connue entre 2 et 300 cm et confirmez la même profondeur.",
    );
  if (![sceneWidth, sceneHeight].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("Les dimensions de la photo sont indisponibles.");
  const reference = parsed.data;
  const dx = (reference.topPoint.x - reference.basePoint.x) * sceneWidth;
  const dy = (reference.basePoint.y - reference.topPoint.y) * sceneHeight;
  const referencePixels = Math.hypot(dx, dy);
  if (dy <= 0 || Math.abs(dx) > dy * Math.tan(Math.PI / 6))
    throw new Error(
      "Choisissez le bas puis le haut d’une hauteur verticale, sans mesurer le sol en profondeur.",
    );
  if (referencePixels < 40)
    throw new Error(
      "La référence est trop petite sur la photo. Choisissez une hauteur plus visible.",
    );
  const pixelsPerCm = referencePixels / reference.realHeightCm;
  if (pixelsPerCm < 0.2 || pixelsPerCm > 200)
    throw new Error(
      "Cette mesure ne correspond pas à la photo. Vérifiez les points et la hauteur.",
    );
  if (
    placementPoints.some(
      (point) =>
        ![point.x, point.y].every(
          (n) => Number.isFinite(n) && n >= 0 && n <= 1,
        ) ||
        Math.abs(point.y - reference.basePoint.y) > 0.08 ||
        Math.hypot(
          (point.x - reference.basePoint.x) * sceneWidth,
          (point.y - reference.basePoint.y) * sceneHeight,
        ) >
          0.25 * Math.max(sceneWidth, sceneHeight),
    )
  )
    throw new Error(
      "Placez les articles près du bas de la référence, à la même profondeur. Sinon, choisissez une autre référence.",
    );
  return { reference, pixelsPerCm, referencePixels };
}
export interface CartLine {
  productId: string;
  quantity: number;
}
export const CART_STORAGE_KEY = "lilideco-storefront-cart-v1";
const uuid = z.string().uuid();

/** Treat persisted browser data as untrusted; merge duplicates with a bounded quantity. */
export function normalizeCart(value: unknown): CartLine[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, number>();
  for (const row of value.slice(0, 100)) {
    if (!row || typeof row !== "object") continue;
    const { productId, quantity } = row as Partial<CartLine>;
    if (
      !uuid.safeParse(productId).success ||
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity <= 0
    )
      continue;
    merged.set(
      productId!,
      Math.min(99, (merged.get(productId!) ?? 0) + quantity),
    );
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}
export function readCart(raw: string | null): CartLine[] {
  try {
    return normalizeCart(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}
export function setCartQuantity(
  cart: CartLine[],
  productId: string,
  quantity: number,
): CartLine[] {
  return normalizeCart([
    ...cart.filter((row) => row.productId !== productId),
    { productId, quantity },
  ]);
}
export function cartQuantity(cart: CartLine[]): number {
  return cart.reduce((n, row) => n + row.quantity, 0);
}
export function cartProductIds(cart: CartLine[]): string[] {
  return cart.flatMap((row) =>
    Array.from({ length: row.quantity }, () => row.productId),
  );
}
export function visualizationHref(ids: string[]): string {
  return `/visualiser?${new URLSearchParams({ products: ids.join(",") })}`;
}
export function parseVisualizationIds(value: string): string[] | null {
  const ids = value.split(",");
  return ids.length >= 1 &&
    ids.length <= 3 &&
    ids.every((id) => uuid.safeParse(id).success)
    ? ids
    : null;
}
export function productPlacementKind(
  product: StorefrontProduct,
): SimplePlacementKind {
  if (product.objectType === "rug") return "flat";
  if (product.placementType === "wall") return "wall";
  return "standing";
}
export function productDimensionPair(
  product: StorefrontProduct,
): SimpleDimensionPair {
  return productPlacementKind(product) === "flat"
    ? {
        mode: "length_width",
        lengthCm: product.widthCm,
        widthCm: product.depthCm,
      }
    : {
        mode: "height_length",
        heightCm: product.heightCm,
        lengthCm: product.widthCm,
      };
}
export function productDimensions(product: StorefrontProduct): string {
  const cm = (n: number) =>
    new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(n);
  return `L ${cm(product.widthCm)} × H ${cm(product.heightCm)} × P ${cm(product.depthCm)} cm`;
}
export function productPrice(
  product: Pick<StorefrontProduct, "priceCents" | "currency">,
  quantity = 1,
): string {
  if (product.priceCents === null || product.priceCents < 0)
    return "Prix sur demande";
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: product.currency,
    }).format((product.priceCents * quantity) / 100);
  } catch {
    return `${((product.priceCents * quantity) / 100).toFixed(2)} ${product.currency}`;
  }
}
export function safeStorefrontUrl(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"))
    return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function visualizationProblem(
  cart: CartLine[],
  products: StorefrontProduct[],
  available: boolean,
): string | null {
  const count = cartQuantity(cart);
  if (count < 1) return "Choisissez au moins un article à visualiser.";
  if (count > 3)
    return "Une visualisation accueille jusqu’à 3 articles, quantités comprises. Réduisez les quantités de votre panier pour continuer.";
  if (!available)
    return "La visualisation est momentanément indisponible. Votre sélection reste dans le panier.";
  for (const line of cart) {
    const product = products.find((p) => p.id === line.productId);
    if (!product)
      return "Un article n’est plus au catalogue. Retirez-le du panier pour continuer.";
    if (!product.visualizationAvailable)
      return `La visualisation n’est pas disponible pour ${product.name}.`;
    if (product.stock !== null && product.stock < line.quantity)
      return `La quantité de ${product.name} dépasse le stock disponible.`;
    if (productPlacementKind(product) === "flat" && product.depthCm <= 0)
      return `Les dimensions de ${product.name} doivent être complétées avant sa visualisation.`;
  }
  return null;
}
