import { ApiError, InvalidApiResponseError } from "./api-errors";
import { storefrontCatalogSchema, type StorefrontCatalog } from "./storefront";

let accessToken = "";
let sessionPromise: Promise<void> | null = null;

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new ApiError(
      body?.detail ?? "La demande n’a pas abouti. Réessayez.",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new InvalidApiResponseError();
  }
}

export async function getStorefrontCatalog(): Promise<StorefrontCatalog> {
  return storefrontCatalogSchema.parse(
    await readResponse(
      await fetch("/api/storefront/products", {
        cache: "no-store",
        credentials: "same-origin",
      }),
    ),
  );
}

export async function establishStorefrontSession(): Promise<void> {
  if (accessToken) return;
  if (!sessionPromise)
    sessionPromise = (async () => {
      const session = await readResponse<{ accessToken: string }>(
        await fetch("/api/storefront/session", {
          method: "POST",
          credentials: "same-origin",
          signal: AbortSignal.timeout(15_000),
        }),
      );
      if (!session.accessToken || typeof session.accessToken !== "string")
        throw new InvalidApiResponseError();
      accessToken = session.accessToken;
    })().finally(() => {
      sessionPromise = null;
    });
  return sessionPromise;
}

export async function storefrontApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!path.startsWith("/v1/") || path.includes("\\"))
    throw new Error("Route boutique invalide");
  await establishStorefrontSession();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (!(init.body instanceof FormData) && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  let response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: init.cache ?? "no-store",
  });
  // Never replay a potentially paid POST automatically after losing a session.
  if (response.status === 401) {
    accessToken = "";
    if (
      (init.method ?? "GET").toUpperCase() === "GET" &&
      !init.signal?.aborted
    ) {
      await establishStorefrontSession();
      headers.set("Authorization", `Bearer ${accessToken}`);
      response = await fetch(path, {
        ...init,
        headers,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) accessToken = "";
    }
  }
  return readResponse<T>(response);
}
