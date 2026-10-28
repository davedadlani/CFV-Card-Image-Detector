import { CARD_ASPECT, findTextLines, fitCanvas, get2d, type Rect } from "./image";

/**
 * Finds the card in an uploaded photo so the crop frame can be placed on it
 * automatically.
 *
 * A photo of a card has a strong block of print in the middle and comparatively
 * quiet background around it. Profiling edge energy row by row and column by
 * column makes that block stand out: the card's border, art and text produce
 * far more vertical/horizontal change than a desk, floor or playmat. Otsu
 * thresholding turns each profile into runs; the span of the structurally
 * strong runs gives the card's bounding box.
 *
 * The box is only a starting point. The frame is snapped to the card aspect
 * ratio and its bottom edge is pulled up to just below the lowest line of
 * print (the collector-number row). Anchoring on the print, not the physical
 * bottom edge, keeps the number inside the frame's bottom bands even when the
 * detected card outline is a little generous.
 */

export interface CardFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Run {
  start: number;
  end: number;
  mean: number;
}

/** Radius of the moving average applied to the edge profiles. */
const SMOOTH_FRACTION = 0.012;
/** Runs separated by at most this much are part of the same card. */
const MERGE_FRACTION = 0.02;
/** A card must cover at least this much of each image axis. */
const MIN_RUN_FRACTION = 0.18;
/** Print below this raw edge strength is too faint to call a card. */
const MIN_PROFILE_MEAN = 1.2;
/** Bounds are grown by this fraction of the shorter side. */
const PAD_FRACTION = 0.012;
/** The number row sits this far above the crop's bottom edge. */
const NUMBER_MARGIN = 0.015;

/** Analysis happens on a copy at most this wide; more pixels add no accuracy. */
const ANALYSIS_MAX = 480;

function luminance(frame: CardFrame): Float32Array {
  const { data, width, height } = frame;
  const luma = new Float32Array(width * height);
  for (let index = 0, pixel = 0; pixel < luma.length; index += 4, pixel++) {
    luma[pixel] =
      data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
  }
  return luma;
}

/**
 * Mean change per row (horizontal edges) and per column (vertical edges),
 * sampled away from the outermost 5% so the photo's own border is ignored.
 */
function profiles(
  luma: Float32Array,
  width: number,
  height: number,
): { rows: Float32Array; cols: Float32Array } {
  const rows = new Float32Array(height);
  const cols = new Float32Array(width);
  const x0 = Math.max(1, Math.floor(width * 0.05));
  const x1 = Math.min(width - 2, Math.ceil(width * 0.95));
  const y0 = Math.max(1, Math.floor(height * 0.05));
  const y1 = Math.min(height - 2, Math.ceil(height * 0.95));

  for (let y = 1; y < height - 1; y++) {
    let sum = 0;
    for (let x = x0; x <= x1; x++) {
      const above = luma[(y - 1) * width + x];
      const below = luma[(y + 1) * width + x];
      sum += Math.abs(below - above);
    }
    rows[y] = sum / Math.max(1, x1 - x0 + 1);
  }

  for (let x = 1; x < width - 1; x++) {
    let sum = 0;
    for (let y = y0; y <= y1; y++) {
      const left = luma[y * width + x - 1];
      const right = luma[y * width + x + 1];
      sum += Math.abs(right - left);
    }
    cols[x] = sum / Math.max(1, y1 - y0 + 1);
  }

  return {
    rows: smooth(rows, Math.max(1, Math.round(height * SMOOTH_FRACTION))),
    cols: smooth(cols, Math.max(1, Math.round(width * SMOOTH_FRACTION))),
  };
}

/** Windowed moving average, using prefix sums so long profiles stay cheap. */
function smooth(values: Float32Array, radius: number): Float32Array {
  if (radius < 1) return values;
  const prefix = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index++) prefix[index + 1] = prefix[index] + values[index];

  const out = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    out[index] = (prefix[end] - prefix[start]) / (end - start);
  }
  return out;
}

/** Otsu threshold for a one-dimensional profile, scaled back to its units. */
function otsu(values: Float32Array): number {
  let maximum = 0;
  for (const value of values) if (value > maximum) maximum = value;
  if (maximum < 1) return 0;

  const bins = 64;
  const histogram = new Uint32Array(bins);
  for (const value of values) {
    histogram[Math.min(bins - 1, Math.floor((value / maximum) * bins))]++;
  }

  const total = values.length;
  let sum = 0;
  for (let bin = 0; bin < bins; bin++) sum += bin * histogram[bin];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let bin = 0; bin < bins; bin++) {
    weightBackground += histogram[bin];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += bin * histogram[bin];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = bin;
    }
  }

  return ((best + 1) / bins) * maximum;
}

/**
 * Contiguous stretches of a profile above the threshold, with runs split by a
 * small gap joined back together.
 */
function runs(values: Float32Array, thresholdScale: number): Run[] {
  const reference = otsu(values);
  if (reference <= 0) return [];
  const threshold = Math.max(0.75, reference * thresholdScale);
  const gap = Math.max(2, Math.round(values.length * MERGE_FRACTION));

  const found: Array<[number, number]> = [];
  let start = -1;
  let last = -1;

  for (let index = 0; index < values.length; index++) {
    if (values[index] >= threshold) {
      if (start < 0) start = index;
      last = index;
    } else if (start >= 0 && index - last > gap) {
      found.push([start, last]);
      start = -1;
    }
  }
  if (start >= 0) found.push([start, last]);

  return found.map(([from, to]) => {
    let sum = 0;
    for (let index = from; index <= to; index++) sum += values[index];
    const length = to - from + 1;
    return { start: from, end: to + 1, mean: sum / length };
  });
}

/**
 * The span of all structurally strong runs. A card profile usually peaks at
 * its top/bottom borders and again in its text bands, with quieter art in
 * between; taking only the single highest-energy run would crop to one of
 * those bands. Runs within 40% of the strongest are treated as part of the
 * same object, which keeps small background edges out.
 */
function significantSpan(candidates: Run[]): Run | null {
  if (!candidates.length) return null;

  let strongestMean = 0;
  for (const candidate of candidates) {
    if (candidate.mean > strongestMean) strongestMean = candidate.mean;
  }

  const kept = candidates.filter(
    (candidate) => candidate.mean >= strongestMean * 0.6 && candidate.end - candidate.start >= 2,
  );
  if (!kept.length) return null;

  let start = kept[0].start;
  let end = kept[0].end;
  for (const candidate of kept) {
    if (candidate.start < start) start = candidate.start;
    if (candidate.end > end) end = candidate.end;
  }
  return { start, end, mean: strongestMean };
}

/**
 * Detects the card's bounding box in a frame, as fractions of the frame.
 *
 * Returns `null` when no card-shaped block of print is found. The caller should
 * keep its normal default crop in that case: finding nothing is better than
 * framing a patch of desk.
 */
export function detectCardBounds(frame: CardFrame): Rect | null {
  const { width, height } = frame;
  if (width < 64 || height < 64) return null;
  if (frame.data.length < width * height * 4) return null;

  const luma = luminance(frame);
  const { rows, cols } = profiles(luma, width, height);

  const minRow = Math.round(height * MIN_RUN_FRACTION);
  const minCol = Math.round(width * MIN_RUN_FRACTION);
  const pad = Math.max(1, Math.round(Math.min(width, height) * PAD_FRACTION));

  // A photo with a clearly separated card has one strong run on each axis.
  // When the card fills the frame the profiles are less bimodal, so retry with
  // a lower threshold before giving up.
  for (const scale of [1, 0.7, 0.5, 0.35]) {
    const row = significantSpan(runs(rows, scale));
    const col = significantSpan(runs(cols, scale));
    if (!row || !col) continue;
    if (row.end - row.start < minRow || col.end - col.start < minCol) continue;
    if (row.mean < MIN_PROFILE_MEAN || col.mean < MIN_PROFILE_MEAN) continue;

    const left = col.start / width;
    const top = row.start / height;
    const boxWidth = (col.end - col.start) / width;
    const boxHeight = (row.end - row.start) / height;
    const aspect = (boxWidth * width) / (boxHeight * height);
    // Allow perspective skew, but reject strips that cannot be a card.
    if (aspect < 0.4 || aspect > 1.15) continue;

    const x = Math.max(0, left - pad / width);
    const y = Math.max(0, top - pad / height);
    const paddedWidth = Math.min(1 - x, boxWidth + (pad * 2) / width);
    const paddedHeight = Math.min(1 - y, boxHeight + (pad * 2) / height);
    if (paddedWidth * paddedHeight < 0.05) continue;

    return { x, y, width: paddedWidth, height: paddedHeight };
  }

  return null;
}

/**
 * Turns a detected bounding box into the card-aspect crop the editor uses.
 * `bottom` may be pulled up to sit just below the lowest printed line.
 */
export function cardCropFromBounds(
  bounds: Rect,
  imageWidth: number,
  imageHeight: number,
  bottom?: number,
): Rect {
  const heightPerWidth = imageWidth / (CARD_ASPECT * imageHeight);
  let width = bounds.width;
  let height = width * heightPerWidth;
  if (height > bounds.height) {
    height = bounds.height;
    width = height / heightPerWidth;
  }

  const centreX = bounds.x + bounds.width / 2;
  let x = centreX - width / 2;
  let y = (bottom ?? bounds.y + bounds.height) - height;

  x = Math.max(0, Math.min(1 - width, x));
  y = Math.max(0, Math.min(1 - height, y));
  return { x, y, width, height };
}

/**
 * Finds the lowest printed line that belongs to the card. Uploads often keep
 * background below the card, so the physical bottom edge is not a reliable
 * anchor; the collector-number row is.
 */
function bottomTextAnchor(bounds: Rect, lines: Array<{ top: number; bottom: number }>): number | null {
  const cardBottom = bounds.y + bounds.height;
  const earliest = bounds.y + bounds.height * 0.45;
  for (const line of lines) {
    // `findTextLines` returns lines bottom-most first.
    if (line.bottom <= earliest) break;
    if (line.bottom > cardBottom + 0.01) continue;
    return Math.min(1, line.bottom + NUMBER_MARGIN);
  }
  return null;
}

/**
 * Reads an uploaded photo and returns a card-aspect crop placed on the card.
 *
 * `null` means the photo needs no automatic placement (the card already fills
 * the frame, so the default crop is right) or no card outline was found. The
 * caller should keep its default crop and let the user align manually.
 */
export function findCardCrop(source: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement): Rect | null {
  const work = fitCanvas(source, ANALYSIS_MAX);
  const context = get2d(work);
  const frame: CardFrame = {
    data: context.getImageData(0, 0, work.width, work.height).data,
    width: work.width,
    height: work.height,
  };

  const bounds = detectCardBounds(frame);
  if (!bounds) return null;

  // A card that already fills the photo needs no alignment. Official card
  // images and tight crops rely on the default frame, whose bottom edge is the
  // true card edge; pulling it up to a detected text line would clip the
  // collector number that sits at the very bottom of the print.
  // Still allow alignment on live scans if the card is very close to filling
  // but not perfectly tight - only skip for nearly full frame on uploads.
  if (bounds.width >= 0.95 && bounds.height >= 0.95) return null;

  const lines = findTextLines(source);
  const anchor = bottomTextAnchor(bounds, lines);
  return cardCropFromBounds(bounds, work.width, work.height, anchor ?? undefined);
}
