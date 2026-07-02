// Client-side image downscaling. Keeps uploads small + fast and lands a clean
// JPEG the vision model reads reliably — no object storage needed server-side.

function drawToJpeg(img: HTMLImageElement, maxDim: number, quality: number): string {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

function loadImage(file: File): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image")); };
    img.src = url;
  });
}

/** A single downscaled (~1024px) JPEG data URL. */
export async function fileToDataUrl(file: File, maxDim = 1024, quality = 0.82): Promise<string> {
  const { img, revoke } = await loadImage(file);
  try { return drawToJpeg(img, maxDim, quality); } finally { revoke(); }
}

/** A full (~1024px) image for the lightbox plus a small (~400px) thumb for the
 *  grid — one decode, two encodes. */
export async function fileToFullAndThumb(file: File): Promise<{ full: string; thumb: string }> {
  const { img, revoke } = await loadImage(file);
  try {
    return { full: drawToJpeg(img, 1024, 0.82), thumb: drawToJpeg(img, 400, 0.7) };
  } finally { revoke(); }
}
