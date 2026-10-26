import { useEffect, useMemo, useState } from "react";
import type { Card, CardDatabase } from "../types";
import { useDecks } from "../context/DeckContext";
import {
  DECK_SIZE,
  MAX_COPIES,
  deckIssues,
  deckToCsv,
  deckToJson,
  deckToNumberList,
  deckToText,
  getDeckStats,
} from "../lib/decks";
import { stripParallelName } from "../lib/database";
import { CardSearch } from "../components/CardSearch";
import { CardModal } from "../components/CardModal";

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeName(name: string): string {
  return name.replace(/[^\w\- ]+/g, "").trim() || "deck";
}

export function DeckPage({ db }: { db: CardDatabase }) {
  const {
    decks,
    activeDeck,
    activeDeckId,
    selectDeck,
    createDeck,
    renameDeck,
    deleteDeck,
    clearDeck,
    setQty,
    removeCard,
    notify,
  } = useDecks();

  const [selected, setSelected] = useState<Card | null>(null);
  const [nameDraft, setNameDraft] = useState(activeDeck?.name ?? "");

  useEffect(() => {
    setNameDraft(activeDeck?.name ?? "");
  }, [activeDeck?.id, activeDeck?.name]);

  const stats = useMemo(
    () => (activeDeck ? getDeckStats(activeDeck, db) : null),
    [activeDeck, db],
  );
  const issues = useMemo(
    () => (activeDeck ? deckIssues(activeDeck, db) : []),
    [activeDeck, db],
  );

  const deckTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const deck of decks) totals.set(deck.id, getDeckStats(deck, db).total);
    return totals;
  }, [decks, db]);

  const copyList = async () => {
    if (!activeDeck) return;
    try {
      await navigator.clipboard.writeText(deckToNumberList(activeDeck, db));
      notify("Card list copied to the clipboard.");
    } catch {
      notify("Could not access the clipboard. Download the text file instead.", "error");
    }
  };

  const commitName = () => {
    if (!activeDeck) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNameDraft(activeDeck.name);
      return;
    }
    if (trimmed !== activeDeck.name) renameDeck(activeDeck.id, trimmed);
  };

  return (
    <div className="page deck-page">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Deckbuilder</p>
          <h1>Build from what you scan.</h1>
          <p className="lede">
            Scans land in your active deck. Keep an eye on the 50-card count, the four-copy rule,
            and trigger limits, then export a list for Deck Log.
          </p>
        </div>
        <div className="database-chip">
          <span>Deck</span>
          <strong>{stats?.total ?? 0}</strong>
          <span>of {DECK_SIZE} cards</span>
        </div>
      </section>

      <div className="deck-layout">
        <aside className="panel deck-sidebar">
          <div className="panel-head">
            <h2>Your decks</h2>
            <button type="button" className="btn btn--small btn--primary" onClick={() => createDeck()}>
              + New
            </button>
          </div>
          <ul className="deck-tabs">
            {decks.map((deck) => {
              const total = deckTotals.get(deck.id) ?? 0;
              return (
                <li key={deck.id} className={deck.id === activeDeckId ? "is-active" : ""}>
                  <button type="button" onClick={() => selectDeck(deck.id)}>
                    <span className="deck-tabs__name">{deck.name}</span>
                    <span className={`deck-tabs__count${total === DECK_SIZE ? " is-complete" : ""}`}>
                      {total}/{DECK_SIZE}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="deck-tabs__delete"
                    title={`Delete ${deck.name}`}
                    aria-label={`Delete ${deck.name}`}
                    onClick={() => {
                      if (window.confirm(`Delete “${deck.name}”? This cannot be undone.`)) {
                        deleteDeck(deck.id);
                      }
                    }}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="muted small deck-sidebar__note">
            Decks are saved in this browser with localStorage.
          </p>
        </aside>

        <div className="deck-main">
          {activeDeck && stats ? (
            <>
              <section className="panel deck-header">
                <label className="deck-name">
                  <span className="eyebrow">Deck name</span>
                  <input
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={commitName}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    maxLength={48}
                  />
                </label>
                <div className="deck-count">
                  <strong>{stats.total}</strong>
                  <span>/ {DECK_SIZE}</span>
                </div>
                <div className="deck-header__actions">
                  <button type="button" className="btn btn--small" onClick={copyList}>
                    Copy list
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() =>
                      downloadFile(
                        `${safeName(activeDeck.name)}.txt`,
                        deckToText(activeDeck, db),
                        "text/plain",
                      )
                    }
                  >
                    .txt
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() =>
                      downloadFile(
                        `${safeName(activeDeck.name)}.csv`,
                        deckToCsv(activeDeck, db),
                        "text/csv",
                      )
                    }
                  >
                    .csv
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() =>
                      downloadFile(
                        `${safeName(activeDeck.name)}.json`,
                        deckToJson(activeDeck, db),
                        "application/json",
                      )
                    }
                  >
                    .json
                  </button>
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    onClick={() => clearDeck(activeDeck.id)}
                    disabled={stats.total === 0}
                  >
                    Empty
                  </button>
                </div>
                <div className="deck-progress" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, (stats.total / DECK_SIZE) * 100)}%` }} />
                </div>
              </section>

              <section className="panel deck-summary">
                <div className="summary-block">
                  <span className="eyebrow">Composition</span>
                  <div className="stat-chips">
                    <div className="stat-chip">
                      <span className="stat-chip__label">Unique</span>
                      <span className="stat-chip__value">{stats.unique}</span>
                    </div>
                    <div className="stat-chip">
                      <span className="stat-chip__label">Triggers</span>
                      <span className="stat-chip__value">
                        {stats.triggers.heal +
                          stats.triggers.over +
                          stats.triggers.critical +
                          stats.triggers.draw +
                          stats.triggers.front}
                      </span>
                    </div>
                    <div className="stat-chip">
                      <span className="stat-chip__label">Heal</span>
                      <span className="stat-chip__value">
                        {stats.triggers.heal}/4
                      </span>
                    </div>
                    <div className="stat-chip">
                      <span className="stat-chip__label">Over</span>
                      <span className="stat-chip__value">{stats.triggers.over}/1</span>
                    </div>
                  </div>
                </div>
                <div className="summary-block">
                  <span className="eyebrow">Grades</span>
                  <div className="grade-bars">
                    {[0, 1, 2, 3, 4].map((grade) => {
                      const count = stats.grades.get(grade) ?? 0;
                      return (
                        <div key={grade} className="grade-bar" title={`Grade ${grade}: ${count}`}>
                          <span>G{grade}</span>
                          <span className="grade-bar__track">
                            <span
                              style={{
                                width: `${Math.min(100, (count / Math.max(1, stats.total)) * 100)}%`,
                              }}
                            />
                          </span>
                          <span className="grade-bar__count">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {issues.length > 0 && (
                  <div className="issue-list">
                    {issues.map((issue) => (
                      <p key={issue.message} className={`issue issue--${issue.level}`}>
                        <span aria-hidden="true">{issue.level === "error" ? "!" : "i"}</span>
                        {issue.message}
                      </p>
                    ))}
                  </div>
                )}
                {issues.length === 0 && stats.total === DECK_SIZE && (
                  <p className="issue issue--ok">
                    <span aria-hidden="true">✓</span>
                    Deck looks legal: 50 cards, within copy and trigger limits.
                  </p>
                )}
              </section>

              <section className="panel deck-contents">
                <div className="panel-head">
                  <h2>
                    Cards <span className="muted">({stats.total})</span>
                  </h2>
                  <span className="muted small">Max {MAX_COPIES} per card name</span>
                </div>

                {stats.lines.length === 0 ? (
                  <div className="empty-state">
                    <span aria-hidden="true">▦</span>
                    <p>This deck is empty.</p>
                    <small>Scan a card on the Scan tab, or search the card list on the right.</small>
                  </div>
                ) : (
                  <ul className="deck-list">
                    {stats.lines.map(({ card, qty }) => (
                      <li key={card.id} className="deck-row">
                        <button
                          type="button"
                          className="deck-row__card"
                          onClick={() => setSelected(card)}
                        >
                          <span className="deck-row__image">
                            {card.image ? (
                              <img
                                src={card.image}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <span aria-hidden="true">▤</span>
                            )}
                          </span>
                          <span className="deck-row__info">
                            <strong>{stripParallelName(card.name)}</strong>
                            <small>
                              {card.number}
                              {card.grade !== null ? ` · Grade ${card.grade}` : ""}
                              {card.trigger ? ` · ${card.trigger.replace(/＋.*/, "")}` : ""}
                            </small>
                          </span>
                        </button>
                        <div className="qty">
                          <button
                            type="button"
                            onClick={() => setQty(card.id, qty - 1)}
                            aria-label={`Remove one ${stripParallelName(card.name)}`}
                          >
                            −
                          </button>
                          <span>{qty}</span>
                          <button
                            type="button"
                            onClick={() => setQty(card.id, qty + 1)}
                            aria-label={`Add one ${stripParallelName(card.name)}`}
                          >
                            +
                          </button>
                        </div>
                        <button
                          type="button"
                          className="deck-row__remove"
                          onClick={() => removeCard(card.id)}
                          title={`Remove ${stripParallelName(card.name)}`}
                          aria-label={`Remove ${stripParallelName(card.name)}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel deck-log-note">
                <h2>Exporting to Deck Log</h2>
                <p>
                  Deck Log does not offer a public deck import API, so a direct “send to Deck Log”
                  button is not possible. Copy the card list and add the cards in Deck Log, or keep
                  the CSV/JSON as a backup of this deck.
                </p>
                <div className="deck-log-note__actions">
                  <button type="button" className="btn btn--small" onClick={copyList}>
                    Copy “qty number” list
                  </button>
                  <a
                    className="btn btn--small btn--ghost"
                    href="https://decklog.bushiroad.com/create"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Deck Log ↗
                  </a>
                </div>
              </section>
            </>
          ) : (
            <section className="panel">
              <div className="empty-state">
                <p>No deck selected.</p>
                <button type="button" className="btn btn--primary" onClick={() => createDeck()}>
                  Create a deck
                </button>
              </div>
            </section>
          )}
        </div>

        <aside className="panel deck-search">
          <div className="panel-head">
            <h2>Add cards</h2>
          </div>
          <CardSearch db={db} onOpen={setSelected} layout="compact" />
        </aside>
      </div>

      {selected && <CardModal card={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
