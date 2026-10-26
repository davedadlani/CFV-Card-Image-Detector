import type { Card, CardDatabase, Deck, DeckEntry } from "../types";
import { stripParallelName } from "./database";

export const DECK_SIZE = 50;
export const RIDE_DECK_SIZE = 5;
export const MAX_COPIES = 4;
export const MAX_HEAL_TRIGGERS = 4;
export const MAX_OVER_TRIGGERS = 1;
export const STORAGE_KEY = "cfv-scan.decks.v1";

export interface DeckLine {
  card: Card;
  qty: number;
}

export interface DeckStats {
  total: number;
  unique: number;
  lines: DeckLine[];
  grades: Map<number, number>;
  triggers: {
    heal: number;
    over: number;
    critical: number;
    draw: number;
    front: number;
    other: number;
  };
  nations: Map<string, number>;
}

export interface DeckIssue {
  level: "error" | "warning";
  message: string;
}

export interface AddResult {
  deck: Deck;
  added: number;
  message: string;
  level: "ok" | "warning" | "error";
}

export function makeDeckId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `deck-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDeck(name = "New deck"): Deck {
  const now = Date.now();
  return {
    id: makeDeckId(),
    name,
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function deckNameKey(card: Card): string {
  return stripParallelName(card.name);
}

export function getDeckStats(deck: Deck, db: CardDatabase): DeckStats {
  const lines: DeckLine[] = [];
  const grades = new Map<number, number>();
  const nations = new Map<string, number>();
  const triggers = { heal: 0, over: 0, critical: 0, draw: 0, front: 0, other: 0 };
  let total = 0;

  for (const entry of deck.entries) {
    const card = db.byId.get(entry.cardId);
    if (!card || entry.qty <= 0) continue;
    lines.push({ card, qty: entry.qty });
    total += entry.qty;

    const grade = card.grade ?? -1;
    grades.set(grade, (grades.get(grade) ?? 0) + entry.qty);
    if (card.nation) nations.set(card.nation, (nations.get(card.nation) ?? 0) + entry.qty);

    const trigger = card.trigger ?? "";
    if (trigger.includes("ヒール")) triggers.heal += entry.qty;
    else if (trigger.includes("オーバー")) triggers.over += entry.qty;
    else if (trigger.includes("クリティカル")) triggers.critical += entry.qty;
    else if (trigger.includes("ドロー")) triggers.draw += entry.qty;
    else if (trigger.includes("フロント")) triggers.front += entry.qty;
    else if (trigger) triggers.other += entry.qty;
  }

  lines.sort((a, b) => {
    const gradeA = a.card.grade ?? 99;
    const gradeB = b.card.grade ?? 99;
    if (gradeA !== gradeB) return gradeA - gradeB;
    return a.card.numberKey.localeCompare(b.card.numberKey, "en");
  });

  return { total, unique: lines.length, lines, grades, triggers, nations };
}

/** Copies already in the deck that share this card's printed name. */
export function countCopiesByName(deck: Deck, db: CardDatabase, card: Card): number {
  const target = deckNameKey(card);
  let count = 0;
  for (const entry of deck.entries) {
    const entryCard = db.byId.get(entry.cardId);
    if (!entryCard) continue;
    if (deckNameKey(entryCard) === target) count += entry.qty;
  }
  return count;
}

export function deckIssues(deck: Deck, db: CardDatabase): DeckIssue[] {
  const stats = getDeckStats(deck, db);
  const issues: DeckIssue[] = [];

  if (stats.total !== DECK_SIZE) {
    issues.push({
      level: "warning",
      message:
        stats.total < DECK_SIZE
          ? `${DECK_SIZE - stats.total} more card${DECK_SIZE - stats.total === 1 ? "" : "s"} needed for a 50-card deck.`
          : `The deck is ${stats.total - DECK_SIZE} card${stats.total - DECK_SIZE === 1 ? "" : "s"} over 50.`,
    });
  }

  const byName = new Map<string, { name: string; qty: number }>();
  for (const line of stats.lines) {
    const key = deckNameKey(line.card);
    const current = byName.get(key);
    if (current) current.qty += line.qty;
    else byName.set(key, { name: key, qty: line.qty });
  }
  for (const { name, qty } of byName.values()) {
    if (qty > MAX_COPIES) {
      issues.push({ level: "error", message: `“${name}” is over the 4-copy limit (${qty}).` });
    }
  }

  if (stats.triggers.heal > MAX_HEAL_TRIGGERS) {
    issues.push({
      level: "error",
      message: `Too many heal triggers (${stats.triggers.heal}); the limit is ${MAX_HEAL_TRIGGERS}.`,
    });
  }
  if (stats.triggers.over > MAX_OVER_TRIGGERS) {
    issues.push({
      level: "error",
      message: `Too many over triggers (${stats.triggers.over}); only ${MAX_OVER_TRIGGERS} is allowed.`,
    });
  }

  const nations = [...stats.nations.entries()].filter(([, count]) => count > 0);
  if (nations.length > 1) {
    issues.push({
      level: "warning",
      message: `Cards from ${nations.length} nations: ${nations
        .map(([nation]) => nation)
        .join(", ")}. Standard decks normally use a single nation.`,
    });
  }

  return issues;
}

/**
 * Adds a card, folding parallel printings into the entry that is already in
 * the deck and refusing to break the four-copy rule.
 */
export function addCardToDeck(
  deck: Deck,
  db: CardDatabase,
  card: Card,
  qty = 1,
): AddResult {
  const name = stripParallelName(card.name);
  const existing = countCopiesByName(deck, db, card);
  const room = MAX_COPIES - existing;

  if (room <= 0) {
    return {
      deck,
      added: 0,
      level: "error",
      message: `“${name}” is already at the 4-copy limit.`,
    };
  }

  const amount = Math.min(Math.max(1, Math.floor(qty)), room);
  const entries = deck.entries.map((entry) => ({ ...entry }));
  const sameNameEntry = entries.find((entry) => {
    const entryCard = db.byId.get(entry.cardId);
    return entryCard ? deckNameKey(entryCard) === name : false;
  });

  if (sameNameEntry) {
    sameNameEntry.qty += amount;
  } else {
    entries.push({ cardId: card.id, qty: amount });
  }

  const next: Deck = { ...deck, entries, updatedAt: Date.now() };
  const capped = amount < qty;
  return {
    deck: next,
    added: amount,
    level: capped ? "warning" : "ok",
    message: capped
      ? `Added ${amount}× ${name}. The 4-copy limit stopped the rest.`
      : `Added ${amount}× ${name}.`,
  };
}

export function setEntryQty(
  deck: Deck,
  db: CardDatabase,
  cardId: number,
  qty: number,
): { deck: Deck; message?: string; level: "ok" | "warning" | "error" } {
  const entry = deck.entries.find((candidate) => candidate.cardId === cardId);
  const card = db.byId.get(cardId);
  if (!entry || !card) return { deck, level: "error", message: "That card is not in the deck." };

  const clamped = Math.max(0, Math.floor(qty));
  if (clamped === 0) {
    return {
      deck: {
        ...deck,
        entries: deck.entries.filter((candidate) => candidate.cardId !== cardId),
        updatedAt: Date.now(),
      },
      level: "ok",
    };
  }

  const otherCopies = countCopiesByName(deck, db, card) - entry.qty;
  const room = Math.max(0, MAX_COPIES - otherCopies);
  const finalQty = Math.min(clamped, room);
  const next = {
    ...deck,
    entries: deck.entries.map((candidate) =>
      candidate.cardId === cardId ? { ...candidate, qty: finalQty } : candidate,
    ),
    updatedAt: Date.now(),
  };
  return {
    deck: next,
    level: finalQty < clamped ? "warning" : "ok",
    message: finalQty < clamped ? "Stopped at the 4-copy limit for that card name." : undefined,
  };
}

export function deckToText(deck: Deck, db: CardDatabase): string {
  const stats = getDeckStats(deck, db);
  const lines = [`// ${deck.name} — ${stats.total}/${DECK_SIZE} cards`, ""];
  for (const line of stats.lines) {
    lines.push(`${line.qty}x ${line.card.number}  ${stripParallelName(line.card.name)}`);
  }
  return lines.join("\n");
}

/** Compact "qty card-number" list, handy for pasting into other tools. */
export function deckToNumberList(deck: Deck, db: CardDatabase): string {
  const stats = getDeckStats(deck, db);
  return stats.lines.map((line) => `${line.qty} ${line.card.number}`).join("\n");
}

export function deckToCsv(deck: Deck, db: CardDatabase): string {
  const stats = getDeckStats(deck, db);
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = ["Qty,Card Number,Name,Set,Rarity,Grade,Trigger"];
  for (const line of stats.lines) {
    rows.push(
      [
        String(line.qty),
        escape(line.card.number),
        escape(stripParallelName(line.card.name)),
        escape(line.card.set ?? ""),
        escape(line.card.rarity ?? ""),
        String(line.card.grade ?? ""),
        escape(line.card.trigger ?? ""),
      ].join(","),
    );
  }
  return rows.join("\n");
}

export function deckToJson(deck: Deck, db: CardDatabase): string {
  const stats = getDeckStats(deck, db);
  return JSON.stringify(
    {
      name: deck.name,
      total: stats.total,
      cards: stats.lines.map((line) => ({
        quantity: line.qty,
        number: line.card.number,
        name: stripParallelName(line.card.name),
        set: line.card.set,
      })),
    },
    null,
    2,
  );
}

interface PersistedState {
  decks: Deck[];
  activeDeckId: string | null;
}

function isDeck(value: unknown): value is Deck {
  if (!value || typeof value !== "object") return false;
  const deck = value as Partial<Deck>;
  return (
    typeof deck.id === "string" &&
    typeof deck.name === "string" &&
    Array.isArray(deck.entries) &&
    deck.entries.every(
      (entry) =>
        entry != null &&
        typeof (entry as DeckEntry).cardId === "number" &&
        typeof (entry as DeckEntry).qty === "number",
    )
  );
}

export function loadPersistedDecks(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { decks: [], activeDeckId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const decks = Array.isArray(parsed.decks) ? parsed.decks.filter(isDeck) : [];
    const activeDeckId =
      typeof parsed.activeDeckId === "string" &&
      decks.some((deck) => deck.id === parsed.activeDeckId)
        ? parsed.activeDeckId
        : (decks[0]?.id ?? null);
    return { decks, activeDeckId };
  } catch {
    return { decks: [], activeDeckId: null };
  }
}

export function savePersistedDecks(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be full or disabled; the in-memory deck still works.
  }
}
