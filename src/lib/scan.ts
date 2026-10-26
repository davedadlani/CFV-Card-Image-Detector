import * as Tesseract from "tesseract.js";
import type { CardDatabase, ScanOutcome } from "../types";
import { binarize, cropFraction, fitCanvas, grayscale, pad, type Rect } from "./image";
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

/** Never OCR a copy wider than this; more pixels only cost time. */
const MAX_WORK_WIDTH = 2400;

export type ScanProgress = (message: string, value: number) => void;

export interface ScanOptions {
  /** Extra passes for uploads or an explicit "scan now" action. */
  thorough?: boolean;
  onProgress?: ScanProgress;
}

function normalize(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

/** True when the number band produced an exact or canonical read. */
function hasStrongNumber(result: MatchResult): boolean {
  return result.matches.some(
    (match) =>
      match.confidence >= 0.9 &&
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
    report: ScanProgress;
    from: number;
    to: number;
  },
): Promise<BandRead> {
  const { psm, whitelist, binary = false, report, from, to } = options;
  const cropped = cropFraction(source, band, width);
  const strip = binary
    ? pad(binarize(cropped), 24, 12)
    : pad(grayscale(cropped), 24, 12);
  const pass = await recognize(strip, {
    psm,
    whitelist,
    onProgress: (message, value) => report(message, from + (value / 100) * (to - from)),
  });
  return { text: normalize(pass.text), confidence: pass.confidence };
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
  const { thorough = false, onProgress } = options;
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
  let passIndex = 0;
  const numberPasses = numberBands.length * widths.length;
  let deepScan = thorough;

  for (const band of numberBands) {
    for (const width of widths) {
      const from = 8 + (passIndex / numberPasses) * 44;
      const to = 8 + ((passIndex + 1) / numberPasses) * 44;
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

  // A settled camera frame only gets the single central band above. If that
  // did not land a strong read, spend one more pass before giving up on the
  // auto-scan tick.
  let result = matchScan(db, { numberText: numberTexts.join("\n") });
  if (!thorough && !hasStrongNumber(result)) {
    deepScan = true;
    const read = await readBand(native, NUMBER_BANDS[0], widths[0], {
      psm: Tesseract.PSM.SINGLE_LINE,
      whitelist: NUMBER_WHITELIST,
      report,
      from: 54,
      to: 62,
    });
    if (read.text) numberTexts.push(read.text);
    result = matchScan(db, { numberText: numberTexts.join("\n") });
  }

  const numberText = numberTexts.join("\n");
  let nameText = "";

  // The number is the reliable identifier. Only fall back to the name bar when
  // it did not produce a confident hit, which keeps uploads fast in the common
  // case and avoids showing a fuzzy name guess beside an exact number.
  if (!hasStrongNumber(result)) {
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
    result = matchScan(db, { numberText, nameText });
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
        numberText: `${numberText}\n${read.text}`,
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
