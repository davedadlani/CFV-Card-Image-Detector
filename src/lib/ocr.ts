import * as Tesseract from "tesseract.js";

const workers = new Map<string, Promise<Tesseract.Worker>>();
let activeProgress: ((message: string, value: number) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

function assetBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return new URL(base, document.baseURI).href.replace(/\/?$/, "/");
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function getWorker(
  language: string,
  onStatus?: (message: string, value: number) => void,
): Promise<Tesseract.Worker> {
  let workerPromise = workers.get(language);
  if (!workerPromise) {
    const base = assetBase();
    onStatus?.("Loading OCR engine…", 2);
    workerPromise = Tesseract.createWorker(language, Tesseract.OEM.LSTM_ONLY, {
      workerPath: `${base}tesseract/worker.min.js`,
      corePath: `${base}tesseract`,
      langPath: `${base}tessdata`,
      gzip: true,
      logger: (message) => {
        if (!activeProgress) return;
        const status = String(message.status ?? "");
        const progress = Number(message.progress ?? 0);
        if (status.includes("recognizing")) {
          activeProgress("Reading text…", Math.round(progress * 100));
        } else if (status.includes("language")) {
          activeProgress("Loading language model…", Math.round(progress * 100));
        } else if (status.includes("initializing")) {
          activeProgress("Starting OCR engine…", Math.round(progress * 100));
        }
      },
      errorHandler: (error) => {
        console.error("Tesseract error", error);
      },
    }).catch((error) => {
      workers.delete(language);
      throw error;
    });
    workers.set(language, workerPromise);
  }
  return workerPromise;
}

export interface OcrLine {
  text: string;
  confidence: number;
}

export interface RecognizeOptions {
  psm: Tesseract.PSM;
  whitelist?: string;
  /** Defaults to the Japanese + English model. Latin-only bands can use "eng". */
  language?: string;
  onProgress?: (message: string, value: number) => void;
}

/**
 * Runs one OCR pass. Calls are serialised on a single worker: Tesseract is
 * already CPU-bound, and two workers on a phone would starve the UI.
 */
export function recognize(
  image: HTMLCanvasElement,
  { psm, whitelist, language = "jpn+eng", onProgress }: RecognizeOptions,
): Promise<OcrLine> {
  return enqueue(async () => {
    const worker = await getWorker(language, onProgress);
    activeProgress = onProgress ?? null;
    onProgress?.("Reading text…", 0);
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        tessedit_char_whitelist: whitelist ?? "",
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });
      const result = await worker.recognize(image);
      const text = String(result.data.text ?? "")
        .replace(/\r/g, "")
        .trim();
      const confidence = Number(result.data.confidence ?? 0);
      return { text, confidence };
    } finally {
      activeProgress = null;
    }
  });
}

/** Frees every worker, e.g. if a language model failed to load and we retry. */
export async function resetOcr(): Promise<void> {
  const current = [...workers.values()];
  workers.clear();
  await Promise.all(
    current.map(async (promise) => {
      try {
        await (await promise).terminate();
      } catch {
        // Nothing to clean up.
      }
    }),
  );
}
