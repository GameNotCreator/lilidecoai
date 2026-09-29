import { parseVisualizationIds, visualizationHref } from "./storefront";

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\./.test(host)
  );
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
}

/** Only an explicit origin is accepted, never a redirect path or a bearer token. */
export function mobileHandoffOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      isLoopbackHostname(url.hostname) ||
      ["0.0.0.0", "[::]"].includes(url.hostname)
    )
      return null;
    if (url.protocol === "http:" && !isPrivateIpv4(url.hostname)) return null;
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export type VisualizationHandoff =
  | { url: string; problem: null }
  | {
      url: null;
      problem: "invalid-selection" | "local-origin" | "invalid-origin";
    };

export function visualizationHandoff(
  productIds: string[],
  currentOrigin: string,
  configuredMobileOrigin = "",
): VisualizationHandoff {
  if (!parseVisualizationIds(productIds.join(",")))
    return { url: null, problem: "invalid-selection" };
  let current: URL;
  try {
    current = new URL(currentOrigin);
  } catch {
    return { url: null, problem: "invalid-origin" };
  }
  const local = isLoopbackHostname(current.hostname);
  const origin = mobileHandoffOrigin(
    local ? configuredMobileOrigin : currentOrigin,
  );
  if (!origin)
    return {
      url: null,
      problem: local && !configuredMobileOrigin ? "local-origin" : "invalid-origin",
    };
  return { url: new URL(visualizationHref(productIds), origin).href, problem: null };
}
