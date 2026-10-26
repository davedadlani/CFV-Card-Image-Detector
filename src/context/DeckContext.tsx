import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Card, CardDatabase, Deck } from "../types";
import {
  addCardToDeck,
  createDeck as buildDeck,
  loadPersistedDecks,
  savePersistedDecks,
  setEntryQty,
  type AddResult,
} from "../lib/decks";

export interface Notice {
  id: number;
  message: string;
  level: "ok" | "warning" | "error";
}

interface DeckState {
  decks: Deck[];
  activeDeckId: string | null;
}

interface DeckContextValue {
  decks: Deck[];
  activeDeck: Deck | null;
  activeDeckId: string | null;
  selectDeck: (id: string) => void;
  createDeck: (name?: string) => Deck;
  renameDeck: (id: string, name: string) => void;
  deleteDeck: (id: string) => void;
  clearDeck: (id?: string) => void;
  addCard: (card: Card, qty?: number, options?: { silent?: boolean }) => AddResult;
  setQty: (cardId: number, qty: number) => void;
  removeCard: (cardId: number) => void;
  notices: Notice[];
  notify: (message: string, level?: Notice["level"]) => void;
  dismissNotice: (id: number) => void;
}

const DeckContext = createContext<DeckContextValue | null>(null);

function initialState(): DeckState {
  const stored = loadPersistedDecks();
  if (stored.decks.length > 0) return stored;
  const deck = buildDeck("My deck");
  return { decks: [deck], activeDeckId: deck.id };
}

export function DeckProvider({ db, children }: { db: CardDatabase; children: ReactNode }) {
  const [state, setState] = useState<DeckState>(initialState);
  const stateRef = useRef(state);
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(1);

  const commit = useCallback((next: DeckState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    savePersistedDecks(state);
  }, [state]);

  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, level: Notice["level"] = "ok") => {
      const id = noticeId.current++;
      setNotices((current) => [...current.slice(-3), { id, message, level }]);
      window.setTimeout(() => {
        setNotices((current) => current.filter((notice) => notice.id !== id));
      }, 4600);
    },
    [],
  );

  const selectDeck = useCallback(
    (id: string) => {
      const current = stateRef.current;
      if (!current.decks.some((deck) => deck.id === id)) return;
      commit({ ...current, activeDeckId: id });
    },
    [commit],
  );

  const createDeck = useCallback(
    (name = "New deck") => {
      const current = stateRef.current;
      const deck = buildDeck(name.trim() || "New deck");
      commit({ decks: [...current.decks, deck], activeDeckId: deck.id });
      notify(`Created “${deck.name}”.`);
      return deck;
    },
    [commit, notify],
  );

  const renameDeck = useCallback(
    (id: string, name: string) => {
      const current = stateRef.current;
      const trimmed = name.trim();
      if (!trimmed) return;
      commit({
        ...current,
        decks: current.decks.map((deck) =>
          deck.id === id ? { ...deck, name: trimmed, updatedAt: Date.now() } : deck,
        ),
      });
    },
    [commit],
  );

  const deleteDeck = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const remaining = current.decks.filter((deck) => deck.id !== id);
      if (remaining.length === 0) {
        const deck = buildDeck("My deck");
        commit({ decks: [deck], activeDeckId: deck.id });
        notify("Created a fresh deck.");
        return;
      }
      commit({
        decks: remaining,
        activeDeckId: current.activeDeckId === id ? remaining[0].id : current.activeDeckId,
      });
    },
    [commit, notify],
  );

  const clearDeck = useCallback(
    (id?: string) => {
      const current = stateRef.current;
      const target = id ?? current.activeDeckId;
      if (!target) return;
      commit({
        ...current,
        decks: current.decks.map((deck) =>
          deck.id === target ? { ...deck, entries: [], updatedAt: Date.now() } : deck,
        ),
      });
      notify("Deck emptied.");
    },
    [commit, notify],
  );

  const addCard = useCallback(
    (card: Card, qty = 1, options: { silent?: boolean } = {}) => {
      const current = stateRef.current;
      const deck = current.decks.find((candidate) => candidate.id === current.activeDeckId);
      if (!deck) {
        return {
          deck: buildDeck(),
          added: 0,
          level: "error" as const,
          message: "There is no active deck.",
        };
      }

      const result = addCardToDeck(deck, db, card, qty);
      if (result.added > 0) {
        commit({
          ...current,
          decks: current.decks.map((candidate) =>
            candidate.id === deck.id ? result.deck : candidate,
          ),
        });
      }
      if (!options.silent) notify(result.message, result.level);
      return result;
    },
    [commit, db, notify],
  );

  const setQty = useCallback(
    (cardId: number, qty: number) => {
      const current = stateRef.current;
      const deck = current.decks.find((candidate) => candidate.id === current.activeDeckId);
      if (!deck) return;
      const result = setEntryQty(deck, db, cardId, qty);
      commit({
        ...current,
        decks: current.decks.map((candidate) =>
          candidate.id === deck.id ? result.deck : candidate,
        ),
      });
      if (result.message) notify(result.message, result.level);
    },
    [commit, db, notify],
  );

  const removeCard = useCallback(
    (cardId: number) => {
      setQty(cardId, 0);
    },
    [setQty],
  );

  const activeDeck = useMemo(
    () => state.decks.find((deck) => deck.id === state.activeDeckId) ?? null,
    [state],
  );

  const value = useMemo<DeckContextValue>(
    () => ({
      decks: state.decks,
      activeDeck,
      activeDeckId: state.activeDeckId,
      selectDeck,
      createDeck,
      renameDeck,
      deleteDeck,
      clearDeck,
      addCard,
      setQty,
      removeCard,
      notices,
      notify,
      dismissNotice,
    }),
    [
      state.decks,
      activeDeck,
      state.activeDeckId,
      selectDeck,
      createDeck,
      renameDeck,
      deleteDeck,
      clearDeck,
      addCard,
      setQty,
      removeCard,
      notices,
      notify,
      dismissNotice,
    ],
  );

  return <DeckContext.Provider value={value}>{children}</DeckContext.Provider>;
}

export function useDecks(): DeckContextValue {
  const value = useContext(DeckContext);
  if (!value) throw new Error("useDecks must be used inside <DeckProvider>.");
  return value;
}
