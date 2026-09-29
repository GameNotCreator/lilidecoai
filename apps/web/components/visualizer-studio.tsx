"use client";

import {
  spatialPreviewSchema,
  type Product,
  type Render,
  type SpatialPreview,
  type SpatialReference,
} from "@lili/types";
import { Badge, Button } from "@lili/ui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  Share2,
  ShoppingBag,
  Sparkles,
  Upload,
} from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  api as sharedApi,
  merchantApi,
  establishGuestEditorSession,
  establishPublicSession,
  getProducts,
  getRender,
} from "@/lib/api";
import { prepareImageForUpload } from "@/lib/client-image";
import {
  clearSpatialDraft,
  readSpatialDraft,
  saveSpatialDraft,
  spatialInsertionSubmissionSchema,
  type SpatialStudioDraft,
} from "@/lib/spatial-studio-draft";
import { spatialRetrySubmissionSchema } from "@/lib/spatial-retry";
import {
  findSpatialSubmission,
  sendSpatialSubmission,
} from "@/lib/spatial-submission";
import { MaskEditor } from "./mask-editor";

interface Scene {
  id: string;
  status: string;
  imageUrl: string;
  widthPx: number;
  heightPx: number;
  analysis: Record<string, unknown>;
  expiresAt?: string;
}

interface Segmentation {
  id: string;
  status: "proposed" | "confirmed";
  label: string;
  confidence: number;
  box: { xMin: number; yMin: number; xMax: number; yMax: number };
  maskUrl: string;
}

interface PlacementPreparation {
  mode: "insert" | "replace";
  surfaceType: string;
  placementPoint: { x: number; y: number };
  targetPoint?: { x: number; y: number };
  targetLabel?: string;
  confidence: number;
  needsClarification: boolean;
  rationale: string;
  segmentation?: Segmentation;
}

interface PreparedRenderInput {
  mode: "insert" | "replace";
  surfaceType: string;
  placementPoint: { x: number; y: number };
  targetPoint?: { x: number; y: number };
  targetMaskId?: string;
  outputQuality: "preview" | "final";
}

const pipelineCopy: Record<string, { title: string; detail: string }> = {
  uploaded: {
    title: "Photo reçue…",
    detail: "Nous préparons une copie sécurisée de votre pièce.",
  },
  analyzing_scene: {
    title: "Analyse de la pièce…",
    detail: "Perspective, support, lumière et obstacles sont étudiés.",
  },
  inspecting_scene: {
    title: "Analyse de la zone…",
    detail: "Nous vérifions le support et ce qui occupe le point.",
  },
  segmenting_target: {
    title: "Sélection de l’objet…",
    detail: "Nous isolons précisément l’élément que vous avez touché.",
  },
  removing_target: {
    title: "Suppression de l’ancien objet…",
    detail: "Le fond caché est reconstruit avant d’ajouter le nouveau produit.",
  },
  removing_obstacle: {
    title: "Suppression de l’ancien objet…",
    detail: "Le fond caché est reconstruit avant d’ajouter le nouveau produit.",
  },
  analyzing_cleaned_scene: {
    title: "Nouvelle lecture de l’espace…",
    detail: "La perspective est recalculée sur la zone maintenant dégagée.",
  },
  computing_geometry: {
    title: "Calcul des dimensions…",
    detail: "La taille et le contact sont adaptés à la perspective réelle.",
  },
  validating_fit: {
    title: "Vérification de la taille…",
    detail: "Nous contrôlons que le produit tient entièrement dans la zone.",
  },
  building_prompt: {
    title: "Préparation du rendu…",
    detail: "Toutes les vues et contraintes du produit sont assemblées.",
  },
  composing_preview: {
    title: "Placement du produit…",
    detail: "La position et l’échelle calculées sont appliquées à la photo.",
  },
  generating_preview: {
    title: "Création de l’aperçu…",
    detail: "Nano Banana 2 compose une prévisualisation rapide.",
  },
  generating_final: {
    title: "Création du rendu final…",
    detail: "Nano Banana Pro affine matière, lumière et perspective.",
  },
  refining_final: {
    title: "Finition photoréaliste…",
    detail: "Les ombres, la lumière et les textures sont harmonisées.",
  },
  quality_check: {
    title: "Contrôle du réalisme…",
    detail: "Fidélité, doublons, contact et décor sont vérifiés.",
  },
  retrying: {
    title: "Correction ciblée…",
    detail: "Une anomalie précise est corrigée une dernière fois.",
  },
};

function currentPipelineCopy(render: Render) {
  if (
    render.engine === "spatial" &&
    render.pipelineState === "generating_final"
  )
    return {
      title: "Création du point de vue…",
      detail:
        "Le volume, les faces visibles et les contacts guident la génération.",
    };
  if (render.status === "queued")
    return {
      title: render.execution?.retrying
        ? "Reprise en attente…"
        : "Rendu en attente…",
      detail:
        "Le traitement continue en arrière-plan. Votre placement est conservé.",
    };
  const stage =
    render.pipelineState ??
    (typeof render.placement?.pipelineStage === "string"
      ? render.placement.pipelineStage
      : "analyzing_scene");
  return pipelineCopy[stage] ?? pipelineCopy.analyzing_scene!;
}

export function VisualizerStudio({
  embedded = false,
  catalogSession = false,
  initialProductId,
  merchantSlug,
  internalSpatial = false,
  draftScope,
}: {
  embedded?: boolean;
  catalogSession?: boolean;
  initialProductId?: string;
  merchantSlug?: string;
  internalSpatial?: boolean;
  draftScope?: string;
}) {
  const api = internalSpatial ? merchantApi : sharedApi;
  const resumeScope = internalSpatial ? draftScope : undefined;
  const [restoreState, setRestoreState] = useState<
    "loading" | "ready" | "error"
  >(resumeScope ? "loading" : "ready");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const submissionInFlight = useRef(false);
  const [pendingDraft, setPendingDraft] = useState<SpatialStudioDraft | null>(
    null,
  );
  const [draftWarning, setDraftWarning] = useState("");
  const [step, setStep] = useState(1);
  const [spatialAvailable, setSpatialAvailable] = useState(false);
  const [spatial, setSpatial] = useState(internalSpatial);
  const [spatialYaw, setSpatialYaw] = useState(0);
  const [spatialReference, setSpatialReference] = useState<SpatialReference>();
  const [referenceDraft, setReferenceDraft] = useState<{
    sceneId: string;
    surfaceId: string;
    sceneFingerprint: string;
    points: Array<{ x: number; y: number }>;
  }>();
  const [referenceLength, setReferenceLength] = useState("");
  const [previewState, setPreviewState] = useState<{
    key: string;
    preview?: SpatialPreview;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    if (!embedded && !catalogSession)
      void api<{ spatial: boolean }>("/v1/render-capabilities")
        .then((value) => {
          if (active) setSpatialAvailable(value.spatial);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [embedded, catalogSession, api]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState(initialProductId ?? "");
  const [scene, setScene] = useState<Scene | null>(null);
  const [surface, setSurface] = useState("tabletop");
  const [renderMode, setRenderMode] = useState<"insert" | "replace">("insert");
  const [outputQuality, setOutputQuality] = useState<"preview" | "final">(
    "final",
  );
  const [placementPoint, setPlacementPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [targetPoint, setTargetPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [segmentation, setSegmentation] = useState<Segmentation | null>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [beforePercent, setBeforePercent] = useState(48);
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("Choisir une photo");
  const [userInstructions, setUserInstructions] = useState("");
  const [manualPlacement, setManualPlacement] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [error, setError] = useState("");

  const product = useMemo(
    () => products.find((item) => item.id === productId) ?? null,
    [products, productId],
  );
  const renderPending =
    render?.status === "processing" || render?.status === "queued";
  const pendingRenderId = renderPending ? render.id : null;
  const spatialPreviewKey =
    spatial &&
    step === 2 &&
    !renderPending &&
    scene &&
    placementPoint &&
    product
      ? JSON.stringify({
          sceneId: scene.id,
          productId: product.id,
          point: placementPoint,
          surfaceType: surface,
          yawDegrees: spatialYaw,
          reference: spatialReference,
        })
      : "";
  const spatialPreview =
    previewState?.key === spatialPreviewKey ? previewState.preview : undefined;
  const spatialPreviewError =
    previewState?.key === spatialPreviewKey ? previewState.error : undefined;
  useEffect(() => {
    if (!scene || !spatialAvailable || step !== 2 || renderPending) return;
    const abort = new AbortController();
    void api(`/v1/scenes/${scene.id}/spatial-analysis`, {
      method: "POST",
      signal: abort.signal,
    }).catch(() => undefined);
    return () => abort.abort();
  }, [scene, spatialAvailable, api, step, renderPending]);
  useEffect(() => {
    if (!spatialPreviewKey) return;
    const abort = new AbortController();
    const { sceneId, ...body } = JSON.parse(spatialPreviewKey);
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await api<unknown>(
          `/v1/scenes/${sceneId}/spatial-preview`,
          { method: "POST", body: JSON.stringify(body), signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        if (typeof result === "object" && result && "pending" in result) {
          if (Date.now() - started > 100_000)
            throw new Error(
              "L’analyse prend plus de temps. Déplacez le point pour reprendre l’aperçu.",
            );
          timer = setTimeout(() => void load(), 2000);
          return;
        }
        setPreviewState({
          key: spatialPreviewKey,
          preview: spatialPreviewSchema.parse(result),
        });
      } catch (reason) {
        if (!abort.signal.aborted)
          setPreviewState({
            key: spatialPreviewKey,
            error:
              reason instanceof Error ? reason.message : "Aperçu indisponible",
          });
      }
    }
    timer = setTimeout(() => void load(), 350);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [spatialPreviewKey, api]);

  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    async function load() {
      if (catalogSession) {
        await establishGuestEditorSession();
      } else if (merchantSlug && initialProductId) {
        await establishPublicSession(merchantSlug, initialProductId);
      }
      const [availableProducts, wallet] = await Promise.all([
        getProducts(api),
        api<{ balance: number }>("/v1/credits"),
      ]);
      let draft = null;
      if (resumeScope) {
        try {
          draft = readSpatialDraft(window.sessionStorage, resumeScope);
        } catch {
          /* The studio remains usable when storage is blocked. */
        }
      }
      const [savedScene, savedRender] = draft
        ? await Promise.all([
            api<Scene>(`/v1/scenes/${draft.sceneId}`, { signal: abort.signal }),
            draft.renderId
              ? getRender(draft.renderId, abort.signal, api)
              : draft.pendingRequest
                ? findSpatialSubmission(draft.pendingRequest, api, abort.signal)
                : Promise.resolve(null),
          ])
        : [null, null];
      if (draft?.pendingRequest && !savedRender) {
        if (active) setPendingDraft(draft);
        throw new Error(
          "Cette demande n’est pas encore visible. Vous pouvez vérifier à nouveau ou renvoyer la même demande.",
        );
      }
      if (draft && savedScene) {
        if (
          savedScene.id !== draft.sceneId ||
          savedScene.status === "deleted" ||
          !savedScene.expiresAt ||
          !Number.isFinite(Date.parse(savedScene.expiresAt)) ||
          Date.parse(savedScene.expiresAt) <= Date.now()
        )
          throw new Error(
            "La photo enregistrée a expiré ou n’est plus disponible.",
          );
        if (
          !savedRender &&
          !availableProducts.some((item) => item.id === draft.productId)
        )
          throw new Error("Le produit enregistré n’est plus disponible.");
        if (
          savedRender &&
          ((draft.renderId && savedRender.id !== draft.renderId) ||
            savedRender.engine !== "spatial" ||
            savedRender.placement?.sceneId !== draft.sceneId)
        )
          throw new Error("Le rendu ne correspond pas à la photo enregistrée.");
      }
      if (draft?.pendingRequest && savedRender && resumeScope && active) {
        saveSpatialDraft(window.sessionStorage, resumeScope, {
          ...draft,
          pendingRequest: undefined,
          renderId: savedRender.id,
          savedAt: Date.now(),
        });
      }
      // Delivery may have captured the credit after the initial parallel read.
      const restoredWallet =
        savedRender?.status === "succeeded"
          ? await api<{ balance: number }>("/v1/credits", {
              signal: abort.signal,
            })
          : wallet;
      return {
        availableProducts,
        wallet: restoredWallet,
        draft,
        savedScene,
        savedRender,
      };
    }

    void load()
      .then(({ availableProducts, wallet, draft, savedScene, savedRender }) => {
        if (!active) return;
        setProducts(availableProducts);
        const nextProductId =
          draft?.productId ||
          initialProductId ||
          availableProducts[0]?.id ||
          "";
        setProductId(nextProductId);
        const selected = availableProducts.find(
          (item) => item.id === nextProductId,
        );
        if (draft && savedScene) {
          setScene(savedScene);
          setSurface(draft.surface);
          setPlacementPoint(draft.point);
          setSpatialYaw(draft.yaw);
          setSpatialReference(draft.reference);
          setUserInstructions(draft.instructions);
          setManualPlacement(true);
          setRender(savedRender);
          setStep(savedRender ? 3 : 2);
          setError(
            savedRender?.status === "failed"
              ? (savedRender.error ?? "Le rendu n’a pas abouti.")
              : "",
          );
        } else if (selected) setSurface(toSurfaceType(selected.placementType));
        setCredits(wallet.balance);
        setPendingDraft(null);
        submissionInFlight.current = false;
        setRestoreState("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "API indisponible");
        if (resumeScope) setRestoreState("error");
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [
    catalogSession,
    initialProductId,
    merchantSlug,
    api,
    resumeScope,
    restoreAttempt,
  ]);

  useEffect(() => {
    if (!resumeScope || restoreState !== "ready" || submissionInFlight.current)
      return;
    try {
      if (!scene || !spatial || renderMode !== "insert") {
        clearSpatialDraft(window.sessionStorage, resumeScope);
        return;
      }
      const saved = saveSpatialDraft(window.sessionStorage, resumeScope, {
        version: 3,
        savedAt: Date.now(),
        sceneId: scene.id,
        productId,
        surface,
        point: placementPoint,
        yaw: spatialYaw,
        reference: spatialReference,
        instructions: userInstructions,
        renderId: render?.id,
      });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Report the result of writing to external browser storage.
      setDraftWarning(
        saved
          ? ""
          : "La reprise après rechargement n’est pas disponible dans cet onglet.",
      );
    } catch {
      setDraftWarning(
        "La reprise après rechargement n’est pas disponible dans cet onglet.",
      );
    }
  }, [
    resumeScope,
    restoreState,
    spatial,
    renderMode,
    scene,
    productId,
    surface,
    placementPoint,
    spatialYaw,
    spatialReference,
    userInstructions,
    render?.id,
  ]);

  useEffect(() => {
    if (!pendingRenderId) return;
    const renderId = pendingRenderId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;

    async function refreshRender() {
      try {
        const nextRender = await getRender(renderId, undefined, api);
        if (cancelled) return;
        consecutiveFailures = 0;
        if (nextRender.status === "succeeded" && resumeScope) {
          // A restored wallet may already include capture; never subtract twice.
          const wallet = await api<{ balance: number }>("/v1/credits").catch(
            () => null,
          );
          if (cancelled) return;
          setCredits(wallet?.balance ?? null);
        }
        setRender(nextRender);
        if (nextRender.status === "succeeded") {
          if (!resumeScope && nextRender.creditCharged) {
            setCredits((value) => (value === null ? value : value - 1));
          }
          return;
        }
        if (nextRender.status === "failed") {
          setError(
            nextRender.error ??
              "Le rendu n’a pas abouti. Choisissez une autre zone ou une photo plus claire.",
          );
          return;
        }
        timer = setTimeout(refreshRender, 2_500);
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          setError(
            "Le rendu continue en arrière-plan. Revenez dans quelques instants.",
          );
        }
        timer = setTimeout(refreshRender, 4_000);
      }
    }

    timer = setTimeout(refreshRender, 1_500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pendingRenderId, api, resumeScope]);

  async function uploadRoom(file: File) {
    setBusy(true);
    setError("");
    try {
      if (catalogSession) {
        await establishGuestEditorSession();
      } else if (merchantSlug && initialProductId) {
        await establishPublicSession(merchantSlug, initialProductId);
      }
      setUploadStatus("Optimisation…");
      const preparedFile = await prepareImageForUpload(file);
      setUploadStatus("Envoi sécurisé…");
      const form = new FormData();
      form.set("file", preparedFile);
      form.set("consent", "true");
      const created = await api<Scene>("/v1/scenes", {
        method: "POST",
        body: form,
      });
      setScene(created);
      setRender(null);
      setSpatialReference(undefined);
      setReferenceDraft(undefined);
      setPlacementPoint(null);
      setTargetPoint(null);
      setSegmentation(null);
      setManualPlacement(internalSpatial);
      setStep(2);
      await recordEvent("room_uploaded");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Téléversement impossible",
      );
    } finally {
      setBusy(false);
      setUploadStatus("Choisir une photo");
    }
  }

  function pointFromEvent(event: MouseEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function placeMarker(event: MouseEvent<HTMLButtonElement>) {
    const point = pointFromEvent(event);
    if (
      spatial &&
      referenceDraft?.sceneId === scene?.id &&
      referenceDraft &&
      referenceDraft.points.length < 2
    ) {
      setReferenceDraft({
        ...referenceDraft,
        points: [...referenceDraft.points, point],
      });
      return;
    }
    setPlacementPoint(point);
    if (renderMode === "replace") {
      setTargetPoint(point);
      void segmentTarget(point);
    }
    void recordEvent("placement_point_selected");
  }

  async function segmentTarget(point: { x: number; y: number }) {
    if (!scene) return;
    setBusy(true);
    setError("");
    setSegmentation(null);
    try {
      const result = await api<Segmentation>(`/v1/scenes/${scene.id}/segment`, {
        method: "POST",
        body: JSON.stringify({ point }),
      });
      setSegmentation(result);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Impossible d’isoler cet objet.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmMask(mask: Blob) {
    if (!scene || !segmentation) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set(
        "file",
        new File([mask], "corrected-mask.png", { type: "image/png" }),
      );
      const confirmed = await api<Segmentation>(
        `/v1/scenes/${scene.id}/segments/${segmentation.id}/confirm`,
        { method: "POST", body: form },
      );
      setSegmentation(confirmed);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Confirmation du masque impossible.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function requestRender(prepared: PreparedRenderInput): Promise<Render> {
    if (!scene || !product) throw new Error("Photos introuvables");
    if (submissionInFlight.current)
      throw new Error("Une demande est déjà en cours de récupération.");
    const request = {
      engine: spatial && prepared.mode === "insert" ? "spatial" : "legacy",
      ...(spatial && prepared.mode === "insert" && spatialReference
        ? { spatialReference }
        : {}),
      mode: prepared.mode,
      placement: {
        sceneId: scene.id,
        productId: product.id,
        ...(spatial ? { rotationDegrees: spatialYaw } : {}),
        mode: prepared.mode,
        surfaceType:
          prepared.mode === "replace"
            ? "existing_object"
            : prepared.surfaceType,
        xNormalized: prepared.placementPoint.x,
        yNormalized: prepared.placementPoint.y,
      },
      placementPoint: prepared.placementPoint,
      ...(prepared.targetPoint ? { targetPoint: prepared.targetPoint } : {}),
      ...(prepared.targetMaskId ? { targetMaskId: prepared.targetMaskId } : {}),
      surfaceType:
        prepared.mode === "replace" ? "existing_object" : prepared.surfaceType,
      idempotencyKey: `web-${crypto.randomUUID()}`,
      outputQuality: prepared.outputQuality,
      quality: prepared.outputQuality === "preview" ? "low" : "high",
      preserveBackground: true,
      userInstructions:
        userInstructions.trim() ||
        "Place ce produit à l’endroit le plus naturel et réaliste.",
    };
    if (
      resumeScope &&
      spatial &&
      prepared.mode === "insert" &&
      prepared.outputQuality === "final"
    ) {
      const pendingRequest = spatialInsertionSubmissionSchema.parse(request);
      const draft: SpatialStudioDraft = {
        version: 3,
        savedAt: Date.now(),
        sceneId: scene.id,
        productId: product.id,
        surface: pendingRequest.surfaceType as SpatialStudioDraft["surface"],
        point: prepared.placementPoint,
        yaw: spatialYaw,
        reference: spatialReference,
        instructions: userInstructions,
        pendingRequest,
      };
      return submitPersistedDraft(draft);
    }
    return api<Render>(`/v1/renders/${prepared.outputQuality}`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async function submitPersistedDraft(
    draft: SpatialStudioDraft,
  ): Promise<Render> {
    if (!resumeScope || !draft.pendingRequest || submissionInFlight.current)
      throw new Error("Une demande est déjà en cours de récupération.");
    let saved = false;
    try {
      saved = saveSpatialDraft(window.sessionStorage, resumeScope, draft);
    } catch {
      /* Storage unavailable. */
    }
    if (!saved)
      throw new Error(
        "Impossible d’enregistrer la demande dans cet onglet. Aucun rendu n’a été envoyé ; autorisez le stockage du navigateur puis réessayez.",
      );
    submissionInFlight.current = true;
    try {
      const result = await sendSpatialSubmission(draft.pendingRequest, api);
      saveSpatialDraft(window.sessionStorage, resumeScope, {
        ...draft,
        pendingRequest: undefined,
        renderId: result.id,
        savedAt: Date.now(),
      });
      setRender(result);
      submissionInFlight.current = false;
      return result;
    } catch (reason) {
      setPendingDraft(draft);
      setRestoreState("error");
      throw reason;
    }
  }

  async function resendSavedRequest() {
    if (!resumeScope || !pendingDraft?.pendingRequest || busy) return;
    setBusy(true);
    setError("");
    setRestoreState("loading");
    try {
      const result = await sendSpatialSubmission(
        pendingDraft.pendingRequest,
        api,
      );
      saveSpatialDraft(window.sessionStorage, resumeScope, {
        ...pendingDraft,
        pendingRequest: undefined,
        renderId: result.id,
        savedAt: Date.now(),
      });
      setRestoreAttempt((value) => value + 1);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Récupération indisponible.",
      );
      setRestoreState("error");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!scene || !product || !placementPoint) return;
    setBusy(true);
    setError("");
    try {
      const result = await requestRender({
        mode: renderMode,
        surfaceType: surface,
        placementPoint,
        ...(targetPoint ? { targetPoint } : {}),
        ...(segmentation?.status === "confirmed"
          ? { targetMaskId: segmentation.id }
          : {}),
        outputQuality,
      });
      setRender(result);
      setStep(3);
      await recordEvent(
        result.status === "succeeded" ? "render_succeeded" : "render_requested",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Rendu impossible");
    } finally {
      setBusy(false);
    }
  }

  async function generateFromInstruction() {
    if (!scene || !product) return;
    setBusy(true);
    setError("");
    try {
      const prepared = await api<PlacementPreparation>(
        `/v1/scenes/${scene.id}/prepare`,
        {
          method: "POST",
          body: JSON.stringify({
            productId: product.id,
            instruction: userInstructions,
          }),
        },
      );
      setRenderMode(prepared.mode);
      setSurface(prepared.surfaceType);
      setPlacementPoint(prepared.placementPoint);
      setTargetPoint(prepared.targetPoint ?? null);
      setSegmentation(prepared.segmentation ?? null);
      if (prepared.needsClarification) {
        setManualPlacement(true);
        setError(
          "Je n’ai pas identifié la zone avec assez de certitude. Touchez simplement l’endroit sur la photo.",
        );
        return;
      }
      const result = await requestRender({
        mode: prepared.mode,
        surfaceType: prepared.surfaceType,
        placementPoint: prepared.placementPoint,
        ...(prepared.targetPoint ? { targetPoint: prepared.targetPoint } : {}),
        ...(prepared.segmentation
          ? { targetMaskId: prepared.segmentation.id }
          : {}),
        outputQuality: "final",
      });
      setRender(result);
      setOutputQuality("final");
      setStep(3);
      await recordEvent("natural_language_render_requested");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Je n’ai pas pu comprendre la demande.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function retryRender() {
    if (!render || busy || submissionInFlight.current) return;
    setBusy(true);
    setError("");
    try {
      if (resumeScope && render.engine === "spatial") {
        const pendingRequest = spatialRetrySubmissionSchema.parse({
          kind: "retry",
          sourceRenderId: render.id,
          idempotencyKey: `retry:${render.id}:${crypto.randomUUID()}`,
          placement: {
            sceneId: render.placement?.sceneId,
            productId: render.placement?.productId,
          },
        });
        if (scene?.id !== pendingRequest.placement.sceneId)
          throw new Error("La photo ne correspond plus au rendu d’origine.");
        await submitPersistedDraft({
          version: 3,
          savedAt: Date.now(),
          sceneId: scene.id,
          productId: pendingRequest.placement.productId,
          surface: toSurfaceType(
            render.surfaceType ?? surface,
          ) as SpatialStudioDraft["surface"],
          point: render.placementPoint ?? placementPoint,
          yaw: spatialYaw,
          reference: spatialReference,
          instructions: userInstructions,
          pendingRequest,
        });
        setFeedbackSent(false);
        return;
      }
      const retried = await api<Render>(`/v1/renders/${render.id}/retry`, {
        method: "POST",
        ...(render.engine === "spatial"
          ? {
              body: JSON.stringify({
                idempotencyKey: `retry:${render.id}:${crypto.randomUUID()}`,
              }),
            }
          : {}),
      });
      setRender(retried);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Nouvel essai impossible",
      );
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback(rating: number) {
    if (!render) return;
    await api(`/v1/renders/${render.id}/feedback`, {
      method: "POST",
      body: JSON.stringify({ rating }),
    });
    setFeedbackSent(true);
  }

  async function recordEvent(event: string) {
    await api("/v1/analytics", {
      method: "POST",
      body: JSON.stringify({
        event,
        sessionId: "demo-session",
        productId: productId || null,
        properties: { embedded, step, renderMode, outputQuality },
      }),
    }).catch(() => undefined);
  }

  return (
    <section
      className={`studio-shell ${embedded ? "embedded" : ""}`}
      data-step={step}
    >
      <header className="studio-head">
        <div>
          <span className="eyebrow">Aussi simple qu’un message</span>
          <h1>Montrez. Demandez. Visualisez.</h1>
          <p>Un produit, une photo de votre pièce et une phrase. C’est tout.</p>
        </div>
        {!embedded && (
          <span className="credit-pill" aria-label="Crédits disponibles">
            <Sparkles size={14} /> {credits ?? "—"} crédits
          </span>
        )}
      </header>

      <nav className="studio-steps" aria-label="Étapes du visualiseur">
        {["Photos", "Demande", "Résultat"].map((label, index) => (
          <button
            key={label}
            className={
              step === index + 1 ? "active" : step > index + 1 ? "done" : ""
            }
            onClick={() => step > index + 1 && setStep(index + 1)}
            disabled={
              step < index + 1 ||
              restoreState !== "ready" ||
              Boolean(resumeScope && (renderPending || busy))
            }
          >
            <span>{step > index + 1 ? <Check size={14} /> : index + 1}</span>
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="studio-error" role="alert">
          {error}
        </div>
      )}

      {draftWarning && <p role="status">{draftWarning}</p>}
      {restoreState === "loading" && (
        <p role="status">Récupération de votre studio…</p>
      )}
      {restoreState === "error" && (
        <div className="studio-panel">
          <p>
            Votre travail enregistré n’a pas pu être récupéré. Réessayer
            consulte son état sans relancer la génération.
          </p>
          <Button
            onClick={() => {
              setError("");
              setRestoreState("loading");
              setRestoreAttempt((value) => value + 1);
            }}
          >
            Réessayer la récupération
          </Button>
          {pendingDraft?.pendingRequest && (
            <Button onClick={() => void resendSavedRequest()} disabled={busy}>
              Renvoyer la demande enregistrée
            </Button>
          )}
          <button
            type="button"
            className="back-link"
            onClick={() => {
              try {
                if (resumeScope)
                  clearSpatialDraft(window.sessionStorage, resumeScope);
              } catch {
                /* Storage unavailable. */
              }
              setError("");
              setPendingDraft(null);
              setRestoreState("loading");
              setRestoreAttempt((value) => value + 1);
            }}
          >
            Ouvrir un nouveau studio
          </button>
          <p>
            Un rendu déjà demandé reste accessible dans votre historique. Ouvrir
            un nouveau studio ne l’annule pas.
          </p>
        </div>
      )}

      {restoreState === "ready" && (
        <div className="studio-body" inert={Boolean(resumeScope && busy)}>
          {step === 1 && (
            <div className="studio-grid intro-grid">
              <div className="studio-panel object-choice-panel">
                <span className="panel-index">1 — L’objet</span>
                <h2>Que voulez-vous essayer ?</h2>
                <p className="muted">
                  Touchez simplement l’objet de votre choix.
                </p>
                <div className="product-options">
                  {products.map((item) => (
                    <button
                      key={item.id}
                      className={
                        item.id === productId
                          ? "product-option selected"
                          : "product-option"
                      }
                      aria-pressed={item.id === productId}
                      onClick={() => {
                        if (resumeScope && item.id !== productId)
                          setRender(null);
                        setProductId(item.id);
                        setSurface(toSurfaceType(item.placementType));
                      }}
                    >
                      {item.cutoutUrl ? (
                        // The URL is returned by the trusted local API.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.cutoutUrl} alt="" />
                      ) : (
                        <ImagePlus />
                      )}
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.widthCm} × {item.heightCm} cm · {item.material}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                {product && product.views.length <= 1 && (
                  <p className="single-view-warning">
                    Certains angles non visibles seront estimés par
                    l’intelligence artificielle.
                  </p>
                )}
              </div>
              <label className="upload-zone">
                <Upload size={32} />
                <span className="panel-index">2 — Votre pièce</span>
                <strong>Ajoutez une photo de la pièce</strong>
                <span>Prenez-la bien droite et avec assez de lumière.</span>
                <span className="button upload-button" aria-live="polite">
                  {busy ? uploadStatus : "Choisir une photo"}
                </span>
                <span>JPEG, PNG ou WebP · 20 Mo maximum</span>
                <input
                  type="file"
                  aria-label="Photo de votre pièce"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy || !product}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadRoom(file);
                  }}
                />
                <small>
                  La photo est automatiquement allégée avant l’envoi.
                </small>
              </label>
            </div>
          )}

          {step === 2 && scene && !manualPlacement && (
            <div className="studio-grid ai-request-grid">
              <div className="ai-room-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scene.imageUrl} alt="Votre pièce" />
                <span>Votre pièce</span>
              </div>
              <div className="studio-panel ai-request-panel">
                <span className="panel-index">Votre demande</span>
                <h2>Dites simplement ce que vous voulez.</h2>
                <p className="muted">
                  L’intelligence artificielle trouvera seule l’objet, le
                  support, la taille et la perspective.
                </p>

                <div className="ai-attachments" aria-label="Images fournies">
                  <div className="ai-attachment">
                    {product?.cutoutUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.cutoutUrl} alt={product.name} />
                    ) : (
                      <ImagePlus size={24} />
                    )}
                    <span>
                      <small>Produit</small>
                      <strong>{product?.name}</strong>
                    </span>
                    <Check size={16} />
                  </div>
                  <div className="ai-attachment">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={scene.imageUrl} alt="Pièce à modifier" />
                    <span>
                      <small>Pièce</small>
                      <strong>Votre photo</strong>
                    </span>
                    <Check size={16} />
                  </div>
                </div>

                <label className="ai-instruction-field">
                  <span>Que voulez-vous faire ?</span>
                  <textarea
                    aria-label="Votre demande"
                    value={userInstructions}
                    maxLength={1500}
                    rows={4}
                    autoFocus
                    placeholder="Ex. Place le vase sur l’étagère"
                    onChange={(event) =>
                      setUserInstructions(event.target.value)
                    }
                  />
                </label>
                <p className="ai-example-copy">
                  Vous pouvez écrire naturellement : « sur l’étagère », « au
                  centre de la table » ou laisser le champ vide pour que l’IA
                  choisisse.
                </p>

                <Button
                  onClick={() => void generateFromInstruction()}
                  disabled={busy || credits === null || credits < 1 || !product}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Sparkles size={18} />
                  )}
                  {busy
                    ? "Je comprends votre demande…"
                    : credits === 0
                      ? "Aucun crédit disponible"
                      : "Créer le rendu · 1 crédit"}
                  {!busy && <ArrowRight size={18} />}
                </Button>

                <div className="ai-hidden-work">
                  <Sparkles size={18} />
                  <span>
                    <strong>Tout est automatique</strong>
                    <small>
                      Analyse de la zone, échelle, perspective, ombres et
                      contrôle du réalisme sont effectués en arrière-plan.
                    </small>
                  </span>
                </div>

                <button
                  className="back-link ai-manual-link"
                  type="button"
                  onClick={() => {
                    setError("");
                    setManualPlacement(true);
                  }}
                >
                  Je préfère indiquer précisément l’endroit
                </button>
                <button
                  className="back-link"
                  type="button"
                  onClick={() => {
                    setScene(null);
                    setRender(null);
                    setPlacementPoint(null);
                    setTargetPoint(null);
                    setSegmentation(null);
                    setStep(1);
                  }}
                >
                  <ArrowLeft size={15} /> Changer les photos
                </button>
              </div>
            </div>
          )}

          {step === 2 && scene && manualPlacement && (
            <div className="studio-grid settings-grid">
              <p className="mobile-placement-hint">
                {renderMode === "replace"
                  ? "Touchez précisément l’élément présent à cet endroit."
                  : "Touchez l’endroit où poser le produit."}
              </p>
              {renderMode === "replace" && segmentation ? (
                <MaskEditor
                  imageUrl={scene.imageUrl}
                  maskUrl={segmentation.maskUrl}
                  busy={busy}
                  confirmed={segmentation.status === "confirmed"}
                  onConfirm={confirmMask}
                  onReset={() => {
                    setSegmentation(null);
                    setPlacementPoint(null);
                    setTargetPoint(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="room-preview marker-placement"
                  aria-label={
                    renderMode === "replace"
                      ? "Sélectionner l’élément présent"
                      : "Placer le point rouge sur la pièce"
                  }
                  onClick={placeMarker}
                  disabled={busy}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={scene.imageUrl} alt="Pièce téléversée" />
                  {spatial && spatialPreview && (
                    <svg
                      viewBox="0 0 1000 1000"
                      preserveAspectRatio="none"
                      aria-label="Aperçu géométrique provisoire"
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        pointerEvents: "none",
                      }}
                    >
                      {[
                        [0, 1],
                        [1, 2],
                        [2, 3],
                        [3, 0],
                        [4, 5],
                        [5, 6],
                        [6, 7],
                        [7, 4],
                        [0, 4],
                        [1, 5],
                        [2, 6],
                        [3, 7],
                      ].map(([a, b], i) => (
                        <line
                          key={i}
                          x1={spatialPreview.corners[a!]!.x * 1000}
                          y1={spatialPreview.corners[a!]!.y * 1000}
                          x2={spatialPreview.corners[b!]!.x * 1000}
                          y2={spatialPreview.corners[b!]!.y * 1000}
                          stroke={
                            spatialPreview.fits && spatialPreview.supportFits
                              ? "#00b9c9"
                              : "#e55353"
                          }
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                    </svg>
                  )}
                  {spatial && referenceDraft?.sceneId === scene.id && (
                    <svg
                      viewBox="0 0 1000 1000"
                      preserveAspectRatio="none"
                      aria-label="Points de référence"
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        pointerEvents: "none",
                      }}
                    >
                      {referenceDraft.points.map((p, i) => (
                        <circle
                          key={i}
                          cx={p.x * 1000}
                          cy={p.y * 1000}
                          r="6"
                          fill="#ffd000"
                        />
                      ))}
                    </svg>
                  )}
                  {placementPoint && (
                    <span
                      className="red-placement-dot"
                      data-testid="placement-dot"
                      style={{
                        left: `${placementPoint.x * 100}%`,
                        top: `${placementPoint.y * 100}%`,
                      }}
                    />
                  )}
                  {busy && renderMode === "replace" && (
                    <span className="segmenting-indicator">
                      <LoaderCircle className="spin" size={20} /> Sélection en
                      cours…
                    </span>
                  )}
                </button>
              )}
              <div className="studio-panel placement-panel">
                <span className="panel-index">Étape 2 sur 3</span>
                <h2>Indiquez l’endroit.</h2>
                <p className="muted">
                  {spatial
                    ? product?.objectType === "rug"
                      ? "Touchez un endroit libre au sol : le point rouge indique le centre du tapis."
                      : "Touchez un support libre dans la photo pour y placer le point de contact de l’objet."
                    : "Touchez simplement la photo. Si la zone est occupée, l’IA la préparera automatiquement."}
                </p>

                {renderMode === "insert" ? (
                  <>
                    <strong className="choice-label">
                      Le produit sera posé sur :
                    </strong>
                    <div className="choice-grid">
                      {surfaceChoices.map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          className={
                            surface === value ? "choice active" : "choice"
                          }
                          onClick={() => {
                            setSurface(value);
                            setSpatialReference(undefined);
                            setReferenceDraft(undefined);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="mask-status-copy">
                    <strong>
                      {segmentation?.status === "confirmed"
                        ? `${segmentation.label} correctement sélectionné`
                        : segmentation
                          ? "Corrigez la zone rouge si nécessaire"
                          : "Touchez l’objet dans la photo"}
                    </strong>
                    <small>Rien ne sera généré avant votre confirmation.</small>
                  </div>
                )}

                {spatialAvailable && renderMode === "insert" && (
                  <div className="user-render-note">
                    <label>
                      <input
                        type="checkbox"
                        checked={spatial}
                        onChange={(event) => {
                          setSpatial(event.target.checked);
                          setOutputQuality("final");
                        }}
                      />{" "}
                      Placement spatial — essai interne
                    </label>
                    {spatial && (
                      <>
                        <p>
                          Visualisation approximative, dimensions catalogue. Le
                          guide géométrique est provisoire. Sol, table ou
                          étagère ; un seul objet ou tapis avec texture
                          confirmée.
                        </p>
                        <label>
                          Orientation : {spatialYaw}°
                          <input
                            type="range"
                            min={-180}
                            max={180}
                            step={5}
                            value={spatialYaw}
                            onChange={(event) =>
                              setSpatialYaw(Number(event.target.value))
                            }
                          />
                        </label>
                        <p role="status">
                          {spatialPreviewError ??
                            (spatialPreview
                              ? !spatialPreview.fits
                                ? "Le produit dépasse la photo : déplacez-le sans réduire ses dimensions."
                                : !spatialPreview.supportFits
                                  ? "Le produit dépasse le support libre : déplacez-le ou faites-le pivoter."
                                  : spatialPreview.calibration ===
                                      "reference_scaled"
                                    ? "Échelle ajustée à votre longueur de référence. La perspective reste estimée."
                                    : "Volume provisoire calculé. Une longueur connue peut préciser son échelle."
                              : placementPoint
                                ? "Analyse de la pièce et calcul du volume…"
                                : "Choisissez d’abord le point de contact.")}
                        </p>
                        <button
                          type="button"
                          disabled={!spatialPreview}
                          onClick={() => {
                            if (spatialPreview) {
                              setReferenceDraft({
                                sceneId: scene.id,
                                surfaceId: spatialPreview.surfaceId,
                                sceneFingerprint:
                                  spatialPreview.sceneFingerprint,
                                points: [],
                              });
                              setReferenceLength("");
                            }
                          }}
                        >
                          Indiquer une longueur connue
                        </button>
                        {referenceDraft?.sceneId === scene.id && (
                          <div>
                            <p>
                              {referenceDraft.points.length < 2
                                ? `Touchez ${referenceDraft.points.length ? "la seconde" : "la première"} extrémité d’une longueur sur le même support que l’objet.`
                                : "Indiquez la longueur entre les deux points jaunes."}
                            </p>
                            <label>
                              Longueur réelle en cm
                              <input
                                type="number"
                                min="0.1"
                                max="10000"
                                step="any"
                                value={referenceLength}
                                onChange={(event) =>
                                  setReferenceLength(event.target.value)
                                }
                              />
                            </label>
                            <button
                              type="button"
                              disabled={
                                referenceDraft.points.length !== 2 ||
                                !(
                                  Number(referenceLength) > 0 &&
                                  Number(referenceLength) <= 10000
                                )
                              }
                              onClick={() => {
                                setSpatialReference({
                                  surfaceId: referenceDraft.surfaceId,
                                  sceneFingerprint:
                                    referenceDraft.sceneFingerprint,
                                  points: [
                                    referenceDraft.points[0]!,
                                    referenceDraft.points[1]!,
                                  ],
                                  lengthCm: Number(referenceLength),
                                });
                                setReferenceDraft(undefined);
                              }}
                            >
                              Appliquer la référence
                            </button>
                            <button
                              type="button"
                              onClick={() => setReferenceDraft(undefined)}
                            >
                              Annuler
                            </button>
                          </div>
                        )}
                        {spatialReference && (
                          <button
                            type="button"
                            onClick={() => setSpatialReference(undefined)}
                          >
                            Retirer la référence
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div
                  className="quality-choice"
                  role="group"
                  aria-label="Qualité du rendu"
                >
                  <button
                    type="button"
                    className={outputQuality === "preview" ? "active" : ""}
                    disabled={spatial}
                    onClick={() => setOutputQuality("preview")}
                  >
                    <strong>Aperçu rapide</strong>
                    <small>Nano Banana 2 · 1K</small>
                  </button>
                  <button
                    type="button"
                    className={outputQuality === "final" ? "active" : ""}
                    onClick={() => setOutputQuality("final")}
                  >
                    <strong>Rendu final</strong>
                    <small>Nano Banana Pro · 2K</small>
                  </button>
                </div>

                <details className="user-render-note">
                  <summary>Ajouter une indication (facultatif)</summary>
                  <textarea
                    value={userInstructions}
                    maxLength={1500}
                    rows={3}
                    placeholder="Ex. conserver le rideau devant le meuble…"
                    onChange={(event) =>
                      setUserInstructions(event.target.value)
                    }
                  />
                </details>

                <div className="auto-placement-note">
                  <Sparkles size={20} />
                  <span>
                    <strong>
                      {spatial
                        ? "Perspective et échelle estimées"
                        : "L’IA mesure et place pour vous"}
                    </strong>
                    <small>
                      Échelle, perspective, contact et lumière sont calculés
                      automatiquement.
                    </small>
                  </span>
                </div>
                <Button
                  onClick={() => void generate()}
                  disabled={
                    busy ||
                    credits === null ||
                    credits < 1 ||
                    !placementPoint ||
                    (spatial &&
                      renderMode === "insert" &&
                      (!spatialPreview?.fits ||
                        !spatialPreview.supportFits ||
                        Boolean(referenceDraft))) ||
                    (renderMode === "replace" &&
                      segmentation?.status !== "confirmed")
                  }
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <Sparkles size={17} />
                  )}
                  {!placementPoint
                    ? renderMode === "replace"
                      ? "Touchez l’élément présent"
                      : "Touchez d’abord la photo"
                    : renderMode === "replace" &&
                        segmentation?.status !== "confirmed"
                      ? "Confirmez d’abord le masque"
                      : credits === 0
                        ? "Aucun crédit disponible"
                        : outputQuality === "preview"
                          ? "Créer mon aperçu · 1 crédit"
                          : "Créer le rendu final · 1 crédit"}
                  {!busy && <ArrowRight size={17} />}
                </Button>
                <button
                  className="back-link"
                  type="button"
                  onClick={() => {
                    setError("");
                    setManualPlacement(false);
                  }}
                >
                  <Sparkles size={15} /> Revenir à la demande simple
                </button>
                <button
                  className="back-link"
                  type="button"
                  onClick={() => {
                    setScene(null);
                    setPlacementPoint(null);
                    setTargetPoint(null);
                    setSegmentation(null);
                    setStep(1);
                  }}
                >
                  <ArrowLeft size={15} /> Choisir une autre photo
                </button>
              </div>
            </div>
          )}

          {step === 3 && scene && render && (
            <div className="result-layout">
              <div className="compare-frame">
                {render.resultUrl || render.compositeUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={render.resultUrl ?? render.compositeUrl ?? ""}
                      alt={
                        render.status === "succeeded"
                          ? "Rendu avec le produit intégré"
                          : "Aperçu du placement non validé"
                      }
                    />
                    <div
                      className="before-layer"
                      style={{
                        clipPath: `polygon(0 0, ${beforePercent}% 0, ${beforePercent}% 100%, 0 100%)`,
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={scene.imageUrl} alt="Photo avant intégration" />
                    </div>
                    <span className="before-label">Avant</span>
                    <span className="after-label">
                      {render.status === "succeeded"
                        ? "Après"
                        : "Aperçu non validé"}
                    </span>
                    <input
                      aria-label="Comparer avant et après"
                      className="compare-range"
                      type="range"
                      min="0"
                      max="100"
                      value={beforePercent}
                      onChange={(event) =>
                        setBeforePercent(Number(event.target.value))
                      }
                    />
                  </>
                ) : (
                  <div className="pipeline-waiting-visual">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={
                        render.engine === "spatial" && render.compositeUrl
                          ? render.compositeUrl
                          : scene.imageUrl
                      }
                      alt={
                        render.engine === "spatial" && render.compositeUrl
                          ? "Guide géométrique provisoire, pas un rendu photographique"
                          : "Photo en cours d’analyse"
                      }
                    />
                    <div className="pipeline-waiting-overlay">
                      {render.status === "failed" ? (
                        <>
                          <strong>Rendu interrompu</strong>
                          <span>
                            {render.error ??
                              "Choisissez une autre zone ou une photo plus claire."}
                          </span>
                        </>
                      ) : (
                        <>
                          <LoaderCircle className="spin" size={34} />
                          <strong>{currentPipelineCopy(render).title}</strong>
                          <span>{currentPipelineCopy(render).detail}</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="result-summary card">
                <Badge
                  tone={render.status === "succeeded" ? "positive" : "warning"}
                >
                  {renderPending && (
                    <LoaderCircle className="spin refining-icon" size={14} />
                  )}
                  {renderPending
                    ? currentPipelineCopy(render).title
                    : render.status === "failed"
                      ? "Placement impossible"
                      : render.qualityDecision?.status === "simulated"
                        ? "Simulation"
                        : render.engine === "spatial"
                          ? "Visualisation approximative contrôlée"
                          : "Rendu contrôlé"}
                </Badge>
                <h2>
                  {renderPending
                    ? "Nous avançons étape par étape."
                    : render.status === "failed"
                      ? "Nous préférons vous arrêter ici."
                      : "Voilà le résultat."}
                </h2>
                <p className="muted">
                  {renderPending
                    ? currentPipelineCopy(render).detail
                    : render.status === "failed"
                      ? (render.error ?? "Essayez une autre zone.")
                      : typeof render.placement?.rationale === "string"
                        ? render.placement.rationale
                        : "Placement, échelle et lumière calculés automatiquement."}
                </p>
                {render.status === "succeeded" && (
                  <>
                    <div className="score-row">
                      <span>Évaluation visuelle</span>
                      <strong>
                        {render.qualityScore === null
                          ? "Non évaluée"
                          : `${Math.round(render.qualityScore * 100)}%`}
                      </strong>
                    </div>
                    {render.qualityDecision?.status === "simulated" && (
                      <p>Simulation — fidélité visuelle non évaluée.</p>
                    )}
                    <div className="render-facts">
                      <span>
                        {render.placement?.perspective &&
                        typeof render.placement.perspective === "object" &&
                        "scale" in render.placement.perspective
                          ? "Dimensions calibrées"
                          : "Dimensions estimées"}
                      </span>
                      <span>{render.model}</span>
                      <span>
                        Coût estimé $
                        {Number(render.estimatedCostUsd ?? 0).toFixed(3)}
                      </span>
                    </div>
                  </>
                )}
                {render.status === "succeeded" && render.resultUrl && (
                  <div className="result-actions">
                    <a
                      className="button"
                      href={product?.buyUrl ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => void recordEvent("add_to_cart_clicked")}
                    >
                      <ShoppingBag size={17} /> Acheter
                    </a>
                    <a
                      className="button secondary"
                      href={render.resultUrl}
                      download
                      onClick={() => void recordEvent("result_downloaded")}
                    >
                      <Download size={17} /> Télécharger
                    </a>
                    <button
                      className="button secondary"
                      onClick={() => {
                        void navigator.share?.({
                          title: "Mon aperçu déco",
                          url: render.resultUrl ?? undefined,
                        });
                        void recordEvent("result_shared");
                      }}
                    >
                      <Share2 size={17} /> Partager
                    </button>
                  </div>
                )}
                {render.status === "succeeded" && !feedbackSent && (
                  <div className="feedback-row">
                    <span>Ce rendu vous aide à choisir ?</span>
                    <button type="button" onClick={() => void sendFeedback(5)}>
                      Oui
                    </button>
                    <button type="button" onClick={() => void sendFeedback(1)}>
                      Non
                    </button>
                  </div>
                )}
                {!renderPending && (
                  <div className="result-secondary-actions">
                    <button
                      className="back-link"
                      type="button"
                      onClick={() => void retryRender()}
                      disabled={busy}
                    >
                      <RefreshCw size={15} /> Nouvelle tentative
                    </button>
                    <button
                      className="back-link"
                      type="button"
                      onClick={() => {
                        setRender(null);
                        setStep(2);
                      }}
                    >
                      <ArrowLeft size={15} /> Essayer un autre endroit
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const surfaceChoices: Array<[string, string]> = [
  ["tabletop", "Table"],
  ["shelf", "Étagère"],
  ["niche", "Niche"],
  ["wall", "Mur"],
  ["floor", "Sol"],
  ["rug_zone", "Zone tapis"],
  ["ceiling", "Plafond"],
];

function toSurfaceType(value: string): string {
  if (value === "table" || value === "nightstand") return "tabletop";
  return value;
}
