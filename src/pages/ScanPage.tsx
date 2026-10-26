import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import type { Card, CardDatabase, ScanMatch, ScanOutcome } from "../types";
import { useDecks } from "../context/DeckContext";
import { stripParallelName } from "../lib/database";
import {
  coverCropFromDisplay,
  cropCanvas,
  fingerprintDistance,
  frameFingerprint,
} from "../lib/image";
import { scanCanvas } from "../lib/scan";
import { CardModal } from "../components/CardModal";
import { UploadCropper } from "../components/UploadCropper";

type CameraState = "idle" | "starting" | "live" | "error";
type Source = "camera" | "upload";

interface ScanPageProps {
  db: CardDatabase;
}

function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was blocked. Allow camera permission in your browser and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera was found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The camera is already being used by another app.";
  }
  if (name === "OverconstrainedError") {
    return "This camera cannot provide a suitable video stream.";
  }
  return "The camera could not be started. Check browser permissions and try again.";
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.92) return "Strong match";
  if (confidence >= 0.82) return "Likely match";
  if (confidence >= 0.65) return "Possible match";
  return "Low confidence";
}

function noCardMessage(outcome: ScanOutcome): string {
  if (outcome.presence.reason === "too-dark") {
    return "The frame is too dark to see a card. Add light, avoid shadows, and fill the guide with the card.";
  }
  return "Nothing that looks like a card is filling the guide. Hold one card flat inside the frame, or upload a photo instead. No matches were produced.";
}

function noMatchMessage(outcome: ScanOutcome): string {
  if (outcome.readName) {
    return `Read “${stripParallelName(outcome.readName)}”, but the collector number could not be confirmed. Try again with the bottom number band sharp and glare-free.`;
  }
  return "A card is there, but the name and number were too unclear to match. Steady the phone, fill the guide, avoid glare, and try a sharper photo.";
}

function MatchRow({
  match,
  index,
  onAdd,
  onOpen,
}: {
  match: ScanMatch;
  index: number;
  onAdd: (card: Card) => void;
  onOpen: (card: Card) => void;
}) {
  const card = match.card;
  const name = stripParallelName(card.name);
  return (
    <li className={`match${index === 0 ? " match--best" : ""}`}>
      <button type="button" className="match__open" onClick={() => onOpen(card)}>
        <span className="match__image">
          {card.image ? (
            <img src={card.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span aria-hidden="true">▤</span>
          )}
        </span>
        <span className="match__info">
          <strong>{name}</strong>
          <small>
            {card.number}
            {card.rarity ? ` · ${card.rarity}` : ""}
          </small>
          <small className="match__reasons">{match.reasons.join(" · ")}</small>
        </span>
      </button>
      <div className="match__actions">
        <span className="match__score" title={confidenceLabel(match.confidence)}>
          {Math.round(match.confidence * 100)}%
        </span>
        <button type="button" className="btn btn--small btn--primary" onClick={() => onAdd(card)}>
          Add
        </button>
      </div>
    </li>
  );
}

export function ScanPage({ db }: ScanPageProps) {
  const { addCard, activeDeck } = useDecks();

  const videoRef = useRef<HTMLVideoElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef(false);
  const lastFrameRef = useRef<Float32Array | null>(null);
  const lastScanRef = useRef<Float32Array | null>(null);

  const [mode, setMode] = useState<Source>("camera");
  const [camera, setCamera] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const [autoScan, setAutoScan] = useState(true);

  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ message: string; value: number } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [capture, setCapture] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<Card | null>(null);

  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [selected, setSelected] = useState<Card | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    lastFrameRef.current = null;
    lastScanRef.current = null;
    setCamera("idle");
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  useEffect(() => {
    return () => {
      if (uploadUrl) URL.revokeObjectURL(uploadUrl);
    };
  }, [uploadUrl]);

  // Prefer upload on devices where the live camera cannot work, instead of
  // leading the user into a permission error they cannot fix.
  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        if (!active) return;
        setCameraNotice(
          "Live camera needs HTTPS or localhost. On a phone, open this site over HTTPS — or upload a photo of the card, which works everywhere.",
        );
        setMode("upload");
        return;
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!active) return;
        const hasVideo = devices.some((device) => device.kind === "videoinput");
        if (!hasVideo && devices.length > 0) {
          setCameraNotice("No camera was found on this device. Upload a photo of the card instead.");
          setMode("upload");
        }
      } catch {
        // Device labels are permission-gated; leave the camera tab available.
      }
    };
    void check();
    return () => {
      active = false;
    };
  }, []);

  const runScan = useCallback(
    async (canvas: HTMLCanvasElement, thorough: boolean, fallbackSource?: HTMLCanvasElement) => {
      if (scanningRef.current) return;
      scanningRef.current = true;
      setScanning(true);
      setScanError(null);
      setLastAdded(null);
      setProgress({ message: "Checking the frame…", value: 0 });

      try {
        const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
        setCapture(dataUrl);
        const result = await scanCanvas(db, canvas, {
          thorough,
          fallbackSource,
          onProgress: (message, value) => setProgress({ message, value }),
        });
        setOutcome(result);
      } catch (error) {
        console.error(error);
        setScanError(
          error instanceof Error
            ? error.message
            : "The scan failed. Try again with a sharper image.",
        );
      } finally {
        scanningRef.current = false;
        setScanning(false);
        setProgress(null);
      }
    },
    [db],
  );

  const startCamera = useCallback(async () => {
    if (camera === "starting" || camera === "live") return;
    setCameraError(null);

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCamera("error");
      setCameraError(
        "Live camera needs a secure context. Open the site on localhost or over HTTPS, then allow camera access.",
      );
      return;
    }

    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("The camera preview is not available.");
      video.srcObject = stream;
      await video.play();
      setCameraNotice(null);
      setCamera("live");
    } catch (error) {
      console.error(error);
      stopCamera();
      setCamera("error");
      setCameraError(cameraErrorMessage(error));
    }
  }, [camera, stopCamera]);

  const captureCamera = useCallback(
    async (force = false) => {
      if (scanningRef.current) return;
      const video = videoRef.current;
      const guide = guideRef.current;
      if (!video || !guide || video.readyState < 2 || !video.videoWidth) return;

      const videoBox = video.getBoundingClientRect();
      const guideBox = guide.getBoundingClientRect();
      const crop = coverCropFromDisplay(video, videoBox, guideBox);
      // Keep the camera's native pixels (capped) so the bottom number band is
      // not softened before OCR; scanCanvas upscales the band itself.
      const canvas = cropCanvas(video, crop, Math.min(2000, Math.round(crop.width)));
      const fingerprint = frameFingerprint(canvas);

      const previous = lastFrameRef.current;
      lastFrameRef.current = fingerprint;

      if (!force) {
        // Auto-scan waits for a still frame: motion blur is the main reason a
        // phone camera read fails. It also skips a frame that was scanned
        // already, so OCR does not run on the same unchanged view forever.
        if (!previous || fingerprintDistance(previous, fingerprint) > 5) return;
        if (lastScanRef.current && fingerprintDistance(lastScanRef.current, fingerprint) < 3) {
          return;
        }
      }

      lastScanRef.current = fingerprint;
      await runScan(canvas, force);
    },
    [runScan],
  );

  const captureRef = useRef(captureCamera);
  useEffect(() => {
    captureRef.current = captureCamera;
  }, [captureCamera]);

  useEffect(() => {
    if (camera !== "live" || !autoScan) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      void captureRef.current(false);
    };
    const first = window.setTimeout(tick, 600);
    const interval = window.setInterval(tick, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [camera, autoScan]);

  const switchMode = (next: Source) => {
    if (next === mode) return;
    if (mode === "camera") stopCamera();
    setMode(next);
    setScanError(null);
    lastFrameRef.current = null;
    lastScanRef.current = null;
  };

  const chooseFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setScanError("That file is not an image. Choose a JPEG or PNG photo of the card.");
      return;
    }
    setScanError(null);
    setOutcome(null);
    setCapture(null);
    setLastAdded(null);
    setUploadUrl(URL.createObjectURL(file));
  };

  // Dropping a photo is supported whether or not one is already loaded, so the
  // preview can be replaced without going through the file picker first.
  const clearDrag = useCallback(() => {
    dragDepth.current = 0;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    // A drop outside the panel or a cancelled drag never reaches the panel's
    // own handlers, so clear the highlight from the window instead.
    window.addEventListener("drop", clearDrag);
    window.addEventListener("dragend", clearDrag);
    return () => {
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("dragend", clearDrag);
    };
  }, [dragging, clearDrag]);

  const dragHasFiles = (event: ReactDragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const handleDragEnter = (event: ReactDragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const handleDragOver = (event: ReactDragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };

  const handleDragLeave = (event: ReactDragEvent) => {
    if (!dragHasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const handleDrop = (event: ReactDragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    clearDrag();
    if (scanningRef.current) return;
    chooseFile(event.dataTransfer.files?.[0] ?? null);
  };

  const statusText =
    camera === "starting"
      ? "Starting camera…"
      : camera === "live"
        ? "Hold the card inside the frame"
        : "Start the camera, or upload a photo of a card.";

  const topMatch = outcome?.cardDetected ? outcome.matches[0] : undefined;

  return (
    <div className="page scan-page">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Live recognition</p>
          <h1>Point, scan, stack your deck.</h1>
          <p className="lede">
            Show a Japanese Standard card to your camera, or upload a photo. The card name and
            collector number are read on your device and checked against the official database.
            Nothing is added until you press Add.
          </p>
        </div>
        <div className="database-chip">
          <span>Official JP database</span>
          <strong>{db.meta.count.toLocaleString()}</strong>
          <span>Standard cards · regulation D</span>
        </div>
      </section>

      <div className="scan-layout">
        <section className="panel stage-panel">
          <div className="mode-tabs" role="tablist" aria-label="Scan source">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "camera"}
              className={mode === "camera" ? "is-active" : ""}
              onClick={() => switchMode("camera")}
            >
              <span aria-hidden="true">◎</span> Live camera
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "upload"}
              className={mode === "upload" ? "is-active" : ""}
              onClick={() => switchMode("upload")}
            >
              <span aria-hidden="true">⇪</span> Upload image
            </button>
          </div>

          {cameraNotice && !cameraError && (
            <div className="callout callout--info">
              <strong>Upload works without a camera</strong>
              <p>{cameraNotice}</p>
              {mode === "camera" && (
                <button
                  type="button"
                  className="btn btn--ghost btn--small callout__action"
                  onClick={() => switchMode("upload")}
                >
                  Use upload instead
                </button>
              )}
            </div>
          )}

          {mode === "camera" ? (
            <>
              <div className={`camera-stage${camera === "live" ? " is-live" : ""}`}>
                <video ref={videoRef} className="camera-stage__video" playsInline muted autoPlay />
                <div className="scan-guide" ref={guideRef} aria-hidden="true">
                  <span className="corner corner--tl" />
                  <span className="corner corner--tr" />
                  <span className="corner corner--bl" />
                  <span className="corner corner--br" />
                  {scanning && <span className="scan-guide__sweep" />}
                </div>

                {camera === "live" && (
                  <span className="live-badge">
                    <span /> {scanning ? "Reading…" : "Live"}
                  </span>
                )}

                {camera !== "live" && (
                  <div className="camera-stage__placeholder">
                    <span className="camera-stage__icon" aria-hidden="true">
                      ◎
                    </span>
                    <p>{statusText}</p>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void startCamera()}
                      disabled={camera === "starting"}
                    >
                      {camera === "starting" ? "Starting…" : "Start camera"}
                    </button>
                    <small>Camera frames never leave your device.</small>
                  </div>
                )}
              </div>

              {cameraError && (
                <div className="callout callout--error" role="alert">
                  <strong>Camera unavailable</strong>
                  <p>{cameraError}</p>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small callout__action"
                    onClick={() => switchMode("upload")}
                  >
                    Use upload instead
                  </button>
                </div>
              )}

              <div className="stage-controls">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void captureCamera(true)}
                  disabled={camera !== "live" || scanning}
                >
                  {scanning ? "Scanning…" : "Scan now"}
                </button>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autoScan}
                    onChange={(event) => setAutoScan(event.target.checked)}
                  />
                  <span>Auto-scan when steady</span>
                </label>
                {camera === "live" && (
                  <button type="button" className="btn btn--ghost" onClick={stopCamera}>
                    Stop camera
                  </button>
                )}
              </div>
              <p className="muted small scan-hint">
                Auto-scan only reads a still frame. If the print is blurry, hold the phone steady
                and press Scan now for a slower, more thorough pass.
              </p>
            </>
          ) : (
            <div
              className={`upload-dropzone${dragging ? " upload-dropzone--dragging" : ""}`}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="upload-dropzone__stage">
                {uploadUrl ? (
                  <UploadCropper
                    src={uploadUrl}
                    busy={scanning}
                    onScan={(canvas, full) => void runScan(canvas, true, full)}
                  />
                ) : (
                  <label className="upload-drop">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                    />
                    <span className="upload-drop__icon" aria-hidden="true">
                      ＋
                    </span>
                    <strong>Choose a card photo</strong>
                    <small>
                      or drop a JPEG / PNG here. You can adjust the crop before scanning. On a
                      phone, a photo taken in good light works better than a live camera frame.
                    </small>
                  </label>
                )}
                {dragging && (
                  <span className="drop-hint" aria-hidden="true">
                    Drop to {uploadUrl ? "replace the photo" : "open the photo"}
                  </span>
                )}
              </div>

              {uploadUrl && (
                <div className="stage-controls">
                  <label className="btn btn--ghost file-button">
                    Choose another
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                </div>
              )}

              {scanError && (
                <div className="callout callout--error" role="alert">
                  <p>{scanError}</p>
                </div>
              )}
              <p className="muted small scan-hint">
                {uploadUrl
                  ? "Drag another photo onto the preview to replace it."
                  : "Tip: flatten the card, fill the frame, avoid glare, and keep the bottom number band sharp. The scan never leaves your device."}
              </p>
            </div>
          )}
        </section>

        <aside className="panel result-panel">
          <div className="panel-head">
            <h2>Scan result</h2>
            {topMatch && (
              <span className={`badge badge--${topMatch.confidence >= 0.82 ? "good" : "warn"}`}>
                {confidenceLabel(topMatch.confidence)}
              </span>
            )}
          </div>

          {progress && (
            <div className="scan-progress" aria-live="polite">
              <div className="scan-progress__track">
                <div
                  className="scan-progress__bar"
                  style={{ width: `${Math.max(4, Math.min(100, progress.value))}%` }}
                />
              </div>
              <p>{progress.message}</p>
            </div>
          )}

          {capture && (
            <div className="capture-preview">
              <img src={capture} alt="Captured card frame" />
              <span>{progress ? "Processing frame" : "Last captured frame"}</span>
            </div>
          )}

          {scanError && !progress && (
            <div className="callout callout--error" role="alert">
              <strong>Scan failed</strong>
              <p>{scanError}</p>
            </div>
          )}

          {!outcome && !progress && !scanError && (
            <div className="empty-state">
              <span aria-hidden="true">⌁</span>
              <p>Scan a card to see the closest matches here.</p>
              <small>
                The scanner first checks that a card is actually in the frame. If the name and
                number are not read reliably, it shows no matches rather than guessing.
              </small>
            </div>
          )}

          {outcome && (
            <>
              {!outcome.cardDetected ? (
                <div className="callout callout--warn" role="status">
                  <strong>
                    {outcome.presence.reason === "too-dark" ? "Frame too dark" : "No card detected"}
                  </strong>
                  <p>{noCardMessage(outcome)}</p>
                </div>
              ) : (
                <>
                  <div className="readout">
                    <div>
                      <span>Read number</span>
                      <strong>{outcome.readNumber ?? "—"}</strong>
                    </div>
                    <div>
                      <span>Read name</span>
                      <strong>{outcome.readName ? stripParallelName(outcome.readName) : "—"}</strong>
                    </div>
                  </div>
                  <p className="muted small scan-meta">
                    {outcome.deepScan ? "Thorough scan" : "Fast scan"} · {outcome.durationMs} ms ·{" "}
                    {outcome.matches.length} match{outcome.matches.length === 1 ? "" : "es"}
                  </p>

                  {outcome.matches.length > 0 ? (
                    <ul className="match-list">
                      {outcome.matches.map((match, index) => (
                        <MatchRow
                          key={match.card.id}
                          match={match}
                          index={index}
                          onAdd={(card) => {
                            addCard(card, 1);
                            setLastAdded(card);
                          }}
                          onOpen={setSelected}
                        />
                      ))}
                    </ul>
                  ) : (
                    <div className="empty-note">{noMatchMessage(outcome)}</div>
                  )}
                </>
              )}

              <details className="ocr-debug">
                <summary>Scan details</summary>
                <pre>
                  {[
                    `PRESENCE: ${outcome.cardDetected ? "card" : outcome.presence.reason} (${Math.round(
                      outcome.presence.confidence * 100,
                    )}%)`,
                    `DETAIL: frame ${(outcome.presence.metrics.detail * 100).toFixed(1)}% · name ${(
                      outcome.presence.metrics.nameDetail * 100
                    ).toFixed(1)}% · number ${(outcome.presence.metrics.numberDetail * 100).toFixed(
                      1,
                    )}%`,
                    `NUMBER: ${outcome.numberText || "—"}`,
                    `NAME: ${outcome.nameText || "—"}`,
                    outcome.fullText ? `FULL:\n${outcome.fullText}` : "",
                  ]
                    .filter(Boolean)
                    .join("\n\n")}
                </pre>
              </details>
            </>
          )}

          {lastAdded && (
            <div className="added-note">
              <span>
                Added <strong>{stripParallelName(lastAdded.name)}</strong> to{" "}
                {activeDeck?.name ?? "your deck"}.
              </span>
              <a href="#deck">Open deck →</a>
            </div>
          )}
        </aside>
      </div>

      <section className="how-it-works">
        <article>
          <span>1</span>
          <h3>Frame the card</h3>
          <p>
            Use a dark, even background and let the guide sit just inside the card edges. Upload a
            photo if the live camera is awkward.
          </p>
        </article>
        <article>
          <span>2</span>
          <h3>Read locally</h3>
          <p>
            The scanner checks for a card, then reads the printed name and number with Japanese OCR
            in your browser. Images are never uploaded to a server.
          </p>
        </article>
        <article>
          <span>3</span>
          <h3>Review &amp; add</h3>
          <p>
            Matches come from {db.meta.count.toLocaleString()} Standard cards. You choose the card
            and press Add; nothing is added automatically.
          </p>
        </article>
      </section>

      {selected && <CardModal card={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
