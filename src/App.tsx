import { useEffect, useState } from "react";
import type { CardDatabase } from "./types";
import { loadCardDatabase } from "./lib/database";
import { DeckProvider } from "./context/DeckContext";
import { Header, type Route } from "./components/Header";
import { Notices } from "./components/Notices";
import { ScanPage } from "./pages/ScanPage";
import { CardsPage } from "./pages/CardsPage";
import { DeckPage } from "./pages/DeckPage";

const ROUTES: Route[] = ["scan", "cards", "deck"];

function currentRoute(): Route {
  const value = window.location.hash.replace(/^#\/?/, "");
  return ROUTES.includes(value as Route) ? (value as Route) : "scan";
}

function LoadingScreen({ status }: { status: string }) {
  return (
    <div className="boot">
      <div className="boot__mark" aria-hidden="true">
        V
      </div>
      <h1>Vanguard Scan</h1>
      <p>{status}</p>
      <div className="boot__bar" aria-hidden="true">
        <span />
      </div>
      <small>Japanese · Standard (regulation D) · {new Date().getFullYear()}</small>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="boot boot--error">
      <div className="boot__mark" aria-hidden="true">
        !
      </div>
      <h1>Could not load the card database</h1>
      <p>{message}</p>
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        Try again
      </button>
      <small>
        The card list is served from <code>public/data/cards.json.gz</code>. Run{" "}
        <code>npm run cards</code> if it is missing, then reload.
      </small>
    </div>
  );
}

export default function App() {
  const [db, setDb] = useState<CardDatabase | null>(null);
  const [status, setStatus] = useState("Loading the card database…");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    let active = true;
    setError(null);
    setStatus("Loading the card database…");
    loadCardDatabase((message) => {
      if (active) setStatus(message);
    })
      .then((database) => {
        if (active) setDb(database);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The card database could not be downloaded.",
        );
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#scan");
    }
    const onHashChange = () => {
      setRoute(currentRoute());
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (error) {
    return <ErrorScreen message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  }

  if (!db) {
    return <LoadingScreen status={status} />;
  }

  return (
    <DeckProvider db={db}>
      <div className="app">
        <Header route={route} db={db} />
        <main>
          {route === "scan" && <ScanPage db={db} />}
          {route === "cards" && <CardsPage db={db} />}
          {route === "deck" && <DeckPage db={db} />}
        </main>
        <footer className="site-footer">
          <span>
            Card data &amp; images © Bushiroad · scanned locally, never uploaded.
          </span>
          <span>
            {db.meta.count.toLocaleString()} Japanese Standard cards · generated{" "}
            {new Date(db.meta.generatedAt).toLocaleDateString()}
          </span>
        </footer>
        <Notices />
      </div>
    </DeckProvider>
  );
}
