import "server-only";
import { cache } from "react";
import { database } from "./mongodb";
import { getStorefrontCatalog } from "./storefront";

// React cache only deduplicates within a request. Publication changes remain live.
export const readStorefrontPage = cache(async () =>
  getStorefrontCatalog(await database()),
);
