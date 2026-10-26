import { useEffect } from "react";
import type { Card } from "../types";
import { stripParallelName } from "../lib/database";
import { useDecks } from "../context/DeckContext";

function Stat({ label, value }: { label: string; value: string | number | null }) {
  if (value === null || value === "" || value === undefined) return null;
  return (
    <div className="stat-chip">
      <span className="stat-chip__label">{label}</span>
      <span className="stat-chip__value">{value}</span>
    </div>
  );
}

export function CardModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const { addCard, activeDeck } = useDecks();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const name = stripParallelName(card.name);

  return (
    <div className="modal" role="presentation" onMouseDown={onClose}>
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} card details`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="modal__image">
          {card.image ? (
            <img src={card.image} alt={name} referrerPolicy="no-referrer" />
          ) : (
            <div className="card-thumb__placeholder">{card.number}</div>
          )}
        </div>

        <div className="modal__body">
          <p className="eyebrow">
            {card.number}
            {card.rarity ? ` · ${card.rarity}` : ""}
          </p>
          <h2>{name}</h2>
          {card.nameKana && <p className="modal__kana">{card.nameKana}</p>}

          <div className="stat-chips">
            <Stat label="Grade" value={card.grade} />
            <Stat label="Power" value={card.power === null ? null : card.power.toLocaleString("en-US")} />
            <Stat label="Shield" value={card.shield === null ? null : card.shield.toLocaleString("en-US")} />
            <Stat label="Critical" value={card.critical} />
            <Stat label="Skill" value={card.skill} />
          </div>

          <dl className="card-facts">
            {card.kind && (
              <>
                <dt>Type</dt>
                <dd>{card.kind}</dd>
              </>
            )}
            {card.trigger && (
              <>
                <dt>Trigger</dt>
                <dd className="highlight">{card.trigger}</dd>
              </>
            )}
            {card.nation && (
              <>
                <dt>Nation</dt>
                <dd>{card.nation}</dd>
              </>
            )}
            {card.clan && (
              <>
                <dt>Clan</dt>
                <dd>{card.clan}</dd>
              </>
            )}
            {card.set && (
              <>
                <dt>Set</dt>
                <dd>{card.set}</dd>
              </>
            )}
          </dl>

          {card.text && <p className="card-text">{card.text}</p>}
          {card.flavor && <p className="card-flavor">{card.flavor}</p>}

          <div className="modal__actions">
            <button type="button" className="btn btn--primary" onClick={() => addCard(card, 1)}>
              Add 1 to {activeDeck?.name ?? "deck"}
            </button>
            <button type="button" className="btn" onClick={() => addCard(card, 4)}>
              Add 4
            </button>
            <a className="btn btn--ghost" href={card.detailUrl} target="_blank" rel="noreferrer">
              Official page ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
