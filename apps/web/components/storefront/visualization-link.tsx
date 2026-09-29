"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Smartphone, X } from "lucide-react";
import {
  normalizeCart,
  visualizationHref,
  visualizationProblem,
} from "@/lib/storefront";
import {
  isLoopbackHostname,
  visualizationHandoff,
} from "@/lib/visualization-handoff";
import { useStorefrontCatalog } from "./catalog-state";
import styles from "./visualization-link.module.css";

/** The normal link remains usable on phones, without JavaScript and in a new tab. */
export function VisualizationLink({
  productIds,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  productIds: string[];
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  const [origin, setOrigin] = useState<string | null>(null);
  return (
    <>
      <Link
        href={visualizationHref(productIds)}
        className={className}
        aria-label={ariaLabel}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            !window.matchMedia("(hover: hover) and (pointer: fine)").matches
          )
            return;
          event.preventDefault();
          setOrigin(window.location.origin);
        }}
      >
        {children}
      </Link>
      {origin && (
        <VisualizationHandoffDialog
          key={productIds.join(",")}
          productIds={productIds}
          origin={origin}
          onClose={() => setOrigin(null)}
        />
      )}
    </>
  );
}

function VisualizationHandoffDialog({
  productIds,
  origin,
  onClose,
}: {
  productIds: string[];
  origin: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const originInputId = useId();
  const [mobileOrigin, setMobileOrigin] = useState(
    process.env.NEXT_PUBLIC_STOREFRONT_MOBILE_ORIGIN ?? "",
  );
  const [originDraft, setOriginDraft] = useState(mobileOrigin);
  const [copyStatus, setCopyStatus] = useState("");
  const { catalog, error, retry } = useStorefrontCatalog();
  const handoff = visualizationHandoff(productIds, origin, mobileOrigin);
  const local = isLoopbackHostname(new URL(origin).hostname);
  const problem = catalog
    ? visualizationProblem(
        normalizeCart(productIds.map((productId) => ({ productId, quantity: 1 }))),
        catalog.products,
        catalog.visualization.available,
      )
    : null;
  const selectedNames = productIds.map(
    (id) => catalog?.products.find((product) => product.id === id)?.name,
  );
  const ready = Boolean(catalog && !error && !problem && handoff.url);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={(event) => {
        // Strict Mode closes then reopens the dialog when replaying the effect.
        // Its queued close event must not dismiss the newly opened dialog.
        if (!event.currentTarget.open) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className={styles.content}>
        <form method="dialog" className={styles.close}>
          <button className="btn btn-ghost btn-square" aria-label="Fermer le QR code">
            <X size={22} aria-hidden="true" />
          </button>
        </form>
        <Smartphone size={28} aria-hidden="true" />
        <h2 id={titleId}>Continuez sur votre téléphone.</h2>
        <p id={descriptionId}>
          Scannez ce code avec l’appareil photo de votre téléphone. Votre sélection
          s’ouvrira directement, prête à être placée chez vous.
        </p>
        {error ? (
          <div role="status">
            <p>{error}</p>
            <button className="btn" onClick={retry}>Réessayer</button>
          </div>
        ) : !catalog ? (
          <p role="status">Vérification de votre sélection…</p>
        ) : problem || handoff.problem === "invalid-selection" ? (
          <p role="status">
            {problem ?? "Choisissez de un à trois articles dans la boutique."}
          </p>
        ) : (
          <>
            <p className={styles.selection}>{selectedNames.join(" · ")}</p>
            {ready && handoff.url && (
              <div className={styles.qr}>
                <QRCodeSVG
                  value={handoff.url}
                  size={232}
                  level="M"
                  marginSize={4}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  title="QR code pour ouvrir votre sélection sur téléphone"
                  role="img"
                />
              </div>
            )}
            {local && (
              <div className={styles.local}>
                <p>
                  Pour cet aperçu local, le téléphone et l’ordinateur doivent
                  être sur le même Wi-Fi. L’adresse « localhost » ne fonctionne
                  pas sur le téléphone.
                </p>
                <details open={!handoff.url}>
                  <summary>Adresse de l’aperçu sur le réseau</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      setMobileOrigin(originDraft.trim());
                      setCopyStatus("");
                    }}
                  >
                    <label htmlFor={originInputId}>Adresse accessible au téléphone</label>
                    <input
                      id={originInputId}
                      className="input w-full"
                      type="url"
                      value={originDraft}
                      onChange={(event) => setOriginDraft(event.target.value)}
                      placeholder="http://192.168.1.10:3105"
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                    <button className="btn" type="submit">Créer le QR code</button>
                  </form>
                  <p>L’aperçu doit être ouvert au réseau local à cette adresse.</p>
                </details>
              </div>
            )}
            {handoff.problem === "invalid-origin" && (
              <p role="alert">
                Utilisez l’adresse réseau privée de l’ordinateur, ou l’adresse
                HTTPS de la boutique, sans chemin ni identifiants.
              </p>
            )}
            {ready && handoff.url && (
              <>
                <button
                  className="btn w-full"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(handoff.url!);
                      setCopyStatus("Lien copié.");
                    } catch {
                      setCopyStatus("Copiez le lien affiché ci-dessous.");
                    }
                  }}
                >
                  <Copy size={17} aria-hidden="true" /> Copier le lien
                </button>
                <a className={`link ${styles.url}`} href={handoff.url}>
                  {handoff.url}
                </a>
              </>
            )}
          </>
        )}
        <p role="status" aria-live="polite">{copyStatus}</p>
        <Link className={`link ${styles.desktop}`} href={visualizationHref(productIds)}>
          Continuer sur cet appareil
        </Link>
      </div>
    </dialog>
  );
}
