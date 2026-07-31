const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const MAX_SOURCE_IMAGE_BYTES = 20_000_000;
export const TARGET_UPLOAD_IMAGE_BYTES = 3_500_000;

const MAX_IMAGE_DIMENSION = 2048;
const MIN_IMAGE_DIMENSION = 640;

export async function prepareImageForUpload(file: File): Promise<File> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Format accepté : JPEG, PNG ou WebP");
  }
  if (file.size === 0) {
    throw new Error("Le fichier sélectionné est vide");
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(
      "Photo trop volumineuse : 20 Mo maximum avant optimisation",
    );
  }

  const source = await decodeImage(file);
  try {
    if (
      file.size <= TARGET_UPLOAD_IMAGE_BYTES &&
      Math.max(source.width, source.height) <= MAX_IMAGE_DIMENSION
    ) {
      return file;
    }

    let scale = Math.min(
      1,
      MAX_IMAGE_DIMENSION / Math.max(source.width, source.height),
    );
    let quality = 0.86;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Optimisation de l’image indisponible");
      context.drawImage(source.image, 0, 0, width, height);

      const blob = await canvasToBlob(canvas, quality);
      canvas.width = 1;
      canvas.height = 1;
      if (blob.size <= TARGET_UPLOAD_IMAGE_BYTES) {
        return new File([blob], webpName(file.name), {
          type: blob.type,
          lastModified: file.lastModified,
        });
      }

      if (quality > 0.62) {
        quality -= 0.08;
      } else {
        const largestSide = Math.max(width, height);
        if (largestSide <= MIN_IMAGE_DIMENSION) break;
        const reduction = Math.min(
          0.85,
          Math.sqrt(TARGET_UPLOAD_IMAGE_BYTES / blob.size) * 0.92,
        );
        scale *= Math.max(0.55, reduction);
        quality = 0.78;
      }
    }
  } finally {
    source.dispose();
  }

  throw new Error(
    "Cette photo n’a pas pu être optimisée. Essayez une autre image JPEG, PNG ou WebP.",
  );
}

interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // Safari can reject a bitmap that its regular image decoder accepts.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Cette image est illisible ou endommagée");
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Optimisation de l’image impossible"));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      quality,
    );
  });
}

function webpName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "photo";
  return `${base}.webp`;
}
