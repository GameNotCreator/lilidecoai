"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";

type Guide = "surface" | "corner" | "none";

export function StorefrontCamera({ onClose, onCapture, onChooseExisting, placementKind = "standing" }: {
  onClose: () => void;
  onCapture: (file: File) => void;
  onChooseExisting: () => void;
  placementKind?: "standing" | "flat" | "wall";
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(false);
  const [guide, setGuide] = useState<Guide>(() => placementKind === "wall" ? "corner" : "surface");
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(4 / 3);
  const [error, setError] = useState("");
  const stop = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };
  useEffect(() => {
    let active = true;
    mounted.current = true;
    dialog.current?.showModal();
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("unavailable");
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
        });
        if (!active) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream.current = acquired;
        if (video.current) { video.current.srcObject = acquired; await video.current.play(); }
      } catch {
        stop();
        if (active) setError("La caméra n’est pas accessible. Vous pouvez autoriser son accès dans votre navigateur ou choisir une photo dans votre galerie.");
      }
    };
    // Defer acquisition one task so React's development effect replay does not
    // open two camera requests; closing before acquisition also cancels it.
    const startup = setTimeout(() => void start(), 0);
    return () => { clearTimeout(startup); active = false; mounted.current = false; stop(); };
  }, []);

  async function capture() {
    const player = video.current;
    if (!ready || capturing || !player?.videoWidth || !player.videoHeight) return;
    setCapturing(true);
    setError("");
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 2048 / Math.max(player.videoWidth, player.videoHeight));
      canvas.width = Math.round(player.videoWidth * scale);
      canvas.height = Math.round(player.videoHeight * scale);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("capture unavailable");
      // The guide is an HTML overlay; only the original camera frame is uploaded.
      context.drawImage(player, 0, 0, canvas.width, canvas.height);
      const photo = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) =>
        blob ? resolve(blob) : reject(new Error("capture unavailable")), "image/jpeg", 0.9));
      if (!mounted.current) return;
      stop();
      onCapture(new File([photo], "mon-interieur.jpg", { type: "image/jpeg", lastModified: Date.now() }));
    } catch {
      if (!mounted.current) return;
      setError("La photo n’a pas pu être prise. Réessayez ou choisissez une image dans votre galerie.");
      setCapturing(false);
    }
  }

  return <dialog ref={dialog} className="modal store-camera-modal" aria-labelledby="store-camera-title"
    onCancel={() => { stop(); onClose(); }} onClose={() => { stop(); onClose(); }}>
    <div className="modal-box w-full max-w-3xl">
      <div className="store-camera-heading flex items-start justify-between gap-3 mb-3">
        <div><h2 id="store-camera-title" className="text-xl! leading-tight!">Cadrez votre intérieur.</h2>
          <p className="text-sm text-base-content/70 mt-2">{placementKind === "wall"
            ? "Gardez les bords du mur visibles. Vous repérerez ensuite son plan avec quatre coins."
            : placementKind === "flat" ? "Gardez un rectangle du sol visible. Quatre coins guideront la perspective du produit."
              : "Gardez le support visible. La boîte et la taille du produit seront ajustables sur la photo."}</p></div>
        <button type="button" className="btn btn-ghost btn-square min-h-11 shrink-0" aria-label="Fermer la caméra" onClick={() => { stop(); onClose(); }}><X size={20} aria-hidden="true" /></button>
      </div>
      <div className="store-camera-view" style={{ aspectRatio, width: `min(100%, ${aspectRatio * 50}dvh)` }}>
        <video ref={video} muted playsInline autoPlay aria-label="Aperçu de la caméra" onLoadedData={(event) => { setReady(true); setAspectRatio(event.currentTarget.videoWidth / event.currentTarget.videoHeight); }} onCanPlay={() => setReady(true)} />
        {guide !== "none" && <svg className="store-camera-guide" viewBox="0 0 100 75" preserveAspectRatio="none" aria-hidden="true">
          {guide === "corner" ? <><path d="M50 8V49M50 49L12 65M50 49L88 65" /><path className="store-camera-guide-dashed" d="M12 10V65M88 10V65" /></>
            : <><path d="M12 45H88M12 45V65M88 45V65" /><path className="store-camera-guide-dashed" d="M12 65H88" /></>}
        </svg>}
        {!ready && !error && <p className="store-camera-wait" role="status">Ouverture de la caméra…</p>}
      </div>
      <div className="flex flex-wrap gap-2 mt-4" role="group" aria-label="Guide de cadrage facultatif">
        {([["surface", "Sol ou table"], ["corner", "Angle de mur"], ["none", "Sans guide"]] as const).map(([value, label]) =>
          <button type="button" className="btn min-h-11" key={value} aria-pressed={guide === value} onClick={() => setGuide(value)}>{label}</button>)}
      </div>
      <p className="text-sm mt-3 text-base-content/70">{guide === "corner" ? "Alignez l’angle du mur avec la ligne centrale, en gardant le support visible."
        : guide === "surface" ? "Placez le bord du sol ou du meuble près de la ligne. Gardez le futur emplacement dans le cadre." : "Cadrez librement le futur emplacement."}</p>
      {error && <p className="text-sm mt-3" role="alert">{error}</p>}
      <div className="modal-action flex-wrap">
        <button type="button" className="btn min-h-11" onClick={() => { stop(); onChooseExisting(); }}><ImagePlus size={18} aria-hidden="true" />Choisir dans la galerie</button>
        <button type="button" className="btn min-h-11" disabled={!ready || capturing || !!error} onClick={() => void capture()}><Camera size={18} aria-hidden="true" />{capturing ? "Préparation…" : "Utiliser cette photo"}</button>
      </div>
    </div>
    <form method="dialog" className="modal-backdrop"><button aria-label="Fermer la caméra et revenir à la photo">Fermer</button></form>
  </dialog>;
}
