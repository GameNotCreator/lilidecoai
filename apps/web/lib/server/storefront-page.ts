import "server-only";
import { cache } from "react";
import {
  resolveStorefrontCategory,
  storefrontCategories,
} from "../storefront-categories";
import { collections, database } from "./mongodb";
import {
  getStorefrontCatalog,
  storefrontOrganization,
  storefrontProductFilter,
  storefrontProductResponse,
  storefrontVisualization,
} from "./storefront";

// React cache only deduplicates within a request. Publication changes remain live.
export const readStorefrontPage = cache(async () =>
  getStorefrontCatalog(await database()),
);

export const readStorefrontCategoryPage = cache(async (id: string) => {
  const catalog = await readStorefrontPage();
  const category = catalog.categories.find((entry) => entry.id === id);
  if (!category) return null;
  return {
    category,
    categories: catalog.categories,
    products: catalog.products.filter(
      (product) => resolveStorefrontCategory(product) === id,
    ),
    visualizationAvailable: catalog.visualization.available,
  };
});

export const readStorefrontProductPage = cache(async (id: string) => {
  const db = await database();
  const organization = await storefrontOrganization(db);
  if (!organization) return null;

  const product = await collections(db).products.findOne({
    ...storefrontProductFilter(organization.id),
    id,
  });
  return product
    ? {
        product: storefrontProductResponse(
          product,
          storefrontCategories(organization.storefrontCategories),
        ),
        available: storefrontVisualization().available,
      }
    : null;
});
