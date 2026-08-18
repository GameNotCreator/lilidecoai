import { z } from "zod";

export const objectTypes = [
  "vase",
  "lamp",
  "frame",
  "mirror",
  "rug",
  "furniture",
  "plant",
  "clock",
  "other",
] as const;

export const placementTypes = [
  "table",
  "nightstand",
  "shelf",
  "niche",
  "wall",
  "floor",
] as const;

export const productStatuses = [
  "draft",
  "processing",
  "ready",
  "archived",
] as const;

/** Accepts a number, a form string or null, and always lands on number | null. */
const optionalNumber = (max: number, min = 0) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) return null;
      return Math.min(Math.max(parsed, min), max);
    });

export const variantSchema = z.object({
  id: z.string().trim().max(80).optional(),
  label: z.string().trim().min(1).max(80),
  sku: z.string().trim().max(80).nullish().transform((value) => value || null),
  widthCm: optionalNumber(2_000),
  heightCm: optionalNumber(2_000),
  depthCm: optionalNumber(2_000),
  priceCents: optionalNumber(1_000_000_000),
  stock: optionalNumber(1_000_000),
  available: z.boolean().default(true),
});

const nameSchema = z.string().trim().min(2).max(120);
const descriptionSchema = z.string().trim().max(2_000);
const objectTypeSchema = z.enum(objectTypes);
const placementSchema = z.enum(placementTypes);
const materialSchema = z.string().trim().min(2).max(120);
const shortTextSchema = z.string().trim().max(80);
const tagsSchema = z.union([z.array(z.string()), z.string()]);
const currencySchema = z.string().trim().min(2).max(6);
const instructionsSchema = z.string().trim().max(1_500);
const lightingSchema = z.string().trim().max(40);
const variantsSchema = z.array(variantSchema).max(24);
const dimensionSchema = z.coerce.number().positive().max(2_000);
const skuSchema = shortTextSchema
  .nullish()
  .transform((value) => value || null);
const buyUrlSchema = z
  .string()
  .trim()
  .max(400)
  .nullish()
  .transform((value) => value || null)
  .refine(
    (value) => value === null || /^https?:\/\//i.test(value),
    "Le lien d’achat doit commencer par http:// ou https://",
  );

export const adminProductSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.default(""),
  objectType: objectTypeSchema.default("other"),
  placementType: placementSchema,
  material: materialSchema,
  sku: skuSchema,
  brand: shortTextSchema.default(""),
  collection: shortTextSchema.default(""),
  tags: tagsSchema.default([]).transform(normalizeTags),
  widthCm: dimensionSchema,
  heightCm: dimensionSchema,
  depthCm: z.coerce.number().nonnegative().max(2_000),
  weightKg: optionalNumber(5_000),
  priceCents: optionalNumber(1_000_000_000),
  currency: currencySchema.default("TND"),
  stock: optionalNumber(1_000_000),
  buyUrl: buyUrlSchema,
  generationInstructions: instructionsSchema.default(""),
  lightingSource: lightingSchema.default("front"),
  reflectance: lightingSchema.default("matte"),
  variants: variantsSchema.default([]),
  status: z.enum(productStatuses).optional(),
});

/**
 * Written out rather than derived with `.partial()`. A `.default()` still fires
 * when its key is absent, so a partial update would silently reset the stored
 * description, type, currency or variants. Every key here is plainly optional:
 * an absent key means "do not touch", an explicit null means "clear".
 */
export const adminProductPatchSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  objectType: objectTypeSchema.optional(),
  placementType: placementSchema.optional(),
  material: materialSchema.optional(),
  sku: skuSchema.optional(),
  brand: shortTextSchema.optional(),
  collection: shortTextSchema.optional(),
  tags: tagsSchema.transform(normalizeTags).optional(),
  widthCm: dimensionSchema.optional(),
  heightCm: dimensionSchema.optional(),
  depthCm: z.coerce.number().nonnegative().max(2_000).optional(),
  weightKg: optionalNumber(5_000).optional(),
  priceCents: optionalNumber(1_000_000_000).optional(),
  currency: currencySchema.optional(),
  stock: optionalNumber(1_000_000).optional(),
  buyUrl: buyUrlSchema.optional(),
  generationInstructions: instructionsSchema.optional(),
  lightingSource: lightingSchema.optional(),
  reflectance: lightingSchema.optional(),
  variants: variantsSchema.optional(),
  status: z.enum(productStatuses).optional(),
});

export const listQuerySchema = z.object({
  q: z.string().trim().max(120).default(""),
  status: z.enum([...productStatuses, "all", "live"]).default("all"),
  objectType: z.enum([...objectTypes, "all"]).default("all"),
  placementType: z.enum([...placementTypes, "all"]).default("all"),
  sort: z
    .enum(["recent", "updated", "name", "price_desc", "price_asc"])
    .default("updated"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

export type AdminProductInput = z.infer<typeof adminProductSchema>;
export type AdminProductPatch = z.infer<typeof adminProductPatchSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;

export function normalizeTags(value: string[] | string): string[] {
  const list = Array.isArray(value) ? value : value.split(",");
  const seen = new Set<string>();
  for (const entry of list) {
    const tag = entry.trim().slice(0, 32);
    if (tag) seen.add(tag);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

export function roundOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(value);
}
