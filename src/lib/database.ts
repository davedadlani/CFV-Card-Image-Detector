import Fuse from "fuse.js";
import type { Card, CardDatabase, CardMeta } from "../types";

interface RawDatabase {
  meta: CardMeta;
  cards: Card[];
}

interface NameEntry {
  card: Card;
  name: string;
  kana: string;
}

/**
 * Normalisation used for substring/filter matching. Keeps kana and kanji
 * intact, removes spaces and punctuation so "D-BT01 / 001" and "dbt01001"
 * compare equal, as do names written with or without spaces.
 */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /[\s\u3000,，.．、。:：;；!！?？'"“”‘’()（）[\]【】{}「」『』〈〉《》<>・･/\\|_+*#@&%$^~`\-–—―]/g,
      "",
    );
}

/**
 * Parallel-art printings carry a marker such as "(P1)" in their official name.
 * For deck construction they are the same card, so remove that suffix.
 */
export function stripParallelName(value: string): string {
  return value
    .replace(/\s*[（(]\s*P\d+[A-Za-z]?\s*[)）]\s*$/i, "")
    .replace(/\s*[（(]\s*(SP|SSP|SE|VSP)\s*[)）]\s*$/i, "")
    .trim();
}

async function readGzippedJson(res: Response): Promise<RawDatabase> {
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) {
    return JSON.parse(new TextDecoder().decode(buffer)) as RawDatabase;
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser cannot decompress the card database. Please use a recent version of Chrome, Edge, Firefox or Safari.",
    );
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text) as RawDatabase;
}

let databasePromise: Promise<CardDatabase> | null = null;

export function loadCardDatabase(
  onStatus?: (message: string) => void,
): Promise<CardDatabase> {
  if (databasePromise) {
    onStatus?.("Loading card database…");
    return databasePromise;
  }
  databasePromise = buildDatabase(onStatus).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

async function buildDatabase(
  onStatus?: (message: string) => void,
): Promise<CardDatabase> {
  onStatus?.("Downloading card database…");
  const url = new URL(`${import.meta.env.BASE_URL}data/cards.json.gz`, document.baseURI);
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`Could not load the card database (HTTP ${res.status}).`);
  }

  onStatus?.("Reading card database…");
  const raw = await readGzippedJson(res);

  onStatus?.("Indexing cards…");
  const byId = new Map<number, Card>();
  const byNumberKey = new Map<string, Card[]>();
  const names: NameEntry[] = [];
  const nameSearch: Array<{ card: Card; text: string }> = [];

  for (const card of raw.cards) {
    byId.set(card.id, card);
    const key = card.numberKey || normalizeSearch(card.number);
    const bucket = byNumberKey.get(key);
    if (bucket) bucket.push(card);
    else byNumberKey.set(key, [card]);

    const clearName = stripParallelName(card.name);
    names.push({ card, name: clearName, kana: card.nameKana ?? "" });
    nameSearch.push({
      card,
      text: normalizeSearch(`${card.name} ${card.nameKana ?? ""} ${card.number} ${card.set ?? ""}`),
    });
  }

  const searchFuse = new Fuse(raw.cards, {
    keys: [
      { name: "name", weight: 0.5 },
      { name: "nameKana", weight: 0.15 },
      { name: "number", weight: 0.2 },
      { name: "set", weight: 0.15 },
    ],
    threshold: 0.38,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 1,
  });

  const nameFuse = new Fuse(names, {
    keys: [
      { name: "name", weight: 0.75 },
      { name: "kana", weight: 0.25 },
    ],
    threshold: 0.46,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 2,
  });

  const nationCounts = new Map<string, number>();
  const setCounts = new Map<string, number>();
  for (const card of raw.cards) {
    if (card.nation) nationCounts.set(card.nation, (nationCounts.get(card.nation) ?? 0) + 1);
    if (card.set) setCounts.set(card.set, (setCounts.get(card.set) ?? 0) + 1);
  }

  const nations = [...nationCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const sets = [...setCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const recent = [...raw.cards].sort((a, b) => b.id - a.id);

  const database: CardDatabase = {
    cards: raw.cards,
    meta: raw.meta,
    byId,
    byNumberKey,
    recent,
    nations,
    sets,
    search(query, filters = {}, limit = 90) {
      const trimmed = query.trim();
      const nation = filters.nation && filters.nation !== "all" ? filters.nation : null;
      const grade = filters.grade && filters.grade !== "all" ? filters.grade : null;

      const accept = (card: Card) => {
        if (nation && card.nation !== nation) return false;
        if (grade && String(card.grade ?? "") !== grade) return false;
        return true;
      };

      if (!trimmed) {
        return recent.filter(accept).slice(0, limit);
      }

      const scored = new Map<number, { card: Card; score: number }>();
      const add = (card: Card, score: number) => {
        if (!accept(card)) return;
        const current = scored.get(card.id);
        if (!current || current.score < score) scored.set(card.id, { card, score });
      };

      const normalized = normalizeSearch(trimmed);
      if (normalized.length >= 3) {
        const numberHit = trimmed.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        if (/\d/.test(numberHit)) {
          for (const card of raw.cards) {
            if (card.numberKey === numberHit) add(card, 3);
            else if (card.numberKey.includes(numberHit)) add(card, 2.4);
          }
        }
      }

      if (normalized.length >= 2) {
        let added = 0;
        for (const entry of nameSearch) {
          if (added >= limit * 4) break;
          if (entry.text.includes(normalized)) {
            add(entry.card, 1.8);
            added++;
          }
        }
      }

      for (const hit of searchFuse.search(trimmed, { limit: limit * 3 })) {
        add(hit.item, 1.2 - (hit.score ?? 0.5));
      }

      return [...scored.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.card);
    },
  };

  // Exposed for OCR name matching without rebuilding an index in the scanner.
  Object.defineProperty(database, "__nameFuse", { value: nameFuse, enumerable: false });
  return database;
}

/** The name index is intentionally non-enumerable on the public database object. */
export function getNameFuse(db: CardDatabase): Fuse<NameEntry> {
  return (db as CardDatabase & { __nameFuse: Fuse<NameEntry> }).__nameFuse;
}
