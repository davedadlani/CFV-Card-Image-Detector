import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { findCardCrop } from "../lib/cardBounds";
import { adjustCrop, cropCanvas, defaultCrop, fitCanvas, type CropHandle, type Rect } from "../lib/image";

interface UploadCropperProps {
  src: string;
  busy: boolean;
  onScan: (canvas: HTMLCanvasElement, fallbackSource: HTMLCanvasElement) => void;
}

/** Detection can fail on unusual photos; that must never block the upload. */
function autoCrop(image: HTMLImageElement): Rect | null {
  try {
    return findCardCrop(image);
  } catch {
    return null;
  }
}

export function UploadCropper({ src, busy, onScan }: UploadCropperProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  /** "fit" scales the photo down to the panel; "actual" shows native pixels. */
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  /** True while the frame is where auto-align put it, not where the user did. */
  const [autoAligned, setAutoAligned] = useState(false);
  const [drag, setDrag] = useState<{
    mode: CropHandle;
    startX: number;
    startY: number;
    crop: Rect;
  } | null>(null);

  useEffect(() => {
    setCrop(null);
    setDrag(null);
    setZoom("fit");
    setAutoAligned(false);
  }, [src]);

  useEffect(() => {
    if (!drag) return;
    const start = drag.crop;

    const onMove = (event: PointerEvent) => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      const dx = (event.clientX - drag.startX) / rect.width;
      const dy = (event.clientY - drag.startY) / rect.height;
      setCrop(adjustCrop(start, drag.mode, dx, dy, natural.width, natural.height));
    };
    const onUp = () => setDrag(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, natural]);

  const handleLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    setNatural(size);
    const auto = autoCrop(img);
    setCrop(auto ?? defaultCrop(size.width, size.height));
    setAutoAligned(Boolean(auto));
  };

  /** Places the frame on the card outline; falls back to the default frame. */
  const align = () => {
    const img = imgRef.current;
    if (!img || !natural.width) return;
    const auto = autoCrop(img);
    setCrop(auto ?? defaultCrop(natural.width, natural.height));
    setAutoAligned(Boolean(auto));
  };

  const begin = (mode: CropHandle) => (event: ReactPointerEvent) => {
    if (!crop) return;
    event.preventDefault();
    event.stopPropagation();
    setAutoAligned(false);
    setDrag({ mode, startX: event.clientX, startY: event.clientY, crop });
  };

  const reset = () => {
    if (natural.width) {
      setCrop(defaultCrop(natural.width, natural.height));
      setAutoAligned(false);
    }
  };

  const toggleZoom = () => setZoom((value) => (value === "fit" ? "actual" : "fit"));

  const scan = () => {
    const img = imgRef.current;
    if (!img || !crop) return;
    const sourceWidth = crop.width * natural.width;
    // Keep the native pixels: the collector number is only a few pixels tall
    // on a 350 px official image, and shrinking the crop first destroys it.
    // Very large phone photos are capped so the OCR copies stay manageable.
    const outWidth = Math.min(2000, Math.round(sourceWidth));
    const canvas = cropCanvas(
      img,
      {
        x: crop.x * natural.width,
        y: crop.y * natural.height,
        width: sourceWidth,
        height: crop.height * natural.height,
      },
      outWidth,
    );
    // Also keep the whole photo: if auto-align missed or the frame is
    // imperfect, the row-by-row sweep can still read the number from the
    // original pixels.
    const full = fitCanvas(img, 2000);
    onScan(canvas, full);
  };

  return (
    <div className="upload-cropper">
      <div className={`crop-stage${zoom === "actual" ? " crop-stage--actual" : ""}`}>
        <div className="crop-frame" ref={frameRef}>
          <img
            ref={imgRef}
            src={src}
            alt="Uploaded card"
            onLoad={handleLoad}
            draggable={false}
          />
          {crop && (
            <div
              className="crop-box"
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.width * 100}%`,
                height: `${crop.height * 100}%`,
              }}
              onPointerDown={begin("move")}
              role="presentation"
            >
              <span className="crop-box__rule crop-box__rule--v" />
              <span className="crop-box__rule crop-box__rule--h" />
              {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                <span
                  key={handle}
                  className={`crop-handle crop-handle--${handle}`}
                  onPointerDown={begin(handle)}
                  role="presentation"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="crop-controls">
        <p className="muted">
          {autoAligned
            ? "The frame was placed on the card automatically. Drag inside it to move, or pull a corner to resize."
            : "Align the frame with the card. Drag inside it to move, or pull a corner to resize."}
          {zoom === "actual"
            ? " Scroll the preview to inspect the photo at full resolution."
            : natural.width
              ? ` The preview is scaled down; scanning uses all ${natural.width} × ${natural.height} px of the photo.`
              : ""}
        </p>
        <div className="crop-controls__buttons">
          <button type="button" className="btn btn--ghost" onClick={align} disabled={!crop || busy}>
            Auto-align
          </button>
          <button type="button" className="btn btn--ghost" onClick={reset} disabled={!crop || busy}>
            Reset frame
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={toggleZoom}
            disabled={!crop || busy}
            aria-pressed={zoom === "actual"}
          >
            {zoom === "actual" ? "Fit to panel" : "Actual size"}
          </button>
          <button type="button" className="btn btn--primary" onClick={scan} disabled={!crop || busy}>
            {busy ? "Scanning…" : "Scan image"}
          </button>
        </div>
      </div>
    </div>
  );
}
