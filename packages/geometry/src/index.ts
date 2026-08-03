export type Point = Readonly<{ x: number; y: number }>;
export type Quad = readonly [Point, Point, Point, Point];
export type Matrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface SegmentCalibration {
  mode: "wall";
  pixelsPerCentimeter: number;
  referencePixels: number;
  referenceCentimeters: number;
  axis: "horizontal" | "vertical";
}

export interface SurfaceCalibration {
  mode: "surface";
  homography: Matrix3;
  widthCentimeters: number;
  depthCentimeters: number;
  corners: Quad;
}

export interface NormalizedBounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface PlacementFitInput {
  imageWidth: number;
  imageHeight: number;
  productWidthCm: number;
  productHeightCm: number;
  xNormalized: number;
  yNormalized: number;
  scale: number;
  fitBounds: NormalizedBounds;
  marginRatio?: number;
}

export interface PlacementFitResult {
  fits: boolean;
  productBounds: NormalizedBounds;
  violations: Array<"left" | "right" | "top" | "bottom">;
}

export class GeometryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_DIMENSION"
      | "DEGENERATE_SEGMENT"
      | "DEGENERATE_SURFACE"
      | "SINGULAR_MATRIX",
  ) {
    super(message);
    this.name = "GeometryError";
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function cmToPixels(
  centimeters: number,
  pixelsPerCentimeter: number,
): number {
  assertPositive(centimeters, "centimeters");
  assertPositive(pixelsPerCentimeter, "pixelsPerCentimeter");
  return centimeters * pixelsPerCentimeter;
}

export function pixelsToCm(
  pixels: number,
  pixelsPerCentimeter: number,
): number {
  if (pixels < 0 || !Number.isFinite(pixels)) {
    throw new GeometryError(
      "pixels must be finite and non-negative",
      "INVALID_DIMENSION",
    );
  }
  assertPositive(pixelsPerCentimeter, "pixelsPerCentimeter");
  return pixels / pixelsPerCentimeter;
}

export function calibrateSegment(
  start: Point,
  end: Point,
  realLengthCentimeters: number,
): SegmentCalibration {
  assertPositive(realLengthCentimeters, "realLengthCentimeters");
  const referencePixels = distance(start, end);
  if (referencePixels < 2) {
    throw new GeometryError(
      "The calibration segment must span at least two pixels",
      "DEGENERATE_SEGMENT",
    );
  }

  return {
    mode: "wall",
    pixelsPerCentimeter: referencePixels / realLengthCentimeters,
    referencePixels,
    referenceCentimeters: realLengthCentimeters,
    axis:
      Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
        ? "horizontal"
        : "vertical",
  };
}

export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  return Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length] as Point;
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
}

export function pointInPolygon(
  point: Point,
  polygon: readonly Point[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++
  ) {
    const currentPoint = polygon[index] as Point;
    const previousPoint = polygon[previous] as Point;
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function calibrateSurface(
  corners: Quad,
  widthCentimeters: number,
  depthCentimeters: number,
): SurfaceCalibration {
  assertPositive(widthCentimeters, "widthCentimeters");
  assertPositive(depthCentimeters, "depthCentimeters");
  if (polygonArea(corners) < 16) {
    throw new GeometryError(
      "The selected surface is too small or degenerate",
      "DEGENERATE_SURFACE",
    );
  }

  const source: Quad = [
    { x: 0, y: 0 },
    { x: widthCentimeters, y: 0 },
    { x: widthCentimeters, y: depthCentimeters },
    { x: 0, y: depthCentimeters },
  ];
  return {
    mode: "surface",
    homography: solveHomography(source, corners),
    widthCentimeters,
    depthCentimeters,
    corners,
  };
}

export function solveHomography(source: Quad, target: Quad): Matrix3 {
  const rows: number[][] = [];
  const values: number[] = [];

  for (let index = 0; index < 4; index += 1) {
    const from = source[index] as Point;
    const to = target[index] as Point;
    rows.push([from.x, from.y, 1, 0, 0, 0, -to.x * from.x, -to.x * from.y]);
    values.push(to.x);
    rows.push([0, 0, 0, from.x, from.y, 1, -to.y * from.x, -to.y * from.y]);
    values.push(to.y);
  }

  const solution = gaussianSolve(rows, values);
  return [
    solution[0] as number,
    solution[1] as number,
    solution[2] as number,
    solution[3] as number,
    solution[4] as number,
    solution[5] as number,
    solution[6] as number,
    solution[7] as number,
    1,
  ];
}

export function projectPoint(matrix: Matrix3, point: Point): Point {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-9) {
    throw new GeometryError("Point projects to infinity", "SINGULAR_MATRIX");
  }
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

export function rotatePoint(
  point: Point,
  center: Point,
  degrees: number,
): Point {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

export function selectOutputSize(
  width: number,
  height: number,
): "1024x1024" | "1536x1024" | "1024x1536" {
  assertPositive(width, "width");
  assertPositive(height, "height");
  const ratio = width / height;
  if (ratio > 1.15) return "1536x1024";
  if (ratio < 0.87) return "1024x1536";
  return "1024x1024";
}

/**
 * Validates a placement using the catalog aspect ratio and the room image
 * aspect ratio. `scale` is the product width divided by the full image width;
 * x is the horizontal centre and y is the bottom contact point.
 */
export function validatePlacementFit(
  input: PlacementFitInput,
): PlacementFitResult {
  assertPositive(input.imageWidth, "imageWidth");
  assertPositive(input.imageHeight, "imageHeight");
  assertPositive(input.productWidthCm, "productWidthCm");
  assertPositive(input.productHeightCm, "productHeightCm");
  assertPositive(input.scale, "scale");

  const margin = Math.max(0, Math.min(input.marginRatio ?? 0.01, 0.1));
  const productHeightNormalized =
    input.scale *
    (input.productHeightCm / input.productWidthCm) *
    (input.imageWidth / input.imageHeight);
  const productBounds: NormalizedBounds = {
    xMin: input.xNormalized - input.scale / 2,
    xMax: input.xNormalized + input.scale / 2,
    yMin: input.yNormalized - productHeightNormalized,
    yMax: input.yNormalized,
  };
  const fitBounds: NormalizedBounds = {
    xMin: Math.max(0, Math.min(input.fitBounds.xMin, input.fitBounds.xMax)),
    xMax: Math.min(1, Math.max(input.fitBounds.xMin, input.fitBounds.xMax)),
    yMin: Math.max(0, Math.min(input.fitBounds.yMin, input.fitBounds.yMax)),
    yMax: Math.min(1, Math.max(input.fitBounds.yMin, input.fitBounds.yMax)),
  };
  const violations: PlacementFitResult["violations"] = [];
  if (productBounds.xMin < fitBounds.xMin + margin) violations.push("left");
  if (productBounds.xMax > fitBounds.xMax - margin) violations.push("right");
  if (productBounds.yMin < fitBounds.yMin + margin) violations.push("top");
  if (productBounds.yMax > fitBounds.yMax - margin) violations.push("bottom");

  return { fits: violations.length === 0, productBounds, violations };
}

function gaussianSolve(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [
    ...row,
    vector[index] as number,
  ]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        Math.abs(augmented[row]?.[column] ?? 0) >
        Math.abs(augmented[pivot]?.[column] ?? 0)
      ) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot]?.[column] ?? 0) < 1e-10) {
      throw new GeometryError(
        "Calibration points produce a singular matrix",
        "SINGULAR_MATRIX",
      );
    }
    [augmented[column], augmented[pivot]] = [
      augmented[pivot] as number[],
      augmented[column] as number[],
    ];
    const divisor = augmented[column]?.[column] as number;
    for (let index = column; index <= size; index += 1) {
      (augmented[column] as number[])[index] =
        (augmented[column]?.[index] as number) / divisor;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]?.[column] as number;
      for (let index = column; index <= size; index += 1) {
        (augmented[row] as number[])[index] =
          (augmented[row]?.[index] as number) -
          factor * (augmented[column]?.[index] as number);
      }
    }
  }
  return augmented.map((row) => row[size] as number);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new GeometryError(
      `${name} must be finite and positive`,
      "INVALID_DIMENSION",
    );
  }
}
