import { describe, expect, it } from "vitest";
import { cardCropFromBounds, detectCardBounds, type CardFrame } from "./cardBounds";
import { CARD_ASPECT } from "./image";

type Paint = (x: number, y: number) => [number, number, number];

function makeFrame(width: number, height: number, paint: Paint | [number, number, number]): CardFrame {
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

/** A card-shaped block of textured print on a plain background. */
function cardOnBackground(
  background: [number, number, number],
  card: { x: number; y: number; width: number; height: number },
): Paint {
  const right = card.x + card.width;
  const bottom = card.y + card.height;
  return (x, y) => {
    const inside = x >= card.x && x < right && y >= card.y && y < bottom;
    if (!inside) return background;

    const onBorder =
      x < card.x + 3 || x >= right - 3 || y < card.y + 3 || y >= bottom - 3;
    if (onBorder) return [28, 28, 34];

    // Deterministic print texture, plus denser rows near the bottom where the
    // card name and collector number are printed.
    const lowPrint = y > bottom - 28 && y < bottom - 16;
    const numberPrint = y > bottom - 12 && y < bottom - 7;
    const texture = (x * 7 + y * 13) % 5 < 2;
    if (numberPrint) return [24, 24, 24];
    if (lowPrint && x > card.x + 10 && x < right - 10) return [50, 50, 50];
    return texture ? [150, 150, 150] : [205, 205, 205];
  };
}

describe("detectCardBounds", () => {
  it("finds a card sitting on a plain background", () => {
    const frame = makeFrame(
      360,
      480,
      cardOnBackground([62, 68, 74], { x: 62, y: 64, width: 236, height: 330 }),
    );

    const bounds = detectCardBounds(frame);
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    expect(bounds.x).toBeCloseTo(62 / 360, 1);
    expect(bounds.y).toBeCloseTo(64 / 480, 1);
    expect(bounds.width).toBeCloseTo(236 / 360, 1);
    expect(bounds.height).toBeCloseTo(330 / 480, 1);
  });

  it("finds a card that fills the whole photo", () => {
    const frame = makeFrame(
      350,
      510,
      cardOnBackground([62, 68, 74], { x: 0, y: 0, width: 350, height: 510 }),
    );

    const bounds = detectCardBounds(frame);
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    expect(bounds.width).toBeGreaterThan(0.9);
    expect(bounds.height).toBeGreaterThan(0.9);
  });

  it("returns null for a blank frame", () => {
    expect(detectCardBounds(makeFrame(360, 480, [128, 128, 128]))).toBeNull();
  });

  it("returns null for a frame smaller than the analysis minimum", () => {
    expect(detectCardBounds(makeFrame(40, 40, [128, 128, 128]))).toBeNull();
  });
});

describe("cardCropFromBounds", () => {
  it("keeps the card aspect ratio and honours the bottom anchor", () => {
    const crop = cardCropFromBounds(
      { x: 0.1, y: 0.15, width: 0.7, height: 0.75 },
      480,
      640,
      0.9,
    );

    expect((crop.width * 480) / (crop.height * 640)).toBeCloseTo(CARD_ASPECT, 5);
    expect(crop.y + crop.height).toBeCloseTo(0.9, 5);
    expect(crop.x + crop.width / 2).toBeCloseTo(0.45, 5);
  });

  it("stays inside the photo when the anchor is too low", () => {
    const crop = cardCropFromBounds(
      { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
      480,
      640,
      1,
    );

    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1);
  });
});
