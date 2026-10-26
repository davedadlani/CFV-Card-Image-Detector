import { describe, expect, it } from "vitest";
import Fuse from "fuse.js";
import type { Card, CardDatabase, CardFilters } from "../types";
import { stripParallelName } from "./database";
import { extractNumberCandidates, levenshtein, matchScan, normalizeKey } from "./match";

function makeCard(overrides: Partial<Card> & Pick<Card, "id" | "number" | "name">): Card {
  const numberKey = normalizeKey(overrides.number);
  return {
    numberKey,
    nameKana: null,
    rarity: "C",
    kind: "ノーマルユニット",
    grade: 1,
    power: 8000,
    shield: 5000,
    critical: 1,
    skill: null,
    trigger: null,
    nation: "ドラゴンエンパイア",
    clan: null,
    country: null,
    set: "テストセット",
    expansion: "1",
    text: "",
    flavor: "",
    image: null,
    parallel: null,
    detailUrl: "https://example.com",
    ...overrides,
  };
}

const cards: Card[] = [
  makeCard({ id: 1, number: "DZ-BT01/001", name: "もう一人の自分 主人公" }),
  makeCard({ id: 2, number: "DZ-BT01/002", name: "青の主宰者 リュミエール" }),
  makeCard({ id: 3, number: "DZ-BT02/015", name: "テストカード" }),
  makeCard({ id: 4, number: "DZ-BT02/016", name: "テストカード(P1)" }),
  makeCard({ id: 5, number: "DZ-TBP02/001", name: "運命の歯車 リュミエール" }),
];

function makeDatabase(list: Card[]): CardDatabase {
  const byId = new Map<number, Card>();
  const byNumberKey = new Map<string, Card[]>();
  for (const card of list) {
    byId.set(card.id, card);
    const bucket = byNumberKey.get(card.numberKey);
    if (bucket) bucket.push(card);
    else byNumberKey.set(card.numberKey, [card]);
  }

  const db = {
    cards: list,
    meta: {
      game: "Cardfight!! Vanguard",
      language: "ja",
      regulation: "D",
      regulationLabel: "Standard",
      source: "test",
      sourceUrl: "https://example.com",
      generatedAt: new Date(0).toISOString(),
      count: list.length,
      totalReported: list.length,
    },
    byId,
    byNumberKey,
    recent: list,
    nations: [],
    sets: [],
    search: (_query: string, _filters?: CardFilters, _limit?: number) => list,
  } as CardDatabase;

  Object.defineProperty(db, "__nameFuse", {
    value: new Fuse(
      list.map((card) => ({
        card,
        name: stripParallelName(card.name),
        kana: card.nameKana ?? "",
      })),
      {
        keys: [
          { name: "name", weight: 0.75 },
          { name: "kana", weight: 0.25 },
        ],
        threshold: 0.46,
        ignoreLocation: true,
        includeScore: true,
        minMatchCharLength: 2,
      },
    ),
    enumerable: false,
  });

  return db;
}

const db = makeDatabase(cards);

// Real Standard printings that differ by one character and are easy for OCR
// to confuse: DZ-TB02/001 vs DZ-TBP02/001, and D-BT01/001 vs DZ-BT01/001.
const ambiguousDb = makeDatabase([
  makeCard({ id: 101, number: "DZ-TB02/001", name: "三日月宗近 祝装" }),
  makeCard({ id: 102, number: "DZ-TBP02/001", name: "もう一人の自分 主人公(P1)" }),
  makeCard({ id: 103, number: "D-BT01/001", name: "ヴェルリーナ・バリエンテ" }),
  makeCard({ id: 104, number: "DZ-BT01/001", name: "無双の運命者 ヴァルガ・ドラグレス" }),
]);

describe("extractNumberCandidates", () => {
  it("normalises a printed card number", () => {
    const candidates = extractNumberCandidates("DZ-BT01/001");
    expect(candidates).toContain("DZBT01001");
  });

  it("handles OCR reading the slash as a pipe or letter I", () => {
    expect(extractNumberCandidates("DZ-BT01|001")).toContain("DZBT01001");
    expect(extractNumberCandidates("DZ-BT01I001")).toContain("DZBT01001");
  });

  it("finds short set numbers such as CP/001", () => {
    expect(extractNumberCandidates("CP/001")).toContain("CP001");
  });

  it("re-joins a number that OCR splits into two tokens", () => {
    expect(extractNumberCandidates("OZ-TBPO2 OO1 GS 202")).toContain("OZTBPO2OO1");
  });

  it("re-joins a set prefix misread as digits to a split serial", () => {
    // Real read from a phone photo of DZ-BT11/SR24.
    expect(extractNumberCandidates("PB 02-811 1/SR24 ED 2025")).toContain("028111SR24");
  });

  it("drops letters glued onto the end of the number", () => {
    expect(extractNumberCandidates("DZ-BT01/001ES")).toContain("DZBT01001");
  });

  it("does not glue ordinary words onto a number", () => {
    const candidates = extractNumberCandidates("OZ-TBPO2 GS 202");
    expect(candidates.some((candidate) => candidate.includes("GS"))).toBe(false);
  });

  it("ignores text without at least two digits", () => {
    expect(extractNumberCandidates("ABC DEF")).toEqual([]);
  });
});

describe("levenshtein", () => {
  it("counts edits", () => {
    expect(levenshtein("DZBT01001", "DZBT01001")).toBe(0);
    expect(levenshtein("DZBT01001", "DZBT01002")).toBe(1);
    expect(levenshtein("ABC", "ABCDEF")).toBe(3);
  });

  it("respects the early-exit budget", () => {
    expect(levenshtein("ABCDEF", "UVWXYZ", 1)).toBeGreaterThan(1);
  });
});

describe("matchScan", () => {
  it("matches a clearly read card number", () => {
    const result = matchScan(db, { numberText: "DZ-BT01/001" });
    expect(result.matches[0]?.card.id).toBe(1);
    expect(result.matches[0]?.confidence).toBeGreaterThan(0.9);
    expect(result.matches[0]?.reasons).toContain("card number");
    expect(result.readNumber).toBe("DZ-BT01/001");
  });

  it("recovers a number with one OCR mistake", () => {
    const result = matchScan(db, { numberText: "DZ-BT01/OO1" });
    expect(result.matches[0]?.card.id).toBe(1);
    expect(result.matches[0]?.confidence).toBeGreaterThan(0.7);
  });

  it("matches by Japanese name when the number band fails", () => {
    const result = matchScan(db, { nameText: "青の主宰者 リュミエール" });
    expect(result.matches[0]?.card.id).toBe(2);
    expect(result.matches[0]?.reasons).toContain("card name");
  });

  it("returns no matches for unrelated text", () => {
    const result = matchScan(db, { nameText: "まったく別のカード", numberText: "ZZZ" });
    expect(result.matches).toHaveLength(0);
  });

  it("recovers the set prefix when OCR confuses letters", () => {
    const result = matchScan(db, { numberText: "0Z-TBP02/001" });
    expect(result.matches[0]?.card.id).toBe(5);
    expect(result.matches[0]?.confidence).toBeGreaterThan(0.85);
  });

  it("recovers a heavily degraded DZ-BT01/001 number", () => {
    const result = matchScan(db, { numberText: "07-8101/001" });
    expect(result.matches[0]?.card.id).toBe(1);
    expect(result.matches[0]?.confidence).toBeGreaterThan(0.8);
  });

  it("matches a split number exactly and drops the lookalike impostor", () => {
    const result = matchScan(ambiguousDb, { numberText: "OZ-TBPO2 OO1 GS 202" });
    expect(result.matches[0]?.card.number).toBe("DZ-TBP02/001");
    expect(result.matches.map((match) => match.card.number)).not.toContain("DZ-TB02/001");
  });

  it("matches a number split inside the serial", () => {
    const splitDb = makeDatabase([
      makeCard({ id: 201, number: "DZ-BT11/SR24", name: "救護の翼 ソエル" }),
      makeCard({ id: 202, number: "DZ-BT01/SR24", name: "優麗の騎士 ノーヴィア" }),
    ]);

    const result = matchScan(splitDb, { numberText: "PB 02-811 1/SR24 ED 2025" });
    expect(result.matches[0]?.card.number).toBe("DZ-BT11/SR24");
    expect(result.matches.map((match) => match.card.number)).not.toContain("DZ-BT01/SR24");
  });

  it("prefers the full printing over a shorter lookalike", () => {
    const result = matchScan(ambiguousDb, { numberText: "0Z-8101001 5" });
    expect(result.matches[0]?.card.number).toBe("DZ-BT01/001");
    expect(result.matches.map((match) => match.card.number)).not.toContain("D-BT01/001");
  });

  it("keeps every card when a fuzzy read is genuinely ambiguous", () => {
    const result = matchScan(db, { numberText: "DZ-BT01/OO9" });
    const numbers = result.matches.map((match) => match.card.number);
    expect(numbers).toContain("DZ-BT01/001");
    expect(numbers).toContain("DZ-BT01/002");
  });

  it.each(["22", "on", "ED", "RS", "es"])(
    "does not turn the OCR noise token %s into a match",
    (token) => {
      const result = matchScan(db, { numberText: token, nameText: token });
      expect(result.matches).toHaveLength(0);
    },
  );

  it("ignores a long effect sentence that mentions a card name", () => {
    const result = matchScan(db, {
      nameText:
        "自動能力：このカードが登場した時、あなたの「青の主宰者 リュミエール」を1枚選び、このターン中、パワーを＋5000し、ドライブを＋1する。",
    });
    expect(result.matches).toHaveLength(0);
  });

  it("still matches an exact Japanese name", () => {
    const result = matchScan(db, { nameText: "もう一人の自分 主人公" });
    expect(result.matches[0]?.card.id).toBe(1);
  });
});
