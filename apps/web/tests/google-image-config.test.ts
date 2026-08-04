import { describe, expect, it } from "vitest";

import { buildGoogleImageResponseFormat } from "../lib/server/ai/google-image-config";

describe("Google image response format", () => {
  it("uses the v1 enum names for portrait final renders", () => {
    expect(buildGoogleImageResponseFormat("1024x1536", "final")).toEqual({
      image: {
        aspectRatio: "ASPECT_RATIO_TWO_BY_THREE",
        imageSize: "IMAGE_SIZE_TWO_K",
      },
    });
  });

  it("uses the v1 enum names for landscape previews", () => {
    expect(buildGoogleImageResponseFormat("1536x1024", "preview")).toEqual({
      image: {
        aspectRatio: "ASPECT_RATIO_THREE_BY_TWO",
        imageSize: "IMAGE_SIZE_ONE_K",
      },
    });
  });

  it("defaults square renders and unspecified quality safely", () => {
    expect(buildGoogleImageResponseFormat("1024x1024", undefined)).toEqual({
      image: {
        aspectRatio: "ASPECT_RATIO_ONE_BY_ONE",
        imageSize: "IMAGE_SIZE_TWO_K",
      },
    });
  });
});
