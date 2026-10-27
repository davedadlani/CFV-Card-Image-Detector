# CFV Card Image Detector

Scan a Japanese **Cardfight!! Vanguard** card with a camera or a photo, match it
against the official **Standard (regulation D)** card list, and add it to a
deck builder. Everything runs locally in the browser: images and OCR text never
leave the device.

- **Scan page** (`#scan`) — live camera or image upload, with a crop box that is
  placed on the card automatically when it can be found, and stays draggable.
  The scanner first checks that a card is actually in the frame, then reads the
  collector number and card name, and shows the closest matches.
- **Cards page** (`#cards`) — search and filter the full Standard card list.
- **Deck page** (`#deck`) — build, validate, and export a deck.

Nothing is added to the deck automatically. You always press **Add** on a
specific match.

## Requirements

- Node.js 20 or newer (npm included)
- A modern browser (Chrome, Edge, Firefox, Safari)
- A **secure context** for the live camera: `https://` or `http://localhost`.
  Browsers block `getUserMedia` on a plain `http://192.168.x.x` LAN address.
  Image upload works everywhere, including insecure origins and browsers with
  no camera.

## Quick start

```powershell
npm install
npm run dev
```

Open <http://localhost:5173>. The dev server is exposed on the LAN (`host: true`),
but camera access over a LAN IP requires HTTPS — use upload instead, or put the
dev server behind a TLS tunnel (for example `cloudflared tunnel --url
http://localhost:5173`).

Production build:

```powershell
npm run build
npm run preview
```

## Live site

The public site is deployed from the **`live`** branch to GitHub Pages:
<https://davedadlani.github.io/CFV-Card-Image-Detector/>

`live` is the deployment line; develop on `main` and merge into `live` when a
change is ready to publish. Every push to `live` (or a manual **Deploy live
site** run) tests, builds, and publishes the site:

1. `npm ci`
2. `npm test`
3. `npm run build` with `VITE_BASE=/CFV-Card-Image-Detector/`
4. upload `dist/` and deploy it with GitHub Pages

The workflow lives in `.github/workflows/deploy-live.yml`. It derives the base
path from the repository name, so the build loads its JS, card database, and
OCR assets from the project subpath. Set a repository variable named `VITE_BASE`
(for example `/`) if the site later moves to a custom domain. To build the same
subpath locally:

```powershell
$env:VITE_BASE = "/CFV-Card-Image-Detector/"
npm run build
npm run preview -- --base /CFV-Card-Image-Detector/
```

**One-time setup:** open **Settings → Pages → Build and deployment** and set
**Source** to **GitHub Actions**. The workflow cannot enable Pages with the
default token, so until this is done the deployment job fails and the URL
returns 404.

## Scripts

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Vite dev server on port 5173, bound to all interfaces               |
| `npm run build`     | Type-check (`tsc --noEmit`) and build to `dist/`                    |
| `npm run preview`   | Serve the production build locally                                  |
| `npm test`          | Run the Vitest suite (matching, presence, deck rules)               |
| `npm run cards`     | Rebuild `public/data/cards.json.gz` from the official API           |
| `npm run cards -- --refresh` | Ignore the local API cache and download every page again   |
| `npm run ocr-assets`| Vendor the Tesseract worker/WASM and refresh the language models    |

## Card database

The app ships with a prebuilt database of the official Japanese Standard
(regulation D) card list:

- Source catalogue: <https://cf-vanguard.com/cardlist/cardsearch/?regulation=D>
- API used by the catalogue (paged, 100 cards per page):
  <https://cf-vanguard.com/manage/card-list-user/list?regulation=D&page=N&per_page=100&sort=no>
- Output: `public/data/cards.json.gz` (about 16,000 cards) and
  `public/data/cards.meta.json`
- Card images are hotlinked from
  `https://cf-vanguard.com/wordpress/wp-content/images/cardlist/`.

`npm run cards` walks every API page and caches the raw JSON responses in
`.cache/official/` so rebuilds are fast. Pass `--refresh` to fetch fresh data.
Re-run this script when Bushiroad adds a new set; the UI shows the database
count and generation date in the footer.

## OCR assets

OCR uses [Tesseract.js](https://github.com/naptha/tesseract.js) with the
`jpn+eng` model. The worker, WASM core, and language models are vendored into
`public/tesseract/` and `public/tessdata/`, so no CDN is needed at runtime.
`npm run ocr-assets` re-copies them from `node_modules` and downloads the
`tessdata_fast` models if they are missing.

## How a scan works

Uploads first get a **frame-placement** pass (`src/lib/cardBounds.ts`). Edge
energy is profiled row by row and column by column; the densest card-shaped
block is taken as the card outline, snapped to the card aspect ratio, and its
bottom edge is anchored just below the lowest printed line (the
collector-number row). That keeps the number inside the crop even when the card
sits in the middle of a table or floor. Photos where the card already fills the
frame keep the default crop, and **Auto-align** re-runs detection after a
manual change. If no card outline is found, the default frame is used and the
row-by-row sweep below still has a chance to read the number.

1. **Presence gate** (`src/lib/presence.ts`) — measures print-like edge energy
   in the card-name and collector-number bands plus overall detail, contrast,
   and saturation. A blank wall, desk, or dark frame is rejected immediately
   with **“No card detected”** / **“Frame too dark”**, before OCR runs.
2. **Collector number** (`src/lib/scan.ts`) — photo uploads are scanned row by
   row. Horizontal edge energy finds the lines of print in the lower part of the
   photo, and they are read from the bottom up, so the card can sit anywhere in
   the frame. Each line is OCR'd twice (a left-of-card strip at 1500 px, then
   full width at 2200 px). A reading is trusted only when it is an exact print,
   or when a second pass over the same line agrees; a lone fuzzy read of a
   small, blurry number is discarded rather than guessed. Small card-only
   uploads (official renders, tight screenshots) try the crop's own bottom
   bands first at 1800–2200 px, with several overlapping vertical bands whose
   readings are merged, and only sweep the whole photo if those miss. OCR
   output is highly sensitive to band placement and output width, so uploads
   try multiple bands and widths.
3. **Name fallback** — the name bar is only OCR'd when the number did not
   produce a confident match. On 350 px official images the name is ~50 px tall
   and unreliable, so it is treated as supporting evidence, not a guess.
4. **Strict matching** (`src/lib/match.ts`) — OCR-confusable characters are
   folded (`O/Q/D→0`, `I/L/T→1`, `Z→2`, `S→5`, `B→8`, `G→6`), the slash may be
   read as `|`, `I`, `l`, `1`, or a space, and trailing rarity letters are
   trimmed. Exact and canonical reads outrank fuzzy reads; fuzzy matching is
   limited to edit distance 1 and requires a matching set prefix. Ambiguous
   fuzzy reads return **all** tied candidates instead of an arbitrary one.
   Matches below ~72% confidence are dropped.
5. **Review, then add** — matches appear as cards; pressing **Add** is the only
   way a card enters the deck.

Camera auto-scan waits for a still frame (16×16 luminance fingerprint) and
skips unchanged frames. Auto-scan does a fast pass; the **Scan now** button and
uploads do a slower, thorough pass.

## Deck rules and export

The deck builder enforces the Standard construction limits:

- 50 cards in the main deck
- maximum 4 copies by **base card name** (parallel printings are folded
  together)
- maximum 1 Over Trigger
- maximum 4 Heal Triggers
- warnings for a missing/extra card and for mixing nations

Decks are stored in `localStorage` under `cfv-scan.decks.v1`. Export from the
Deck page as:

- text list (`qty card-number name`)
- CSV (`Qty, Card Number, Name, Set, Rarity, Grade, Trigger`)
- JSON
- a compact `qty card-number` list for the clipboard

### Deck Log limitation

Deck Log does **not** provide a public deck-import API, so this app cannot push
a deck into it. Use the text/number-list export and paste or recreate the deck
in Deck Log manually. The export formats are designed to make that copy/paste
quick.

## Project structure

```
src/
  pages/          Scan, Cards, and Deck screens
  components/     Card modal/search, upload cropper, header
  context/        Deck state + localStorage persistence
  lib/
    scan.ts       presence gate → band OCR → matching orchestration
    match.ts      number/name extraction, canonicalisation, scoring
    cardBounds.ts finds the card and places the upload crop frame
    presence.ts   cheap “is a card in frame?” pixel analysis
    ocr.ts        cached Tesseract worker(s)
    image.ts      crop, grayscale, binarize, fingerprint helpers
    decks.ts      deck rules, stats, and export formats
public/
  data/           prebuilt card database (.json.gz + meta)
  tessdata/       vendored Tesseract language models
  tesseract/      vendored Tesseract worker/WASM
scripts/
  build-cards.mjs    official API → public/data/cards.json.gz
  fetch-ocr-assets.mjs
```

## Known limits

- Official card images are only 350×510 px, so tiny print is at the edge of what
  OCR can recover. High-resolution phone photos generally scan better than the
  official thumbnails.
- Glare, motion blur, sleeves, and severe perspective distortion reduce
  accuracy. Fill the guide, keep the printed number sharp, and take a second
  photo if the first read is wrong.
- Auto-align assumes an upright card. A strongly tilted or landscape card may
  need the frame dragged manually; the whole-photo sweep still reads the number
  when the crop is imperfect.
- The camera requires HTTPS (or localhost). Upload always remains available.
- Card data and images belong to Bushiroad; this is an unofficial fan tool.
