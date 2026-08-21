import { describe, expect, it } from "vitest";
import {
  buildSimplePointPrompt,
  PROMPT_VERSION,
  PromptBuilder,
} from "../src/index";

describe("PromptBuilder", () => {
  it("assigns explicit image roles and encodes hard replacement constraints", () => {
    const built = new PromptBuilder().build({
      mode: "replace",
      outputQuality: "final",
      imageRoles: ["room_original", "product_front", "target_mask"],
      product: {
        name: "Fauteuil Atlas",
        description: "Fauteuil tunisien",
        material: "bois et tissu",
        dimensionsCm: { width: 82, height: 91, depth: 78 },
        anchorType: "bottom_center",
      },
      placement: {
        point: { x: 0.45, y: 0.78 },
        targetPoint: { x: 0.46, y: 0.76 },
        surfaceType: "existing_object",
      },
      preserveBackground: true,
    });

    expect(built.version).toBe(PROMPT_VERSION);
    expect(built.text).toContain("Operation: REPLACE");
    expect(built.text).toContain("No remnant or duplicate");
    expect(built.text).toContain(
      "Everything outside the confirmed edit region",
    );
    expect(built.imageRoleSummary).toEqual([
      "Image 1: untouched original room photograph; source of truth.",
      "Image 2: front catalog view; product identity reference.",
      "Image 3: confirmed editable target mask.",
    ]);
  });

  it("warns about unseen angles when only one product view exists", () => {
    const text = new PromptBuilder().build({
      mode: "insert",
      outputQuality: "preview",
      imageRoles: ["room_original", "product_front"],
      product: {
        name: "Vase",
        description: "",
        material: "ceramic",
        dimensionsCm: { width: 20, height: 40, depth: 20 },
        anchorType: "bottom_center",
      },
      placement: {
        point: { x: 0.5, y: 0.6 },
        surfaceType: "shelf",
      },
      preserveBackground: true,
    }).text;
    expect(text).toContain("Only one product angle is available");
  });

  it("builds grounded, scale-anchored instructions for multiple objects", () => {
    const text = buildSimplePointPrompt({
      objects: [
        {
          objectLabel: "Vase Sable",
          category: "ceramic vase",
          material: "céramique",
          catalogDescription: "Vase en céramique sable, silhouette arrondie.",
          placementKind: "standing",
          point: { x: 0.5, y: 0.25 },
          imageWidth: 1200,
          imageHeight: 800,
          dimensions: {
            mode: "height_length",
            heightCm: 42,
            lengthCm: 24,
          },
        },
        {
          objectLabel: "Lampe Boman",
          category: "lamp",
          material: "verre et cuivre",
          placementKind: "standing",
          emitsLight: true,
          point: { x: 0.75, y: 0.5 },
          imageWidth: 1200,
          imageHeight: 800,
          dimensions: {
            mode: "height_length",
            heightCm: 74.5,
            lengthCm: 33,
          },
        },
      ],
    });

    // Change-vs-keep contract frames the prompt.
    expect(text.startsWith("Task: reproduce the photograph in image 1")).toBe(
      true,
    );
    expect(text).toContain("adding 2 new objects");
    expect(text).toContain("Image 1 is the base canvas");
    // References declared not-to-scale so cutout pixel size is never inherited.
    expect(text).toContain("not to scale");
    // Identity: design fixed, viewpoint and lighting free.
    expect(text).toContain("Object 1 — ceramic vase, céramique (image 2)");
    expect(text).toContain("This is the product Vase Sable");
    expect(text).toContain("Its design is fixed");
    // Scale: everyday comparison computed from the catalog height.
    expect(text).toContain("42 cm tall, 24 cm wide");
    expect(text).toContain("about chair-seat height");
    // Grounding: verbal axis phrases plus fractions, base anchoring.
    expect(text).toContain("midway across, about a quarter of the way down");
    expect(text).toContain("x = 50% of the width from the left");
    expect(text).toContain("center of the contact area between its base");
    // Lamp rendered off.
    expect(text).toContain("Object 2 — lamp, verre et cuivre (image 3)");
    expect(text).toContain("It is switched off");
    // Relative proportion with a never-invert guard.
    expect(text).toContain("never render object 1 as large as object 2");
    // Mapping with contrastive binding.
    expect(text).toContain("Mapping (strict)");
    expect(text).toContain("not the lamp");
    // Pixel coordinates and quoted names are banned (px cannot be measured,
    // quotes are gpt-image's render-this-text signal).
    expect(text).not.toMatch(/\d+\s?px/);
    expect(text).not.toMatch(/["«»]/);
  });

  it("adapts anchoring to wall-mounted and floor-lying object families", () => {
    const wall = buildSimplePointPrompt({
      objects: [
        {
          objectLabel: "Miroir Louna",
          category: "mirror",
          placementKind: "wall",
          point: { x: 0.3, y: 0.4 },
          imageWidth: 1000,
          imageHeight: 1000,
          dimensions: { mode: "height_length", heightCm: 80, lengthCm: 60 },
        },
      ],
    });
    expect(wall).toContain("hangs flat against the wall");
    expect(wall).toContain("80 cm tall by 60 cm wide on the wall");

    const rug = buildSimplePointPrompt({
      objects: [
        {
          objectLabel: "Tapis Rayé",
          category: "rug",
          placementKind: "flat",
          point: { x: 0.5, y: 0.8 },
          imageWidth: 1000,
          imageHeight: 1000,
          dimensions: { mode: "length_width", lengthCm: 200, widthCm: 140 },
        },
      ],
    });
    expect(rug).toContain("lies flat on the floor");
    expect(rug).toContain("200 by 140 cm footprint");
    expect(rug).toContain("larger than the footprint of a double bed");
  });

  it("rejects more than three objects in the simple prompt", () => {
    const object = {
      objectLabel: "un objet",
      point: { x: 0.5, y: 0.5 },
      imageWidth: 1000,
      imageHeight: 1000,
      dimensions: {
        mode: "height_length" as const,
        heightCm: 20,
        lengthCm: 10,
      },
    };
    expect(() =>
      buildSimplePointPrompt({ objects: [object, object, object, object] }),
    ).toThrow(/un et trois objets/);
  });
});
