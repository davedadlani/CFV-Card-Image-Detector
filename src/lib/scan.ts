import * as Tesseract from "tesseract.js";
import type { CardDatabase, ScanOutcome } from "../types";
import { binarize, contentBottom, cropFraction, fitCanvas, grayscale, pad, type Rect } from "./image";
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
/** Used when the photo has no detectable printed area to anchor to. */
const FALLBACK_BOTTOM = 0.94;
const NAME_BANDS: Rect[] = [
  { x: 0.03, y: 0.82, width: 0.94, height: 0.112 },
  { x: 0.04, y: 0.836, width: 0.92, height: 0.088 },
];

const NUMBER_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/- ";

/** One whole-photo attempt: the strip, and how to prepare it. */
interface WideBand {
  rect: Rect;
  binary: boolean;
  width: number;
}

/**
 * Candidate strips for the collector-number line, derived from the bottom edge
 * of the printed area. The number shares its baseline with the copyright line
 * just above the card's bottom border, so the strips are centred that far up
 * from the detected edge. Narrow strips cut out noisy background beside the
 * card; full-width strips keep the whole printed line together.
 */
function wideNumberBands(bottom: number): WideBand[] {
  const strip = (
    offset: number,
    x: number,
    width: number,
    height: number,
    outWidth: number,
  ): WideBand => ({
    rect: { x, y: Math.max(0, bottom - offset - height / 2), width, height },
    binary: true,
    width: outWidth,
  });

  return [
    strip(0.05, 0.03, 0.35, 0.022, 1500),
    strip(0.05, 0, 1, 0.032, 1800),
    strip(0.058, 0.02, 0.5, 0.026, 1600),
    strip(0.058, 0, 1, 0.032, 1800),
    strip(0.042, 0.02, 0.5, 0.026, 1600),
    strip(0.062, 0.03, 0.35, 0.022, 1500),
    strip(0.038, 0, 1, 0.032, 1800),
  ];
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
   * The whole photo a crop came from. Uploads can leave background below the
   * card, which lifts the printed number above the crop's bottom edge; a
   * thorough scan falls back to this image when the crop reads nothing.
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

/**
 * Reads the collector number straight from the original photo, before the crop
 * bands run.
 *
 * The number sits a few percent above the bottom border of the card, and a
 * hand-drawn upload crop usually keeps that border near the bottom of the
 * photo even when it also keeps some table below it. Running this first also
 * matters for accuracy: Tesseract gets unreliable after a long run of misses,
 * and the strips it cannot read mid-scan read cleanly on a fresh engine.
 *
 * Each strip is matched on its own, and a reading is only trusted when two
 * independent strips agree or one is an exact print. A single fuzzy read of a
 * small, blurry number is easy to confuse with a neighbouring card.
 */
async function readWholePhotoNumber(
  db: CardDatabase,
  photo: HTMLCanvasElement,
  report: ScanProgress,
): Promise<{ result: MatchResult; text: string }> {
  const source =
    photo.width > MAX_WORK_WIDTH ? fitCanvas(photo, MAX_WORK_WIDTH) : photo;
  const bottom = contentBottom(source) ?? FALLBACK_BOTTOM;
  const bands = wideNumberBands(bottom);
  const votes = new Map<string, { result: MatchResult; count: number; exact: boolean }>();
  const reads: string[] = [];

  for (let index = 0; index < bands.length; index++) {
    const { rect, binary, width } = bands[index];
    const from = 2 + (index / bands.length) * 8;
    const to = 2 + ((index + 1) / bands.length) * 8;
    report("Reading the card number…", from);
    const read = await readBand(source, rect, width, {
      psm: Tesseract.PSM.SINGLE_LINE,
      whitelist: NUMBER_WHITELIST,
      binary,
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

    const exact = best.confidence >= STRONG_CONFIDENCE;
    let vote = votes.get(best.card.numberKey);
    if (!vote) {
      vote = { result: matched, count: 0, exact: false };
      votes.set(best.card.numberKey, vote);
    }
    vote.count += 1;
    vote.exact = vote.exact || exact;
    if (vote.exact || vote.count >= 2) {
      return { result: vote.result, text: reads.join("\n") };
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
  let wideText = "";
  let deepScan = thorough;

  // Uploads often keep background below the card, which pushes the printed
  // number away from the bottom edge of the crop. Read the number from the
  // whole photo first, while the engine is fresh.
  let result: MatchResult = { matches: [], readNumber: null, readName: null };
  if (thorough && fallbackSource) {
    const wide = await readWholePhotoNumber(db, fallbackSource, report);
    result = wide.result;
    wideText = wide.text;
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

  const cropNumberText = numberTexts.join("\n");
  /** Both passes, for the scan-details panel; matching only uses crop reads. */
  const numberText = [wideText, cropNumberText].filter(Boolean).join("\n");
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
