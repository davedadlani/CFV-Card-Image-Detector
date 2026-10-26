import { useDecks } from "../context/DeckContext";

export function Notices() {
  const { notices, dismissNotice } = useDecks();
  if (notices.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`toast toast--${notice.level}`}>
          <span>{notice.message}</span>
          <button
            type="button"
            onClick={() => dismissNotice(notice.id)}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
