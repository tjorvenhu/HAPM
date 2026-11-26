import fs from "fs";
import path from "path";
import { dataDir } from "./paths";

interface RateLimitEntry {
  timestamps: number[];
}

// Liegt im Daten-Volume, damit die Zählung einen Neustart übersteht.
const DATA_DIR = dataDir();
const PERSIST_PATH = path.join(DATA_DIR, "rate-limit.json");

// Debounce interval for writes (max once per 5 seconds)
const DEBOUNCE_MS = 5_000;
let lastPersist = 0;
let persistScheduled = false;

const store = new Map<string, RateLimitEntry>();

// ---------------------------------------------------------------------------
// Restore store from disk on module load (synchronous so data is available
// immediately for the first request after a server restart).
// ---------------------------------------------------------------------------
function loadFromDisk() {
  try {
    if (fs.existsSync(PERSIST_PATH)) {
      const raw = fs.readFileSync(PERSIST_PATH, "utf-8");
      const parsed: Record<string, RateLimitEntry> = JSON.parse(raw);
      for (const [key, entry] of Object.entries(parsed)) {
        if (Array.isArray(entry?.timestamps)) {
          store.set(key, { timestamps: entry.timestamps });
        }
      }
    }
  } catch (err) {
    // File missing, corrupt, or unreadable — start with an empty store
    console.warn("[rate-limit] Failed to load persisted data, starting fresh:", err);
  }
}

loadFromDisk();

// ---------------------------------------------------------------------------
// Persist store to disk. Called asynchronously (debounced).
// Uses writeFileSync for simplicity — the file is small.
// ---------------------------------------------------------------------------
function persistToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const obj: Record<string, RateLimitEntry> = {};
    for (const [key, entry] of store.entries()) {
      obj[key] = { timestamps: entry.timestamps };
    }

    fs.writeFileSync(PERSIST_PATH, JSON.stringify(obj, null, 2), "utf-8");
    lastPersist = Date.now();
  } catch (err) {
    console.error("[rate-limit] Failed to persist data:", err);
  }
}

function schedulePersist() {
  if (persistScheduled) return;

  const elapsed = Date.now() - lastPersist;

  if (elapsed >= DEBOUNCE_MS) {
    // Enough time has passed — write immediately (but asynchronously via
    // setTimeout(0) so the caller isn't blocked).
    persistScheduled = true;
    setTimeout(() => {
      persistScheduled = false;
      persistToDisk();
    }, 0);
  } else {
    // Schedule a write after the remaining debounce time
    persistScheduled = true;
    setTimeout(() => {
      persistScheduled = false;
      persistToDisk();
    }, DEBOUNCE_MS - elapsed);
  }
}

// ---------------------------------------------------------------------------
// Cleanup — remove stale entries
// ---------------------------------------------------------------------------
// Clean up expired entries every 60 seconds
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanup(now: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of store.entries()) {
    // Das längste Fenster ist ein Tag (Fehlversuche je Konto, `failuresBlocked`).
    const maxWindow = 24 * 60 * 60 * 1000;
    entry.timestamps = entry.timestamps.filter((t) => now - t < maxWindow);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sliding window rate limiter backed by an in-memory Map with file-based
 * persistence so that rate-limit data survives server restarts.
 *
 * @param key     Unique key for the rate limit bucket (e.g. IP address or session ID)
 * @param limit   Maximum number of requests allowed in the window
 * @param windowMs  Window size in milliseconds
 * @returns       { success, remaining, retryAfter? }
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { success: boolean; remaining: number; retryAfter?: number } {
  const now = Date.now();

  // Periodically clean up stale entries
  cleanup(now);

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Remove timestamps outside the current window
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= limit) {
    // Rate limit exceeded
    const oldestInWindow = entry.timestamps[0];
    const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
    return {
      success: false,
      remaining: 0,
      retryAfter,
    };
  }

  // Record this request
  entry.timestamps.push(now);

  // Persist to disk (debounced)
  schedulePersist();

  return {
    success: true,
    remaining: limit - entry.timestamps.length,
  };
}

/**
 * Eine Grenze nur für Fehlversuche: vor dem Versuch fragen (`failuresBlocked`),
 * nach einem Fehlschlag eintragen (`recordFailure`), nach einem Erfolg leeren
 * (`clearFailures`). Anders als `rateLimit` zählt eine gelungene Anmeldung
 * hier nicht mit, deshalb verträgt die Grenze ein langes Fenster: wer sich
 * richtig anmeldet, stößt nie daran, wer rät, hat am Tag nur wenige Versuche.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export function failuresBlocked(key: string, limit: number, windowMs: number): { blocked: boolean; retryAfter?: number } {
  const now = Date.now();
  cleanup(now);
  const entry = store.get(key);
  if (!entry) return { blocked: false };
  const recent = entry.timestamps.filter((t) => now - t < windowMs);
  if (recent.length < limit) return { blocked: false };
  return { blocked: true, retryAfter: Math.ceil((recent[recent.length - limit] + windowMs - now) / 1000) };
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const entry = store.get(key) ?? { timestamps: [] };
  // Mehr als die Grenze muss niemand wissen: die Liste wächst nicht mit jedem Versuch.
  entry.timestamps = [...entry.timestamps.filter((t) => now - t < DAY_MS), now].slice(-200);
  store.set(key, entry);
  schedulePersist();
}

export function clearFailures(key: string): void {
  if (store.delete(key)) schedulePersist();
}
