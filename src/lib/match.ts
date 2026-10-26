import type { Card, CardDatabase, ScanMatch } from "../types";
import { getNameFuse, normalizeSearch, stripParallelName } from "./database";

export interface ScanTexts {
  numberText?: string;
  nameText?: string;
  fullText?: string;
}

export interface MatchResult {
  matches: ScanMatch[];
  readNumber: string | null;
  readName: string | null;
}

const NUMBER_PATTERN =
  /([A-Z0-9][A-Z0-9-]{1,8})\s*[/\\|Il!]\s*([0-9OQ]{1,4})(?:\s*([A-Z]{0,3}))?/g;
const TOKEN_PATTERN = /[A-Z0-9][A-Z0-9/\\|\-]{3,14}/g;
/** Shorter tokens are also considered when re-joining a split number. */
const SPLIT_TOKEN_PATTERN = /[A-Z0-9][A-Z0-9/\\|\-]{0,14}/g;
/** A set prefix like "DZ-TBP02" or "DBT01": letters and at least one digit. */
const SET_PREFIX = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9-]{3,}$/;
/** The "/001" half of a number. OCR often reads 0 as O/Q and 1 as I/L. */
const SERIAL_TAIL = /^[0-9OQILZSBG]{2,4}[A-Z]{0,2}$/;
/** Trailing rarity/legal letters glued onto the number by OCR. */
const TRAILING_NOISE = /^(.*\d{2,})[A-Z]{1,3}$/;
const DIGITS = /\d/g;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** A name line must be at least this long before it is trusted at all. */
const MIN_NAME_CHARS = 4;
/** Fuse score above this is too different to call a read. */
const MAX_NAME_SCORE = 0.24;
/** The OCR line and the database name must be roughly the same size. */
const MIN_NAME_COVERAGE = 0.66;

export function normalizeKey(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Characters that OCR and small print routinely confuse. Both the read number
 * and the database keys are folded through this map so that "0Z-TBP02/001"
 * still equals "DZ-TBP02/001".
 */
const CONFUSABLE: Record<string, string> = {
  O: "0",
  Q: "0",
  D: "0",
  I: "1",
  L: "1",
  T: "1",
  Z: "2",
  S: "5",
  B: "8",
  G: "6",
};

export function canonicalNumber(value: string): string {
  return normalizeKey(value).replace(/[OQDILTZSBG]/g, (character) => CONFUSABLE[character] ?? character);
}

/** Classic Levenshtein distance with an early exit for very different strings. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return max + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/**
 * Pulls plausible card numbers out of OCR output. OCR frequently reads the
 * slash as "I", "l", "1", "|" or "\", so separators are kept loose. Both
 * "DZ-BT01/001" and "DZBT01001" styles are considered.
 */
export function extractNumberCandidates(text: string): string[] {
  const upper = text.normalize("NFKC").toUpperCase();
  const keys = new Set<string>();

  const add = (value: string) => {
    const key = normalizeKey(value);
    if (key.length < 4) return;
    const digits = key.match(DIGITS)?.length ?? 0;
    if (digits < 2) return;
    keys.add(key);
  };

  /** Adds a token plus the same token without OCR-glued trailing letters. */
  const addToken = (value: string) => {
    add(value);
    const trimmed = value.match(TRAILING_NOISE);
    if (trimmed) add(trimmed[1]);
  };

  for (const match of upper.matchAll(NUMBER_PATTERN)) {
    add(`${match[1]}${match[2]}${match[3] ?? ""}`);
    // Sometimes the suffix is not printed or not captured; try without it too.
    if (match[3]) add(`${match[1]}${match[2]}`);
  }

  for (const match of upper.matchAll(TOKEN_PATTERN)) {
    addToken(match[0]);
  }

  // Tiny print makes OCR drop the slash between the set prefix and the serial,
  // producing e.g. "OZ-TBPO2 OO1". Re-join adjacent token pairs when the second
  // token is a plausible serial. Both halves must look like print, not words.
  for (const line of upper.split(/\n+/)) {
    const tokens = [...line.matchAll(SPLIT_TOKEN_PATTERN)].map((match) => match[0]);
    for (let index = 0; index < tokens.length - 1; index++) {
      const prefix = tokens[index];
      const serial = tokens[index + 1];
      if (SET_PREFIX.test(prefix) && SERIAL_TAIL.test(serial) && /\d/.test(serial)) {
        addToken(`${prefix}${serial}`);
      }

      // OCR can also break the serial itself: "02-811 1/SR24" is
      // "DZ-BT11/SR24" with the set prefix misread as digits. Join a
      // digit-heavy prefix to a slash-bearing tail as a second candidate.
      const prefixDigits = prefix.match(DIGITS)?.length ?? 0;
      const serialDigits = serial.match(DIGITS)?.length ?? 0;
      if (
        prefix.length >= 4 &&
        prefixDigits >= 2 &&
        serialDigits >= 2 &&
        /[/\\|Il!]/.test(serial)
      ) {
        addToken(`${prefix}${serial}`);
      }
    }
  }

  return [...keys].sort((a, b) => {
    const aDigits = a.match(DIGITS)?.length ?? 0;
    const bDigits = b.match(DIGITS)?.length ?? 0;
    return bDigits - aDigits || b.length - a.length;
  });
}

function cleanOcrLine(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

interface CanonicalIndex {
  keys: string[];
  canonical: string[];
  byCanonical: Map<string, string[]>;
}

const canonicalCache = new WeakMap<CardDatabase, CanonicalIndex>();

function getCanonicalIndex(db: CardDatabase): CanonicalIndex {
  const cached = canonicalCache.get(db);
  if (cached) return cached;

  const index: CanonicalIndex = { keys: [], canonical: [], byCanonical: new Map() };
  for (const key of db.byNumberKey.keys()) {
    const folded = canonicalNumber(key);
    index.keys.push(key);
    index.canonical.push(folded);
    const bucket = index.byCanonical.get(folded);
    if (bucket) bucket.push(key);
    else index.byCanonical.set(folded, [key]);
  }
  canonicalCache.set(db, index);
  return index;
}

/** How much of the shorter string is contained in the longer one (0–1). */
function lengthCoverage(a: string, b: string): number {
  return Math.min(a.length, b.length) / Math.max(a.length, b.length);
}

interface BaseNameIndex {
  entries: Array<{ card: Card; base: string }>;
}

const baseNameCache = new WeakMap<CardDatabase, BaseNameIndex>();

/** Base names are normalised once per database, not once per OCR line. */
function getBaseNames(db: CardDatabase): BaseNameIndex {
  const cached = baseNameCache.get(db);
  if (cached) return cached;

  const entries: Array<{ card: Card; base: string }> = [];
  for (const card of db.cards) {
    const base = normalizeSearch(stripParallelName(card.name));
    if (base.length >= MIN_NAME_CHARS) entries.push({ card, base });
  }
  const index = { entries };
  baseNameCache.set(db, index);
  return index;
}

/**
 * Reads the two printed identifiers and matches them against the local
 * database. The rule is deliberately strict: a number or a name has to be
 * read well enough to be evidence. No match is better than a fabricated one.
 */
export function matchScan(db: CardDatabase, input: ScanTexts): MatchResult {
  const numberText = input.numberText ?? "";
  const index = getCanonicalIndex(db);
  const numberScores = new Map<number, { score: number; fuzzy: boolean }>();
  let readNumber: string | null = null;

  const addNumberCards = (key: string, score: number, fuzzy: boolean) => {
    const cards = db.byNumberKey.get(key);
    if (!cards) return;
    for (const card of cards) {
      const previous = numberScores.get(card.id);
      if (!previous || previous.score < score) {
        numberScores.set(card.id, { score, fuzzy });
      }
    }
  };

  const candidates = extractNumberCandidates(numberText);
  for (const candidate of candidates) {
    const exact = db.byNumberKey.get(candidate);
    if (exact) {
      addNumberCards(candidate, 0.985, false);
      readNumber ??= candidate;
      continue;
    }

    const folded = canonicalNumber(candidate);
    const canonicalHits = index.byCanonical.get(folded);
    if (canonicalHits) {
      // Folding loses information (D→0, Z→2, …), so several keys can collide.
      // Prefer the key whose *unfolded* print is closest to what OCR saw.
      const raw = normalizeKey(candidate);
      const ranked = [...canonicalHits].sort(
        (a, b) =>
          levenshtein(raw, normalizeKey(a)) - levenshtein(raw, normalizeKey(b)) ||
          a.length - b.length,
      );
      for (const key of ranked) addNumberCards(key, 0.9, true);
      readNumber ??= ranked[0];
      continue;
    }

    if (candidate.length < 5) continue;
    const maxDistance = 1;
    let bestDistance = maxDistance + 1;
    let bestKeys: string[] = [];

    for (let i = 0; i < index.keys.length; i++) {
      const keyFolded = index.canonical[i];
      if (Math.abs(keyFolded.length - folded.length) > maxDistance) continue;
      if (keyFolded[0] !== folded[0] && keyFolded[1] !== folded[1]) continue;
      const distance = levenshtein(folded, keyFolded, maxDistance);
      if (distance > maxDistance) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKeys = [index.keys[i]];
      } else if (distance === bestDistance && bestKeys.length < 8) {
        // Keep every key at the best distance: a single OCR mistake is often
        // genuinely ambiguous between neighbouring printings.
        bestKeys.push(index.keys[i]);
      }
    }

    if (bestKeys.length > 0) {
      for (const key of bestKeys) addNumberCards(key, 0.84, true);
      readNumber ??= bestKeys[0];
    }
  }

  const nameFuse = getNameFuse(db);
  const baseNames = getBaseNames(db);
  const nameScores = new Map<number, number>();
  const nameHits: Array<{ id: number; confidence: number }> = [];
  let readName: string | null = null;

  const lines = (input.nameText ?? "")
    .split(/\n+/)
    .map(cleanOcrLine)
    .filter((line) => line.length >= MIN_NAME_CHARS);

  for (const line of lines) {
    const normalizedLine = normalizeSearch(line);
    if (normalizedLine.length < MIN_NAME_CHARS) continue;

    const cjkCount = (normalizedLine.match(CJK) ?? []).length;
    const latinCount = (normalizedLine.match(/[a-z0-9]/g) ?? []).length;
    // Reject tiny noise tokens ("on", "ED", "22") before Fuse even sees them.
    if (cjkCount < 2 && latinCount < 4) continue;

    for (const hit of nameFuse.search(line, { limit: 6 })) {
      const score = hit.score ?? 1;
      if (score > MAX_NAME_SCORE) continue;

      const base = normalizeSearch(stripParallelName(hit.item.card.name));
      if (base.length < MIN_NAME_CHARS) continue;
      if (lengthCoverage(normalizedLine, base) < MIN_NAME_COVERAGE) continue;

      const confidence = Math.min(0.95, 0.55 + (1 - score) * 0.37);
      const previous = nameScores.get(hit.item.card.id) ?? 0;
      if (confidence > previous) {
        nameScores.set(hit.item.card.id, confidence);
        nameHits.push({ id: hit.item.card.id, confidence });
      }
      if (confidence >= 0.85 && (!readName || confidence > 0.9)) {
        readName = hit.item.card.name;
      }
    }

    // Exact substring evidence is stronger than fuzzy similarity, but only
    // when the OCR line is about the same size as the name. A long effect
    // sentence that happens to mention a card must not count as a read.
    for (const { card, base } of baseNames.entries) {
      if (!normalizedLine.includes(base)) continue;
      if (normalizedLine.length > base.length + 8) continue;
      if (lengthCoverage(normalizedLine, base) < 0.85) continue;

      const confidence = 0.93;
      if (confidence > (nameScores.get(card.id) ?? 0)) {
        nameScores.set(card.id, confidence);
        nameHits.push({ id: card.id, confidence });
      }
      readName ??= card.name;
    }
  }

  const merged = new Map<number, ScanMatch>();
  const ensure = (card: Card) => {
    let match = merged.get(card.id);
    if (!match) {
      match = { card, confidence: 0, reasons: [] };
      merged.set(card.id, match);
    }
    return match;
  };

  for (const [id, info] of numberScores) {
    const card = db.byId.get(id);
    if (!card) continue;
    const match = ensure(card);
    match.confidence = Math.max(match.confidence, info.score);
    match.reasons.push(info.fuzzy ? "card number (fuzzy)" : "card number");
  }

  for (const [id, score] of nameScores) {
    const card = db.byId.get(id);
    if (!card) continue;
    const match = ensure(card);
    if (score > match.confidence) match.confidence = score;
    match.reasons.push("card name");
  }

  const bestNumber = Math.max(0, ...[...numberScores.values()].map((entry) => entry.score));

  let matches = [...merged.values()];

  // A clearly-read number (exact print or canonical fold) is decisive. Drop
  // name noise *and* weaker fuzzy number guesses, which would otherwise show
  // an impostor card beside the exact hit (DZ-TB02/001 vs DZ-TBP02/001).
  if (bestNumber >= 0.9) {
    matches = matches.filter((match) => {
      const info = numberScores.get(match.card.id);
      return Boolean(info && info.score >= 0.9);
    });
    for (const match of matches) {
      if (match.reasons.includes("card name")) {
        match.confidence = Math.min(0.997, match.confidence + 0.012);
      }
    }
  }

  // Name-only results: fold parallel printings of the same card together so
  // the user is not asked to pick between eight identical names.
  if (numberScores.size === 0) {
    const byBaseName = new Map<string, ScanMatch>();
    for (const match of matches) {
      const key = normalizeSearch(stripParallelName(match.card.name));
      const current = byBaseName.get(key);
      if (!current || match.confidence > current.confidence) byBaseName.set(key, match);
    }
    matches = [...byBaseName.values()];
  }

  matches = matches
    .filter((match) => match.confidence >= 0.72)
    .sort((a, b) => b.confidence - a.confidence || a.card.numberKey.localeCompare(b.card.numberKey, "en"))
    .slice(0, 8);

  const bestName = nameHits.sort((a, b) => b.confidence - a.confidence)[0];
  if (readName && (!bestName || bestName.confidence < 0.85)) readName = null;

  return {
    matches,
    readNumber: matches.length > 0 ? (matches[0].card.number ?? readNumber) : null,
    readName: readName ? stripParallelName(readName) : null,
  };
}
