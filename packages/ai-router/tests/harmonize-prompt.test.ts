import { describe, expect, it } from "vitest";
import {
  buildSimpleHarmonizePrompt,
  SIMPLE_COMPOSITE_PROMPT_VERSION,
} from "../src/index";

describe("buildSimpleHarmonizePrompt v3", () => {
  it("is versioned as v3", () => {
    expect(SIMPLE_COMPOSITE_PROMPT_VERSION).toBe("simple-composite-v3.0.0");
  });

  it("lists products front to back with light-driven shadows", () => {
    const prompt = buildSimpleHarmonizePrompt({
      objects: [
        {
          category: "vase",
          material: "glazed stoneware",
          kind: "standing",
          heightCm: 36,
          supportMaterial: "wood",
        },
        {
          category: "lamp",
          material: "brass and linen",
          kind: "standing",
          heightCm: 50,
          emitsLight: true,
          croppedByFrame: true,
        },
      ],
      lighting: {
        lightDirection: "left",
        lightElevation: "low",
        shadowSoftness: "soft",
        colourTemperature: "warm",
        shadowDirection: "right",
      },
      letterboxed: true,
    });
    expect(prompt).toContain("2 products already placed");
    expect(prompt).toContain("listed front to back");
    expect(prompt).toContain(
      "- Product 1 (appearance reference: image 2): vase, glazed stoneware. It stands on the horizontal support at its base, a wooden surface.",
    );
    expect(prompt).toContain(
      "- Product 2 (appearance reference: image 3): lamp",
    );
    expect(prompt).toContain("It is switched off");
    expect(prompt).toContain("cut off by the edge of the frame");
    expect(prompt).toContain(
      "the main light comes from the left, low, with soft shadows, warm in tone; the existing shadows fall towards the right",
    );
    expect(prompt).toContain("stretched towards the right");
    // Median standing height of [36, 50] → upper middle 50 → reach 13 cm.
    expect(prompt).toContain("fading within about 13 cm of the base");
    expect(prompt).toContain("placeholder, not a real shadow");
    expect(prompt).toContain("Images 2 to 3 are appearance references only");
    expect(prompt).toContain("flat grey bars");
    expect(prompt).toContain(
      "never move, resize, rotate, crop, duplicate, replace or restyle it",
    );
    expect(prompt).toContain("within about 12 percent");
    expect(prompt).toContain("preserve colour ratios and fine texture");
  });

  it("falls back to reading the light from the photo when unknown", () => {
    const prompt = buildSimpleHarmonizePrompt({
      objects: [{ category: "plant", kind: "standing", heightCm: 80 }],
      lighting: null,
    });
    expect(prompt).toContain("Product in image 1:");
    expect(prompt).toContain(
      "infer direction and softness from existing shadows",
    );
    expect(prompt).toContain("spreading slightly outward from the base");
    expect(prompt).toContain("Image 2 is an appearance reference only");
    expect(prompt).not.toContain("flat grey bars");
  });

  it("describes wall, flat and glossy cases", () => {
    const prompt = buildSimpleHarmonizePrompt({
      objects: [
        { category: "picture frame", kind: "wall", heightCm: 60 },
        { category: "rug", kind: "flat", heightCm: 1 },
        {
          category: "vase",
          kind: "standing",
          heightCm: 30,
          supportGlossy: true,
          synthetic: true,
        },
      ],
      lighting: {
        lightDirection: "diffuse",
        lightElevation: "high",
        shadowSoftness: "hard",
        colourTemperature: "cool",
        shadowDirection: "none_visible",
      },
    });
    expect(prompt).toContain("It hangs flat on the wall.");
    expect(prompt).toContain("casts no floor shadow");
    expect(prompt).toContain("Product 2 lies flat");
    expect(prompt).toContain("Product 3 stands on a glossy surface");
    // PRO-008 removed this sentence with the synthetic cutout it existed for:
    // every cutout now comes from the customer's own photo, so there is no
    // second appearance to arbitrate against.
    expect(prompt).not.toContain("is the authority for its colours");
    // Diffuse light uses the fallback sentence.
    expect(prompt).toContain(
      "infer direction and softness from existing shadows",
    );
    expect(prompt).toContain("hard-edged");
  });

  it("rejects an empty object list", () => {
    expect(() =>
      buildSimpleHarmonizePrompt({ objects: [], lighting: null }),
    ).toThrow();
  });
});
