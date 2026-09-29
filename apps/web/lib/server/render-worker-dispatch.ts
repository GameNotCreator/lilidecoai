import "server-only";

import { isIP } from "node:net";
import { serverConfig } from "./config";
import { durableEnabled } from "./durable-queue";

export const RENDER_WORKER_DISPATCH_TIMEOUT_MS = 5_000;
const WORKER_PATH = "/api/cron/render-worker";

/**
 * Resolve only deployment-owned configuration, never request Host/Origin or
 * user data. An explicit override must name this deployment's worker: a
 * different revision will not claim its jobs because leases are fingerprinted.
 */
export function renderWorkerDispatchUrl(): URL | null {
  const override = process.env.RENDER_WORKER_ORIGIN?.trim();
  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (!override && !deploymentHost) return null;
  try {
    const origin = new URL(override || `https://${deploymentHost}`);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.port ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !publicHostname(origin.hostname)
    )
      return null;
    // VERCEL_URL is a generated deployment hostname, not a general URL. A
    // custom domain can be explicitly configured with RENDER_WORKER_ORIGIN.
    if (
      !override &&
      (!isVercelHost(origin.hostname) ||
        origin.host !== deploymentHost?.toLowerCase())
    )
      return null;
    return new URL(WORKER_PATH, origin);
  } catch {
    return null;
  }
}

function publicHostname(hostname: string): boolean {
  return (
    !isIP(hostname.replace(/^\[|\]$/g, "")) &&
    hostname.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
      hostname,
    ) &&
    !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(hostname)
  );
}

function isVercelHost(hostname: string): boolean {
  return hostname.endsWith(".vercel.app");
}

/**
 * Best-effort wakeup only: its failure must never undo durable admission. Use
 * this in the admission route's after-response callback. No render payload or
 * scene/product data is sent; the dedicated worker atomically claims jobs.
 */
export async function dispatchRenderWorker(): Promise<boolean> {
  if (!durableEnabled()) return false;
  const url = renderWorkerDispatchUrl();
  if (!serverConfig.cronSecret || !url) {
    // Local/CLI setups need no HTTP worker. Production should make a missing
    // kick configuration observable without exposing hosts or credentials.
    if (process.env.NODE_ENV === "production")
      console.info("render_worker_dispatch", {
        status: "skipped",
        reason: "unconfigured",
      });
    return false;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serverConfig.cronSecret}`,
  };
  const protectionBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (protectionBypass && isVercelHost(url.hostname)) {
    headers["x-vercel-protection-bypass"] = protectionBypass;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(RENDER_WORKER_DISPATCH_TIMEOUT_MS),
    });
    // Never read or log a response body that could contain private diagnostics.
    // Cancelling it also releases the connection if a proxy returns a page.
    await response.body?.cancel().catch(() => {});
    const accepted = response.status === 202;
    console.info("render_worker_dispatch", {
      status: accepted ? "accepted" : "rejected",
      httpStatus: response.status,
    });
    return accepted;
  } catch {
    // Cron remains the durable safety net for cold starts/network failures.
    console.info("render_worker_dispatch", { status: "unavailable" });
    return false;
  }
}
