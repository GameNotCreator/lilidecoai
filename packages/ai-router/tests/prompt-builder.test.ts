import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, PromptBuilder } from "../src/index";

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
});
