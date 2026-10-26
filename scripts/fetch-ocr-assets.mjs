/**
 * Copies the Tesseract worker + WASM core into public/ and downloads the
 * English and Japanese language models, so scanning works without any
 * third-party CDN.
 *
 * Usage: npm run ocr-assets
 */
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { readFile } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const TESSERACT_SRC = path.join(ROOT, "node_modules", "tesseract.js", "dist");
const CORE_SRC = path.join(ROOT, "node_modules", "tesseract.js-core");
const OUT_TESSERACT = path.join(ROOT, "public", "tesseract");
const OUT_TESSDATA = path.join(ROOT, "public", "tessdata");
const LANGS = ["eng", "jpn"];
const langUrl = (lang) => `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`;

async function main() {
  await mkdir(OUT_TESSERACT, { recursive: true });
  await mkdir(OUT_TESSDATA, { recursive: true });

  await copyFile(path.join(TESSERACT_SRC, "worker.min.js"), path.join(OUT_TESSERACT, "worker.min.js"));

  const { readdir } = await import("node:fs/promises");
  const coreFiles = await readdir(CORE_SRC);
  let copied = 0;
  for (const name of coreFiles) {
    if (!/\.(wasm|js)$/.test(name) || name.endsWith(".map")) continue;
    await copyFile(path.join(CORE_SRC, name), path.join(OUT_TESSERACT, name));
    copied++;
  }

  for (const lang of LANGS) {
    const langFile = path.join(OUT_TESSDATA, `${lang}.traineddata.gz`);
    let needsDownload = true;
    try {
      const info = await stat(langFile);
      needsDownload = info.size < 200_000;
    } catch {
      // missing
    }
    if (!needsDownload) {
      console.log(`${lang} language model already present.`);
      continue;
    }

    console.log(`Downloading ${lang} language model…`);
    const res = await fetch(langUrl(lang), { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${lang} language model`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(langFile, gzipSync(buffer, { level: 9 }));
    console.log(`  ${(buffer.length / 1024 / 1024).toFixed(1)} MB → ${langFile}`);
  }

  console.log(`Copied ${copied} Tesseract core files to public/tesseract.`);
}

await main();
