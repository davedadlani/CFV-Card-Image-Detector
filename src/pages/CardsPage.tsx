import { useState } from "react";
import type { Card, CardDatabase } from "../types";
import { CardSearch } from "../components/CardSearch";
import { CardModal } from "../components/CardModal";

export function CardsPage({ db }: { db: CardDatabase }) {
  const [selected, setSelected] = useState<Card | null>(null);

  return (
    <div className="page cards-page">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Card catalogue</p>
          <h1>Every Standard card, searchable.</h1>
          <p className="lede">
            Browse the same Japanese card pool the scanner uses. Search by Japanese name, kana,
            printed number, or set, then add directly to the active deck.
          </p>
        </div>
        <div className="database-chip">
          <span>Loaded locally</span>
          <strong>{db.meta.count.toLocaleString()}</strong>
          <span>Japanese Standard cards</span>
        </div>
      </section>

      <section className="panel cards-panel">
        <CardSearch db={db} onOpen={setSelected} layout="full" />
      </section>

      <p className="muted small source-note">
        Card data and images come from the official Bushiroad card database ·{" "}
        <a href={db.meta.sourceUrl} target="_blank" rel="noreferrer">
          {db.meta.sourceUrl} ↗
        </a>
      </p>

      {selected && <CardModal card={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
