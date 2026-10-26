/**
 * Canvas helpers shared by the camera scanner and the upload cropper.
 *
 * A Vanguard card is 63mm × 88mm, so every guide frame keeps that aspect
 * ratio. Crops are expressed either in source pixels (`Rect`) or as
 * fractions of the source (0–1), depending on the caller.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CARD_ASPECT = 63 / 88;

export type ImageSource = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function sourceSize(source: ImageSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth || 1, height: source.videoHeight || 1 };
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width || 1, height: source.naturalHeight || source.height || 1 };
  }
  return { width: source.width, height: source.height };
}

export function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
  // Tiny card-number text needs the best scaling the browser can offer.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

/** Paints `source` into a fresh canvas, never upscaling beyond `maxWidth`. */
export function fitCanvas(source: ImageSource, maxWidth: number, maxHeight = Infinity): HTMLCanvasElement {
  const { width, height } = sourceSize(source);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const canvas = createCanvas(width * scale, height * scale);
  get2d(canvas).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Draws a pixel rectangle from any source into a new canvas. */
export function cropCanvas(
  source: ImageSource,
  rect: Rect,
  outWidth?: number,
): HTMLCanvasElement {
  const { width, height } = sourceSize(source);
  const x = clamp(rect.x, 0, width - 1);
  const y = clamp(rect.y, 0, height - 1);
  const w = clamp(rect.width, 1, width - x);
  const h = clamp(rect.height, 1, height - y);
  const scale = outWidth ? outWidth / w : 1;
  const canvas = createCanvas(w * scale, h * scale);
  get2d(canvas).drawImage(source, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Source rectangle of a "cover"-fitted video that corresponds to the guide
 * frame drawn over it. Both rectangles are viewport coordinates from
 * `getBoundingClientRect()`.
 */
export function coverCropFromDisplay(
  video: HTMLVideoElement,
  videoBox: DOMRect,
  guideBox: DOMRect,
): Rect {
  const { width: vw, height: vh } = sourceSize(video);
  const scale = Math.max(videoBox.width / vw, videoBox.height / vh);
  const drawnWidth = vw * scale;
  const drawnHeight = vh * scale;
  const offsetX = (videoBox.width - drawnWidth) / 2;
  const offsetY = (videoBox.height - drawnHeight) / 2;

  const left = (guideBox.left - videoBox.left - offsetX) / scale;
  const top = (guideBox.top - videoBox.top - offsetY) / scale;
  const width = guideBox.width / scale;
  const height = guideBox.height / scale;

  const x = clamp(left, 0, vw - 1);
  const y = clamp(top, 0, vh - 1);
  return {
    x,
    y,
    width: clamp(width, 1, vw - x),
    height: clamp(height, 1, vh - y),
  };
}

/**
 * Tiny 16×16 luminance fingerprint of a frame, used by the camera loop to tell
 * whether the view has settled and whether an identical frame was already
 * scanned. Cheap enough to run before every auto-scan tick.
 */
export function frameFingerprint(source: ImageSource): Float32Array {
  const size = 16;
  const canvas = createCanvas(size, size);
  const ctx = get2d(canvas);
  ctx.drawImage(source, 0, 0, size, size);
  const image = ctx.getImageData(0, 0, size, size).data;
  const fingerprint = new Float32Array(size * size);
  for (let i = 0, p = 0; i < image.length; i += 4, p++) {
    fingerprint[p] = image[i] * 0.299 + image[i + 1] * 0.587 + image[i + 2] * 0.114;
  }
  return fingerprint;
}

/** Mean absolute luminance difference between two fingerprints (0–255). */
export function fingerprintDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/** Crops a fraction of a canvas (0–1 values) and scales it to `outWidth`. */
export function cropFraction(
  canvas: HTMLCanvasElement,
  fraction: Rect,
  outWidth: number,
): HTMLCanvasElement {
  return cropCanvas(
    canvas,
    {
      x: fraction.x * canvas.width,
      y: fraction.y * canvas.height,
      width: fraction.width * canvas.width,
      height: fraction.height * canvas.height,
    },
    outWidth,
  );
}

/** luminance-preserving grayscale with a percentile contrast stretch. */
export function grayscale(source: HTMLCanvasElement, stretch = true): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height);
  const ctx = get2d(canvas);
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const gray = new Uint8ClampedArray(canvas.width * canvas.height);

  let min = 255;
  let max = 0;
  const histogram = new Uint32Array(256);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma is close to how Tesseract converts colour input.
    const value = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[p] = value;
    histogram[value]++;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  let low = 0;
  let high = 255;
  if (stretch) {
    const total = gray.length;
    const lowCut = total * 0.015;
    const highCut = total * 0.985;
    let running = 0;
    for (let i = 0; i < 256; i++) {
      running += histogram[i];
      if (running >= lowCut) {
        low = i;
        break;
      }
    }
    running = 0;
    for (let i = 0; i < 256; i++) {
      running += histogram[i];
      if (running >= highCut) {
        high = i;
        break;
      }
    }
    if (high - low < 24) {
      low = Math.max(0, min);
      high = Math.min(255, max);
    }
  }

  const span = Math.max(1, high - low);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const value = clamp(((gray[p] - low) / span) * 255, 0, 255);
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Otsu threshold, useful when the print is flat and evenly lit. */
export function binarize(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height);
  const ctx = get2d(canvas);
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const histogram = new Uint32Array(256);
  const count = canvas.width * canvas.height;

  for (let i = 0; i < data.length; i += 4) {
    const value = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    histogram[value]++;
  }

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let i = 0; i < 256; i++) {
    weightBackground += histogram[i];
    if (weightBackground === 0) continue;
    const weightForeground = count - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }

  for (let i = 0; i < data.length; i += 4) {
    const value = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    const out = value > threshold ? 255 : 0;
    data[i] = out;
    data[i + 1] = out;
    data[i + 2] = out;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Adds a quiet border around text so Tesseract has room to segment it. */
export function pad(canvas: HTMLCanvasElement, x = 16, y = 8): HTMLCanvasElement {
  const out = createCanvas(canvas.width + x * 2, canvas.height + y * 2);
  const ctx = get2d(out);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, x, y);
  return out;
}

export type CropHandle = "move" | "nw" | "ne" | "sw" | "se";

/**
 * Moves or resizes a fractional crop while keeping the card aspect ratio.
 * `dx`/`dy` are fractions of the displayed image size.
 */
export function adjustCrop(
  crop: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): Rect {
  if (handle === "move") {
    return {
      ...crop,
      x: clamp(crop.x + dx, 0, 1 - crop.width),
      y: clamp(crop.y + dy, 0, 1 - crop.height),
    };
  }

  const heightPerWidth = imageWidth / (CARD_ASPECT * imageHeight);
  const minWidth = 0.12;

  if (handle === "se") {
    let width = Math.max(crop.width + dx, crop.width + dy / heightPerWidth);
    width = clamp(width, minWidth, Math.min(1 - crop.x, (1 - crop.y) / heightPerWidth));
    return { x: crop.x, y: crop.y, width, height: width * heightPerWidth };
  }

  if (handle === "nw") {
    const right = crop.x + crop.width;
    const bottom = crop.y + crop.height;
    let width = Math.max(crop.width - dx, crop.width - dy / heightPerWidth);
    width = clamp(width, minWidth, Math.min(right, bottom / heightPerWidth));
    return { x: right - width, y: bottom - width * heightPerWidth, width, height: width * heightPerWidth };
  }

  if (handle === "ne") {
    const bottom = crop.y + crop.height;
    let width = Math.max(crop.width + dx, crop.width - dy / heightPerWidth);
    width = clamp(width, minWidth, Math.min(1 - crop.x, bottom / heightPerWidth));
    return { x: crop.x, y: bottom - width * heightPerWidth, width, height: width * heightPerWidth };
  }

  // south-west
  const right = crop.x + crop.width;
  let width = Math.max(crop.width - dx, crop.width + dy / heightPerWidth);
  width = clamp(width, minWidth, Math.min(right, (1 - crop.y) / heightPerWidth));
  return { x: right - width, y: crop.y, width, height: width * heightPerWidth };
}

/**
 * Small helper used by the upload crop editor to build sensible defaults.
 *
 * The crop is anchored to the bottom of the image. The collector number is
 * printed in the bottom-left corner of the card, so a centred crop that removes
 * a few percent from both ends (the old behaviour) silently deleted the number
 * strip. The card name sits safely above it, so trimming the top instead is
 * harmless.
 */
export function defaultCrop(imageWidth: number, imageHeight: number): Rect {
  let height = 0.9;
  let width = (height * imageHeight * CARD_ASPECT) / imageWidth;
  if (width > 0.96) {
    width = 0.96;
    height = (width * imageWidth) / (CARD_ASPECT * imageHeight);
  }
  return {
    x: (1 - width) / 2,
    y: 1 - height,
    width,
    height,
  };
}

/**
 * Finds the bottom edge of the printed area in a photo, as a fraction of the
 * image height.
 *
 * Uploads commonly keep some table, floor, or playmat below the card, which
 * pushes the printed collector number above the bottom edge of the crop. The
 * number shares its baseline with the copyright line just above the card's
 * bottom border, so anchoring to that border makes the number band land in the
 * right place regardless of how much background the photo kept.
 *
 * Returns null when the lower part of the image has no clear edge (a blank or
 * uniform photo), so callers can fall back to fixed bands.
 */
export function contentBottom(source: HTMLCanvasElement, from = 0.35): number | null {
  const work = fitCanvas(source, 240);
  const width = work.width;
  const height = work.height;
  if (height < 24) return null;
  const data = get2d(work).getImageData(0, 0, width, height).data;
  const rows = new Float32Array(height);
  let peak = 0;

  for (let y = 1; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      const j = i + 4;
      const a = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const b = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
      sum += Math.abs(a - b);
    }
    rows[y] = sum / Math.max(1, width - 1);
    if (rows[y] > peak) peak = rows[y];
  }

  if (peak < 4) return null;
  const threshold = Math.max(3, peak * 0.16);
  const start = Math.floor(height * from);

  // Walk up from the bottom and accept the first row that has printed detail
  // both on itself and on the row above: a single noisy row is not an edge.
  for (let y = height - 2; y > start; y--) {
    if (rows[y] >= threshold && rows[y - 1] >= threshold) {
      return (y + 1) / height;
    }
  }
  return null;
}
