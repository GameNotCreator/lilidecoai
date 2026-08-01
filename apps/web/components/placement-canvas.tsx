"use client";

import { useEffect, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Stage, Transformer } from "react-konva";
import type Konva from "konva";
import useImage from "use-image";

export interface PlacementState {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export function PlacementCanvas({
  sceneUrl,
  productUrl,
  value,
  onChange,
}: {
  sceneUrl: string;
  productUrl: string;
  value: PlacementState;
  onChange: (placement: PlacementState) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const productRef = useRef<Konva.Image>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [availableWidth, setAvailableWidth] = useState(640);
  const [scene] = useImage(sceneUrl, "anonymous");
  const [product] = useImage(productUrl, "anonymous");

  useEffect(() => {
    const node = wrapper.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(Math.min(760, entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (productRef.current && transformerRef.current) {
      transformerRef.current.nodes([productRef.current]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [product, availableWidth]);

  const sceneRatio = scene ? scene.height / scene.width : 0.68;
  const stageWidth = Math.max(280, availableWidth);
  const stageHeight = stageWidth * sceneRatio;
  const productRatio = product ? product.height / product.width : 1.3;
  const productWidth = stageWidth * value.scale;
  const productHeight = productWidth * productRatio;

  return (
    <div className="placement-canvas" ref={wrapper}>
      <Stage width={stageWidth} height={stageHeight}>
        <Layer>
          <KonvaImage
            image={scene}
            width={stageWidth}
            height={stageHeight}
            listening={false}
          />
          <KonvaImage
            ref={productRef}
            image={product}
            x={value.x * stageWidth - productWidth / 2}
            y={value.y * stageHeight - productHeight}
            width={productWidth}
            height={productHeight}
            rotation={value.rotation}
            draggable
            shadowColor="black"
            shadowBlur={10}
            shadowOpacity={0.18}
            shadowOffset={{ x: 5, y: 8 }}
            onDragEnd={(event) => {
              const node = event.target;
              onChange({
                ...value,
                x: (node.x() + productWidth / 2) / stageWidth,
                y: (node.y() + productHeight) / stageHeight,
              });
            }}
            onTransformEnd={() => {
              const node = productRef.current;
              if (!node) return;
              const nextWidth = Math.max(32, node.width() * node.scaleX());
              node.scaleX(1);
              node.scaleY(1);
              onChange({
                x: (node.x() + nextWidth / 2) / stageWidth,
                y: (node.y() + nextWidth * productRatio) / stageHeight,
                scale: Math.min(0.9, Math.max(0.04, nextWidth / stageWidth)),
                rotation: node.rotation(),
              });
            }}
          />
          <Transformer
            ref={transformerRef}
            rotateEnabled
            keepRatio
            flipEnabled={false}
            boundBoxFunc={(oldBox, newBox) =>
              newBox.width < 32 || newBox.width > stageWidth * 0.9
                ? oldBox
                : newBox
            }
            anchorFill="#fbfaf6"
            anchorStroke="#667052"
            borderStroke="#667052"
            anchorCornerRadius={8}
          />
        </Layer>
      </Stage>
    </div>
  );
}
