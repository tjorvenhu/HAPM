/**
 * CrowdSec einrichten: die Dateien für beide Container schreiben, den Bouncer
 * anmelden, die Freigabeliste anlegen.
 *
 * Wie bei HAProxy richtet HAPM das selbst ein (`lib/bootstrap.ts`). Die Dateien
 * entstehen beim Start, bevor Compose die Container von CrowdSec startet (sie
 * warten auf `service_healthy` von HAPM). Den Bouncer meldet CrowdSec beim
 * eigenen Start selbst an, aus `/run/secrets/bouncer_key_hapm`. Fehlt er
 * trotzdem (CrowdSec lief schon, bevor es den Schlüssel gab), holt
 * `reconcileCrowdsec` das nach.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { engine } from '../docker';
import { HAPROXY_LOG_FILE } from '../haproxy-log';
import { cscli, cscliJson } from './cscli';
import { HAPROXY_CFG, parseHaproxyConfig } from '../haproxy/config';
import {
  APP_RULES,
  CRS_APPS_FILE,
  appUsage,
  appWhitelistFile,
  renderAppWhitelist,
  renderCrsAppScopes,
  type AppRules,
  type AppUse,
} from './apps';
import {
  renderAcquis,
  renderBackendParser,
  renderBouncerConfig,
  renderCrsMethods,
  readCrsMode,
  isValidBouncerKey,
  type CrsMode,
} from './files';
import {
  ACQUIS_FILE,
  ALLOWLIST_NAME,
  BOUNCER_CONFIG_FILE,
  BOUNCER_KEY_FILE,
  BOUNCER_NAME,
  CRS_METHODS_FILE,
  PARSER_FILE,
  bouncerContainerName,
  crowdsecContainerName,
  DISABLED_FILE,
  crowdsecDir,
  crowdsecDisabled,
  crowdsecInStack,
} from './paths';

function file(relative: string): string {
  return path.join(crowdsecDir(), relative);
}

function readText(relative: string): string | null {
  try {
    return fs.readFileSync(file(relative), 'utf8');
  } catch {
    return null;
  }
}

/** Schreibt nur, wenn sich etwas ändert. Gibt zurück, ob geschrieben wurde. */
function writeIfChanged(relative: string, content: string, mode = 0o644): boolean {
  if (readText(relative) === content) return false;
  const target = file(relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
  return true;
}

/** Der Schlüssel des Bouncers. Die Datei ist die Wahrheit: CrowdSec liest sie. */
export function bouncerKey(): string {
  const stored = readText(BOUNCER_KEY_FILE)?.trim() ?? '';
  if (isValidBouncerKey(stored)) return stored;
  const key = randomBytes(24).toString('hex');
  writeIfChanged(BOUNCER_KEY_FILE, key, 0o600);
  return key;
}

export function currentCrsMode(): CrsMode {
  return readCrsMode(readText(ACQUIS_FILE));
}

export interface CrowdsecFiles {
  /** Ob der Ordner überhaupt eingebunden ist. Ohne ihn gibt es kein CrowdSec. */
  mounted: boolean;
  crowdsecChanged: boolean;
  bouncerChanged: boolean;
}

/**
 * Die Dateien schreiben. Ohne eingebundenen Ordner (Entwicklung ohne Compose,
 * Stack ohne CrowdSec) geschieht nichts.
 */
export function writeCrowdsecFiles(crs: CrsMode = currentCrsMode()): CrowdsecFiles {
  if (!crowdsecInStack() || !fs.existsSync(crowdsecDir()) || crowdsecDisabled()) {
    return { mounted: false, crowdsecChanged: false, bouncerChanged: false };
  }
  const key = bouncerKey();
  const acquis = writeIfChanged(ACQUIS_FILE, renderAcquis(crs));
  const parser = writeIfChanged(PARSER_FILE, renderBackendParser());
  // Auch bei abgeschalteten OWASP-Regeln: die Datei liest nur, wer sie lädt.
  const methods = writeIfChanged(CRS_METHODS_FILE, renderCrsMethods());
  // Die Ausnahmen der Anwendungen nach den Zielen in haproxy.cfg. Was dafür
  // aus dem Hub fehlt oder übrig ist, holt `syncApps` nach, sobald CrowdSec läuft.
  const uses = currentAppUsage();
  const apps = uses ? writeAppFiles(uses) : false;
  const bouncer = writeIfChanged(BOUNCER_CONFIG_FILE, renderBouncerConfig(key), 0o600);
  // CrowdSec liest eine Datei, die beim Start fehlt, nicht nach.
  try {
    if (!fs.existsSync(HAPROXY_LOG_FILE)) {
      fs.mkdirSync(path.dirname(HAPROXY_LOG_FILE), { recursive: true });
      fs.writeFileSync(HAPROXY_LOG_FILE, '');
    }
  } catch {
    // Ohne Log-Ordner gibt es auch keinen Mitschnitt; die WAF geht trotzdem.
  }
  const result = { mounted: true, crowdsecChanged: acquis || parser || methods || apps, bouncerChanged: bouncer };
  // Beim Start laufen die Container noch nicht (Compose startet sie nach HAPM)
  // oder noch mit den alten Dateien (Update von HAPM). Den Neustart holt
  // `reconcileCrowdsec` nach, sobald sie laufen.
  const pending = pendingChanges();
  pending.crowdsec ||= result.crowdsecChanged;
  pending.bouncer ||= result.bouncerChanged;
  return result;
}

const store = globalThis as unknown as { __hapmCrowdsecPending?: { crowdsec: boolean; bouncer: boolean } };

/** Ob die eigene Whitelist einer Anwendung liegt. */
export function appWhitelistPresent(app: AppRules): boolean {
  return readText(appWhitelistFile(app.id)) !== null;
}

/**
 * Welche Anwendung an welchen Zielen läuft, aus `haproxy.cfg`. Ohne Datei (noch
 * nicht eingerichtet) an keinem. `null`, wenn sie da, aber nicht lesbar ist:
 * dann bleiben die Ausnahmen, wie sie sind, statt mit den Zielen zu verschwinden.
 */
export function currentAppUsage(): AppUse[] | null {
  if (!fs.existsSync(HAPROXY_CFG)) return [];
  try {
    return appUsage(parseHaproxyConfig(fs.readFileSync(HAPROXY_CFG, 'utf8')));
  } catch {
    return null;
  }
}

/** Was in den Dateien der Anwendungen stehen soll: Pfad und Inhalt, `null` heißt keine Datei. */
function appFiles(uses: readonly AppUse[]): [string, string | null][] {
  return [
    [CRS_APPS_FILE, renderCrsAppScopes(uses)],
    ...APP_RULES.filter((app) => app.local).map((app): [string, string | null] => {
      const use = uses.find((entry) => entry.app.id === app.id);
      return [appWhitelistFile(app.id), use ? renderAppWhitelist(app, use.backends) : null];
    }),
  ];
}

/** Ob `writeAppFiles` etwas ändern würde. */
export function appFilesDiffer(uses: readonly AppUse[]): boolean {
  return appFiles(uses).some(([relative, content]) => readText(relative) !== content);
}

/**
 * Die eigenen Whitelists (nur für die Backends der Ziele mit der Anwendung) und
 * die Hosts der OWASP-Ausnahmen schreiben, die Whitelists ungenannter
 * Anwendungen entfernen. Gibt zurück, ob sich etwas geändert hat.
 */
export function writeAppFiles(uses: readonly AppUse[]): boolean {
  let changed = false;
  for (const [relative, content] of appFiles(uses)) {
    if (content !== null) {
      changed = writeIfChanged(relative, content) || changed;
      continue;
    }
    try {
      fs.unlinkSync(file(relative));
      changed = true;
    } catch {
      // Lag nicht da.
    }
  }
  return changed;
}

/** Den Schalter der Oberfläche setzen (`crowdsecDisabled`). */
export function setDisabledMarker(disabled: boolean): void {
  const target = file(DISABLED_FILE);
  if (disabled) fs.writeFileSync(target, `${new Date().toISOString()}\n`);
  else fs.rmSync(target, { force: true });
}

/**
 * Abgeschaltet heißt: beide Container stehen. Startet sie jemand neu (etwa
 * `docker compose up -d` bei einem Update), hält der Abgleich sie wieder an.
 * Gibt zurück, was angehalten wurde.
 */
export async function keepCrowdsecStopped(): Promise<string[]> {
  const stopped: string[] = [];
  for (const name of [bouncerContainerName(), crowdsecContainerName()]) {
    if (await running(name)) {
      await engine.stop(name).catch(() => undefined);
      stopped.push(name);
    }
  }
  return stopped;
}

function pendingChanges() {
  return (store.__hapmCrowdsecPending ??= { crowdsec: false, bouncer: false });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Antworten der Engine */
async function running(name: string): Promise<boolean> {
  const container: any = await engine.findContainer(name).catch(() => null);
  return Boolean(container?.State?.Running);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * CrowdSec mit neuen Quellen, Parsern oder Sammlungen starten. Ein Neustart
 * und kein Signal: neue Quellen (die WAF mit anderen Regeln) übernimmt er so
 * sicher. Die Regeln ändern sich selten, und in den Sekunden des Neustarts
 * gehen Anfragen ungeprüft durch, wie bei jedem Ausfall des Bouncers.
 */
export async function reloadCrowdsec(): Promise<void> {
  if (!(await running(crowdsecContainerName()))) return;
  await engine.restart(crowdsecContainerName());
  // Der Neustart hat geladen, was `writeCrowdsecFiles` vorgemerkt hat: sonst
  // startete der Abgleich CrowdSec eine Viertelstunde später ein zweites Mal.
  pendingChanges().crowdsec = false;
}

/**
 * Den Rest nachholen, wenn die Container laufen: Bouncer anmelden,
 * Freigabeliste anlegen, nach geänderten Dateien neu laden. Scheitert nie nach
 * außen, das Ergebnis steht im Log.
 */
export async function reconcileCrowdsec(files?: CrowdsecFiles): Promise<string[]> {
  const notes: string[] = [];
  if (!crowdsecInStack()) return notes;
  try {
    if (!(await running(crowdsecContainerName()))) return notes;

    const bouncers = await cscliJson<{ name?: string }[]>(['bouncers', 'list']).catch(() => null);
    const registered = Array.isArray(bouncers) && bouncers.some((b) => b?.name === BOUNCER_NAME);
    if (bouncers && !registered) {
      const added = await cscli(['bouncers', 'add', BOUNCER_NAME, '--key', bouncerKey()]);
      notes.push(added.code === 0 ? 'Bouncer angemeldet.' : `Bouncer nicht angemeldet: ${added.stderr.trim()}`);
      if (added.code === 0 && (await running(bouncerContainerName()))) {
        await engine.restart(bouncerContainerName()).catch(() => undefined);
      }
    }

    await ensureAllowlist();
    const { syncAllowFile } = await import('./allow-file');
    const { parseAllowlist } = await import('./data');
    const allow = await cscliJson(['allowlists', 'inspect', ALLOWLIST_NAME]).catch(() => null);
    if (allow) await syncAllowFile(parseAllowlist(allow));

    const pending = pendingChanges();
    if (files?.crowdsecChanged || pending.crowdsec) {
      await reloadCrowdsec();
      pending.crowdsec = false;
      notes.push('CrowdSec neu geladen.');
    }
    if ((files?.bouncerChanged || pending.bouncer) && (await running(bouncerContainerName()))) {
      await engine.restart(bouncerContainerName());
      pending.bouncer = false;
      notes.push('Bouncer neu gestartet.');
    }
  } catch (err) {
    notes.push(`CrowdSec: ${err instanceof Error ? err.message : String(err)}`);
  }
  return notes;
}

/** Die Freigabeliste von HAPM, falls es sie noch nicht gibt. */
export async function ensureAllowlist(): Promise<void> {
  const inspect = await cscli(['allowlists', 'inspect', ALLOWLIST_NAME, '-o', 'json']);
  if (inspect.code === 0) return;
  await cscli(['allowlists', 'create', ALLOWLIST_NAME, '-d', 'Freigaben aus HAPM']);
}
