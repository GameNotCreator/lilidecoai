"use client";
import { useSyncExternalStore } from "react";
import {
  CART_STORAGE_KEY,
  readCart,
  normalizeCart,
  setCartQuantity,
  type CartLine,
} from "./storefront";

const EMPTY: CartLine[] = [];
let cached: CartLine[] = EMPTY;
let cachedRaw: string | null | undefined;
let memoryOnly = false;
const listeners = new Set<() => void>();
function snapshot() {
  if (typeof window === "undefined") return EMPTY;
  if (memoryOnly) return cached;
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cached = readCart(raw);
    }
  } catch {
    memoryOnly = true;
  }
  return cached;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const sync = (event: StorageEvent) => {
    if (event.key === CART_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", sync);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", sync);
  };
}
function save(lines: CartLine[]) {
  cached = normalizeCart(lines);
  cachedRaw = JSON.stringify(cached);
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, cachedRaw);
  } catch {
    memoryOnly = true;
  }
  listeners.forEach((listener) => listener());
}
export function useStorefrontCart() {
  const lines = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const ready = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return {
    lines,
    ready,
    storageAvailable: !memoryOnly,
    setQuantity(productId: string, quantity: number) {
      save(setCartQuantity(snapshot(), productId, quantity));
    },
    add(productId: string, maximum = 99) {
      const current = snapshot();
      const quantity =
        current.find((row) => row.productId === productId)?.quantity ?? 0;
      save(
        setCartQuantity(current, productId, Math.min(maximum, quantity + 1)),
      );
    },
    remove(productId: string) {
      save(snapshot().filter((row) => row.productId !== productId));
    },
  };
}
