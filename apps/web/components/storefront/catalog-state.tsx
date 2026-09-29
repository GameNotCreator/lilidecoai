"use client";
import { useEffect, useState } from "react";
import { getStorefrontCatalog } from "@/lib/storefront-api";
import type { StorefrontCatalog } from "@/lib/storefront";

export function useStorefrontCatalog(
  initialCatalog: StorefrontCatalog | null = null,
) {
  const [catalog, setCatalog] = useState<StorefrontCatalog | null>(
    initialCatalog,
  );
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    getStorefrontCatalog()
      .then((value) => {
        if (active) {
          setCatalog(value);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Le catalogue n’a pas pu être chargé.",
          );
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return {
    catalog,
    error,
    retry: () => {
      setError("");
      setRevision((n) => n + 1);
    },
  };
}
