import { describe, expect, it } from "vitest";
import type { Card, CardDatabase } from "../types";
import { normalizeKey } from "./match";
import {
  MAX_COPIES,
  addCardToDeck,
  createDeck,
  deckIssues,
  deckToNumberList,
  getDeckStats,
  setEntryQty,
} from "./decks";

function makeCard(overrides: Partial<Card> & Pick<Card, "id" | "number" | "name">): Card {
  return {
    numberKey: normalizeKey(overrides.number),
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
  makeCard({ id: 1, number: "DZ-BT01/001", name: "テストカード" }),
  makeCard({ id: 2, number: "DZ-BT01/001P", name: "テストカード(P1)" }),
  makeCard({
    id: 3,
    number: "DZ-BT01/002",
    name: "ヒールの守り手",
    trigger: "ヒールトリガー＋10000",
    grade: 0,
    shield: 15000,
  }),
  makeCard({
    id: 4,
    number: "DZ-BT01/003",
    name: "超える者",
    trigger: "オーバートリガー＋100000000",
    grade: 0,
    shield: 0,
  }),
];

const db = {
  cards,
  byId: new Map(cards.map((card) => [card.id, card])),
  byNumberKey: new Map(),
} as unknown as CardDatabase;

describe("addCardToDeck", () => {
  it("adds copies and folds parallel printings into one line", () => {
    let deck = createDeck();
    const first = addCardToDeck(deck, db, cards[0], 2);
    deck = first.deck;
    expect(first.added).toBe(2);
    expect(deck.entries).toHaveLength(1);

    const parallel = addCardToDeck(deck, db, cards[1], 1);
    deck = parallel.deck;
    expect(parallel.added).toBe(1);
    expect(deck.entries).toHaveLength(1);
    expect(deck.entries[0]).toMatchObject({ cardId: 1, qty: 3 });
  });

  it("refuses a fifth copy by base card name", () => {
    let deck = createDeck();
    deck = addCardToDeck(deck, db, cards[0], MAX_COPIES).deck;
    const fifth = addCardToDeck(deck, db, cards[1], 1);
    expect(fifth.added).toBe(0);
    expect(fifth.level).toBe("error");
    expect(fifth.deck.entries[0].qty).toBe(MAX_COPIES);
  });

  it("caps a large add at the copy limit", () => {
    const result = addCardToDeck(createDeck(), db, cards[0], 9);
    expect(result.added).toBe(MAX_COPIES);
    expect(result.level).toBe("warning");
  });
});

describe("setEntryQty", () => {
  it("removes the entry at zero", () => {
    const deck = addCardToDeck(createDeck(), db, cards[0], 2).deck;
    const result = setEntryQty(deck, db, cards[0].id, 0);
    expect(result.deck.entries).toHaveLength(0);
  });

  it("counts other printings when clamping", () => {
    let deck = addCardToDeck(createDeck(), db, cards[0], 2).deck;
    deck = addCardToDeck(deck, db, cards[1], 1).deck;
    const result = setEntryQty(deck, db, cards[0].id, 9);
    expect(result.deck.entries[0].qty).toBe(MAX_COPIES);
    expect(result.level).toBe("warning");
  });
});

describe("getDeckStats and deckIssues", () => {
  it("counts triggers and grades", () => {
    let deck = createDeck();
    deck = addCardToDeck(deck, db, cards[2], 3).deck;
    deck = addCardToDeck(deck, db, cards[3], 1).deck;
    const stats = getDeckStats(deck, db);
    expect(stats.total).toBe(4);
    expect(stats.triggers.heal).toBe(3);
    expect(stats.triggers.over).toBe(1);
    expect(stats.grades.get(0)).toBe(4);
  });

  it("reports trigger and deck-size problems", () => {
    let deck = createDeck();
    deck = addCardToDeck(deck, db, cards[3], 1).deck;
    // Add a second over trigger under a different name via a synthetic card.
    const anotherOver = makeCard({
      id: 5,
      number: "DZ-BT01/004",
      name: "もう一枚の超",
      trigger: "オーバートリガー＋100000000",
      grade: 0,
    });
    const withCard = { ...db, cards: [...cards, anotherOver], byId: new Map(db.byId) } as CardDatabase;
    withCard.byId.set(anotherOver.id, anotherOver);
    deck = addCardToDeck(deck, withCard, anotherOver, 1).deck;

    const issues = deckIssues(deck, withCard);
    expect(issues.some((issue) => issue.message.includes("over triggers"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("more cards needed"))).toBe(true);
  });
});

describe("deckToNumberList", () => {
  it("exports quantity and card number", () => {
    let deck = createDeck();
    deck = addCardToDeck(deck, db, cards[0], 2).deck;
    deck = addCardToDeck(deck, db, cards[2], 1).deck;
    expect(deckToNumberList(deck, db)).toBe("1 DZ-BT01/002\n2 DZ-BT01/001");
  });
});
