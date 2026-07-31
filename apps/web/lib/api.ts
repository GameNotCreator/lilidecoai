import {
  productSchema,
  renderSchema,
  type Product,
  type Render,
} from "@lili/types";
import { z } from "zod";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
let publicSessionToken = "";
let publicSessionKey = "";
let publicSessionPromise: Promise<void> | null = null;

const headers = {
  "X-Organization-Id": "00000000-0000-4000-8000-000000000001",
  "X-User-Id": "00000000-0000-4000-8000-000000000002",
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(publicSessionToken
        ? { Authorization: `Bearer ${publicSessionToken}` }
        : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(payload?.detail ?? `Erreur API ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function establishPublicSession(
  merchantSlug: string,
  productId: string,
): Promise<void> {
  const key = `${merchantSlug}/${productId}`;
  if (publicSessionToken && publicSessionKey === key) return;
  if (publicSessionPromise && publicSessionKey === key) {
    return publicSessionPromise;
  }
  publicSessionKey = key;
  publicSessionPromise = api<{ accessToken: string }>(
    `/v1/visualizer/${encodeURIComponent(merchantSlug)}/${encodeURIComponent(productId)}`,
  )
    .then((bootstrap) => {
      publicSessionToken = bootstrap.accessToken;
    })
    .finally(() => {
      publicSessionPromise = null;
    });
  return publicSessionPromise;
}

export async function getProducts(): Promise<Product[]> {
  const payload = await api<unknown[]>("/v1/products");
  return z.array(productSchema).parse(payload);
}

export async function getRender(renderId: string): Promise<Render> {
  return renderSchema.parse(await api(`/v1/renders/${renderId}`));
}

export { headers as demoHeaders };
