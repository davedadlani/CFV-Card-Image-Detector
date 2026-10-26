import { useState } from "react";
import type { Card } from "../types";
import { stripParallelName } from "../lib/database";

interface CardThumbProps {
  card: Card;
  qty?: number;
  onOpen?: (card: Card) => void;
  onAdd?: (card: Card) => void;
  addLabel?: string;
  compact?: boolean;
}

export function CardThumb({ card, qty, onOpen, onAdd, addLabel = "＋", compact }: CardThumbProps) {
  const [failed, setFailed] = useState(false);
  const name = stripParallelName(card.name);

  return (
    <article className={`card-thumb${compact ? " card-thumb--compact" : ""}`}>
      <button
        type="button"
        className="card-thumb__open"
        onClick={() => onOpen?.(card)}
        title={`${name} · ${card.number}`}
      >
        <span className="card-thumb__image">
          {card.image && !failed ? (
            <img
              src={card.image}
              alt={name}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
            />
          ) : (
            <span className="card-thumb__placeholder" aria-hidden="true">
              {card.number.split(/[/-]/).pop() ?? "?"}
            </span>
          )}
          {qty !== undefined && qty > 0 && <span className="card-thumb__qty">×{qty}</span>}
        </span>
        <span className="card-thumb__name">{name}</span>
        <span className="card-thumb__meta">
          <span>{card.number}</span>
          {card.rarity && <span>{card.rarity}</span>}
        </span>
      </button>
      {onAdd && (
        <button
          type="button"
          className="card-thumb__add"
          onClick={() => onAdd(card)}
          aria-label={`Add ${name} to deck`}
          title={`Add ${name} to deck`}
        >
          {addLabel}
        </button>
      )}
    </article>
  );
}
