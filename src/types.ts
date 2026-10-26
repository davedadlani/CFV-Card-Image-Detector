export interface Card {
  id: number;
  number: string;
  numberKey: string;
  name: string;
  nameKana: string | null;
  rarity: string | null;
  kind: string | null;
  grade: number | null;
  power: number | null;
  shield: number | null;
  critical: number | null;
  skill: string | null;
  trigger: string | null;
  nation: string | null;
  clan: string | null;
  country: string | null;
  set: string | null;
  expansion: string | null;
  text: string;
  flavor: string;
  image: string | null;
  parallel: string | null;
  detailUrl: string;
}

export interface CardMeta {
  game: string;
  language: string;
  regulation: string;
  regulationLabel: string;
  source: string;
  sourceUrl: string;
  generatedAt: string;
  count: number;
  totalReported: number;
}

export interface CardDatabase {
  cards: Card[];
  meta: CardMeta;
  byId: Map<number, Card>;
  byNumberKey: Map<string, Card[]>;
  recent: Card[];
  nations: string[];
  sets: string[];
  search(query: string, filters?: CardFilters, limit?: number): Card[];
}

export interface CardFilters {
  nation?: string;
  grade?: string;
}

export interface ScanMatch {
  card: Card;
  confidence: number;
  reasons: string[];
}

export interface PresenceMetrics {
  /** Share of the whole crop with print-like edges (0–1). */
  detail: number;
  /** Share of the card-name strip with print-like edges (0–1). */
  nameDetail: number;
  /** Share of the collector-number strip with print-like edges (0–1). */
  numberDetail: number;
  /** Mean colour saturation (0–1). */
  saturation: number;
  /** Luminance standard deviation (0–1). */
  contrast: number;
  /** Mean luminance (0–1). */
  brightness: number;
}

export interface PresenceResult {
  present: boolean;
  confidence: number;
  reason: "card" | "empty" | "too-dark";
  metrics: PresenceMetrics;
}

export interface ScanOutcome {
  matches: ScanMatch[];
  readNumber: string | null;
  readName: string | null;
  numberText: string;
  nameText: string;
  fullText: string;
  durationMs: number;
  deepScan: boolean;
  /** False when the frame does not look like a card at all. */
  cardDetected: boolean;
  presence: PresenceResult;
}

export interface DeckEntry {
  cardId: number;
  qty: number;
}

export interface Deck {
  id: string;
  name: string;
  entries: DeckEntry[];
  createdAt: number;
  updatedAt: number;
}
