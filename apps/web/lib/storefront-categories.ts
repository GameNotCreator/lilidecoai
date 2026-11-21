import { z } from "zod";

export const STOREFRONT_CATEGORY_LABELS = {
  "coffrets-cadeaux": "Coffrets Cadeaux",
  "sculptures-objets-deco": "Sculptures & Objets Déco",
  "vases-cache-pots": "Vases & Cache-pots",
  "art-de-la-table": "Art de la Table",
  "lampes-luminaires": "Lampes & Luminaires",
  "decoration-murale": "Décoration Murale",
  "bougeoirs-photophores": "Bougeoirs & Photophores",
  "tapis-textiles": "Tapis & Textiles",
  "petit-mobilier": "Petit Mobilier",
  "autres-accessoires-deco": "Autres Accessoires Déco",
} as const;

export type StorefrontCategory = keyof typeof STOREFRONT_CATEGORY_LABELS;

export const storefrontCategorySchema = z.enum(
  Object.keys(STOREFRONT_CATEGORY_LABELS) as [
    StorefrontCategory,
    ...StorefrontCategory[],
  ],
);

const categoryByObjectType: Partial<Record<string, StorefrontCategory>> = {
  vase: "vases-cache-pots",
  lamp: "lampes-luminaires",
  frame: "decoration-murale",
  mirror: "decoration-murale",
  clock: "decoration-murale",
  rug: "tapis-textiles",
  cushion: "tapis-textiles",
  chair: "petit-mobilier",
  armchair: "petit-mobilier",
  sofa: "petit-mobilier",
  table: "petit-mobilier",
  furniture: "petit-mobilier",
};

const categoryByName: ReadonlyArray<readonly [RegExp, StorefrontCategory]> = [
  [/\bcoffrets?\b/, "coffrets-cadeaux"],
  [/\b(?:bougeoirs?|photophores?|chandeliers?)\b/, "bougeoirs-photophores"],
  [/\b(?:lampes?|luminaires?|appliques? murales?)\b/, "lampes-luminaires"],
  [/\b(?:vases?|cache[\s-]*pots?)\b/, "vases-cache-pots"],
  [
    /\b(?:assiettes?|tasses?|coupelles?|saladiers?|plateaux?|carafes?|sous[\s-]+verres?|art de la table)\b/,
    "art-de-la-table",
  ],
  [
    /\b(?:tableaux?|affiches?|miroirs?|decorations? murales?|sculptures? murales?)\b/,
    "decoration-murale",
  ],
  [
    /\b(?:tapis|coussins?|plaids?|nappes?|rideaux|textiles?)\b/,
    "tapis-textiles",
  ],
  [
    /\b(?:tabourets?|tables? basses?|etageres?|bancs?|meubles?)\b/,
    "petit-mobilier",
  ],
  [
    /\b(?:sculptures?|statues?|statuettes?|figurines?)\b|^poissons?\b/,
    "sculptures-objets-deco",
  ],
];

/** Classify existing products when no category has been chosen in the back office. */
export function resolveStorefrontCategory(product: {
  name: string;
  objectType?: string;
  storefrontCategory?: StorefrontCategory | null;
}): StorefrontCategory {
  const stored = storefrontCategorySchema.safeParse(product.storefrontCategory);
  if (stored.success) return stored.data;

  const name = product.name
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const named = categoryByName.find(([pattern]) => pattern.test(name));
  if (named) return named[1];

  const objectType = product.objectType ?? "";
  return Object.hasOwn(categoryByObjectType, objectType)
    ? (categoryByObjectType[objectType] ?? "autres-accessoires-deco")
    : "autres-accessoires-deco";
}
