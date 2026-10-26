import * as Tesseract from "tesseract.js";
import type { CardDatabase, ScanOutcome } from "../types";
import {
  binarize,
  cropFraction,
  findTextLines,
  fitCanvas,
  grayscale,
  pad,
  type Rect,
  type TextLine,
} from "./image";
import { matchScan, type MatchResult } from "./match";
import { recognize } from "./ocr";
import { detectCardPresence } from "./presence";

/**
 * Printed bands on an already-cropped card, as fractions of that crop.
 *
 * The collector number shares its baseline with the nation/copyright line at
 * the very bottom of the card. These bands are a little taller than the glyphs
 * so they stay on target whether the caller passed the whole card (camera
 * guide) or the default upload crop, which trims the top 10%.
 *
 * The name sits in the dark strip above the bottom info line. On a 350 px
 * official image it is only ~50 px tall, which is why several overlapping
 * bands are tried for uploads.
 */
const NUMBER_BANDS: Rect[] = [
  { x: 0, y: 0.96, width: 1, height: 0.03 },
  { x: 0, y: 0.966, width: 1, height: 0.022 },
  { x: 0, y: 0.97, width: 1, height: 0.024 },
];
const NAME_BANDS: Rect[] = [
  { x: 0.03, y: 0.82, width: 0.94, height: 0.112 },
  { x: 0.04, y: 0.836, width: 0.92, height: 0.088 },
];

const NUMBER_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/- ";

/**
 * A tight box around one detected line of print, grown vertically so the glyphs
 * are never clipped. The detected run is only the dense middle of the line, so
 * a straight crop of it would lose ascenders and descenders.
 */
function lineBand(line: TextLine, x: number, width: number): Rect {
  const raw = line.bottom - line.top;
  const height = Math.min(0.05, Math.max(raw * 2.2, 0.016));
  // A run taller than the cap merged several rows (or a bordered text box).
  // The collector number is always the bottom row, so read from the bottom up.
  const centre =
    raw * 2.2 > 0.05 ? line.bottom - height / 2 : (line.top + line.bottom) / 2;
  return {
    x,
    y: Math.max(0, Math.min(1 - height, centre - height / 2)),
    width,
    height,
  };
}

/** Never OCR a copy wider than this; more pixels only cost time. */
const MAX_WORK_WIDTH = 2400;
/** A match this confident is an exact or canonical print, not a fuzzy guess. */
const STRONG_CONFIDENCE = 0.9;

export type ScanProgress = (message: string, value: number) => void;

export interface ScanOptions {
  /** Extra passes for uploads or an explicit "scan now" action. */
  thorough?: boolean;
  /**
   * The whole photo a crop came from. Uploads can leave the card anywhere in
   * the frame, so a thorough scan scans this photo line by line before falling
   * back to bands placed on the crop itself.
   */
  fallbackSource?: HTMLCanvasElement;
  onProgress?: ScanProgress;
}

function normalize(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

/** True when the number band produced an exact or canonical read. */
function hasStrongNumber(result: MatchResult): boolean {
  return result.matches.some(
    (match) =>
      match.confidence >= STRONG_CONFIDENCE &&
      match.reasons.some((reason) => reason.startsWith("card number")),
  );
}

/**
 * OCR copy widths. Output width changes Tesseract's segmentation, so uploads
 * try a second one; the same strip can yield a clean read at 1800 px and
 * garbage at 2200 px.
 */
function workWidths(source: HTMLCanvasElement, thorough: boolean): number[] {
  const base = Math.max(1800, Math.min(2200, Math.round(source.width)));
  if (!thorough) return [base];
  return [base, Math.min(MAX_WORK_WIDTH, Math.round(base * 1.22))];
}

interface BandRead {
  text: string;
  confidence: number;
}

async function readBand(
  source: HTMLCanvasElement,
  band: Rect,
  width: number,
  options: {
    psm: Tesseract.PSM;
    whitelist?: string;
    binary?: boolean;
    /** Quiet border around the text. Tesseract is sensitive to this too. */
    padding?: [number, number];
    report: ScanProgress;
    from: number;
    to: number;
  },
): Promise<BandRead> {
  const { psm, whitelist, binary = false, report, from, to, padding = [24, 12] } = options;
  const [padX, padY] = padding;
  const cropped = cropFraction(source, band, width);
  const strip = binary
    ? pad(binarize(cropped), padX, padY)
    : pad(grayscale(cropped), padX, padY);
  const pass = await recognize(strip, {
    psm,
    whitelist,
    onProgress: (message, value) => report(message, from + (value / 100) * (to - from)),
  });
  return { text: normalize(pass.text), confidence: pass.confidence };
}

/** Never OCR more lines than this; the number is usually in the bottom few. */
const MAX_CANDIDATE_LINES = 8;

/**
 * Two ways of cropping a detected line. The number is printed at the left of
 * the card, so the narrow strip avoids the copyright text on the right; a
 * full-width strip sometimes segments better on high-resolution photos, so
 * both are tried before moving up to the next line.
 */
interface LineStrip {
  x: number;
  width: number;
  outWidth: number;
  binary: boolean;
}

const LINE_STRIPS: LineStrip[] = [
  { x: 0.02, width: 0.5, outWidth: 1500, binary: true },
  { x: 0, width: 1, outWidth: 2200, binary: true },
];

/** A fuzzy whole-photo reading, kept so a second pass can corroborate it. */
interface LineRead {
  line: TextLine;
  strip: LineStrip;
  result: MatchResult;
  confidence: number;
}

/**
 * Reads the collector number straight from the original photo, before the crop
 * bands run.
 *
 * Uploads put the card wherever the user left it: sometimes flush with the
 * bottom of the crop, sometimes with a table, floor, or playmat below it. Rather
 * than assuming a fixed distance from the bottom edge, this walks the photo's
 * detected lines of print from the bottom up and reads each one. Running this
 * first also matters for accuracy: Tesseract gets unreliable after a long run of
 * misses, and a strip it cannot read mid-scan reads cleanly on a fresh engine.
 *
 * A reading is only trusted when it is an exact print, or when a second pass
 * over the same line agrees on the card. A single fuzzy read of a small, blurry
 * number is easy to confuse with a neighbouring card.
 */
async function readWholePhotoNumber(
  db: CardDatabase,
  photo: HTMLCanvasElement,
  report: ScanProgress,
): Promise<{ result: MatchResult; text: string }> {
  const source =
    photo.width > MAX_WORK_WIDTH ? fitCanvas(photo, MAX_WORK_WIDTH) : photo;
  const lines = findTextLines(source).slice(0, MAX_CANDIDATE_LINES);
  const reads: string[] = [];
  const total = lines.length * LINE_STRIPS.length;
  let step = 0;
  let fuzzy: LineRead | null = null;

  for (const line of lines) {
    for (const strip of LINE_STRIPS) {
      const from = 2 + (step / total) * 7;
      const to = 2 + ((step + 1) / total) * 7;
      step++;
      report("Scanning the photo for the card number…", from);
      const read = await readBand(source, lineBand(line, strip.x, strip.width), strip.outWidth, {
        psm: Tesseract.PSM.SINGLE_LINE,
        whitelist: NUMBER_WHITELIST,
        binary: strip.binary,
        padding: [20, 10],
        report,
        from,
        to,
      });
      if (!read.text) continue;
      reads.push(read.text);

      const matched = matchScan(db, { numberText: read.text });
      const best = matched.matches[0];
      if (!best) continue;

      // An exact or canonical print needs no second opinion.
      if (best.confidence >= STRONG_CONFIDENCE) {
        return { result: matched, text: reads.join("\n") };
      }
      if (!fuzzy || best.confidence > fuzzy.confidence) {
        fuzzy = { line, strip, result: matched, confidence: best.confidence };
      }
    }
  }

  if (fuzzy) {
    // Re-read the same line with the other crop and a grayscale copy: only an
    // agreeing second pass is trusted.
    report("Double-checking the card number…", 9);
    const alt = LINE_STRIPS[fuzzy.strip === LINE_STRIPS[0] ? 1 : 0];
    const read = await readBand(
      source,
      lineBand(fuzzy.line, alt.x, alt.width),
      Math.min(MAX_WORK_WIDTH, Math.round(alt.outWidth * 1.1)),
      {
        psm: Tesseract.PSM.SINGLE_LINE,
        whitelist: NUMBER_WHITELIST,
        padding: [20, 10],
        report,
        from: 9,
        to: 10,
      },
    );
    if (read.text) {
      reads.push(read.text);
      const best = matchScan(db, { numberText: read.text }).matches[0];
      if (best && best.card.numberKey === fuzzy.result.matches[0].card.numberKey) {
        return { result: fuzzy.result, text: reads.join("\n") };
      }
    }
  }

  return { result: { matches: [], readNumber: null, readName: null }, text: reads.join("\n") };
}

/**
 * Checks that the frame actually contains a card, reads the two printed
 * identifiers (collector number and card name), matches them against the local
 * database, and adds extra passes only when the reading was not good enough.
 * Nothing is invented: an empty frame short-circuits with no matches, and if
 * neither band can be read the caller gets an empty match list.
 */
export async function scanCanvas(
  db: CardDatabase,
  source: HTMLCanvasElement,
  options: ScanOptions = {},
): Promise<ScanOutcome> {
  const started = performance.now();
  const { thorough = false, onProgress, fallbackSource } = options;
  const report: ScanProgress = (message, value) => onProgress?.(message, value);

  report("Checking the frame…", 2);
  const preview = fitCanvas(source, 1100);
  const presence = detectCardPresence(preview);

  if (!presence.present) {
    report("No card detected.", 100);
    return {
      matches: [],
      readNumber: null,
      readName: null,
      numberText: "",
      nameText: "",
      fullText: "",
      durationMs: Math.round(performance.now() - started),
      deepScan: false,
      cardDetected: false,
      presence,
    };
  }

  // OCR the native crop, not the phone-sized presence copy: the collector
  // number is only ~5 px tall on an official 350 px image and is destroyed by
  // an extra downscale plus upscale.
  const native = source.width > MAX_WORK_WIDTH ? fitCanvas(source, MAX_WORK_WIDTH) : source;
  const widths = workWidths(native, thorough);
  const numberBands = thorough ? NUMBER_BANDS : [NUMBER_BANDS[1]];

  const numberTexts: string[] = [];
  let photoText = "";
  let deepScan = thorough;

  // Uploads put the card wherever the crop left it, so phone photos get a
  // whole-photo line sweep first — while the engine is fresh. Small uploads are
  // usually card-only images (official renders, tight screenshots) where the
  // crop's own bands are exact, so try those first and only sweep if they miss.
  const smallUpload = Boolean(fallbackSource && fallbackSource.width < 1000);
  const sweepFirst = thorough && Boolean(fallbackSource) && !smallUpload;

  let result: MatchResult = { matches: [], readNumber: null, readName: null };
  if (sweepFirst && fallbackSource) {
    const wide = await readWholePhotoNumber(db, fallbackSource, report);
    result = wide.result;
    photoText = wide.text;
  }

  if (result.matches.length === 0) {
    let passIndex = 0;
    const numberPasses = numberBands.length * widths.length;

    for (const band of numberBands) {
      for (const width of widths) {
        const from = 10 + (passIndex / numberPasses) * 40;
        const to = 10 + ((passIndex + 1) / numberPasses) * 40;
        report("Reading card number…", from);
        const read = await readBand(native, band, width, {
          psm: Tesseract.PSM.SINGLE_LINE,
          whitelist: NUMBER_WHITELIST,
          report,
          from,
          to,
        });
        if (read.text) numberTexts.push(read.text);
        passIndex++;
      }
    }

    result = matchScan(db, { numberText: numberTexts.join("\n") });

    // A settled camera frame only gets the single central band above. If that
    // did not land a strong read, spend one more pass before giving up on the
    // auto-scan tick.
    if (!thorough && !hasStrongNumber(result)) {
      deepScan = true;
      const read = await readBand(native, NUMBER_BANDS[0], widths[0], {
        psm: Tesseract.PSM.SINGLE_LINE,
        whitelist: NUMBER_WHITELIST,
        report,
        from: 52,
        to: 60,
      });
      if (read.text) numberTexts.push(read.text);
      result = matchScan(db, { numberText: numberTexts.join("\n") });
    }
  }

  // A small upload whose crop bands did not read cleanly still gets the
  // photo-wide sweep, in case the card is not flush with the crop's bottom.
  if (!sweepFirst && thorough && fallbackSource && !hasStrongNumber(result)) {
    const wide = await readWholePhotoNumber(db, fallbackSource, report);
    if (wide.result.matches.length > 0) result = wide.result;
    photoText = wide.text;
  }

  const cropNumberText = numberTexts.join("\n");
  /** Both passes, for the scan-details panel. */
  const numberText = [photoText, cropNumberText].filter(Boolean).join("\n");
  let nameText = "";

  // The number is the reliable identifier. Only fall back to the name bar when
  // it produced no match at all, which keeps uploads fast and avoids showing a
  // fuzzy name guess beside a number read.
  if (result.matches.length === 0) {
    const nameBands = thorough ? NAME_BANDS : [NAME_BANDS[0]];
    const nameWidths = thorough ? widths : [widths[0]];
    const nameTexts: string[] = [];
    const namePasses = nameBands.length * nameWidths.length;
    let namePass = 0;

    for (const band of nameBands) {
      for (const width of nameWidths) {
        const from = 64 + (namePass / namePasses) * 26;
        const to = 64 + ((namePass + 1) / namePasses) * 26;
        report("Reading card name…", from);
        const read = await readBand(native, band, width, {
          psm: Tesseract.PSM.SINGLE_LINE,
          report,
          from,
          to,
        });
        if (read.text) nameTexts.push(read.text);
        namePass++;
      }
    }

    nameText = nameTexts.join("\n");
    result = matchScan(db, { numberText: cropNumberText, nameText });
  }

  // OCR is very sensitive to band placement. Uploads get one last attempt with
  // a hard black/white copy before reporting "no match".
  if (thorough && result.matches.length === 0) {
    report("Taking one last look…", 94);
    const read = await readBand(native, NUMBER_BANDS[1], widths[0], {
      psm: Tesseract.PSM.SINGLE_LINE,
      whitelist: NUMBER_WHITELIST,
      binary: true,
      report,
      from: 94,
      to: 99,
    });
    if (read.text) {
      result = matchScan(db, {
        numberText: `${cropNumberText}\n${read.text}`,
        nameText,
      });
    }
  }

  report("Matching card…", 100);

  return {
    matches: result.matches,
    readNumber: result.readNumber,
    readName: result.readName,
    numberText,
    nameText,
    fullText: "",
    durationMs: Math.round(performance.now() - started),
    deepScan,
    cardDetected: true,
    presence,
  };
}
