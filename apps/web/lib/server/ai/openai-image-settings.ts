import type { ImageQuality, ImageSize } from "@lili/ai-router";

export function imageQualityForModel(
  model: string,
  quality: ImageQuality,
): ImageQuality {
  if (/^gpt-image-2\.5-(sunburst|flare)(-|$)/.test(model)) return quality;
  return quality === "max" || quality === "xhigh" ? "high" : quality;
}

/** Token-based amount when available; fallback is only a planning allowance. */
export function imageUsageCost(
  model: string,
  usage: Record<string, unknown> | undefined,
): number | null {
  if (!/^gpt-image-2(?:\.|-|$)/.test(model) || !usage) return null;
  const details = usage.input_tokens_details as
    Record<string, unknown> | undefined;
  const text = details?.text_tokens;
  const image = details?.image_tokens;
  const output = usage.output_tokens;
  if (
    ![text, image, output].every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  )
    return null;
  // Cached input is conservatively priced at the non-cached rate.
  return (
    ((text as number) * 5 + (image as number) * 8 + (output as number) * 30) /
    1_000_000
  );
}

export function imageCostAllowance(
  model: string,
  quality: ImageQuality,
  size: ImageSize,
): number {
  if (/^gpt-image-2\.5-/.test(model)) {
    // 2.5 has variable token consumption: these are operational allowances,
    // not the legacy GPT Image 2 per-image rate card or a billing guarantee.
    return quality === "max"
      ? 3
      : quality === "xhigh"
        ? 2
        : quality === "high"
          ? 1
          : 0.5;
  }
  const square = size === "1024x1024";
  if (quality === "low") return square ? 0.006 : 0.005;
  if (quality === "medium") return square ? 0.053 : 0.041;
  return square ? 0.211 : 0.165;
}
