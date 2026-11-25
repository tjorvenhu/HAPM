/**
 * Die Läufe im Hintergrund und ihr eines Fenster.
 *
 * Ein Vorgang, der länger dauert als eine Anfrage (Reverse-Proxy, Update,
 * Sicherung, Zurückspielen), steht nie als Kasten in einer Seite, sondern im
 * Fenster `RunOverlay`. Es hängt am Rahmen (`ActivityIndicator`), nicht an der
 * Seite: so übersteht es einen Seitenwechsel, und die Pille unten rechts öffnet
 * dasselbe Fenster wieder.
 *
 * Geöffnet wird von außen über `openRun` und `startRun`, wie die globale Suche
 * (`openGlobalSearch`): ein Context um den ganzen Rahmen wäre für zwei Aufrufe
 * zu viel. Kein React und kein `lib/db` hier, die Seiten importieren es.
 */

export type RunKind = 'haproxy' | 'update' | 'backup' | 'restore';

export interface RunRef {
  kind: RunKind;
  id: string;
  /** Titel der Meldung am Ende, schon übersetzt. Nur für Läufe, die ihre Art nicht selbst benennt (Import). */
  label?: string;
}

export interface RunRequest extends RunRef {
  /** Am Ende eine Meldung absetzen. `startRun` setzt es, `openRun` nicht: wer nur nachsieht, wird nicht benachrichtigt. */
  watch: boolean;
}

type Listener = (request: RunRequest) => void;
const openListeners = new Set<Listener>();

/** Das Fenster für einen Lauf öffnen, etwa aus der Historie oder aus einer Meldung. */
export function openRun(ref: RunRef): void {
  for (const listener of openListeners) listener({ ...ref, watch: false });
}

/** Ein eben gestarteter Lauf: das Fenster geht auf, und sein Ende kommt als Meldung. */
export function startRun(ref: RunRef): void {
  for (const listener of openListeners) listener({ ...ref, watch: true });
}

export function subscribeOpenRun(listener: Listener): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

type FinishedListener = (ref: RunRef) => void;
const finishedListeners = new Set<FinishedListener>();

export function emitRunFinished(ref: RunRef): void {
  for (const listener of finishedListeners) listener(ref);
}

/** Für Seiten, die nach dem Ende eines Laufs neu laden wollen. */
export function subscribeRunFinished(listener: FinishedListener): () => void {
  finishedListeners.add(listener);
  return () => {
    finishedListeners.delete(listener);
  };
}

/*
 * Neu laden mitten im Lauf. Beim Tausch von HAPM und beim Zurückspielen ist
 * die Seite danach ein anderer Prozess, oft ein anderes Abbild: sie lädt neu,
 * sobald HAPM wieder antwortet. Das Fenster soll danach wieder offen sein, aber
 * nur nach diesem Neuladen, nicht nach einem F5 (da zeigt die Pille den Lauf).
 * Nach dem Zurückspielen liegt die Anmeldung dazwischen, deshalb
 * `sessionStorage` und eine Frist.
 */
const REOPEN_KEY = 'hapm-reopen-run';
const REOPEN_MAX_AGE_MS = 30 * 60 * 1000;

export interface ReopenRun {
  request: RunRequest;
  /** Das Fenster wieder öffnen. Sonst wird der Lauf nur weiter verfolgt, für die Meldung am Ende. */
  open: boolean;
}

export function reloadKeepingRun(reopen: ReopenRun | null): void {
  try {
    if (reopen) sessionStorage.setItem(REOPEN_KEY, JSON.stringify({ ...reopen, at: Date.now() }));
  } catch {
    // Ohne Speicher geht nur das Fenster verloren, nicht der Lauf.
  }
  window.location.reload();
}

/** Liest den Lauf, den das letzte Neuladen offen halten wollte. Gelöscht wird mit `clearReopenRun`. */
export function peekReopenRun(): ReopenRun | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(REOPEN_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as ReopenRun & { at?: number };
    if (!saved.at || Date.now() - saved.at > REOPEN_MAX_AGE_MS || !saved.request) return null;
    return { request: saved.request, open: saved.open === true };
  } catch {
    return null;
  }
}

export function clearReopenRun(): void {
  try {
    sessionStorage.removeItem(REOPEN_KEY);
  } catch {
    // Nichts zu tun.
  }
}

export function runKey(ref: RunRef): string {
  return `${ref.kind}-${ref.id}`;
}
