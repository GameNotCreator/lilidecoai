import "server-only";

import type { CutoutMetadata } from "@lili/types";

import { CUTOUT_VERSION } from "./assets";
import type { CutoutQualityFlags } from "./assets";

/**
 * Whether a stored cutout may be trusted as the product's identity — audit
 * finding A03, ticket PRO-008.
 *
 * The cutout is not a preview. Its pixels are composited into the room, and
 * `pasteBackOutsideMask` re-stamps them OVER the model's output as the last
 * operation before encoding — so whatever is in the cutout is what the customer
 * is told their product looks like. Its alpha also defines the editable mask,
 * its aspect sets the rendered width and its base row sets the anchor. A cutout
 * a generative model re-rendered is therefore not a lesser cutout; it is a
 * different object presented as theirs.
 *
 * The rule this file enforces has one sentence: **every pixel of a stored
 * cutout comes from the customer's own photo.**
 *
 * The gate is an ALLOWLIST, deliberately. Written as a denylist over
 * `synthetic` it would read a cutout carrying no metadata at all — every
 * product prepared before this field existed — as trustworthy, which is
 * exactly backwards.
 */

/** Sources whose pixels come from the customer's photo. */
const AUTHENTIC_SOURCES = new Set(["heuristic", "matting"]);

export type CutoutTrust =
  { trusted: true } | { trusted: false; reason: string; message: string };

export function cutoutTrust(cutout: CutoutMetadata | undefined): CutoutTrust {
  if (!cutout) {
    return {
      trusted: false,
      reason: "cutout_unknown_provenance",
      message:
        "L’origine du détourage de cet objet n’est pas connue. Relancez sa préparation avant de l’utiliser.",
    };
  }
  if (cutout.synthetic || !AUTHENTIC_SOURCES.has(cutout.source)) {
    return {
      trusted: false,
      reason: "cutout_synthetic",
      message:
        "Le détourage de cet objet a été régénéré par un modèle : ce n’est plus la photo du produit. Relancez sa préparation.",
    };
  }
  if (!cutout.cutoutVersion) {
    return {
      trusted: false,
      reason: "cutout_unversioned",
      message:
        "Ce détourage a été produit avant le suivi de version. Relancez la préparation de l’objet.",
    };
  }
  if (cutout.verdict?.usable === false) {
    return {
      trusted: false,
      reason: "cutout_unusable",
      message:
        cutout.verdict.detail ||
        "Le détourage est inutilisable. Relancez la préparation avec une photo plus nette.",
    };
  }
  if (
    !Number.isFinite(cutout.widthPx) ||
    cutout.widthPx < 1 ||
    !Number.isFinite(cutout.heightPx) ||
    cutout.heightPx < 1 ||
    !Number.isFinite(cutout.baseRowFraction) ||
    cutout.baseRowFraction <= 0 ||
    cutout.baseRowFraction > 1
  ) {
    return {
      trusted: false,
      reason: "cutout_invalid_geometry",
      message:
        "Les dimensions du détourage sont invalides. Relancez la préparation de l’objet.",
    };
  }
  return { trusted: true };
}

/**
 * The matte's own verdict on the photo, recorded on every prepare.
 *
 * Only two outcomes make the cutout genuinely unusable, and neither is a policy
 * choice: `opaque` means nothing was removed, so compositing it would paste the
 * photo's background into the room; `vanished` means nothing survived, so there
 * is no product left to paste. Everything else — a soft edge, a retained
 * contact shadow, a pocket of background inside the silhouette — ships with a
 * warning, exactly as before.
 *
 * The softer causes are recorded and NOT refused. Their real frequency on
 * customer photos has never been measured, and refusing on an unmeasured rate
 * would turn away people whose photo works. The corpus (PRO-007) is the
 * instrument that will measure it; enforcement can follow the measurement.
 */
export function cutoutVerdict(
  quality: CutoutQualityFlags,
): NonNullable<CutoutMetadata["verdict"]> {
  if (quality.vanished) {
    return {
      usable: false,
      code: "product_not_separable",
      detail:
        "L’objet ne se distingue pas de son fond : il ne reste rien à détourer. Photographiez-le devant un fond uni nettement plus clair ou plus foncé que lui.",
    };
  }
  if (quality.opaque) {
    return {
      usable: false,
      code: "background_not_removable",
      detail:
        "Le fond de cette photo n’a pas pu être séparé de l’objet. Photographiez-le devant un fond uni, sans motif ni objets derrière.",
    };
  }
  if (quality.busyBackground) {
    return {
      usable: true,
      code: "background_busy",
      detail: "Fond chargé : le contour peut être imprécis.",
    };
  }
  if (quality.enclosedBackground) {
    return {
      usable: true,
      code: "background_trapped_inside",
      detail: "Une zone de fond subsiste peut-être à l’intérieur de l’objet.",
    };
  }
  if (quality.shadowBand) {
    return {
      usable: true,
      code: "contact_shadow_retained",
      detail: "Une ombre de contact n’a pas pu être retirée avec certitude.",
    };
  }
  if (quality.hollowed) {
    return {
      usable: true,
      code: "silhouette_eaten",
      detail: "Le détourage a peut-être mangé une partie de l’objet.",
    };
  }
  if (quality.ragged) {
    return {
      usable: true,
      code: "edge_soft",
      detail: "Le contour est flou : la découpe peut manquer de netteté.",
    };
  }
  return { usable: true, code: "ok", detail: "" };
}

export class CutoutUnusableError extends Error {
  readonly status = 422;
  constructor(readonly verdict: NonNullable<CutoutMetadata["verdict"]>) {
    super(verdict.detail);
  }
}

/** The version stamped on a cutout this build produces. */
export { CUTOUT_VERSION };
