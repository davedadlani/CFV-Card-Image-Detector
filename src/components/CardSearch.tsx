import { useMemo, useState } from "react";
import type { Card, CardDatabase } from "../types";
import { getDeckStats, DECK_SIZE } from "../lib/decks";
import { useDecks } from "../context/DeckContext";
import { CardThumb } from "./CardThumb";

interface CardSearchProps {
  db: CardDatabase;
  onOpen: (card: Card) => void;
  layout?: "compact" | "full";
}

export function CardSearch({ db, onOpen, layout = "compact" }: CardSearchProps) {
  const { addCard, activeDeck } = useDecks();
  const [query, setQuery] = useState("");
  const [nation, setNation] = useState("all");
  const [grade, setGrade] = useState("all");
  const [limit, setLimit] = useState(layout === "compact" ? 40 : 60);

  const results = useMemo(
    () => db.search(query, { nation, grade }, limit),
    [db, query, nation, grade, limit],
  );

  const total = activeDeck ? getDeckStats(activeDeck, db).total : 0;

  return (
    <div className={`card-search card-search--${layout}`}>
      <div className="card-search__bar">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            placeholder="Search name, card number or set…"
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(layout === "compact" ? 40 : 60);
            }}
            aria-label="Search cards"
          />
        </label>
        <div className="card-search__filters">
          <select
            value={nation}
            onChange={(event) => {
              setNation(event.target.value);
              setLimit(layout === "compact" ? 40 : 60);
            }}
            aria-label="Filter by nation"
          >
            <option value="all">All nations</option>
            {db.nations.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            value={grade}
            onChange={(event) => {
              setGrade(event.target.value);
              setLimit(layout === "compact" ? 40 : 60);
            }}
            aria-label="Filter by grade"
          >
            <option value="all">All grades</option>
            {[0, 1, 2, 3, 4].map((value) => (
              <option key={value} value={String(value)}>
                Grade {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card-search__meta">
        <span>
          {results.length === 0
            ? "No matches"
            : `${results.length} card${results.length === 1 ? "" : "s"}`}
          {query.trim() ? ` for “${query.trim()}”` : ""}
        </span>
        <span className="card-search__deck">
          {activeDeck ? `${activeDeck.name} · ${total}/${DECK_SIZE}` : "No active deck"}
        </span>
      </div>

      {results.length > 0 ? (
        <div className="card-grid">
          {results.map((card) => (
            <CardThumb
              key={card.id}
              card={card}
              onOpen={onOpen}
              onAdd={(selected) => addCard(selected, 1)}
              compact={layout === "compact"}
            />
          ))}
        </div>
      ) : (
        <p className="empty-note">
          Nothing found. Try part of the Japanese card name or the printed number, for example
          “DZ-BT01/001”.
        </p>
      )}

      {results.length >= limit && (
        <button
          type="button"
          className="btn btn--ghost card-search__more"
          onClick={() => setLimit((value) => value + 60)}
        >
          Show more cards
        </button>
      )}
    </div>
  );
}
