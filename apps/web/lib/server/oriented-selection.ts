import "server-only";
import { createHash } from "node:crypto";
import {
  intersectSupport,
  projectSpatialPoint,
  type SpatialCamera,
} from "@lili/geometry";
import type { PreparedProductView } from "@lili/types";
import { planSpatialPlacement } from "../spatial-scene";

export const ORIENTED_PLACEMENT_VERSION = "oriented-placement-v1" as const;
type Point = { x: number; y: number };
type Bounds = { x: number; y: number; width: number; height: number };
export type LocalOrientation = { azimuthDeg: number; elevationDeg: number };
export type OrientationUncertainty = {
  azimuthMinDeg: number;
  azimuthMaxDeg: number;
  elevationMinDeg: number;
  elevationMaxDeg: number;
  source: "model_estimate_not_statistical";
};

export class OrientedPlacementError extends Error {
  readonly status = 422;
  constructor(
    readonly code:
      | "orientation_unavailable"
      | "invalid_view"
      | "invalid_pose"
      | "support_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "OrientedPlacementError";
  }
}

/** The authoritative camera and all polygons use the normalized full scene.
 * Cropping is only an affine display transform, never a second camera estimate. */
export function transformOrientedPoint(
  point: Point,
  matrix: readonly number[],
): Point {
  if (
    matrix.length !== 6 ||
    ![point.x, point.y, ...matrix].every(Number.isFinite)
  )
    throw new OrientedPlacementError(
      "invalid_pose",
      "Transformation de coordonnées invalide.",
    );
  const [a, b, c, d, e, f] = matrix as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (Math.abs(a * d - b * c) < 1e-9)
    throw new OrientedPlacementError(
      "invalid_pose",
      "Transformation de coordonnées dégénérée.",
    );
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

const wrapDegrees = (value: number) =>
  ((((value + 180) % 360) + 360) % 360) - 180;

/** Azimuth zero faces the camera at the centre of the image. Positive azimuth
 * observes the product from its left. Object yaw follows projectSpatialBox.
 * Elevation targets the object's mid-height, not the global camera pitch. */
export function localCameraOrientation(
  camera: SpatialCamera,
  anchorPx: Point,
  productHeightCm: number,
  yawDegrees: number,
): LocalOrientation {
  if (
    !(productHeightCm > 0) ||
    ![productHeightCm, yawDegrees].every(Number.isFinite)
  )
    throw new OrientedPlacementError(
      "invalid_pose",
      "Dimensions ou rotation invalides.",
    );
  const origin = intersectSupport(camera, anchorPx);
  return {
    azimuthDeg: wrapDegrees(
      (Math.atan2(origin.x, origin.z) * 180) / Math.PI - yawDegrees,
    ),
    elevationDeg:
      (Math.atan2(
        camera.heightAboveSupportCm - productHeightCm / 2,
        Math.hypot(origin.x, origin.z),
      ) *
        180) /
      Math.PI,
  };
}

type PlanInput = Parameters<typeof planSpatialPlacement>[0] & {
  views: PreparedProductView[];
  organizationId: string;
  productId: string;
  variantId: string | null;
  sourceFingerprint: string;
  geometryFingerprint: string;
  /** Optional original/EXIF/crop lineage. Placement coordinates remain normalized. */
  coordinateTransforms?: Array<{
    from: string;
    to: string;
    matrix: [number, number, number, number, number, number];
  }>;
};

type Interval = [number, number];
const intervalProduct = (a: Interval, b: Interval): Interval => {
  const products = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [Math.min(...products), Math.max(...products)];
};
const intervalSquare = (a: Interval): Interval => [
  a[0] <= 0 && a[1] >= 0 ? 0 : Math.min(a[0] ** 2, a[1] ** 2),
  Math.max(a[0] ** 2, a[1] ** 2),
];

/** Interval arithmetic encloses the entire camera range, including extrema
 * between sampled corners. Deliberately loose bounds result in refusal. */
export function localOrientationBounds(input: {
  width: number;
  height: number;
  anchor: Point;
  productHeightCm: number;
  yawDegrees: number;
  focalPx: Interval;
  pitchDownDegrees: Interval;
  heightAboveSupportCm: Interval;
}): OrientationUncertainty {
  const focal = input.focalPx,
    height = input.heightAboveSupportCm;
  if (
    ![
      ...focal,
      ...height,
      ...input.pitchDownDegrees,
      input.width,
      input.height,
      input.anchor.x,
      input.anchor.y,
      input.productHeightCm,
      input.yawDegrees,
    ].every(Number.isFinite) ||
    focal[0] > focal[1] ||
    height[0] > height[1] ||
    input.pitchDownDegrees[0] > input.pitchDownDegrees[1] ||
    focal[0] <= 0 ||
    height[0] <= 0 ||
    input.pitchDownDegrees[0] <= -89.5 ||
    input.pitchDownDegrees[1] >= 89.5
  )
    throw new OrientedPlacementError(
      "orientation_unavailable",
      "L’incertitude de caméra ne permet pas de choisir une vue fiable.",
    );
  const pitch = input.pitchDownDegrees.map(
    (p) => (p * Math.PI) / 180,
  ) as Interval;
  const sin: Interval = [Math.sin(pitch[0]), Math.sin(pitch[1])];
  const cos: Interval = [
    Math.min(Math.cos(pitch[0]), Math.cos(pitch[1])),
    pitch[0] <= 0 && pitch[1] >= 0
      ? 1
      : Math.max(Math.cos(pitch[0]), Math.cos(pitch[1])),
  ];
  const divideByFocal = (value: number): Interval => [
    Math.min(value / focal[0], value / focal[1]),
    Math.max(value / focal[0], value / focal[1]),
  ];
  const x = divideByFocal(input.anchor.x - input.width / 2),
    up = divideByFocal(input.height / 2 - input.anchor.y);
  const upCos = intervalProduct(up, cos),
    upSin = intervalProduct(up, sin);
  const down: Interval = [sin[0] - upCos[1], sin[1] - upCos[0]];
  const z: Interval = [upSin[0] + cos[0], upSin[1] + cos[1]];
  if (down[0] <= 0 || z[0] <= 0)
    throw new OrientedPlacementError(
      "orientation_unavailable",
      "La caméra pourrait ne pas voir ce support dans toute sa plage d’incertitude.",
    );
  const xSquared = intervalSquare(x),
    zSquared = intervalSquare(z);
  const horizontal: Interval = [
    Math.sqrt(xSquared[0] + zSquared[0]),
    Math.sqrt(xSquared[1] + zSquared[1]),
  ];
  const heightFactor: Interval = [
    1 - input.productHeightCm / (2 * height[0]),
    1 - input.productHeightCm / (2 * height[1]),
  ];
  const elevationRatio = intervalProduct(intervalProduct(heightFactor, down), [
    1 / horizontal[1],
    1 / horizontal[0],
  ]);
  const azimuthRatio = intervalProduct(x, [1 / z[1], 1 / z[0]]);
  const azimuth = azimuthRatio.map(
    (v) => (Math.atan(v) * 180) / Math.PI - input.yawDegrees,
  ) as Interval;
  const wrapped = azimuth.map(wrapDegrees) as Interval;
  if (wrapped[0] > wrapped[1])
    throw new OrientedPlacementError(
      "orientation_unavailable",
      "Cette orientation traverse une limite de couverture des vues.",
    );
  return {
    azimuthMinDeg: wrapped[0],
    azimuthMaxDeg: wrapped[1],
    elevationMinDeg: (Math.atan(elevationRatio[0]) * 180) / Math.PI,
    elevationMaxDeg: (Math.atan(elevationRatio[1]) * 180) / Math.PI,
    source: "model_estimate_not_statistical",
  };
}

export type OrientedPlacementPlan = {
  version: typeof ORIENTED_PLACEMENT_VERSION;
  sceneFingerprint: string;
  planFingerprint: string;
  width: number;
  height: number;
  spatial: ReturnType<typeof planSpatialPlacement>;
  view: PreparedProductView;
  localOrientation: LocalOrientation;
  orientationUncertainty: OrientationUncertainty;
  /** One scale for both axes. Input coordinates are prepared-image pixels. */
  transform: {
    scale: number;
    rotationDegrees: number;
    translateX: number;
    translateY: number;
  };
  visibleBounds: Bounds;
  anchor: Point;
  projectedPhysicalHeightPx: number;
  coordinateTransforms: NonNullable<PlanInput["coordinateTransforms"]>;
  metricVerified: false;
};

function containsCoverage(
  coverage: NonNullable<PreparedProductView["orientation"]["coverage"]>,
  interval: OrientationUncertainty,
) {
  return (
    coverage.azimuthMinDeg <= interval.azimuthMinDeg &&
    coverage.azimuthMaxDeg >= interval.azimuthMaxDeg &&
    coverage.elevationMinDeg <= interval.elevationMinDeg &&
    coverage.elevationMaxDeg >= interval.elevationMaxDeg
  );
}

export function selectOrientedView(input: {
  views: PreparedProductView[];
  organizationId: string;
  productId: string;
  variantId: string | null;
  sourceFingerprint: string;
  geometryFingerprint: string;
  localOrientation: LocalOrientation;
  uncertainty: OrientationUncertainty;
}): PreparedProductView {
  const views = input.views.filter(
    (view) =>
      view.organizationId === input.organizationId &&
      view.productId === input.productId &&
      view.variantId === input.variantId &&
      view.state === "approved" &&
      view.sourceFingerprint === input.sourceFingerprint &&
      view.geometryFingerprint === input.geometryFingerprint &&
      view.image &&
      view.alpha &&
      view.visibleBounds &&
      view.anchor &&
      view.physicalHeightSegment &&
      view.orientation.estimated &&
      view.orientation.coverage &&
      view.review &&
      view.review.decision === "approved" &&
      view.review.kind === "human" &&
      view.review.coverage &&
      Object.values(view.review.criteria).every(
        (criterion) => criterion === "pass",
      ) &&
      containsCoverage(view.orientation.coverage, input.uncertainty) &&
      containsCoverage(view.review.coverage, input.uncertainty),
  );
  // A real photograph wins over a reconstruction, then the closest measured
  // view. Requested generator angles deliberately never contribute to ranking.
  const distance = (view: PreparedProductView) => {
    const measured = view.orientation.estimated!;
    return Math.hypot(
      wrapDegrees(measured.azimuthDeg - input.localOrientation.azimuthDeg),
      measured.elevationDeg - input.localOrientation.elevationDeg,
    );
  };
  views.sort(
    (a, b) =>
      Number(a.origin !== "photographed") -
        Number(b.origin !== "photographed") ||
      distance(a) - distance(b) ||
      a.id.localeCompare(b.id) ||
      b.revision - a.revision,
  );
  const selected = views[0];
  if (!selected)
    throw new OrientedPlacementError(
      "orientation_unavailable",
      "Aucune vue approuvée ne couvre cet angle et son incertitude. Déplacez l’objet ou choisissez une autre photo.",
    );
  return structuredClone(selected);
}

export function buildOrientedPlacementPlan(
  input: PlanInput,
): OrientedPlacementPlan {
  const spatial = planSpatialPlacement(input);
  if (!spatial.fits || !spatial.supportFits)
    throw new OrientedPlacementError(
      "support_unavailable",
      "L’objet dépasse le cadre ou le support libre. Déplacez son point d’appui.",
    );
  const anchor = {
    x: input.point.x * input.width,
    y: input.point.y * input.height,
  };
  const localOrientation = localCameraOrientation(
    spatial.camera,
    anchor,
    input.size.heightCm,
    spatial.projection.yawDegrees,
  );
  const calibrationFactor =
    spatial.camera.heightAboveSupportCm /
    spatial.surface.heightAboveSupportCm.estimate;
  const orientationUncertainty = localOrientationBounds({
    width: input.width,
    height: input.height,
    anchor,
    productHeightCm: input.size.heightCm,
    yawDegrees: spatial.projection.yawDegrees,
    focalPx: [
      input.width * input.scene.focalLengthInImageWidths.min,
      input.width * input.scene.focalLengthInImageWidths.max,
    ],
    pitchDownDegrees: [
      input.scene.pitchDownDegrees.min,
      input.scene.pitchDownDegrees.max,
    ],
    heightAboveSupportCm: [
      spatial.surface.heightAboveSupportCm.min * calibrationFactor,
      spatial.surface.heightAboveSupportCm.max * calibrationFactor,
    ],
  });
  // A wrap across the back face cannot be represented by one approved interval.
  if (
    orientationUncertainty.azimuthMaxDeg -
      orientationUncertainty.azimuthMinDeg >
    180
  )
    throw new OrientedPlacementError(
      "orientation_unavailable",
      "Cette orientation traverse une limite de couverture des vues.",
    );
  const view = selectOrientedView({
    ...input,
    localOrientation,
    uncertainty: orientationUncertainty,
  });
  const image = view.image!,
    physical = view.physicalHeightSegment!,
    bounds = view.visibleBounds!,
    viewAnchor = view.anchor!;
  if (
    image.widthPx !== view.alpha!.widthPx ||
    image.heightPx !== view.alpha!.heightPx ||
    viewAnchor.confidence < 0.8
  )
    throw new OrientedPlacementError(
      "invalid_view",
      "La vue préparée ne possède pas un masque et un appui fiables.",
    );
  const sourceHeight = Math.hypot(
    (physical.top.x - physical.bottom.x) * image.widthPx,
    (physical.top.y - physical.bottom.y) * image.heightPx,
  );
  if (
    Math.hypot(
      (physical.bottom.x - viewAnchor.x) * image.widthPx,
      (physical.bottom.y - viewAnchor.y) * image.heightPx,
    ) > Math.max(2, sourceHeight * 0.03)
  )
    throw new OrientedPlacementError(
      "invalid_view",
      "Le segment physique doit partir de l’appui annoté de la vue.",
    );
  const projectedTop = projectSpatialPoint(spatial.camera, {
    ...spatial.projection.origin,
    y: input.size.heightCm,
  });
  const projectedPhysicalHeightPx = Math.hypot(
    projectedTop.x - anchor.x,
    projectedTop.y - anchor.y,
  );
  if (
    !Number.isFinite(sourceHeight) ||
    sourceHeight < 2 ||
    projectedPhysicalHeightPx < 4
  )
    throw new OrientedPlacementError(
      "invalid_view",
      "Le segment physique de la vue ou la taille projetée est inexploitable.",
    );
  const scale = projectedPhysicalHeightPx / sourceHeight;
  const sourceAngle = Math.atan2(
    (physical.top.y - physical.bottom.y) * image.heightPx,
    (physical.top.x - physical.bottom.x) * image.widthPx,
  );
  const targetAngle = Math.atan2(
    projectedTop.y - anchor.y,
    projectedTop.x - anchor.x,
  );
  const rotation = targetAngle - sourceAngle;
  const cosine = Math.cos(rotation),
    sine = Math.sin(rotation);
  const rotateScale = (p: Point) => ({
    x: scale * (cosine * p.x - sine * p.y),
    y: scale * (sine * p.x + cosine * p.y),
  });
  const anchorOffset = rotateScale({
    x: viewAnchor.x * image.widthPx,
    y: viewAnchor.y * image.heightPx,
  });
  const transform = {
    scale,
    rotationDegrees: (rotation * 180) / Math.PI,
    translateX: anchor.x - anchorOffset.x,
    translateY: anchor.y - anchorOffset.y,
  };
  const corners = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x + bounds.width, bounds.y + bounds.height],
    [bounds.x, bounds.y + bounds.height],
  ].map(([x, y]) =>
    rotateScale({ x: x! * image.widthPx, y: y! * image.heightPx }),
  );
  const visibleBounds = {
    x: transform.translateX + Math.min(...corners.map((p) => p.x)),
    y: transform.translateY + Math.min(...corners.map((p) => p.y)),
    width:
      Math.max(...corners.map((p) => p.x)) -
      Math.min(...corners.map((p) => p.x)),
    height:
      Math.max(...corners.map((p) => p.y)) -
      Math.min(...corners.map((p) => p.y)),
  };
  if (
    visibleBounds.x < 1 ||
    visibleBounds.y < 1 ||
    visibleBounds.x + visibleBounds.width > input.width - 1 ||
    visibleBounds.y + visibleBounds.height > input.height - 1
  )
    throw new OrientedPlacementError(
      "invalid_pose",
      "La silhouette préparée est coupée par le cadre.",
    );
  const envelope = spatial.projection.bounds;
  // Two pixels cover sampling/annotation rounding, not a corrective deformation.
  if (
    visibleBounds.x < envelope.left - 2 ||
    visibleBounds.y < envelope.top - 2 ||
    visibleBounds.x + visibleBounds.width > envelope.right + 2 ||
    visibleBounds.y + visibleBounds.height > envelope.bottom + 2
  )
    throw new OrientedPlacementError(
      "invalid_view",
      "La silhouette préparée dépasse l’enveloppe des dimensions catalogue. Revérifiez la vue et son segment physique.",
    );
  for (const step of input.coordinateTransforms ?? [])
    transformOrientedPoint({ x: 0, y: 0 }, step.matrix);
  const plan = {
    version: ORIENTED_PLACEMENT_VERSION,
    sceneFingerprint: input.fingerprint,
    width: input.width,
    height: input.height,
    spatial,
    view,
    localOrientation,
    orientationUncertainty,
    transform,
    visibleBounds,
    anchor,
    projectedPhysicalHeightPx,
    coordinateTransforms: input.coordinateTransforms ?? [],
    metricVerified: false as const,
  };
  return {
    ...plan,
    planFingerprint: createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex"),
  };
}
