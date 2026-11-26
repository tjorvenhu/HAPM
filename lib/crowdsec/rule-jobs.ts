/**
 * Die Warteschlange für Änderungen an den Regeln von CrowdSec.
 *
 * Eine Änderung holt Regeln aus dem Hub (`cscli … install`), danach startet
 * CrowdSec neu. Das dauert länger, als eine Anfrage warten soll, und zwei
 * `cscli`-Läufe nebeneinander schreiben in denselben Hub. Deshalb reiht jede
 * Änderung sich hier ein (Oberfläche, interne API und MCP), und es arbeitet
 * immer nur eine.
 *
 * Was sich einreiht, während ein Lauf arbeitet, hängt an diesen Lauf an.
 * CrowdSec lädt je Lauf einmal neu, am Ende, wenn die Schlange leer ist: jeder
 * Neustart lässt für Sekunden Anfragen ungeprüft durch, und drei Schalter
 * hintereinander sollen das nicht dreimal tun. Was sich während des Neuladens
 * einreiht, beginnt den nächsten Lauf: `cscli` im neu startenden Container
 * scheiterte.
 *
 * Im Speicher und nicht in der Datenbank: HAPM ist ein Prozess, und eine
 * wartende Änderung überlebte seinen Neustart ohnehin nicht. Die letzten Läufe
 * bleiben stehen, damit das Fenster der Läufe ihr Ergebnis noch zeigen kann.
 *
 * Kennt die Regeln selbst nicht: was eine Änderung tut, steht in `actions.ts`.
 */

import { randomUUID } from 'node:crypto';
import { ApiError } from '../api';
import { msg, msgid, type Translatable, type Translator } from '../i18n';
import type { HaproxyStep } from '../types';
import { reloadCrowdsec } from './setup';

/** Die Beschriftung eines Schritts. `name` ist selbst ein Schlüssel und wird eigens übersetzt. */
export interface StepLabel {
  text: string;
  name?: string;
}

export interface RuleJob<T = unknown> {
  /** Woran die Oberfläche den Schalter erkennt: `crs`, `app:<id>`, der Name einer Sammlung, `hub`. */
  key: string;
  /** Der gewünschte Zustand: an oder aus, bei `crs` der Modus. */
  wanted: boolean | string;
  label: StepLabel;
  /** Die Änderung selbst, ohne Neuladen. */
  run: () => Promise<T>;
}

interface Queued {
  job: RuleJob;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface RunStep {
  label: StepLabel;
  ok: boolean;
  detail?: Translatable;
}

interface RuleRun {
  id: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  completedAt: string | null;
  steps: RunStep[];
  queue: Queued[];
  active: Queued | null;
  /** Gelungen, aber noch nicht geladen: bis zum Neuladen am Ende gilt die Änderung nicht. */
  changed: RuleJob[];
}

interface Store {
  /** Die neuesten zuerst. */
  runs: RuleRun[];
  /** Der Lauf, der noch Änderungen annimmt. */
  open: RuleRun | null;
  /** Das Ende des zuletzt begonnenen Laufs: der nächste beginnt erst danach. */
  tail: Promise<void>;
}

/** So viele beendete Läufe bleiben im Speicher. */
const KEPT_RUNS = 20;

/**
 * So lange bleibt ein Lauf nach seiner letzten Änderung offen, bevor er
 * CrowdSec neu lädt. Wer drei Schalter hintereinander umlegt, klickt im
 * Sekundentakt, und manche Änderung ist in Millisekunden getan (eine eigene
 * Whitelist ist nur eine Datei): ohne die Frist begänne der zweite Klick schon
 * einen zweiten Lauf mit einem zweiten Neustart, und in der Pille stünden zwei
 * Vorgänge für eine Handlung.
 */
let graceMs = 1500;

/** Nur für Tests: die Frist, die ein Lauf auf weitere Änderungen wartet. */
export function setRuleGrace(ms: number): void {
  graceMs = ms;
}

const RELOAD_STEP: StepLabel = { text: msgid('CrowdSec neu laden') };

const state = globalThis as unknown as { __hapmCrowdsecRuleJobs?: Store };

function store(): Store {
  return (state.__hapmCrowdsecRuleJobs ??= { runs: [], open: null, tail: Promise.resolve() });
}

/** Was im Schritt steht, wenn er scheitert. Eine Meldung für Menschen bleibt übersetzbar. */
function failureText(err: unknown): Translatable {
  if (err instanceof ApiError) return msg(err.text, err.params);
  return (err instanceof Error ? err.message : String(err)).slice(0, 1500);
}

async function work(run: RuleRun): Promise<void> {
  const done: { entry: Queued; ok: boolean; value?: unknown; error?: unknown }[] = [];
  for (;;) {
    const entry = run.queue.shift();
    if (!entry) {
      // Kurz offen bleiben: kommt in der Frist noch etwas, gehört es zu diesem Lauf.
      if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
      if (run.queue.length > 0) continue;
      break;
    }
    run.active = entry;
    try {
      const value = await entry.job.run();
      run.steps.push({ label: entry.job.label, ok: true });
      run.changed.push(entry.job);
      done.push({ entry, ok: true, value });
    } catch (err) {
      // Die übrigen laufen weiter: sie hängen nicht an dieser Änderung.
      run.steps.push({ label: entry.job.label, ok: false, detail: failureText(err) });
      done.push({ entry, ok: false, error: err });
    }
    run.active = null;
  }
  // Ohne `await` seit der leeren Schlange: ab hier nimmt der Lauf nichts mehr an.
  const jobs = store();
  if (jobs.open === run) jobs.open = null;

  // Auch nach einem Fehler: was schon installiert oder entfernt ist, soll
  // geladen sein und nicht erst beim nächsten Neustart wirken.
  let reloadError: unknown;
  let reloaded = true;
  try {
    await reloadCrowdsec();
    run.steps.push({ label: RELOAD_STEP, ok: true });
  } catch (err) {
    reloaded = false;
    reloadError = err;
    run.steps.push({ label: RELOAD_STEP, ok: false, detail: failureText(err) });
  }
  run.completedAt = new Date().toISOString();
  run.status = run.steps.every((step) => step.ok) ? 'success' : 'error';
  run.changed = [];

  for (const item of done) {
    if (!item.ok) item.entry.reject(item.error);
    else if (!reloaded) item.entry.reject(reloadError);
    else item.entry.resolve(item.value);
  }
}

function beginRun(jobs: Store): RuleRun {
  const run: RuleRun = {
    id: randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    steps: [],
    queue: [],
    active: null,
    changed: [],
  };
  jobs.open = run;
  jobs.runs.unshift(run);
  let finished = 0;
  jobs.runs = jobs.runs.filter((entry) => entry.status === 'running' || ++finished <= KEPT_RUNS);
  jobs.tail = jobs.tail
    .then(() => work(run))
    .catch((err) => {
      console.error(`[crowdsec] Regel-Lauf abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
      run.completedAt ??= new Date().toISOString();
      run.status = 'error';
      run.changed = [];
      if (jobs.open === run) jobs.open = null;
    });
  return run;
}

/**
 * Eine Änderung einreihen. `done` erfüllt sich mit ihrem Ergebnis, wenn sie
 * gelaufen ist UND CrowdSec neu geladen hat, und scheitert mit ihrem Fehler
 * (oder dem des Neuladens). Wartet schon eine Änderung mit demselben Schlüssel,
 * tritt diese an ihre Stelle: die wartende hätte nur einen Zustand hergestellt,
 * den die spätere gleich wieder ändert.
 */
export function enqueueRuleChange<T>(job: RuleJob<T>): { runId: string; done: Promise<T> } {
  const jobs = store();
  const run = jobs.open ?? beginRun(jobs);
  const done = new Promise<T>((resolve, reject) => {
    const entry: Queued = { job, resolve: resolve as (value: unknown) => void, reject };
    const waiting = run.queue.findIndex((queued) => queued.job.key === job.key);
    if (waiting < 0) {
      run.queue.push(entry);
      return;
    }
    const [replaced] = run.queue.splice(waiting, 1, entry);
    replaced.reject(new ApiError(msg('Eine spätere Änderung hat diese ersetzt, bevor sie an der Reihe war.'), 409));
  });
  // Wer nicht wartet (die Oberfläche), liest das Ergebnis aus dem Lauf.
  done.catch(() => undefined);
  return { runId: run.id, done };
}

/**
 * Was aussteht: Schlüssel und gewünschter Zustand, für die Schalter der Seite.
 * Dazu zählt, was wartet, was gerade läuft und was gelungen, aber noch nicht
 * geladen ist. Eine gescheiterte Änderung steht nicht mehr aus: ihr Schalter
 * zeigt wieder, was ist.
 */
export function pendingRuleChanges(): Record<string, boolean | string> {
  const pending: Record<string, boolean | string> = {};
  // Älteste zuerst, damit die spätere Änderung desselben Schlüssels gilt.
  for (const run of [...store().runs].reverse()) {
    if (run.status !== 'running') continue;
    const jobs = [...run.changed, ...(run.active ? [run.active.job] : []), ...run.queue.map((entry) => entry.job)];
    for (const job of jobs) pending[job.key] = job.wanted;
  }
  return pending;
}

/** Ob gerade ein Lauf arbeitet oder ansteht. Solange lädt niemand sonst CrowdSec neu. */
export function ruleRunActive(): boolean {
  return store().runs.some((run) => run.status === 'running');
}

function labelText(label: StepLabel, t: Translator['t']): string {
  return t(label.text, label.name ? { name: t(label.name) } : undefined);
}

/** Was noch kommt, der erste Eintrag läuft gerade. Am Ende steht immer das Neuladen. */
function remaining(run: RuleRun, t: Translator['t']): string[] {
  if (run.status !== 'running') return [];
  const entries = [...(run.active ? [run.active] : []), ...run.queue];
  return [...entries.map((entry) => labelText(entry.job.label, t)), labelText(RELOAD_STEP, t)];
}

export interface RuleRunView {
  $id: string;
  status: RuleRun['status'];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  steps: HaproxyStep[];
  pending: string[];
}

/**
 * Ein Lauf in der Form, die das Fenster der Läufe liest
 * (`components/runs/sources.ts`), in der Sprache der Anfrage: die Schritte
 * tragen Namen, also übersetzt sie der Server und nicht die Seite.
 */
export function ruleRunView(id: string, t: Translator['t']): RuleRunView | null {
  const run = store().runs.find((entry) => entry.id === id);
  if (!run) return null;
  const steps: HaproxyStep[] = run.steps.map((step) => ({
    label: labelText(step.label, t),
    ok: step.ok,
    ...(step.detail ? { detail: t(step.detail) } : {}),
  }));
  return {
    $id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.status === 'error' ? (steps.find((step) => !step.ok)?.detail ?? null) : null,
    steps,
    pending: remaining(run, t),
  };
}

/** Die laufenden Läufe für die Pille unten rechts, mit dem Schritt, der gerade läuft. */
export function activeRuleRuns(t: Translator['t']): { id: string; startedAt: string; step: string | null }[] {
  return store()
    .runs.filter((run) => run.status === 'running')
    .map((run) => ({ id: run.id, startedAt: run.startedAt, step: remaining(run, t)[0] ?? null }));
}
