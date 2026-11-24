import "server-only";

export function storefrontAnalyticsDestination() {
  const endpoint = process.env.STOREFRONT_ANALYTICS_WORKER_URL?.trim();
  const token = process.env.STOREFRONT_ANALYTICS_WRITE_TOKEN?.trim();
  if (!endpoint || !token || !/^[a-zA-Z0-9_-]{32,128}$/.test(token))
    return null;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return { url: new URL("/collect", url).href, token };
  } catch {
    return null;
  }
}

export function storefrontMeasurementOptions() {
  const pixelId = process.env.STOREFRONT_META_PIXEL_ID?.trim();
  return {
    analytics: Boolean(storefrontAnalyticsDestination()),
    pixelId: pixelId && /^\d{5,30}$/.test(pixelId) ? pixelId : null,
  };
}
