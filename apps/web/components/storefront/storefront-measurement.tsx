"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  browserMeasurementChoice,
  clearMeasurementVisit,
  flushAudienceEvents,
  measurementChoiceChange,
  recordAudienceEvent,
  setBrowserMeasurementChoice,
} from "@/lib/storefront-measurement-client";
import {
  recordMetaPixelEvent,
  revokeMetaPixel,
} from "@/lib/storefront-meta-pixel";
import type {
  MeasurementChoice,
  MeasurementEvent,
} from "@/lib/storefront-measurement";

export type MeasurementOptions = { analytics: boolean; pixelId: string | null };
type Track = (event: MeasurementEvent, leadId?: string) => void;
const MeasurementContext = createContext<Track>(() => {});

function subscribe(callback: () => void) {
  window.addEventListener(measurementChoiceChange, callback);
  window.addEventListener("focus", callback);
  return () => {
    window.removeEventListener(measurementChoiceChange, callback);
    window.removeEventListener("focus", callback);
  };
}

function useMeasurementChoice() {
  return useSyncExternalStore<MeasurementChoice | null | "pending">(
    subscribe,
    browserMeasurementChoice,
    () => "pending",
  );
}

export function StorefrontMeasurementProvider({
  analytics,
  pixelId,
  children,
}: MeasurementOptions & { children: ReactNode }) {
  if (!analytics && !pixelId) return children;
  return (
    <ActiveMeasurementProvider analytics={analytics} pixelId={pixelId}>
      {children}
    </ActiveMeasurementProvider>
  );
}

function ActiveMeasurementProvider({
  analytics,
  pixelId,
  children,
}: MeasurementOptions & { children: ReactNode }) {
  const choice = useMeasurementChoice();
  const measureAudience = analytics && choice?.[0] === "1";
  const measureAds = Boolean(pixelId) && choice?.[1] === "1";

  useEffect(() => {
    if (!measureAds) revokeMetaPixel();
  }, [measureAds]);

  useEffect(() => {
    if (!measureAudience) {
      if (!analytics || browserMeasurementChoice()?.[0] !== "1")
        clearMeasurementVisit();
      return;
    }
    function hidden() {
      if (document.visibilityState === "hidden") flushAudienceEvents("first");
    }
    function closing(event: PageTransitionEvent) {
      if (!event.persisted) flushAudienceEvents("exit");
    }
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", closing);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", closing);
    };
  }, [analytics, measureAudience]);

  const track = useCallback<Track>(
    (event, leadId) => {
      if (!measureAudience && !measureAds) return;
      const current = browserMeasurementChoice();
      if (measureAudience && current?.[0] === "1") {
        try {
          recordAudienceEvent(event);
        } catch {
          // Audience measurement must never interrupt shopping.
        }
      }
      if (measureAds && pixelId && current?.[1] === "1") {
        try {
          recordMetaPixelEvent(pixelId, event, leadId);
        } catch {
          // A script blocker or unavailable ad service must never interrupt shopping.
        }
      }
    },
    [measureAudience, measureAds, pixelId],
  );

  return (
    <MeasurementContext.Provider value={track}>
      {children}
    </MeasurementContext.Provider>
  );
}

export function useStorefrontMeasurement() {
  return useContext(MeasurementContext);
}

export function StorefrontCatalogueView({
  categoryId,
}: {
  categoryId?: string;
}) {
  const track = useStorefrontMeasurement();
  useEffect(() => {
    track(
      categoryId
        ? { name: "category_selected", categoryId }
        : { name: "catalogue_viewed" },
    );
  }, [track, categoryId]);
  return null;
}

export function StorefrontMeasurementPreferences(options: MeasurementOptions) {
  if (!options.analytics && !options.pixelId) return null;
  return <MeasurementPreferences {...options} />;
}

function MeasurementPreferences({ analytics, pixelId }: MeasurementOptions) {
  const path = usePathname();
  const choice = useMeasurementChoice();
  const [customize, setCustomize] = useState(false);
  const [audience, setAudience] = useState(false);
  const [advertising, setAdvertising] = useState(false);

  if (choice === "pending" || path === "/admin" || path.startsWith("/admin/"))
    return null;
  function choose(audience: boolean, advertising: boolean) {
    const consent =
      `${audience ? 1 : 0}${advertising ? 1 : 0}` as MeasurementChoice;
    if (!advertising) revokeMetaPixel();
    setBrowserMeasurementChoice(consent);
    setCustomize(false);
  }

  function openPreferences() {
    setAudience(analytics && choice?.[0] === "1");
    setAdvertising(Boolean(pixelId) && choice?.[1] === "1");
    setCustomize(true);
  }

  return (
    <>
      <button
        type="button"
        className="store-privacy-link"
        onClick={openPreferences}
      >
        Préférences de confidentialité
      </button>
      {(choice === null || customize) && (
        <aside
          className="store-measurement-panel"
          aria-labelledby="store-measurement-heading"
        >
          <h2 id="store-measurement-heading">
            Vos préférences de confidentialité
          </h2>
          <p>
            {analytics && pixelId
              ? "Vous pouvez autoriser la mesure de fréquentation et le suivi des publicités Meta séparément."
              : analytics
                ? "Vous pouvez nous aider à comprendre comment la boutique est visitée."
                : "Vous pouvez autoriser la mesure des publicités ByLiliDeco sur Facebook et Instagram."}
          </p>
          {customize && (
            <div className="store-measurement-switches">
              {analytics && (
                <label>
                  <input
                    type="checkbox"
                    checked={audience}
                    onChange={(event) => setAudience(event.target.checked)}
                  />{" "}
                  Mesure de fréquentation
                </label>
              )}
              {pixelId && (
                <label>
                  <input
                    type="checkbox"
                    checked={advertising}
                    onChange={(event) => setAdvertising(event.target.checked)}
                  />{" "}
                  Mesure publicitaire Meta
                </label>
              )}
            </div>
          )}
          <div className="store-measurement-actions">
            <button
              type="button"
              className="store-button secondary"
              onClick={() => choose(false, false)}
            >
              Tout refuser
            </button>
            <button
              type="button"
              className="store-button secondary"
              onClick={() =>
                customize
                  ? choose(audience, advertising)
                  : choose(analytics, Boolean(pixelId))
              }
            >
              {customize ? "Enregistrer mes choix" : "Tout accepter"}
            </button>
          </div>
          <div className="store-measurement-links">
            {customize ? (
              <button type="button" onClick={() => setCustomize(false)}>
                Annuler
              </button>
            ) : (
              <button type="button" onClick={openPreferences}>
                Personnaliser
              </button>
            )}
            <Link href="/privacy">Politique de confidentialité</Link>
          </div>
        </aside>
      )}
    </>
  );
}
