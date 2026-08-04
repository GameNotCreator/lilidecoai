import type {
  ImageReference,
  NormalizedPoint,
  OutputQuality,
  RenderMode,
  SurfaceType,
} from "./index";

export const PROMPT_VERSION = "placement-v2.0.0";

export interface PromptBuilderInput {
  mode: RenderMode;
  outputQuality: OutputQuality;
  imageRoles: ImageReference["role"][];
  product: {
    name: string;
    description: string;
    material: string;
    dimensionsCm: { width: number; height: number; depth: number };
    anchorType: string;
    merchantInstructions?: string;
  };
  placement: {
    point: NormalizedPoint;
    targetPoint?: NormalizedPoint;
    surfaceType: SurfaceType;
    geometry?: Record<string, unknown>;
  };
  lighting?: Record<string, unknown>;
  calibration?: Record<string, unknown>;
  preserveBackground: boolean;
  userInstructions?: string;
  repairFeedback?: string;
}

export interface BuiltPrompt {
  version: string;
  text: string;
  imageRoleSummary: string[];
}

const roleLabels: Record<ImageReference["role"], string> = {
  room_original: "untouched original room photograph; source of truth",
  product_front: "front catalog view; product identity reference",
  product_three_quarter: "three-quarter catalog view; geometry reference",
  product_side: "side catalog view; depth reference",
  product_back: "back catalog view; hidden-side reference",
  product_detail: "detail catalog view; material and distinctive details",
  composition:
    "deterministic placement composition; position and scale reference",
  target_mask: "confirmed editable target mask",
  intermediate: "intermediate cleanup or repair result",
};

export class PromptBuilder {
  readonly version = PROMPT_VERSION;

  build(input: PromptBuilderInput): BuiltPrompt {
    const imageRoleSummary = input.imageRoles.map(
      (role, index) => `Image ${index + 1}: ${roleLabels[role]}.`,
    );
    const productViewCount = input.imageRoles.filter((role) =>
      role.startsWith("product_"),
    ).length;
    const modeInstructions =
      input.mode === "replace"
        ? [
            "Operation: REPLACE the object selected by the confirmed mask.",
            "Remove the complete old object inside the mask, including appendages, feet, handles, cables, reflections and its old contact shadow.",
            "Reconstruct hidden background/support texture before integrating exactly one new catalog product.",
            "No remnant or duplicate of the old object may remain.",
          ]
        : [
            "Operation: INSERT exactly one catalog product at the indicated placement point.",
            "Do not remove, move or invent existing furniture or decoration.",
          ];

    const lines = [
      `PROMPT_VERSION: ${PROMPT_VERSION}`,
      "ROLE: Perform a constrained purchase-decision product visualization edit, not an inspiration image.",
      "IMAGE ROLES:",
      ...imageRoleSummary,
      "PRODUCT IDENTITY (HARD CONSTRAINTS):",
      `Product: ${input.product.name}. ${input.product.description}`,
      `Real dimensions: width ${input.product.dimensionsCm.width} cm, height ${input.product.dimensionsCm.height} cm, depth ${input.product.dimensionsCm.depth} cm. Anchor: ${input.product.anchorType}. Material: ${input.product.material}.`,
      "Preserve shape, silhouette, proportions, colors, patterns, material, distinctive details, legs, armrests, seams, handles and element count from the supplied product views.",
      productViewCount <= 1
        ? "Only one product angle is available. Infer hidden surfaces conservatively and never imply exact fidelity for unseen angles."
        : "Use all supplied product views together; do not blend them into multiple products.",
      "EDIT OPERATION:",
      ...modeInstructions,
      "GEOMETRY AND CONTACT (HARD CONSTRAINTS):",
      `Surface: ${input.placement.surfaceType}. Normalized point: x=${input.placement.point.x.toFixed(4)}, y=${input.placement.point.y.toFixed(4)}.`,
      `Deterministic geometry: ${JSON.stringify(input.placement.geometry ?? {})}.`,
      `Calibration: ${JSON.stringify(input.calibration ?? { status: "estimated" })}.`,
      "Keep the original camera, crop, lens perspective, horizon and vanishing lines. The product bottom/anchor must contact the indicated physical support plane.",
      "Follow the supplied dimensions and calibration. If calibration is estimated, use nearby objects, support depth and perspective as scale evidence without making the object implausibly small merely to fit.",
      "Respect foreground occlusion: objects physically in front must mask the product correctly. Never let the product cross walls, shelf tops, ceilings or support boundaries.",
      "LIGHT AND MATERIAL INTEGRATION:",
      `Scene lighting analysis: ${JSON.stringify(input.lighting ?? { mode: "automatic" })}.`,
      "Match illumination direction, intensity, color temperature, softness, white balance, reflections, contact shadow, ambient occlusion, depth of field, grain and compression of the original photograph.",
      "BACKGROUND PRESERVATION:",
      input.preserveBackground
        ? "Everything outside the confirmed edit region must remain pixel-consistent with the original room. Do not move walls, windows, doors, architecture, furniture or decor."
        : "Preserve all unrelated room content and architecture.",
      "Exactly one new product must be visible. No duplicated contours, ghost product, extra furniture, invented decor, melted parts, cut parts, halos or floating contact are allowed.",
      input.product.merchantInstructions
        ? `Merchant instructions (apply only when compatible with identity and geometry): ${input.product.merchantInstructions}`
        : "Merchant instructions: none.",
      input.userInstructions
        ? `User instructions (apply only when compatible with hard constraints): ${input.userInstructions}`
        : "User instructions: none.",
      input.repairFeedback
        ? `TARGETED RETRY: Correct only this validated failure: ${input.repairFeedback}`
        : "TARGETED RETRY: none.",
      input.outputQuality === "preview"
        ? "OUTPUT: fast photorealistic preview, restrained detail, same room aspect ratio."
        : "OUTPUT: premium photorealistic final suitable for a purchase decision, with high-fidelity product identity and clean local integration.",
    ];

    return {
      version: this.version,
      text: lines.join("\n"),
      imageRoleSummary,
    };
  }
}
