import type { ImageGenerationRequest } from "@lili/ai-router";

export type GoogleImageAspectRatio =
  | "ASPECT_RATIO_ONE_BY_ONE"
  | "ASPECT_RATIO_TWO_BY_THREE"
  | "ASPECT_RATIO_THREE_BY_TWO";

export type GoogleImageSize = "IMAGE_SIZE_ONE_K" | "IMAGE_SIZE_TWO_K";

export function buildGoogleImageResponseFormat(
  size: ImageGenerationRequest["size"],
  outputQuality: ImageGenerationRequest["outputQuality"],
): {
  image: {
    aspectRatio: GoogleImageAspectRatio;
    imageSize: GoogleImageSize;
  };
} {
  return {
    image: {
      aspectRatio: googleAspectRatio(size),
      imageSize:
        outputQuality === "preview" ? "IMAGE_SIZE_ONE_K" : "IMAGE_SIZE_TWO_K",
    },
  };
}

function googleAspectRatio(
  size: ImageGenerationRequest["size"],
): GoogleImageAspectRatio {
  if (size === "1536x1024") return "ASPECT_RATIO_THREE_BY_TWO";
  if (size === "1024x1536") return "ASPECT_RATIO_TWO_BY_THREE";
  return "ASPECT_RATIO_ONE_BY_ONE";
}
