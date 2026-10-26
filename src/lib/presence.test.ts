import { describe, expect, it } from "vitest";
import { analyzeFrame, evaluatePresence, type FramePixels } from "./presence";

type Paint = (x: number, y: number) => [number, number, number];

function makeFrame(paint: Paint | [number, number, number], width = 180, height = 252): FramePixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = typeof paint === "function" ? paint(x, y) : paint;
      const offset = (y * width + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Draws alternating dark/light print strokes inside a fractional band. */
function stripedBand(
  x: number,
  y: number,
  width: number,
  height: number,
  band: { x: number; y: number; width: number; height: number },
): [number, number, number] {
  const inBand =
    x >= band.x * width &&
    x < (band.x + band.width) * width &&
    y >= band.y * height &&
    y < (band.y + band.height) * height;
  if (!inBand) return [96, 84, 70];
  return (x - Math.floor(band.x * width)) % 7 < 3 ? [18, 16, 14] : [235, 226, 205];
}

function cardLikeFrame(): FramePixels {
  const width = 180;
  const height = 252;
  return makeFrame(
    (x, y) => {
      const name = stripedBand(x, y, width, height, {
        x: 0.03,
        y: 0.84,
        width: 0.94,
        height: 0.1,
      });
      if (name[0] !== 96) return name;
      const number = stripedBand(x, y, width, height, {
        x: 0,
        y: 0.93,
        width: 0.44,
        height: 0.07,
      });
      if (number[0] !== 96) return number;
      // Simple colour blocks for the art area.
      return x < width / 2 ? [40, 90, 170] : [170, 90, 50];
    },
    width,
    height,
  );
}

describe("card presence", () => {
  it("rejects a plain, empty background", () => {
    const result = evaluatePresence(analyzeFrame(makeFrame([130, 130, 130])));
    expect(result.present).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("reports a black frame as too dark", () => {
    const result = evaluatePresence(analyzeFrame(makeFrame([3, 3, 5])));
    expect(result.present).toBe(false);
    expect(result.reason).toBe("too-dark");
  });

  it("accepts a frame with card-name and number print bands", () => {
    const result = evaluatePresence(analyzeFrame(cardLikeFrame()));
    expect(result.present).toBe(true);
    expect(result.reason).toBe("card");
    expect(result.metrics.nameDetail).toBeGreaterThan(0.05);
    expect(result.metrics.numberDetail).toBeGreaterThan(0.03);
  });

  it("keeps the raw metrics available for diagnostics", () => {
    const metrics = analyzeFrame(cardLikeFrame());
    expect(metrics.detail).toBeGreaterThan(0);
    expect(metrics.contrast).toBeGreaterThan(0);
    expect(metrics.brightness).toBeGreaterThan(0.1);
    expect(metrics.saturation).toBeGreaterThan(0.05);
  });
});
