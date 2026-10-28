import type { PresenceMetrics, PresenceResult } from "../types";
import { createCanvas, get2d, type Rect } from "./image";

/**
 * Cheap "is there actually a card in this frame?" check.
 *
 * A real Japanese Vanguard card always has two dense print bands inside the
 * crop: the card name strip above the bottom info line and the collector
 * number in the bottom-left corner. A wall, desk, hand or empty room does not.
 * Measuring edge energy in those two bands (plus overall detail) is enough to
 * reject an empty frame before spending seconds on OCR, and it keeps the scan
 * result honest when the user is not pointing at a card.
 */

const NAME_BAND: Rect = { x: 0.03, y: 0.84, width: 0.94, height: 0.1 };
const NUMBER_BAND: Rect = { x: 0, y: 0.93, width: 0.44, height: 0.07 };

/** Analysis is done at this width; larger sizes only waste CPU. */
const ANALYSIS_WIDTH = 180;

/** Minimum local luminance step that counts as a printed/text edge. */
const EDGE_THRESHOLD = 30;

export interface FramePixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return values.length ? sum / values.length : 0;
}

/**
 * Pure pixel analysis: no DOM APIs, so it can be unit-tested with synthetic
 * frames. `data` is RGBA in the usual canvas byte order.
 */
export function analyzeFrame(pixels: FramePixels): PresenceMetrics {
  const { data, width, height } = pixels;
  const count = width * height;
  const luma = new Float32Array(count);
  const saturation = new Float32Array(count);

  for (let index = 0, offset = 0; index < count; index++, offset += 4) {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    luma[index] = r * 0.299 + g * 0.587 + b * 0.114;
    saturation[index] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  const brightness = mean(luma) / 255;
  const average = mean(luma);
  let variance = 0;
  for (let index = 0; index < count; index++) {
    const delta = luma[index] - average;
    variance += delta * delta;
  }
  const contrast = Math.sqrt(variance / count) / 255;

  const detailIn = (rect: Rect): number => {
    const x0 = Math.max(1, Math.floor(rect.x * width));
    const y0 = Math.max(1, Math.floor(rect.y * height));
    const x1 = Math.min(width - 2, Math.ceil((rect.x + rect.width) * width));
    const y1 = Math.min(height - 2, Math.ceil((rect.y + rect.height) * height));
    if (x1 <= x0 || y1 <= y0) return 0;

    let edges = 0;
    let total = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        const index = row + x;
        const gx = luma[index + 1] - luma[index - 1];
        const gy = luma[index + width] - luma[index - width];
        if (Math.abs(gx) + Math.abs(gy) >= EDGE_THRESHOLD) edges++;
        total++;
      }
    }
    return total ? edges / total : 0;
  };

  return {
    detail: detailIn({ x: 0.02, y: 0.02, width: 0.96, height: 0.96 }),
    nameDetail: detailIn(NAME_BAND),
    numberDetail: detailIn(NUMBER_BAND),
    saturation: mean(saturation) / 255,
    contrast,
    brightness,
  };
}

/**
 * Turns pixel metrics into a yes/no answer. The rule is intentionally
 * permissive about real cards (a dark, over-exposed or angled photo still
 * passes) and strict only about frames with essentially no print structure.
 */
export function evaluatePresence(metrics: PresenceMetrics): PresenceResult {
  const { detail, nameDetail, numberDetail, saturation, contrast, brightness } = metrics;

  const bandEvidence =
    clamp01(nameDetail / 0.05) * 0.6 + clamp01(numberDetail / 0.035) * 0.4;
  const frameEvidence = clamp01(detail / 0.055);
  const colorEvidence = clamp01(saturation / 0.18);
  const confidence = clamp01(
    bandEvidence * 0.55 + frameEvidence * 0.27 + colorEvidence * 0.18,
  );

  const tooDark = brightness < 0.03 || (brightness < 0.08 && contrast < 0.02);
  // Both bands should show print. If one band is weak (glare, angle, crop),
  // one strong band plus a detailed frame is still accepted.
  const bothBands = nameDetail >= 0.008 && numberDetail >= 0.004;
  const oneStrongBand =
    (nameDetail >= 0.02 && detail >= 0.025) ||
    (numberDetail >= 0.015 && detail >= 0.03) ||
    (detail >= 0.04 && (nameDetail >= 0.01 || numberDetail >= 0.008));

  const present = !tooDark && (bothBands || oneStrongBand || detail >= 0.05);

  return {
    present,
    confidence,
    reason: present ? "card" : tooDark ? "too-dark" : "empty",
    metrics,
  };
}

/** Downscales the crop, reads its pixels, and evaluates card presence. */
export function detectCardPresence(source: HTMLCanvasElement): PresenceResult {
  const scale = Math.min(1, ANALYSIS_WIDTH / source.width);
  const width = Math.max(24, Math.round(source.width * scale));
  const height = Math.max(24, Math.round(source.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = get2d(canvas);
  ctx.drawImage(source, 0, 0, width, height);
  return evaluatePresence(analyzeFrame(ctx.getImageData(0, 0, width, height)));
}
