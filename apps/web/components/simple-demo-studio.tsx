"use client";

import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ImagePlus,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Ruler,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ASSUMED_ROOM_WIDTH_CM,
  computeSimplePlacement,
  footprintsCollide,
  normalizeTap,
  orderByDepth,
  type SimpleDimensionPair,
  type SimplePlacementKind,
  type SimplePlacementResult,
  type SimpleScaleSource,
} from "@lili/geometry";
import type { Render } from "@lili/types";

import { api, establishGuestEditorSession, getRender } from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";
import {
  startRenderTracking,
  type RenderTrackingIssue,
} from "@/lib/render-tracking";
import { renderTerminalAnnouncement } from "@/lib/render-progress";
import { RenderProgressPanel } from "./render-progress-panel";

type DimensionMode = "height_length" | "length_width";
type ObjectDimensionPair = SimpleDimensionPair;
type Step = 1 | 2 | 3;

/** Measurements the server takes on the stored cutout during /prepare. */
interface CutoutInfo {
  widthPx: number;
  heightPx: number;
  baseRowFraction: number;
  source: "heuristic" | "model" | "matting";
  synthetic: boolean;
  shadowRemoved: boolean;
  warnings: string[];
}

interface PreparedProduct {
  id: string;
  name: string;
  cutoutUrl?: string | null;
  widthCm: number;
  heightCm: number;
  depthCm: number;
  cutout?: Partial<CutoutInfo> | null;
}

interface DemoObject {
  key: string;
  file: File | null;
  preview: string;
  kind: SimplePlacementKind;
  isMirror: boolean;
  dimensionMode: DimensionMode;
  heightValue: string;
  lengthValue: string;
  widthValue: string;
  product: PreparedProduct | null;
  /** Multiplier applied by the customer on the measured scale (1 = none). */
  scaleFactor: number;
  /** The customer chose to continue despite the cutout notices. */
  noticesAcknowledged: boolean;
}

interface Scene {
  id: string;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
}

interface Point {
  x: number;
  y: number;
}

/** One span of POST /v1/scenes/:id/scale, in tap order. */
interface SceneScaleSpan {
  pixelsPerCm: number | null;
  scaleSource: SimpleScaleSource;
  confidence: "high" | "low" | "none";
  supportKind: string;
  supportMaterial: string;
  supportGlossy: boolean;
  referenceKind: string;
  impliedFrameWidthCm: number | null;
}

interface SceneLighting {
  lightDirection: "left" | "right" | "front" | "behind" | "top" | "diffuse";
  lightElevation: "low" | "mid" | "high";
  shadowSoftness: "hard" | "soft";
  colourTemperature: "warm" | "neutral" | "cool";
  shadowDirection: string;
}

interface SceneScaleResponse {
  spans: SceneScaleSpan[];
  lighting: SceneLighting | null;
}

interface SceneScaleState {
  key: string;
  spans: SceneScaleSpan[];
  lighting: SceneLighting | null;
  error: string;
}

/** Narrowed view of render.placement.compositePlacements[i]. */
export interface CompositePlacementSummary {
  objectIndex: number;
  scaleSource: SimpleScaleSource | null;
  clamped: boolean;
  croppedByFrame: number;
  pixelsPerCm: number | null;
  impliedWidthCm: number | null;
}

interface ObjectPlacement {
  index: number;
  placement: SimplePlacementResult;
  /** Effective pixels per centimetre once the slider is applied, or null. */
  userPixelsPerCm: number | null;
  span: SceneScaleSpan | null;
}

const MAX_OBJECTS = 3;
const SCALE_DEBOUNCE_MS = 400;
const ASPECT_MISMATCH_TOLERANCE = 0.35;
const CROPPED_WARNING_THRESHOLD = 0.85;
const progressLabels = ["Vos objets", "Votre intérieur", "Résultat"];

const KIND_LABELS: Record<SimplePlacementKind, string> = {
  standing: "Posé (sol ou meuble)",
  wall: "Au mur",
  flat: "À plat (tapis)",
};

const KIND_CATALOG: Record<
  SimplePlacementKind,
  { objectType: string; placementType: string; surfaceType: string }
> = {
  standing: {
    objectType: "other",
    placementType: "table",
    surfaceType: "tabletop",
  },
  wall: { objectType: "frame", placementType: "wall", surfaceType: "wall" },
  flat: { objectType: "rug", placementType: "floor", surfaceType: "floor" },
};

export function SimpleDemoStudio() {
  const [step, setStep] = useState<Step>(1);
  const [ready, setReady] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Préparation de la démo…");
  const [error, setError] = useState("");
  const [objects, setObjects] = useState<DemoObject[]>(() => [createObject(1)]);
  const [scene, setScene] = useState<Scene | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [scale, setScale] = useState<SceneScaleState | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [trackingIssue, setTrackingIssue] =
    useState<RenderTrackingIssue | null>(null);
  const [regenFactors, setRegenFactors] = useState<Record<number, number>>({});
  const nextObjectId = useRef(2);
  const previewUrls = useRef(new Set<string>());
  const frameRef = useRef<HTMLButtonElement | null>(null);
  const refreshTracking = useRef<(() => void) | null>(null);
  const progressPanelRef = useRef<HTMLDivElement | null>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusResultAfterUpdate = useRef(false);
  const renderInProgress =
    render?.status === "processing" || render?.status === "queued";
  const trackedRenderId = renderInProgress ? render.id : null;

  const busy = Boolean(busyLabel && ready);
  const objectsAreValid = objects.every(isObjectReady);
  const allPointsPlaced = points.length === objects.length;
  const pixelPoints = useMemo(() => {
    if (!scene) return [];
    return points.map((point) => ({
      x: Math.round(point.x * scene.widthPx),
      y: Math.round(point.y * scene.heightPx),
    }));
  }, [points, scene]);

  const scaleKey =
    scene && allPointsPlaced
      ? JSON.stringify({
          sceneId: scene.id,
          points,
          kinds: objects.map((object) => object.kind),
        })
      : "";
  const scaleAnswered = Boolean(scaleKey) && scale?.key === scaleKey;
  // Derived, never stored: clearing the points can then never leave the
  // indicator spinning on a screen that has nothing to measure.
  const scaleMeasuring = Boolean(scaleKey) && !scaleAnswered;
  // Memoized: a fresh [] on every render would re-run every placement.
  const spans = useMemo<SceneScaleSpan[]>(
    () => (scaleAnswered && scale ? scale.spans : []),
    [scaleAnswered, scale],
  );

  const objectPlacements = useMemo<ObjectPlacement[]>(() => {
    if (!scene) return [];
    const result: ObjectPlacement[] = [];
    objects.forEach((object, index) => {
      const point = points[index];
      if (!point || !object.product) return;
      const span = spans[index] ?? null;
      const userPixelsPerCm = effectivePixelsPerCm(
        span,
        object.scaleFactor,
        scene,
      );
      result.push({
        index,
        span,
        userPixelsPerCm,
        placement: computeSimplePlacement({
          sceneWidth: scene.widthPx,
          sceneHeight: scene.heightPx,
          point,
          cutout: cutoutDimensions(object),
          dimensions: objectDimensionPair(object),
          pixelsPerCm: userPixelsPerCm ?? span?.pixelsPerCm ?? null,
          scaleSource:
            object.scaleFactor !== 1
              ? "user"
              : (span?.scaleSource ?? undefined),
          kind: object.kind,
        }),
      });
    });
    return result;
  }, [objects, points, scene, spans]);

  const collidingIndexes = useMemo(() => {
    const indexes = new Set<number>();
    if (!scene) return indexes;
    for (let a = 0; a < objectPlacements.length; a += 1) {
      for (let b = a + 1; b < objectPlacements.length; b += 1) {
        const first = objectPlacements[a];
        const second = objectPlacements[b];
        if (!first || !second) continue;
        if (
          footprintsCollide(first.placement, second.placement, scene.heightPx)
        ) {
          indexes.add(first.index);
          indexes.add(second.index);
        }
      }
    }
    return indexes;
  }, [objectPlacements, scene]);

  const frameWarnings = objectPlacements
    .filter(
      ({ placement }) =>
        placement.visible === null ||
        placement.croppedByFrame > CROPPED_WARNING_THRESHOLD,
    )
    .map(
      ({ index }) =>
        `L’objet ${index + 1} ne tient pas dans le cadre à cet endroit.`,
    );

  const overlayOrder = useMemo(() => {
    const ranks = new Map<number, number>();
    orderByDepth(
      objectPlacements.map(({ index, placement }) => ({
        index,
        depthKey: placement.depthKey,
        kind: placement.kind,
      })),
    ).forEach((entry, rank) => ranks.set(entry.index, rank + 1));
    return ranks;
  }, [objectPlacements]);

  useEffect(() => {
    void establishGuestEditorSession()
      .then(() => {
        setReady(true);
        setBusyLabel("");
      })
      .catch((reason: unknown) => {
        setBusyLabel("");
        setError(
          reason instanceof Error
            ? reason.message
            : "Impossible de préparer la démo.",
        );
      });
  }, []);

  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (!trackedRenderId) return;
    const tracking = startRenderTracking({
      renderId: trackedRenderId,
      fetchRender: getRender,
      onRender: (next) => {
        if (
          next.status !== "processing" &&
          next.status !== "queued" &&
          progressPanelRef.current?.contains(document.activeElement)
        ) {
          focusResultAfterUpdate.current = true;
        }
        setRender(next);
      },
      onInterrupted: setTrackingIssue,
    });
    refreshTracking.current = tracking.refresh;
    const resume = () => {
      if (document.visibilityState === "visible") tracking.resume();
    };
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      tracking.stop();
      refreshTracking.current = null;
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [trackedRenderId]);

  useEffect(() => {
    if (!renderInProgress && focusResultAfterUpdate.current) {
      focusResultAfterUpdate.current = false;
      resultHeadingRef.current?.focus();
    }
  }, [renderInProgress]);

  // Free scale estimate once every point is placed (debounced, cancellable).
  useEffect(() => {
    if (!scaleKey) return;
    const request = JSON.parse(scaleKey) as {
      sceneId: string;
      points: Point[];
      kinds: SimplePlacementKind[];
    };
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<SceneScaleResponse>(`/v1/scenes/${request.sceneId}/scale`, {
        method: "POST",
        body: JSON.stringify({ points: request.points, kinds: request.kinds }),
      })
        .then((response) => {
          if (cancelled) return;
          setScale({
            key: scaleKey,
            spans: Array.isArray(response.spans) ? response.spans : [],
            lighting: response.lighting ?? null,
            error: "",
          });
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setScale({
            key: scaleKey,
            spans: [],
            lighting: null,
            error:
              reason instanceof Error
                ? reason.message
                : "Échelle indisponible pour le moment.",
          });
        });
    }, SCALE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scaleKey]);

  function updateObject(
    key: string,
    changes: Partial<Omit<DemoObject, "key">>,
  ) {
    setObjects((current) =>
      current.map((object) =>
        object.key === key ? { ...object, ...changes } : object,
      ),
    );
    setPoints([]);
    setScale(null);
    setError("");
  }

  function setObjectKind(object: DemoObject, kind: SimplePlacementKind) {
    if (object.kind === kind) return;
    updateObject(object.key, {
      kind,
      dimensionMode:
        kind === "flat"
          ? "length_width"
          : object.dimensionMode === "length_width"
            ? "height_length"
            : object.dimensionMode,
      product: null,
      noticesAcknowledged: false,
    });
  }

  function selectObjectFile(key: string, file: File | null) {
    const previous = objects.find((object) => object.key === key)?.preview;
    if (previous) {
      URL.revokeObjectURL(previous);
      previewUrls.current.delete(previous);
    }
    const preview = file ? URL.createObjectURL(file) : "";
    if (preview) previewUrls.current.add(preview);
    updateObject(key, {
      file,
      preview,
      product: null,
      noticesAcknowledged: false,
    });
  }

  function addObject() {
    if (objects.length >= MAX_OBJECTS) return;
    setObjects((current) => [...current, createObject(nextObjectId.current++)]);
    invalidatePlacement();
    setError("");
  }

  function removeObject(key: string) {
    if (objects.length === 1) return;
    const removed = objects.find((object) => object.key === key);
    if (removed?.preview) {
      URL.revokeObjectURL(removed.preview);
      previewUrls.current.delete(removed.preview);
    }
    setObjects((current) => current.filter((object) => object.key !== key));
    invalidatePlacement();
    setError("");
  }

  async function prepareObjects() {
    if (!objectsAreValid) {
      setError("Ajoutez une image et une dimension valide pour chaque objet.");
      return;
    }
    setError("");
    try {
      await establishGuestEditorSession();
      const prepared: DemoObject[] = [];
      let preparedNow = false;
      for (let index = 0; index < objects.length; index += 1) {
        const object = objects[index];
        if (!object) continue;
        if (object.product) {
          prepared.push(object);
          continue;
        }
        setBusyLabel(
          objects.length === 1
            ? "Préparation de l’objet…"
            : `Préparation de l’objet ${index + 1} sur ${objects.length}…`,
        );
        const product = await prepareObject(object);
        const next = { ...object, product, noticesAcknowledged: false };
        prepared.push(next);
        preparedNow = true;
        setObjects((current) =>
          current.map((item) => (item.key === object.key ? next : item)),
        );
      }
      setPoints([]);
      const pending = prepared.some(
        (object) =>
          !object.noticesAcknowledged && objectNotices(object).length > 0,
      );
      if (preparedNow && pending) return;
      setObjects((current) =>
        current.map((object) => ({ ...object, noticesAcknowledged: true })),
      );
      setStep(2);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Un objet n’a pas pu être préparé.",
      );
    } finally {
      setBusyLabel("");
    }
  }

  async function prepareObject(object: DemoObject): Promise<PreparedProduct> {
    if (!object.file) throw new Error("L’image de l’objet est manquante.");
    const dimensions = objectDimensionPair(object);
    const lengthCm = dimensions.lengthCm;
    // The API needs a positive height; a flat object has no useful one.
    const heightCm =
      dimensions.mode === "height_length" ? dimensions.heightCm : 2;
    const depthCm =
      dimensions.mode === "length_width"
        ? dimensions.widthCm
        : Math.max(0.1, Math.min(lengthCm, heightCm) * 0.4);
    const catalog = KIND_CATALOG[object.kind];
    const name = objectName(object.file.name);
    const created = await api<PreparedProduct>("/v1/products", {
      method: "POST",
      body: JSON.stringify({
        temporary: true,
        name,
        description: "Objet fourni par l’utilisateur pour cette visualisation.",
        objectType:
          object.kind === "wall" && object.isMirror
            ? "mirror"
            : catalog.objectType,
        widthCm: roundDimension(lengthCm),
        heightCm: roundDimension(heightCm),
        depthCm: roundDimension(depthCm),
        material: "Matière visible sur la photo de référence",
        generationInstructions:
          "Conserver fidèlement la forme, les couleurs et tous les détails visibles.",
        placementType: catalog.placementType,
        lightingProfile: {},
        buyUrl: null,
      }),
    });
    setBusyLabel(`Envoi de ${name}…`);
    const preparedFile = await prepareImageForUpload(object.file);
    const upload = new FormData();
    upload.set("file", preparedFile);
    upload.set("viewType", "front");
    await api(`/v1/products/${created.id}/assets`, {
      method: "POST",
      body: upload,
    });
    setBusyLabel(`Détourage de ${name}…`);
    const prepared = await api<PreparedProduct>(
      `/v1/products/${created.id}/prepare`,
      { method: "POST" },
    );
    await api(`/v1/products/${created.id}/anchor`, {
      method: "POST",
      body: JSON.stringify({
        anchorType: "bottom_center",
        xNormalized: 0.5,
        yNormalized: 1,
      }),
    });
    return prepared;
  }

  async function uploadRoom(file: File) {
    setError("");
    setBusyLabel("Envoi de la photo…");
    try {
      await establishGuestEditorSession();
      const prepared = await prepareImageForUpload(file);
      const form = new FormData();
      form.set("file", prepared);
      form.set("consent", "true");
      const created = await api<Scene>("/v1/scenes", {
        method: "POST",
        body: form,
      });
      setScene(created);
      resetPoints();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Photo de l’intérieur impossible à envoyer.",
      );
    } finally {
      setBusyLabel("");
    }
  }

  function selectPoint(event: MouseEvent<HTMLButtonElement>) {
    if (allPointsPlaced) return;
    const frame = frameRef.current ?? event.currentTarget;
    const point = normalizeTap(
      event.clientX,
      event.clientY,
      frame.getBoundingClientRect(),
    );
    if (!point) return;
    setPoints((current) => [...current, point]);
    setError("");
  }

  function setScaleFactor(key: string, factor: number) {
    setObjects((current) =>
      current.map((object) =>
        object.key === key ? { ...object, scaleFactor: factor } : object,
      ),
    );
  }

  function buildSimplePlacements(
    pixelsPerCmFor: (index: number) => number | null,
  ) {
    return objects.map((object, index) => {
      const pixelsPerCm = pixelsPerCmFor(index);
      return {
        productId: object.product!.id,
        placementPoint: points[index],
        dimensionPair: objectDimensionPair(object),
        placementKind: object.kind,
        ...(pixelsPerCm !== null
          ? { pixelsPerCm: clampPixelsPerCm(pixelsPerCm) }
          : {}),
      };
    });
  }

  async function postRender(
    simplePlacements: ReturnType<typeof buildSimplePlacements>,
  ) {
    const firstObject = objects[0];
    const firstPoint = points[0];
    if (!scene || !firstObject?.product || !firstPoint) return;
    const surfaceType = KIND_CATALOG[firstObject.kind].surfaceType;
    setError("");
    setBusyLabel("Lancement de GPT Image 2…");
    try {
      const created = await api<Render>("/v1/renders/final", {
        method: "POST",
        body: JSON.stringify({
          workflow: "simple_point",
          mode: "insert",
          simplePlacements,
          placement: {
            sceneId: scene.id,
            productId: firstObject.product.id,
            mode: "insert",
            surfaceType,
            xNormalized: firstPoint.x,
            yNormalized: firstPoint.y,
          },
          placementPoint: firstPoint,
          surfaceType,
          outputQuality: "final",
          preserveBackground: true,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setRender(created);
      setTrackingIssue(null);
      setRegenFactors({});
      setStep(3);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Génération impossible.",
      );
    } finally {
      setBusyLabel("");
    }
  }

  async function generate() {
    const products = objects.map((object) => object.product);
    if (!scene || products.some((product) => !product) || !allPointsPlaced) {
      setError("Ajoutez les images puis placez un point par objet.");
      return;
    }
    if (collidingIndexes.size > 0) {
      setError(
        "Ces deux objets se chevauchent sur la même surface — déplacez l’un d’eux.",
      );
      return;
    }
    await postRender(
      buildSimplePlacements((index) => {
        const object = objects[index];
        const entry = objectPlacements.find((item) => item.index === index);
        if (!object || !entry || object.scaleFactor === 1) return null;
        return entry.userPixelsPerCm;
      }),
    );
  }

  async function regenerate(placements: CompositePlacementSummary[]) {
    await postRender(
      buildSimplePlacements((index) => {
        const base = placements.find((item) => item.objectIndex === index);
        if (!base || base.pixelsPerCm === null) return null;
        const factor = regenFactors[index] ?? 1;
        // Sending a scale marks it as customer-confirmed on the server, which
        // also lifts the size cap. An untouched slider must stay silent, or a
        // second render quietly resizes objects nobody asked to change.
        if (Math.abs(factor - 1) <= 0.001 && base.scaleSource !== "user") {
          return null;
        }
        return base.pixelsPerCm * factor;
      }),
    );
  }

  /**
   * Points and the measured scale describe one exact set of objects. Any edit
   * to that set invalidates both: a scale factor kept across an edit ends up
   * multiplying a fallback estimate the customer never saw.
   */
  function invalidatePlacement() {
    setPoints([]);
    setScale(null);
    setObjects((current) =>
      current.map((object) =>
        object.scaleFactor === 1 ? object : { ...object, scaleFactor: 1 },
      ),
    );
  }

  function resetPoints() {
    invalidatePlacement();
    setError("");
  }

  function reset() {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current.clear();
    nextObjectId.current = 2;
    setStep(1);
    setError("");
    setObjects([createObject(1)]);
    setScene(null);
    setPoints([]);
    setScale(null);
    setRender(null);
    setTrackingIssue(null);
    focusResultAfterUpdate.current = false;
    setRegenFactors({});
    setBusyLabel("");
  }

  const nextObject = objects[points.length];
  const allPrepared = objects.every((object) => object.product);
  // Step 2 only exists for prepared objects. Derived rather than corrected in
  // an effect: an edit that invalidates one while the customer is already on
  // step 2 sends them back to step 1, instead of leaving a screen with no
  // card, no back button and no way out but a reload.
  const activeStep: Step = step === 2 && !allPrepared ? 1 : step;
  const noticesPending = objects.some(
    (object) =>
      object.product &&
      !object.noticesAcknowledged &&
      objectNotices(object).length > 0,
  );
  const compositePlacements = readCompositePlacements(render?.placement);
  const compositeUrl = render?.compositeUrl ?? null;
  const regenChanged = Object.values(regenFactors).some(
    (factor) => Math.abs(factor - 1) > 0.001,
  );

  return (
    <section className="simple-demo" data-step={step}>
      <header className="simple-demo-head">
        <span className="simple-demo-kicker">Visualisation IA</span>
        <h1>Voyez vos objets chez vous.</h1>
        <p>Jusqu’à trois objets, une photo et leurs points. C’est tout.</p>
      </header>

      <ol className="simple-demo-progress" aria-label="Étapes de la démo">
        {progressLabels.map((label, index) => {
          const number = (index + 1) as Step;
          return (
            <li
              key={label}
              className={
                number === activeStep
                  ? "active"
                  : number < activeStep
                    ? "done"
                    : ""
              }
            >
              <span>{number < activeStep ? <Check size={16} /> : number}</span>
              <strong>{label}</strong>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="simple-demo-error" role="alert">
          {error}
        </div>
      )}

      {!ready && (
        <div className="simple-demo-loading" aria-live="polite">
          <LoaderCircle className="spin" size={22} /> Préparation de la démo…
        </div>
      )}

      {activeStep === 1 && (
        <div className="simple-demo-card">
          <div className="simple-demo-title">
            <span>1</span>
            <div>
              <h2>Ajoutez les objets à placer</h2>
              <p>De un à trois objets, visibles en entier sur leurs photos.</p>
            </div>
          </div>

          <div className="simple-objects-list">
            {objects.map((object, index) => {
              const objectReady = isObjectReady(object);
              const notices = object.product ? objectNotices(object) : [];
              const cutoutPreview = object.product?.cutoutUrl || "";
              return (
                <article className="simple-object-entry" key={object.key}>
                  <div className="simple-object-entry-head">
                    <div>
                      <span>{index + 1}</span>
                      <strong>Objet {index + 1}</strong>
                    </div>
                    {objects.length > 1 && (
                      <button
                        type="button"
                        className="simple-object-remove"
                        aria-label={`Supprimer l’objet ${index + 1}`}
                        disabled={busy}
                        onClick={() => removeObject(object.key)}
                      >
                        <Trash2 size={17} />
                        <span>Supprimer</span>
                      </button>
                    )}
                  </div>

                  <div className="simple-object-entry-body">
                    <div>
                      <label
                        className={
                          cutoutPreview
                            ? "simple-upload simple-object-upload has-image has-cutout"
                            : object.preview
                              ? "simple-upload simple-object-upload has-image"
                              : "simple-upload simple-object-upload"
                        }
                      >
                        {cutoutPreview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={cutoutPreview}
                            alt={`Détourage de l’objet ${index + 1}`}
                          />
                        ) : object.preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={object.preview}
                            alt={`Objet ${index + 1} à placer`}
                          />
                        ) : (
                          <>
                            <ImagePlus size={30} />
                            <strong>Choisir l’image</strong>
                            <span>PNG, JPG ou WebP</span>
                          </>
                        )}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          aria-label={`Image de l’objet ${index + 1}`}
                          disabled={!ready || busy}
                          onChange={(event) =>
                            selectObjectFile(
                              object.key,
                              event.target.files?.[0] ?? null,
                            )
                          }
                        />
                      </label>

                      {object.preview && (
                        <label className="simple-change-file">
                          <Upload size={17} />{" "}
                          {cutoutPreview
                            ? "Changer la photo"
                            : "Changer l’image"}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            aria-label={`Changer l’image de l’objet ${index + 1}`}
                            disabled={busy}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) selectObjectFile(object.key, file);
                            }}
                          />
                        </label>
                      )}
                      {object.product?.cutout?.synthetic && (
                        <span className="simple-object-flag">
                          <Sparkles size={14} /> Détourage IA
                        </span>
                      )}
                    </div>

                    <div className="simple-object-dimensions">
                      <div className="simple-field-label">
                        <MapPin size={19} />
                        <div>
                          <strong>Comment l’objet se pose</strong>
                          <span>
                            Sur une surface, accroché ou étendu au sol.
                          </span>
                        </div>
                      </div>
                      <div
                        className="simple-segmented simple-kind-segmented"
                        role="group"
                        aria-label={`Type de pose de l’objet ${index + 1}`}
                      >
                        {(
                          Object.keys(KIND_LABELS) as SimplePlacementKind[]
                        ).map((kind) => (
                          <button
                            type="button"
                            key={kind}
                            className={object.kind === kind ? "selected" : ""}
                            aria-pressed={object.kind === kind}
                            disabled={busy}
                            onClick={() => setObjectKind(object, kind)}
                          >
                            {KIND_LABELS[kind]}
                          </button>
                        ))}
                      </div>

                      {object.kind === "wall" && (
                        <label>
                          <input
                            type="checkbox"
                            checked={object.isMirror}
                            disabled={busy}
                            onChange={(event) =>
                              updateObject(object.key, {
                                isMirror: event.target.checked,
                                product: null,
                                noticesAcknowledged: false,
                              })
                            }
                          />
                          Cet objet est un miroir
                        </label>
                      )}
                      <div className="simple-field-label">
                        <Ruler size={19} />
                        <div>
                          <strong>Deux dimensions connues</strong>
                          <span>
                            {object.kind === "flat"
                              ? "Choisissez la paire que vous pouvez mesurer."
                              : "La hauteur réelle et la longueur de face."}
                          </span>
                        </div>
                      </div>
                      {object.kind === "flat" && (
                        <div
                          className="simple-segmented"
                          role="group"
                          aria-label={`Dimensions de l’objet ${index + 1}`}
                        >
                          <button
                            type="button"
                            className={
                              object.dimensionMode === "length_width"
                                ? "selected"
                                : ""
                            }
                            aria-pressed={
                              object.dimensionMode === "length_width"
                            }
                            disabled={busy}
                            onClick={() =>
                              updateObject(object.key, {
                                dimensionMode: "length_width",
                                product: null,
                              })
                            }
                          >
                            Longueur + largeur
                          </button>
                          <button
                            type="button"
                            className={
                              object.dimensionMode === "height_length"
                                ? "selected"
                                : ""
                            }
                            aria-pressed={
                              object.dimensionMode === "height_length"
                            }
                            disabled={busy}
                            onClick={() =>
                              updateObject(object.key, {
                                dimensionMode: "height_length",
                                product: null,
                              })
                            }
                          >
                            Hauteur + longueur
                          </button>
                        </div>
                      )}
                      <div className="simple-size-inputs">
                        {object.dimensionMode === "height_length" ? (
                          <>
                            <SizeInput
                              disabled={busy}
                              label="Hauteur"
                              objectNumber={index + 1}
                              value={object.heightValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  heightValue: value,
                                  product: null,
                                })
                              }
                            />
                            <SizeInput
                              disabled={busy}
                              label="Longueur"
                              objectNumber={index + 1}
                              value={object.lengthValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  lengthValue: value,
                                  product: null,
                                })
                              }
                            />
                          </>
                        ) : (
                          <>
                            <SizeInput
                              disabled={busy}
                              label="Longueur"
                              objectNumber={index + 1}
                              value={object.lengthValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  lengthValue: value,
                                  product: null,
                                })
                              }
                            />
                            <SizeInput
                              disabled={busy}
                              label="Largeur"
                              objectNumber={index + 1}
                              value={object.widthValue}
                              onChange={(value) =>
                                updateObject(object.key, {
                                  widthValue: value,
                                  product: null,
                                })
                              }
                            />
                          </>
                        )}
                      </div>
                      {objectReady && notices.length === 0 && (
                        <span className="simple-object-ready">
                          {object.product ? <Check size={15} /> : null}
                          {object.product
                            ? `Objet ${index + 1} détouré`
                            : "Informations complètes · détourage à effectuer"}
                        </span>
                      )}
                      {notices.length > 0 && (
                        <ul className="simple-object-notices">
                          {notices.map((notice) => (
                            <li key={notice}>
                              <AlertTriangle size={15} />
                              <span>{notice}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {objects.length < MAX_OBJECTS && (
            <button
              type="button"
              className="simple-add-object"
              disabled={busy}
              onClick={addObject}
            >
              <Plus size={19} /> Ajouter un objet
              <span>
                {objects.length}/{MAX_OBJECTS}
              </span>
            </button>
          )}

          {noticesPending && !busy && (
            <p className="simple-object-notice-hint">
              Vérifiez les remarques ci-dessus, changez la photo si besoin, ou
              continuez tel quel.
            </p>
          )}

          <button
            type="button"
            className="simple-demo-primary"
            disabled={!ready || busy || !objectsAreValid}
            onClick={() => void prepareObjects()}
          >
            {busy ? <LoaderCircle className="spin" size={19} /> : null}
            {busy
              ? busyLabel
              : allPrepared && noticesPending
                ? "Continuer"
                : `Continuer avec ${objects.length} objet${objects.length > 1 ? "s" : ""}`}
            {!busy && <ArrowRight size={19} />}
          </button>
        </div>
      )}

      {activeStep === 2 && (
        <div className="simple-demo-card simple-room-card">
          <div className="simple-demo-title">
            <span>2</span>
            <div>
              <h2>Ajoutez la photo du lieu</h2>
              <p>Placez ensuite un point numéroté pour chaque objet.</p>
            </div>
          </div>

          <div
            className="simple-placement-objects"
            aria-label="Objets à placer"
          >
            {objects.map((object, index) => {
              const entry = objectPlacements.find(
                (item) => item.index === index,
              );
              return (
                <div
                  className={
                    points[index]
                      ? "placed"
                      : index === points.length
                        ? "current"
                        : ""
                  }
                  key={object.key}
                >
                  <span className="simple-placement-number">{index + 1}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={object.product?.cutoutUrl || object.preview}
                    alt=""
                  />
                  <span>
                    <strong>
                      {object.product?.name || `Objet ${index + 1}`}
                    </strong>
                    <small>
                      {KIND_LABELS[object.kind]} ·{" "}
                      {dimensionPairSummary(object)}
                    </small>
                    {scaleAnswered && entry && (
                      <ScaleSlider
                        label={`Taille de l’objet ${index + 1} dans la photo`}
                        value={object.scaleFactor}
                        hint={`≈ ${formatCm(entry.placement.impliedWidthCm)} cm de large`}
                        onChange={(factor) =>
                          setScaleFactor(object.key, factor)
                        }
                      />
                    )}
                  </span>
                  {points[index] && <Check size={17} />}
                </div>
              );
            })}
          </div>

          <div className="photo-guideline">
            <MapPin size={21} />
            <div>
              <strong>Reculez d’au moins 1,5 mètre.</strong>
              <span>
                Cadrez l’emplacement et le sol ou le support. Évitez le zoom et
                gardez le téléphone droit.
              </span>
            </div>
          </div>

          {!scene ? (
            <label className="simple-upload simple-room-upload">
              <ImagePlus size={34} />
              <strong>Choisir la photo du lieu</strong>
              <span>Prise à 1,5 m minimum · nette et bien éclairée</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Photo du lieu de réception"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadRoom(file);
                }}
              />
            </label>
          ) : (
            <div className="point-picker-block">
              <div className="point-picker-heading">
                <div>
                  <strong>
                    {allPointsPlaced
                      ? "Tous les points sont placés"
                      : `Placez le point ${points.length + 1}`}
                  </strong>
                  <span>
                    {nextObject
                      ? `Touchez l’endroit où poser ${nextObject.product?.name || `l’objet ${points.length + 1}`}.`
                      : `${points.length} point${points.length > 1 ? "s" : ""} enregistré${points.length > 1 ? "s" : ""}.`}
                  </span>
                </div>
                <div className="point-picker-tools">
                  {points.length > 0 && (
                    <button type="button" onClick={resetPoints} disabled={busy}>
                      <RefreshCw size={16} /> Replacer les points
                    </button>
                  )}
                  <label>
                    <Upload size={16} /> Changer la photo
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label="Changer la photo du lieu"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadRoom(file);
                      }}
                    />
                  </label>
                </div>
              </div>
              <div className="simple-point-stage">
                <button
                  type="button"
                  ref={frameRef}
                  className={
                    allPointsPlaced
                      ? "simple-point-picker simple-point-frame points-complete"
                      : "simple-point-picker simple-point-frame"
                  }
                  style={frameStyle(scene)}
                  aria-label={
                    allPointsPlaced
                      ? "Tous les points sont placés"
                      : `Placer le point ${points.length + 1} dans l’image`
                  }
                  onClick={selectPoint}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="simple-point-photo"
                    src={scene.imageUrl}
                    alt="Lieu de réception"
                  />
                  {objectPlacements.map(({ index, placement }) => {
                    const object = objects[index];
                    const src = object?.product?.cutoutUrl;
                    if (!src) return null;
                    return (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={`overlay-${object.key}`}
                        className="simple-point-overlay"
                        src={src}
                        alt=""
                        aria-hidden="true"
                        data-testid="placement-overlay"
                        style={{
                          ...overlayStyle(placement, scene),
                          zIndex: overlayOrder.get(index) ?? 1,
                        }}
                      />
                    );
                  })}
                  {points.map((point, index) => (
                    <span
                      className={
                        collidingIndexes.has(index)
                          ? "simple-red-dot colliding"
                          : "simple-red-dot"
                      }
                      style={{
                        left: `${point.x * 100}%`,
                        top: `${point.y * 100}%`,
                      }}
                      data-testid="placement-dot"
                      data-point-number={index + 1}
                      key={`${point.x}-${point.y}-${index}`}
                    >
                      {index + 1}
                    </span>
                  ))}
                  {scaleAnswered &&
                    points.map((point, index) => {
                      const entry = objectPlacements.find(
                        (item) => item.index === index,
                      );
                      if (!entry) return null;
                      return (
                        <span
                          className={`simple-point-badge ${entry.span?.confidence ?? "none"}`}
                          style={{
                            left: `${point.x * 100}%`,
                            top: `${point.y * 100}%`,
                          }}
                          key={`badge-${index}`}
                        >
                          {scaleBadgeText(entry)}
                        </span>
                      );
                    })}
                </button>
              </div>
              <div
                className={
                  points.length > 0
                    ? "point-coordinates ready"
                    : "point-coordinates"
                }
              >
                {points.length > 0 ? (
                  <>
                    <Check size={17} />
                    {pixelPoints.map((point, index) => (
                      <span key={`${point.x}-${point.y}-${index}`}>
                        Point {index + 1} : x {point.x} · y {point.y}
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    <MapPin size={17} /> Touchez la photo pour placer le point 1
                  </>
                )}
              </div>
              {allPointsPlaced && (
                <div className="simple-scale-summary" aria-live="polite">
                  {scaleMeasuring && (
                    <span className="pending">
                      <LoaderCircle className="spin" size={15} /> Mesure de
                      l’échelle…
                    </span>
                  )}
                  {scaleAnswered &&
                    objectPlacements.map((entry) => (
                      <span
                        className={entry.span?.confidence ?? "none"}
                        key={`scale-${entry.index}`}
                      >
                        Point {entry.index + 1} · {scaleBadgeText(entry)}
                      </span>
                    ))}
                  {scaleAnswered && scale?.error && (
                    <span className="none">
                      Échelle indisponible ({scale.error}) — le rendu utilisera
                      une estimation.
                    </span>
                  )}
                </div>
              )}
              {(collidingIndexes.size > 0 || frameWarnings.length > 0) && (
                <ul className="simple-placement-warnings">
                  {collidingIndexes.size > 0 && (
                    <li className="blocking">
                      <AlertTriangle size={16} />
                      <span>
                        Ces deux objets se chevauchent sur la même surface —
                        déplacez l’un d’eux.
                      </span>
                    </li>
                  )}
                  {frameWarnings.map((warning) => (
                    <li key={warning}>
                      <AlertTriangle size={16} />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="simple-demo-actions">
            <button
              type="button"
              className="simple-demo-secondary"
              disabled={busy}
              onClick={() => setStep(1)}
            >
              <ArrowLeft size={18} /> Retour
            </button>
            <button
              type="button"
              className="simple-demo-primary"
              disabled={
                busy || !scene || !allPointsPlaced || collidingIndexes.size > 0
              }
              onClick={() => void generate()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={19} />
              ) : (
                <Sparkles size={19} />
              )}
              {busy ? busyLabel : "Générer avec GPT Image 2"}
            </button>
          </div>
        </div>
      )}

      {activeStep === 3 && scene && (
        <div className="simple-demo-card simple-result-card">
          <p
            className="render-completion-announcement"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {renderTerminalAnnouncement(render?.status)}
          </p>
          <div className="simple-demo-title">
            <span>3</span>
            <div>
              <h2 ref={resultHeadingRef} tabIndex={-1}>
                Votre visualisation
              </h2>
              <p>
                {renderInProgress
                  ? "Suivez la préparation de votre image et comparez le placement dès qu’il est prêt."
                  : "Comparez le lieu original, l’aperçu et le résultat."}
              </p>
            </div>
          </div>

          {renderInProgress && render && (
            <RenderProgressPanel
              key={render.id}
              render={render}
              sceneUrl={scene.imageUrl}
              trackingIssue={trackingIssue}
              panelRef={progressPanelRef}
              onRefresh={() => refreshTracking.current?.()}
            />
          )}

          {render?.status === "failed" && (
            <div className="simple-demo-error" role="alert">
              {render.error ?? "La génération a échoué. Réessayez."}
            </div>
          )}

          {render &&
            !renderInProgress &&
            (render.status !== "failed" || compositeUrl) && (
              <div
                className={
                  compositeUrl
                    ? "simple-result-grid triptych"
                    : "simple-result-grid"
                }
              >
                <figure>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={scene.imageUrl} alt="Photo avant" />
                  <figcaption>Avant</figcaption>
                </figure>
                {compositeUrl && (
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={compositeUrl}
                      alt="Aperçu du placement, avant le rendu réaliste"
                    />
                    <figcaption>Aperçu du placement</figcaption>
                  </figure>
                )}
                {render.status === "succeeded" && render.resultUrl && (
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={render.resultUrl} alt="Visualisation après" />
                    <figcaption>
                      Après · {render.model ?? "gpt-image-2"}
                    </figcaption>
                    {render.qualityDecision?.status === "simulated" && (
                      <p>Simulation — fidélité visuelle non évaluée.</p>
                    )}
                  </figure>
                )}
              </div>
            )}

          {render && compositePlacements.length > 0 && (
            <div className="simple-result-objects">
              {objects.map((object, index) => {
                const summary = compositePlacements.find(
                  (item) => item.objectIndex === index,
                );
                const badges = summary ? placementBadges(summary, object) : [];
                return (
                  <div className="simple-result-object" key={object.key}>
                    <span className="simple-placement-number">{index + 1}</span>
                    <div>
                      <strong>
                        {object.product?.name || `Objet ${index + 1}`}
                      </strong>
                      {badges.length > 0 && (
                        <span className="simple-result-badges">
                          {badges.map((badge) => (
                            <span key={badge.label} data-tone={badge.tone}>
                              {badge.label}
                            </span>
                          ))}
                        </span>
                      )}
                      {summary?.pixelsPerCm !== null &&
                        summary?.pixelsPerCm !== undefined &&
                        render.status !== "processing" &&
                        render.status !== "queued" && (
                          <ScaleSlider
                            label={`Corriger la taille de l’objet ${index + 1}`}
                            value={regenFactors[index] ?? 1}
                            hint={
                              summary.impliedWidthCm !== null
                                ? `≈ ${formatCm(summary.impliedWidthCm * (regenFactors[index] ?? 1))} cm de large`
                                : undefined
                            }
                            onChange={(factor) =>
                              setRegenFactors((current) => ({
                                ...current,
                                [index]: factor,
                              }))
                            }
                          />
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="simple-demo-actions">
            <button
              type="button"
              className="simple-demo-secondary restart-button"
              disabled={busy}
              onClick={reset}
            >
              <RefreshCw size={18} /> Faire un nouvel essai
            </button>
            {compositePlacements.length > 0 && (
              <button
                type="button"
                className="simple-demo-primary"
                disabled={
                  busy ||
                  !regenChanged ||
                  render?.status === "processing" ||
                  render?.status === "queued"
                }
                onClick={() => void regenerate(compositePlacements)}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={19} />
                ) : (
                  <Sparkles size={19} />
                )}
                {busy ? busyLabel : "Régénérer avec cette échelle"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ScaleSlider({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="simple-scale-slider">
      <span>
        Taille ×{value.toFixed(2)}
        {hint ? ` · ${hint}` : ""}
      </span>
      <input
        type="range"
        min="0.5"
        max="2"
        step="0.05"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function createObject(id: number): DemoObject {
  return {
    key: `object-${id}`,
    file: null,
    preview: "",
    kind: "standing",
    isMirror: false,
    dimensionMode: "height_length",
    heightValue: "",
    lengthValue: "",
    widthValue: "",
    product: null,
    scaleFactor: 1,
    noticesAcknowledged: false,
  };
}

function isObjectReady(object: DemoObject): boolean {
  if (!object.file || !positiveDimension(object.lengthValue)) return false;
  return object.dimensionMode === "height_length"
    ? positiveDimension(object.heightValue)
    : positiveDimension(object.widthValue);
}

function positiveDimension(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_500;
}

function objectDimensionPair(object: DemoObject): ObjectDimensionPair {
  return object.dimensionMode === "height_length"
    ? {
        mode: "height_length",
        heightCm: Number(object.heightValue),
        lengthCm: Number(object.lengthValue),
      }
    : {
        mode: "length_width",
        lengthCm: Number(object.lengthValue),
        widthCm: Number(object.widthValue),
      };
}

function dimensionPairSummary(object: DemoObject): string {
  const dimensions = objectDimensionPair(object);
  return dimensions.mode === "height_length"
    ? `Hauteur ${dimensions.heightCm} cm · Longueur ${dimensions.lengthCm} cm`
    : `Longueur ${dimensions.lengthCm} cm · Largeur ${dimensions.widthCm} cm`;
}

/** Cutout size used by the geometry; falls back to the catalog ratio. */
function cutoutDimensions(object: DemoObject): {
  widthPx: number;
  heightPx: number;
  baseRowFraction?: number;
} {
  const cutout = object.product?.cutout;
  if (cutout && cutout.widthPx && cutout.heightPx) {
    return {
      widthPx: cutout.widthPx,
      heightPx: cutout.heightPx,
      ...(cutout.baseRowFraction
        ? { baseRowFraction: cutout.baseRowFraction }
        : {}),
    };
  }
  const dimensions = objectDimensionPair(object);
  const widthCm = Math.max(0.1, dimensions.lengthCm);
  const heightCm =
    dimensions.mode === "height_length"
      ? Math.max(0.1, dimensions.heightCm)
      : Math.max(0.1, dimensions.widthCm);
  return {
    widthPx: Math.round(widthCm * 10),
    heightPx: Math.round(heightCm * 10),
  };
}

/**
 * Ratio between the entered front proportions and the photographed
 * silhouette, or null when the check does not apply (flat objects, missing
 * cutout metadata). 1 means the photo is a front view of the entered sizes.
 */
export function aspectMismatch(
  kind: SimplePlacementKind,
  dimensions: SimpleDimensionPair,
  cutout: { widthPx: number; heightPx: number } | null | undefined,
): { entered: number; photo: number; ratio: number } | null {
  if (kind === "flat" || dimensions.mode !== "height_length") return null;
  if (!cutout || cutout.widthPx <= 0 || cutout.heightPx <= 0) return null;
  if (dimensions.heightCm <= 0) return null;
  const entered = dimensions.lengthCm / dimensions.heightCm;
  const photo = cutout.widthPx / cutout.heightPx;
  return { entered, photo, ratio: entered / photo };
}

/** User-facing notices for a prepared object (aspect check + server flags). */
function objectNotices(object: DemoObject): string[] {
  const notices: string[] = [];
  const cutout = object.product?.cutout;
  if (cutout?.source === "matting") {
    notices.push(
      "Vérifiez le détourage affiché : l’objet doit être complet, sans morceau du fond ni du support. Changez la photo si nécessaire.",
    );
  }
  const mismatch = aspectMismatch(
    object.kind,
    objectDimensionPair(object),
    cutout && cutout.widthPx && cutout.heightPx
      ? { widthPx: cutout.widthPx, heightPx: cutout.heightPx }
      : null,
  );
  if (mismatch && Math.abs(mismatch.ratio - 1) > ASPECT_MISMATCH_TOLERANCE) {
    notices.push(
      `La photo ne semble pas être une vue de face : proportions saisies ${mismatch.entered.toFixed(2)}, photo ${mismatch.photo.toFixed(2)}.`,
    );
  }
  for (const warning of cutout?.warnings ?? []) {
    if (typeof warning === "string" && warning.trim()) notices.push(warning);
  }
  return notices;
}

/** Effective pixels per centimetre after the slider, null when untouched. */
function effectivePixelsPerCm(
  span: SceneScaleSpan | null,
  factor: number,
  scene: Scene,
): number | null {
  if (Math.abs(factor - 1) < 0.001) return null;
  const base =
    span?.pixelsPerCm && span.pixelsPerCm > 0
      ? span.pixelsPerCm
      : Math.max(scene.widthPx, scene.heightPx) / ASSUMED_ROOM_WIDTH_CM;
  return base * factor;
}

function clampPixelsPerCm(value: number): number {
  return Math.round(Math.max(0.2, Math.min(200, value)) * 1000) / 1000;
}

function frameStyle(scene: Scene): CSSProperties {
  const ratio = scene.widthPx / Math.max(1, scene.heightPx);
  return {
    aspectRatio: `${scene.widthPx} / ${scene.heightPx}`,
    width: `min(100%, calc(640px * ${ratio}))`,
  };
}

/** Percent box of a placement inside a frame sized like the scene. */
export function overlayStyle(
  placement: Pick<
    SimplePlacementResult,
    "left" | "top" | "widthPx" | "heightPx"
  >,
  scene: { widthPx: number; heightPx: number },
): { left: string; top: string; width: string; height: string } {
  const W = Math.max(1, scene.widthPx);
  const H = Math.max(1, scene.heightPx);
  return {
    left: `${(placement.left / W) * 100}%`,
    top: `${(placement.top / H) * 100}%`,
    width: `${(placement.widthPx / W) * 100}%`,
    height: `${(placement.heightPx / H) * 100}%`,
  };
}

function formatCm(value: number): string {
  if (!Number.isFinite(value)) return "?";
  return value >= 100 ? String(Math.round(value)) : value.toFixed(0);
}

function scaleBadgeText(entry: ObjectPlacement): string {
  const width = formatCm(entry.placement.impliedWidthCm);
  const span = entry.span;
  if (entry.userPixelsPerCm !== null) {
    return `≈ ${width} cm de large ici · échelle ajustée par vous`;
  }
  if (!span || span.confidence === "none" || span.pixelsPerCm === null) {
    return "échelle inconnue — le rendu utilisera une estimation";
  }
  if (span.confidence === "high") {
    const reference = span.referenceKind
      ? ` (repère : ${span.referenceKind})`
      : "";
    return `≈ ${width} cm de large ici · échelle estimée${reference}`;
  }
  return `≈ ${width} cm de large ici · échelle approximative`;
}

const SCALE_SOURCE_BADGES: Record<SimpleScaleSource, string> = {
  user: "Taille ajustée visuellement",
  vision: "Échelle estimée sur la photo",
  vision_coarse: "Échelle approximative",
  vision_interpolated: "Échelle approximative",
  assumed_room_width: `Échelle estimée (${ASSUMED_ROOM_WIDTH_CM} cm)`,
};

/**
 * A measured scale and a guess must never look alike: the tone is what tells
 * the customer whether the size on screen was verified or assumed.
 */
type BadgeTone = "measured" | "estimate" | "warning";

interface PlacementBadge {
  label: string;
  tone: BadgeTone;
}

const SCALE_SOURCE_TONES: Record<SimpleScaleSource, BadgeTone> = {
  user: "estimate",
  vision: "estimate",
  vision_coarse: "estimate",
  vision_interpolated: "estimate",
  assumed_room_width: "estimate",
};

function placementBadges(
  summary: CompositePlacementSummary,
  object: DemoObject,
): PlacementBadge[] {
  const badges: PlacementBadge[] = [];
  if (summary.scaleSource) {
    badges.push({
      label: SCALE_SOURCE_BADGES[summary.scaleSource],
      tone: SCALE_SOURCE_TONES[summary.scaleSource],
    });
  }
  if (summary.clamped) {
    badges.push({ label: "Taille ajustée au cadre", tone: "warning" });
  }
  if (summary.croppedByFrame > 0.02) {
    badges.push({ label: "Objet coupé par le bord", tone: "warning" });
  }
  if (object.product?.cutout?.synthetic) {
    badges.push({ label: "Détourage IA", tone: "warning" });
  }
  return badges;
}

const SCALE_SOURCES: readonly SimpleScaleSource[] = [
  "user",
  "vision",
  "vision_coarse",
  "vision_interpolated",
  "assumed_room_width",
];

/** Defensive narrowing of render.placement.compositePlacements. */
export function readCompositePlacements(
  placement: Record<string, unknown> | undefined | null,
): CompositePlacementSummary[] {
  const raw = placement?.compositePlacements;
  if (!Array.isArray(raw)) return [];
  const result: CompositePlacementSummary[] = [];
  raw.forEach((item, position) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const objectIndex =
      typeof record.objectIndex === "number" ? record.objectIndex : position;
    const source = record.scaleSource;
    const pixelsPerCm = record.pixelsPerCm;
    const impliedWidthCm = record.impliedWidthCm;
    const croppedByFrame = record.croppedByFrame;
    result.push({
      objectIndex,
      scaleSource:
        typeof source === "string" &&
        (SCALE_SOURCES as readonly string[]).includes(source)
          ? (source as SimpleScaleSource)
          : null,
      clamped: record.clamped === true,
      croppedByFrame:
        typeof croppedByFrame === "number" && Number.isFinite(croppedByFrame)
          ? croppedByFrame
          : 0,
      pixelsPerCm:
        typeof pixelsPerCm === "number" && pixelsPerCm > 0 ? pixelsPerCm : null,
      impliedWidthCm:
        typeof impliedWidthCm === "number" && Number.isFinite(impliedWidthCm)
          ? impliedWidthCm
          : null,
    });
  });
  return result;
}

function SizeInput({
  label,
  objectNumber,
  value,
  disabled,
  onChange,
}: {
  label: "Hauteur" | "Longueur" | "Largeur";
  objectNumber: number;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="simple-unit-input">
      <span>{label}</span>
      <div>
        <input
          type="number"
          inputMode="decimal"
          min="0.1"
          max="1500"
          step="0.1"
          value={value}
          disabled={disabled}
          aria-label={`${label} de l’objet ${objectNumber} en centimètres`}
          placeholder="Ex. 42"
          onChange={(event) => onChange(event.target.value)}
        />
        <span>cm</span>
      </div>
    </label>
  );
}

function objectName(filename: string): string {
  const cleaned = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return "Objet à placer";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1, 118);
}

function roundDimension(value: number): number {
  return Math.round(Math.max(0.1, Math.min(1000, value)) * 10) / 10;
}
