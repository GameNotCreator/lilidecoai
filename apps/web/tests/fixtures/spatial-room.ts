import type { GlobalSpatialScene } from "../../lib/spatial-scene";
export const globalRoom: GlobalSpatialScene = {
  focalLengthInImageWidths: { min: 0.9, estimate: 1, max: 1.1 },
  pitchDownDegrees: { min: 25, estimate: 30, max: 35 },
  cameraEvidence: "synthetic camera fixture",
  lighting: "left",
  reflectiveRegions: [],
  surfaces: [
    {
      kind: "floor",
      label: "Floor",
      heightAboveSupportCm: { min: 140, estimate: 150, max: 160 },
      yawDegrees: 0,
      boundary: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      holes: [],
      obstacles: [],
      scaleEvidence: "synthetic test dimensions",
    },
  ],
};
