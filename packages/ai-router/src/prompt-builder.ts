import type {
  ImageReference,
  NormalizedPoint,
  OutputQuality,
  RenderMode,
  SurfaceType,
} from "./index";

export const PROMPT_VERSION = "placement-v2.0.0";
export const SIMPLE_POINT_PROMPT_VERSION = "simple-multi-point-v3.0.0";
export const SIMPLE_COMPOSITE_PROMPT_VERSION = "simple-composite-v1.1.0";

/**
 * Prompt for the composite-then-harmonize pipeline: the objects are already
 * pasted at final position and size, the model only integrates light and
 * shadow inside the mask. No coordinates, no centimetres — geometry is done.
 */
export function buildSimpleHarmonizePrompt(
  objectCount: number,
  letterboxed = false,
): string {
  const products = objectCount === 1 ? "product" : `${objectCount} products`;
  const lines = [
    `Task: image 1 is the finished composition — the customer's room photograph with ${products} already placed at final position and final size. Reproduce image 1 exactly, only integrating the ${objectCount === 1 ? "product" : "products"} naturally into the room's light.`,
    `Every product keeps exactly its current position, size, proportions, colors, materials and details as shown in image 1. The remaining images show the same ${products} for appearance reference only — ${objectCount === 1 ? "it is" : "they are"} already placed in image 1.`,
    "Only in the immediate area around each product: paint a soft, physically correct contact shadow and blend the product's edges into the scene's light and grain.",
    "The contact shadow lies flat on the horizontal surface under the product's base, matches the direction, softness and color temperature of the shadows already present, and fades within a few centimetres of the base.",
    "The wall and the background behind and beside each product keep exactly the brightness and color they have in image 1 — nothing is darkened, tinted or shaded there.",
    "Everything else — walls, floor, furniture, decoration, framing, camera, colors, white balance and grain — stays identical to image 1.",
    "The output is a clean photograph: no added text, no watermark, no outlines.",
  ];
  if (letterboxed) {
    lines.push(
      "The flat gray bars on the edges of image 1 are technical padding: keep them exactly as they are.",
    );
  }
  return lines.join("\n");
}

export type SimplePointPlacementKind = "standing" | "wall" | "flat";

export interface SimplePointObjectInput {
  /** Product display name from the catalog. Used unquoted and at most once:
   *  quoted strings are gpt-image's render-this-text convention. */
  objectLabel: string;
  /** Short English category noun ("ceramic vase", "lamp"). */
  category?: string;
  material?: string;
  catalogDescription?: string;
  placementKind?: SimplePointPlacementKind;
  /** Lamps must be rendered switched off, lit only by the room. */
  emitsLight?: boolean;
  point: NormalizedPoint;
  imageWidth: number;
  imageHeight: number;
  dimensions:
    | { mode: "height_length"; heightCm: number; lengthCm: number }
    | { mode: "length_width"; lengthCm: number; widthCm: number };
}

export interface SimplePointPromptInput {
  objects: SimplePointObjectInput[];
}

export function simplePointCategoryLabel(objectType?: string): string {
  switch (objectType) {
    case "vase":
      return "vase";
    case "lamp":
      return "lamp";
    case "frame":
      return "picture frame";
    case "mirror":
      return "mirror";
    case "rug":
      return "rug";
    case "furniture":
      return "piece of furniture";
    case "plant":
      return "plant";
    case "clock":
      return "clock";
    default:
      return "decorative object";
  }
}

export function simplePointPlacementKind(
  objectType?: string,
): SimplePointPlacementKind {
  if (objectType === "frame" || objectType === "mirror") return "wall";
  if (objectType === "rug") return "flat";
  return "standing";
}

// Axis phrases are independent per axis: unlike 3x3 grid-cell names, they
// degrade gracefully when a coordinate sits near a cell boundary.
function acrossPhrase(x: number): string {
  if (x < 0.125) return "at the far left";
  if (x < 0.375) return "about a quarter of the way in from the left";
  if (x < 0.625) return "midway across";
  if (x < 0.875) return "about three quarters of the way across";
  return "at the far right";
}

function downPhrase(y: number): string {
  if (y < 0.125) return "near the top";
  if (y < 0.375) return "about a quarter of the way down";
  if (y < 0.625) return "midway down";
  if (y < 0.875) return "about three quarters of the way down";
  return "near the bottom";
}

function positionPhrase(point: NormalizedPoint): string {
  return `${acrossPhrase(point.x)}, ${downPhrase(point.y)}`;
}

// Image models follow relational language, not centimeter arithmetic: every
// height gets a template-computed everyday comparison.
function heightComparison(heightCm: number): string {
  if (heightCm < 15) return "about the height of a coffee mug";
  if (heightCm < 30) return "about the height of a wine bottle";
  if (heightCm < 50) return "about chair-seat height";
  if (heightCm < 80) return "about table-top height";
  if (heightCm < 120) return "about door-handle height";
  return "approaching the height of a door";
}

function footprintComparison(lengthCm: number, widthCm: number): string {
  const longest = Math.max(lengthCm, widthCm);
  if (longest < 40) return "smaller than a doormat";
  if (longest < 100) return "about the size of a doormat";
  if (longest < 200) return "about the footprint of a single bed";
  return "larger than the footprint of a double bed";
}

function primarySize(object: SimplePointObjectInput): {
  cm: number;
  axis: "tall" | "across";
} {
  return object.dimensions.mode === "height_length"
    ? { cm: object.dimensions.heightCm, axis: "tall" }
    : {
        cm: Math.max(object.dimensions.lengthCm, object.dimensions.widthCm),
        axis: "across",
      };
}

// Verbal fractions: decimal multipliers ("1.8x") are weakly followed.
function ratioWords(ratio: number): string | null {
  if (ratio < 1.15) return null;
  if (ratio < 1.4) return "noticeably larger than";
  if (ratio < 1.8) return "about half as large again as";
  if (ratio < 2.6) return "about twice as large as";
  if (ratio < 3.6) return "about three times as large as";
  return "several times as large as";
}

function categoryOf(object: SimplePointObjectInput): string {
  return object.category?.trim() || "decorative object";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function sizeLine(object: SimplePointObjectInput): string {
  const kind = object.placementKind ?? "standing";
  if (object.dimensions.mode === "height_length") {
    const { heightCm, lengthCm } = object.dimensions;
    if (kind === "wall") {
      return `Real size: ${heightCm} cm tall by ${lengthCm} cm wide on the wall.`;
    }
    return `Real size: ${heightCm} cm tall, ${lengthCm} cm wide. Height is the dominant dimension — get the height right first: at ${heightCm} cm it stands ${heightComparison(heightCm)}.`;
  }
  const { lengthCm, widthCm } = object.dimensions;
  return `Real size: a ${lengthCm} by ${widthCm} cm footprint on its surface, ${footprintComparison(lengthCm, widthCm)}. The footprint is the dominant dimension — get the footprint right first.`;
}

function positionLine(
  object: SimplePointObjectInput,
  kind: SimplePointPlacementKind,
): string {
  const point = object.point;
  const coords = `(x = ${Math.round(point.x * 100)}% of the width from the left, y = ${Math.round(point.y * 100)}% of the height from the top)`;
  const where = `Position in the frame: ${positionPhrase(point)} ${coords}.`;
  if (kind === "wall") {
    return `${where} It hangs flat against the wall; this position is the geometric center of the object on that wall. Size it for the distance of that wall from the camera.`;
  }
  if (kind === "flat") {
    return `${where} It lies flat on the floor, drawn in the floor's perspective; this position is the center of its footprint.`;
  }
  return `${where} It stands on whatever horizontal surface is visible at that exact spot — shelf, table top or floor. The position marks the center of the contact area between its base and that surface, and the body of the object rises above it. Size it for the distance of that surface from the camera, not for the foreground or for the wall behind it.`;
}

function buildObjectBlock(
  object: SimplePointObjectInput,
  index: number,
): string {
  const number = index + 1;
  const imageNumber = index + 2;
  const kind = object.placementKind ?? "standing";
  const material = object.material?.trim();
  const description = object.catalogDescription?.trim();
  const name = object.objectLabel.trim();

  const lines = [
    `Object ${number} — ${categoryOf(object)}${material ? `, ${material}` : ""} (image ${imageNumber}):`,
  ];
  if (name && description) {
    lines.push(
      `- This is the product ${name}. Catalog description: ${truncate(description, 160)}`,
    );
  } else if (name) {
    lines.push(`- This is the product ${name}.`);
  }
  lines.push(
    `- Its design is fixed: same shape, proportions, colors, materials, pattern and details as image ${imageNumber}. Render it from this room's camera angle and in this room's light, but never alter its design, color shade or material, and never substitute a similar-looking product.`,
  );
  lines.push(`- ${sizeLine(object)}`);
  lines.push(`- ${positionLine(object, kind)}`);
  if (object.emitsLight) {
    lines.push(
      `- It is switched off: it emits no light and does not brighten its surroundings; it is lit only by the room's existing light, exactly as image ${imageNumber} shows it.`,
    );
  }
  return lines.join("\n");
}

function buildMappingLine(objects: SimplePointObjectInput[]): string {
  const parts = objects.map((object, index) => {
    const others = [
      ...new Set(
        objects
          .filter((_, otherIndex) => otherIndex !== index)
          .map((other) => categoryOf(other))
          .filter((label) => label !== categoryOf(object)),
      ),
    ];
    const contrast = others.length
      ? ` — not the ${others.join(" or the ")}`
      : "";
    return `object ${index + 1}, the ${categoryOf(object)} from image ${index + 2}, appears only at its own position (${positionPhrase(object.point)})${contrast}`;
  });
  return `Mapping (strict): ${parts.join("; ")}. Each object appears exactly once, and none borrows another's colors, materials or shape.`;
}

export function buildSimplePointPrompt(input: SimplePointPromptInput): string {
  const objects = input.objects;
  const count = objects.length;
  if (count < 1 || count > 3) {
    throw new Error("Le prompt simple accepte entre un et trois objets.");
  }
  const noun = count === 1 ? "object" : "objects";

  // The change-vs-keep contract frames the whole prompt: the strongest known
  // guard against full-frame redecoration when no mask is sent.
  const task = [
    `Task: reproduce the photograph in image 1 exactly, adding ${count} new ${noun} to it.`,
    `The output is image 1 itself — same room, same camera, same framing — with the new ${noun} composited onto it.`,
    `Every pixel outside the new ${noun} and their shadows must be indistinguishable from image 1.`,
  ].join(" ");

  const roles = [
    "Image roles:",
    "- Image 1 is the base canvas: the room photograph, the single source of truth for geometry, perspective, lighting and everything already present. It is never redrawn, only added to.",
    ...objects.map(
      (object, index) =>
        `- Image ${index + 2} shows the exact product to insert as object ${index + 1} (${categoryOf(object)}).`,
    ),
    "- The product images are appearance references only and are not to scale — not with each other, not with the room. Ignore how large each product appears inside its own image; only the real sizes stated below define size.",
    "- Each product image shows only its product on a uniform blank background: everything that is not that flat backdrop is part of the product, including white or light-colored parts. None of the backdrop may appear in the output — no halo, panel or fringe around the inserted object.",
  ].join("\n");

  const objectBlocks = objects.map((object, index) =>
    buildObjectBlock(object, index),
  );

  const ratioLines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    for (let other = index + 1; other < count; other += 1) {
      const a = objects[index];
      const b = objects[other];
      if (!a || !b) continue;
      const sizeA = primarySize(a);
      const sizeB = primarySize(b);
      const bIsLarger = sizeB.cm >= sizeA.cm;
      const larger = bIsLarger ? sizeB : sizeA;
      const smaller = bIsLarger ? sizeA : sizeB;
      const largerNumber = bIsLarger ? other + 1 : index + 1;
      const smallerNumber = bIsLarger ? index + 1 : other + 1;
      const words = ratioWords(larger.cm / Math.max(1, smaller.cm));
      ratioLines.push(
        words
          ? `- Side by side on the same surface, object ${largerNumber} (${larger.cm} cm) is ${words} object ${smallerNumber} (${smaller.cm} cm); never render object ${smallerNumber} as large as object ${largerNumber} at similar depth. When their positions sit at different depths, the nearer one may rightly appear larger in the frame.`
          : `- Objects ${index + 1} and ${other + 1} are about the same real size; render them at matching sizes when their positions share a similar depth.`,
      );
    }
  }

  const placement = [
    "Placement and scale:",
    "- Judge real-world scale from what is actually visible in image 1 — a door (about 200 cm tall) or a chair seat (about 45 cm) if one appears; in a close-up with no furniture, use everyday items near the position instead: a hardcover book is about 24 cm tall, a dinner plate about 27 cm across, a wine bottle about 30 cm tall. These references are for judging size only.",
    "- Deeper in the scene means smaller in the frame, following the room's own vanishing lines.",
    "- These are decorative accents, small relative to the furniture around them. When size is uncertain, err on the smaller side: an oversized object is the most common mistake.",
    ...ratioLines,
    "- Full contact with the supporting surface: nothing floats, nothing sinks, and each standing object stays plumb unless its surface is visibly inclined.",
    "- Anything physically in front of a stated position keeps overlapping the object placed there.",
    "- If an object at its correct size extends past the edge of the frame, keep its base at its position and let the frame cut it off, exactly as a real photograph would — its size never shrinks and the canvas never extends.",
  ].join("\n");

  const scene = [
    "Light and scene:",
    "- The room's lighting, exposure and color temperature are already final in image 1 and carry over unchanged. The only new light effects are each object's cast shadow and contact darkening, matching the direction and softness of the shadows already present in image 1.",
    "- Everything already present in image 1 — every object, surface, reflection, imperfection and detail — appears unchanged, in the same place, with the same colors, white balance, grain and sharpness. Camera, framing, crop and aspect ratio are identical to image 1.",
  ].join("\n");

  const additions = objects
    .map(
      (object, index) =>
        `object ${index + 1}, the ${categoryOf(object)}, ${positionPhrase(object.point)}`,
    )
    .join("; ");
  const closing = [
    `Result: the exact photograph from image 1, unchanged in every detail — same camera, framing, walls, floor, furniture, decoration, colors and grain — plus exactly ${count} new ${noun}: ${additions}.`,
    `Someone comparing the result with image 1 side by side must find exactly one difference: the ${count === 1 ? "new object and its shadow" : `${count} new objects and their shadows`}.`,
    "The stated positions are locations only, never visible marks: the output is a clean photograph with no added text, no watermark and no graphic overlays.",
  ].join(" ");

  return [
    task,
    roles,
    ...objectBlocks,
    ...(count > 1 ? [buildMappingLine(objects)] : []),
    placement,
    scene,
    closing,
  ].join("\n\n");
}

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
