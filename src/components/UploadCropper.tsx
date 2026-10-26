import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { adjustCrop, cropCanvas, defaultCrop, fitCanvas, type CropHandle, type Rect } from "../lib/image";

interface UploadCropperProps {
  src: string;
  busy: boolean;
  onScan: (canvas: HTMLCanvasElement, fallbackSource: HTMLCanvasElement) => void;
}

export function UploadCropper({ src, busy, onScan }: UploadCropperProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<{
    mode: CropHandle;
    startX: number;
    startY: number;
    crop: Rect;
  } | null>(null);

  useEffect(() => {
    setCrop(null);
    setDrag(null);
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
    setCrop(defaultCrop(size.width, size.height));
  };

  const begin = (mode: CropHandle) => (event: ReactPointerEvent) => {
    if (!crop) return;
    event.preventDefault();
    event.stopPropagation();
    setDrag({ mode, startX: event.clientX, startY: event.clientY, crop });
  };

  const reset = () => {
    if (natural.width) setCrop(defaultCrop(natural.width, natural.height));
  };

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
    // Also keep the whole photo: when the crop leaves background below the
    // card, the printed number sits above the crop's bottom edge and the
    // scanner falls back to these wider bands.
    const full = fitCanvas(img, 2000);
    onScan(canvas, full);
  };

  return (
    <div className="upload-cropper">
      <div className="crop-stage">
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
          Align the frame with the card. Drag inside it to move, or pull a corner to resize.
        </p>
        <div className="crop-controls__buttons">
          <button type="button" className="btn btn--ghost" onClick={reset} disabled={busy}>
            Reset frame
          </button>
          <button type="button" className="btn btn--primary" onClick={scan} disabled={!crop || busy}>
            {busy ? "Scanning…" : "Scan image"}
          </button>
        </div>
      </div>
    </div>
  );
}
