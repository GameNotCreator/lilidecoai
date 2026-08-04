"use client";

import {
  Check,
  Eraser,
  LoaderCircle,
  Paintbrush,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function MaskEditor({
  imageUrl,
  maskUrl,
  busy,
  confirmed,
  onConfirm,
  onReset,
}: {
  imageUrl: string;
  maskUrl: string;
  busy: boolean;
  confirmed: boolean;
  onConfirm: (mask: Blob) => Promise<void>;
  onReset: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [tool, setTool] = useState<"add" | "remove">("add");
  const [brushSize, setBrushSize] = useState(44);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mask = new Image();
    mask.onload = () => {
      canvas.width = mask.naturalWidth;
      canvas.height = mask.naturalHeight;
      canvas.getContext("2d")?.drawImage(mask, 0, 0);
    };
    mask.src = maskUrl;
  }, [maskUrl]);

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || confirmed) return;
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * canvas.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * canvas.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const scaledBrush = brushSize * (canvas.width / Math.max(bounds.width, 1));
    context.save();
    context.globalCompositeOperation =
      tool === "remove" ? "destination-out" : "source-over";
    context.fillStyle = "rgba(255, 46, 46, 0.62)";
    context.beginPath();
    context.arc(x, y, scaledBrush / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (confirmed) return;
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    draw(event);
  }

  function confirm() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) void onConfirm(blob);
    }, "image/png");
  }

  return (
    <div className="mask-editor" data-confirmed={confirmed}>
      <div className="mask-canvas-wrap">
        {/* The URL is returned by the authenticated local API. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="Objet à remplacer" />
        <canvas
          ref={canvasRef}
          aria-label="Corriger le masque de l’objet"
          onPointerDown={pointerDown}
          onPointerMove={(event) => drawingRef.current && draw(event)}
          onPointerUp={() => {
            drawingRef.current = false;
          }}
          onPointerCancel={() => {
            drawingRef.current = false;
          }}
        />
        {confirmed && (
          <span className="mask-confirmed-badge">
            <Check size={15} /> Masque confirmé
          </span>
        )}
      </div>
      {!confirmed && (
        <div className="mask-tools" aria-label="Outils de correction du masque">
          <button
            type="button"
            className={tool === "add" ? "active" : ""}
            onClick={() => setTool("add")}
          >
            <Paintbrush size={17} /> Ajouter
          </button>
          <button
            type="button"
            className={tool === "remove" ? "active" : ""}
            onClick={() => setTool("remove")}
          >
            <Eraser size={17} /> Retirer
          </button>
          <label>
            Taille
            <input
              aria-label="Taille de la brosse"
              type="range"
              min="20"
              max="100"
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
          </label>
          <button type="button" onClick={onReset}>
            <RotateCcw size={17} /> Recommencer
          </button>
          <button
            type="button"
            className="primary-mask-action"
            disabled={busy}
            onClick={confirm}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Check size={17} />
            )}
            Confirmer le masque
          </button>
        </div>
      )}
    </div>
  );
}
