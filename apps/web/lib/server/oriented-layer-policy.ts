/** Experimental bounds to freeze before the holdout corpus, not physical laws. */
export const ORIENTED_LAYER_POLICY = Object.freeze({
  version: "oriented-layers-v2" as const,
  maxPixels: 4_000_000,
  maxProviderPixels: 25_000_000,
  contactDarkening: 0.14,
  maxShadowDarkening: 0.18,
  minProductExposure: 0.9,
  maxProductExposure: 1.1,
});
