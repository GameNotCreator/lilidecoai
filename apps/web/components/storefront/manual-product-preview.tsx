"use client";

import { useEffect, useRef, useState } from "react";
import { manualPlacementTransform, type ManualPlacement } from "@lili/geometry";

/** A prepared alpha cutout warped with the same homography as the server montage. */
export function ManualProductPreview({ url, placement, name, onAspect }: {
  url: string; placement: ManualPlacement; name: string; onAspect: (ratio: number) => void;
}) {
  const layer = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = layer.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <span ref={layer} className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={url} alt={name} draggable={false} onLoad={event => {
      if (event.currentTarget.naturalWidth && event.currentTarget.naturalHeight)
        onAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight);
    }} style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1,
      maxWidth: "none", transformOrigin: "0 0", opacity: size.width ? 1 : 0,
      transform: size.width ? manualPlacementTransform(placement, size.width, size.height) : undefined }} />
  </span>;
}
