import type { Render } from "@lili/types";

export const RENDER_PROGRESS_STEPS = [
  "Lecture de l’intérieur",
  "Placement des objets",
  "Lumière et ombres",
  "Vérification du résultat",
] as const;

export const STOREFRONT_PLACEMENT_PROGRESS_STEPS = [
  "Lecture de l’intérieur",
  "Placement des objets",
  "Vérification du placement",
] as const;

/** This is the server-resolved quality contract, never a client preference. */
export function isStorefrontPlacementRender(
  render: Pick<Render, "engineVersions">,
): boolean {
  return render.engineVersions?.quality === "storefront-placement-review-v1";
}

export function renderTerminalAnnouncement(
  status: Render["status"] | undefined,
): string {
  switch (status) {
    case "succeeded":
      return "Votre visualisation est prête.";
    case "failed":
      return "La génération n’a pas abouti. Consultez le message d’erreur.";
    case "cancelled":
      return "La génération a été annulée.";
    case "deleted":
      return "Cette visualisation a été supprimée.";
    default:
      return "";
  }
}

type ProgressInput = Pick<
  Render,
  | "status"
  | "pipelineState"
  | "placement"
  | "execution"
  | "compositeUrl"
  | "engineVersions"
>;
type StageCopy = { title: string; detail: string; phase: number | null };

const stageCopy: Record<string, StageCopy> = {
  uploaded: {
    title: "Préparation de votre demande",
    detail: "Les images et votre placement sont pris en compte.",
    phase: 0,
  },
  analyzing_scene: {
    title: "Lecture de votre intérieur",
    detail:
      "Les surfaces, la perspective et la lumière de la photo sont analysées.",
    phase: 0,
  },
  inspecting_scene: {
    title: "Lecture de votre intérieur",
    detail: "Les surfaces et les zones de placement sont repérées.",
    phase: 0,
  },
  estimating_scale: {
    title: "Vérification de l’échelle",
    detail:
      "Les dimensions des objets sont rapprochées des repères de la photo.",
    phase: 0,
  },
  inspecting_targets: {
    title: "Vérification des emplacements",
    detail: "Les zones choisies sont examinées avant d’y placer vos objets.",
    phase: 0,
  },
  segmenting_target: {
    title: "Repérage de l’objet à remplacer",
    detail: "Son contour est préparé pour dégager l’emplacement.",
    phase: 0,
  },
  awaiting_mask_confirmation: {
    title: "Confirmation du contour nécessaire",
    detail:
      "Le traitement attend la validation du contour de l’objet à remplacer.",
    phase: 0,
  },
  removing_target: {
    title: "Préparation de l’emplacement",
    detail:
      "L’objet à remplacer est retiré et la surface derrière lui est reconstruite.",
    phase: 0,
  },
  analyzing_cleaned_scene: {
    title: "Vérification de l’espace dégagé",
    detail: "La perspective est vérifiée après le retrait de l’ancien objet.",
    phase: 0,
  },
  computing_geometry: {
    title: "Calcul du placement",
    detail:
      "La position, les dimensions et les points de contact sont préparés.",
    phase: 1,
  },
  validating_fit: {
    title: "Vérification des dimensions",
    detail: "La place disponible et la taille des objets sont comparées.",
    phase: 1,
  },
  compositing: {
    title: "Placement de vos objets",
    detail:
      "Les objets sont intégrés à leur position et à leur taille prévues.",
    phase: 1,
  },
  composing_preview: {
    title: "Préparation de l’aperçu du placement",
    detail: "Une première image de vos objets dans la pièce est assemblée.",
    phase: 1,
  },
  building_prompt: {
    title: "Préparation du rendu",
    detail:
      "Les références des objets et les contraintes de placement sont réunies.",
    phase: 1,
  },
  checking_composition: {
    title: "Vérification du placement",
    detail:
      "L’aperçu est contrôlé avant de travailler la lumière et les ombres.",
    phase: 1,
  },
  generating_preview: {
    title: "Création du rendu",
    detail: "La lumière et les ombres sont adaptées à votre intérieur.",
    phase: 2,
  },
  generating_final: {
    title: "Création du rendu réaliste",
    detail:
      "La lumière et les ombres sont travaillées pour intégrer vos objets à la pièce.",
    phase: 2,
  },
  refining_final: {
    title: "Finition du rendu",
    detail:
      "La lumière et le contact des objets avec leur support sont affinés.",
    phase: 2,
  },
  repairing_integration: {
    title: "Affinement de l’intégration",
    detail:
      "Le contrôle a demandé une correction de l’image avant sa livraison.",
    phase: 2,
  },
  retrying: {
    title: "Correction du rendu",
    detail:
      "Une nouvelle passe corrige les points relevés lors de la vérification.",
    phase: 2,
  },
  quality_check: {
    title: "Vérification du résultat",
    detail:
      "La fidélité des objets, leur placement et leur intégration sont contrôlés.",
    phase: 3,
  },
  completed: {
    title: "Votre rendu est prêt",
    detail: "La visualisation est disponible.",
    phase: 4,
  },
  complete: {
    title: "Votre rendu est prêt",
    detail: "La visualisation est disponible.",
    phase: 4,
  },
};

const placementStageCopy: Record<string, StageCopy> = {
  uploaded: stageCopy.uploaded!,
  analyzing_scene: {
    title: "Lecture de votre intérieur",
    detail: "Les surfaces et la perspective de votre photo sont repérées.",
    phase: 0,
  },
  estimating_scale: stageCopy.estimating_scale!,
  inspecting_targets: stageCopy.inspecting_targets!,
  computing_geometry: stageCopy.computing_geometry!,
  validating_fit: stageCopy.validating_fit!,
  compositing: {
    title: "Placement de vos objets",
    detail:
      "Les photos des produits sont placées dans votre intérieur à l’échelle estimée.",
    phase: 1,
  },
  composing_preview: {
    title: "Préparation de l’aperçu du placement",
    detail: "L’image de votre sélection dans la pièce est assemblée.",
    phase: 1,
  },
  checking_placement: {
    title: "Vérification du placement",
    detail:
      "La fidélité des produits, leurs positions et leurs dimensions estimées sont contrôlées.",
    phase: 2,
  },
  quality_check: {
    title: "Vérification du placement",
    detail:
      "La fidélité des produits, leurs positions et leurs dimensions estimées sont contrôlées.",
    phase: 2,
  },
  completed: { ...stageCopy.completed!, phase: 3 },
  complete: { ...stageCopy.complete!, phase: 3 },
};

/** Progress comes exclusively from server evidence, never elapsed time. */
export function renderProgress(render: ProgressInput) {
  const sourcePixelPlacement = isStorefrontPlacementRender(render);
  const copies = sourcePixelPlacement ? placementStageCopy : stageCopy;
  const placementStage =
    typeof render.placement?.pipelineStage === "string"
      ? render.placement.pipelineStage
      : "";
  // These state transitions also exist without a new placement document.
  const stage =
    render.pipelineState === "quality_check" ||
    render.pipelineState === "retrying"
      ? render.pipelineState === "retrying" &&
        placementStage === "repairing_integration"
        ? placementStage
        : render.pipelineState
      : placementStage || render.pipelineState || "";
  const copy = stage.startsWith("removing_object_")
    ? copies.removing_target
    : (copies[stage] ?? copies[render.pipelineState ?? ""]);
  const queued = render.status === "queued";
  const retrying = queued && render.execution?.retrying === true;
  const phase = queued && !retrying ? null : (copy?.phase ?? null);
  const title = queued
    ? retrying
      ? "Reprise en attente"
      : "Votre rendu est dans la file d’attente"
    : (copy?.title ?? "Traitement de votre image");
  const detail = queued
    ? retrying
      ? "Le traitement reprendra automatiquement à partir des étapes déjà enregistrées. Votre placement est conservé."
      : "Votre demande est enregistrée. Les étapes s’afficheront ici dès le début du traitement."
    : (copy?.detail ??
      "Nous attendons la prochaine information du traitement.");
  return {
    title,
    detail,
    queued,
    retrying,
    sourcePixelPlacement,
    steps: (sourcePixelPlacement
      ? STOREFRONT_PLACEMENT_PROGRESS_STEPS
      : RENDER_PROGRESS_STEPS
    ).map((label, index) => ({
      label,
      state:
        phase !== null && index < phase
          ? ("complete" as const)
          : index === phase
            ? queued
              ? ("waiting" as const)
              : ("active" as const)
            : ("pending" as const),
    })),
  };
}

/** Wall time since the accepted request; invalid/future dates have no clock. */
export function elapsedRenderTime(
  createdAt: string,
  now: number | null,
): string | null {
  const start = Date.parse(createdAt);
  if (now === null || !Number.isFinite(start) || start > now) return null;
  const seconds = Math.floor((now - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds} s`;
  if (minutes < 60)
    return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
