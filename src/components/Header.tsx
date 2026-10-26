import type { CardDatabase } from "../types";
import { getDeckStats, DECK_SIZE } from "../lib/decks";
import { useDecks } from "../context/DeckContext";

export type Route = "scan" | "cards" | "deck";

const NAV: Array<{ route: Route; label: string; icon: string }> = [
  { route: "scan", label: "Scan", icon: "◎" },
  { route: "cards", label: "Cards", icon: "▤" },
  { route: "deck", label: "Deck", icon: "▦" },
];

export function Header({ route, db }: { route: Route; db: CardDatabase }) {
  const { activeDeck } = useDecks();
  const total = activeDeck ? getDeckStats(activeDeck, db).total : 0;

  return (
    <header className="site-header">
      <a className="brand" href="#scan" aria-label="Vanguard Scan home">
        <span className="brand__mark" aria-hidden="true">
          V
        </span>
        <span className="brand__text">
          <strong>Vanguard Scan</strong>
          <small>Standard · Japanese</small>
        </span>
      </a>

      <nav className="site-nav" aria-label="Main">
        {NAV.map((item) => (
          <a
            key={item.route}
            className={`site-nav__link${route === item.route ? " is-active" : ""}`}
            href={`#${item.route}`}
            aria-current={route === item.route ? "page" : undefined}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </a>
        ))}
      </nav>

      <a className="deck-pill" href="#deck" title={activeDeck?.name ?? "Deck"}>
        <span className="deck-pill__name">{activeDeck?.name ?? "No deck"}</span>
        <span className={`deck-pill__count${total === DECK_SIZE ? " is-complete" : ""}`}>
          {total}/{DECK_SIZE}
        </span>
      </a>
    </header>
  );
}
