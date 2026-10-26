/**
 * Builds the local Cardfight!! Vanguard (Japanese / Standard) card database.
 *
 * Source: the official Bushiroad card database JSON API used by
 * https://cf-vanguard.com/cardlist/cardsearch/?regulation=D
 * (the "Standard" / D regulation filter).
 *
 * Output: public/data/cards.json.gz + public/data/cards.meta.json
 *
 * The API returns 100 cards per page (per_page is capped), so we walk every
 * page and cache the raw responses for fast rebuilds.
 *
 * Usage: npm run cards
 *        npm run cards -- --refresh   (ignore the local response cache)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const REGULATION = "D";
const API_BASE = "https://cf-vanguard.com/manage";
const IMAGE_BASE = "https://cf-vanguard.com/wordpress/wp-content/images/cardlist/";
const DETAIL_BASE = "https://cf-vanguard.com/cardlist/";
const CATALOG_URL = `https://cf-vanguard.com/cardlist/cardsearch/?regulation=${REGULATION}`;
const PER_PAGE = 100;
const CONCURRENCY = 6;
const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache", "official");
const DATA_DIR = path.join(ROOT, "public", "data");
const OUT_FILE = path.join(DATA_DIR, "cards.json.gz");
const META_FILE = path.join(DATA_DIR, "cards.meta.json");
const REFRESH = process.argv.includes("--refresh");

function cachePath(page) {
  return path.join(CACHE_DIR, `page-${String(page).padStart(3, "0")}.json`);
}

async function fetchPage(page, totalPages) {
  const file = cachePath(page);
  if (!REFRESH && existsSync(file)) {
    return JSON.parse(await readFile(file, "utf8"));
  }

  const params = new URLSearchParams({
    regulation: REGULATION,
    page: String(page),
    per_page: String(PER_PAGE),
    sort: "no",
  });
  const url = `${API_BASE}/card-list-user/list?${params}`;

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Referer: CATALOG_URL,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for page ${page}`);
      const json = await res.json();
      if (!Array.isArray(json.items)) throw new Error(`Unexpected payload for page ${page}`);
      await writeFile(file, JSON.stringify(json));
      console.log(`  page ${page}/${totalPages} · ${json.items.length} cards`);
      return json;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  throw lastError;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function cleanText(value) {
  if (!value) return "";
  return decodeEntities(
    String(value)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCardNumber(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** "-" and "" become null; everything else becomes a number when possible. */
function numeric(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === "-" || text === "－") return null;
  const parsed = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toCard(item) {
  const imagePath = String(item.picture ?? "").replace(/^\/+/, "");
  const image = imagePath ? `${IMAGE_BASE}${imagePath}` : null;
  return {
    id: item.id,
    number: String(item.card_number ?? "").trim(),
    numberKey: normalizeCardNumber(item.card_number),
    name: String(item.card_name ?? "").trim(),
    nameKana: String(item.card_name_kana ?? "").trim() || null,
    rarity: item.rare && item.rare !== "-" ? item.rare : null,
    kind: item.card_kind_name || null,
    grade: numeric(item.grade),
    power: numeric(item.power),
    shield: numeric(item.shield),
    critical: numeric(item.critical),
    skill: item.skill_icon && item.skill_icon !== "-" ? item.skill_icon : null,
    trigger: item.card_trigger && item.card_trigger !== "-" ? item.card_trigger : null,
    nation: item.nation_clan && item.nation_clan !== "-" ? item.nation_clan : null,
    clan: item.clan && item.clan !== "-" ? item.clan : null,
    country: item.country && item.country !== "-" ? item.country : null,
    set: item.expansion_name || null,
    expansion: item.expansion != null ? String(item.expansion) : null,
    text: cleanText(item.text),
    flavor: cleanText(item.flavor_text ?? item.flavor ?? ""),
    image,
    parallel: item.parallel_param ? String(item.parallel_param) : null,
    detailUrl: `${DETAIL_BASE}?cardno=${encodeURIComponent(item.card_number ?? "")}`,
  };
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(path.join(ROOT, "public", "tessdata"), { recursive: true });

  console.log("Fetching Standard (regulation D) catalogue from cf-vanguard.com…");
  const first = await fetchPage(1, "?");
  const total = Number(first.total ?? 0);
  const totalPages = Math.ceil(total / PER_PAGE);
  console.log(`  ${total.toLocaleString()} cards across ${totalPages} pages`);

  const pages = [first];
  if (totalPages > 1) {
    const rest = await pool(
      Array.from({ length: totalPages - 1 }, (_, index) => index + 2),
      CONCURRENCY,
      (page) => fetchPage(page, totalPages),
    );
    pages.push(...rest);
  }

  const seen = new Set();
  const cards = [];
  let nonCardRows = 0;
  for (const page of pages) {
    for (const item of page.items) {
      if (!item || !item.card_number || seen.has(item.id)) {
        nonCardRows++;
        continue;
      }
      seen.add(item.id);
      cards.push(toCard(item));
    }
  }

  cards.sort((a, b) => a.numberKey.localeCompare(b.numberKey, "en"));

  const meta = {
    game: "Cardfight!! Vanguard",
    language: "ja",
    regulation: REGULATION,
    regulationLabel: "Standard",
    source: "Official Bushiroad Card Database (cf-vanguard.com)",
    sourceUrl: CATALOG_URL,
    generatedAt: new Date().toISOString(),
    count: cards.length,
    totalReported: total,
  };

  const payload = JSON.stringify({ meta, cards });
  const gz = gzipSync(Buffer.from(payload, "utf8"), { level: 9 });
  await writeFile(OUT_FILE, gz);
  await writeFile(META_FILE, JSON.stringify(meta, null, 2));

  console.log(`\nWrote ${cards.length.toLocaleString()} cards`);
  console.log(`  ${path.relative(ROOT, OUT_FILE)} · ${(gz.length / 1024 / 1024).toFixed(2)} MB gzipped`);
  console.log(`  ${(Buffer.byteLength(payload) / 1024 / 1024).toFixed(2)} MB raw JSON`);
  if (nonCardRows) console.log(`  skipped ${nonCardRows} duplicate/empty rows`);
}

await main();
