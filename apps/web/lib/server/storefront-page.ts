import "server-only";
import { cache } from "react";
import { storefrontCategories } from "../storefront-categories";
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
