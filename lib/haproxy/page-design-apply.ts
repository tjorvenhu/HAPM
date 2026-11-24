/**
 * Das gespeicherte Design auf die Maschine bringen.
 *
 * ── Die Fehlerdateien gehen den vorhandenen Weg ──
 *
 * `updateErrorPages` in `provision.ts`: nur was `haproxy.cfg` nennt, Sicherung,
 * `haproxy -c`, Reload, bei einem Fehlschlag zurück. Hier steht kein zweiter.
 * Nach einem geänderten Design weicht jede Datei von dem ab, was jetzt
 * entstünde, und wird deshalb neu geschrieben.
 *
 * ── Die Seiten der Passwortsperre kommen danach ──
 *
 * `provision.ts` schreibt sie vor jedem Schreibvorgang an der Konfiguration
 * (`ensureLockPages`), sobald ihre Prüfsumme abweicht. Ein gespeichertes
 * Design soll aber nicht auf den nächsten Vorgang an irgendeinem Ziel warten.
 * Deshalb schreibt dieser Schritt sie selbst, mit denselben Kommandos
 * (`lock-page.ts`), und nur, wenn die Konfiguration auf sie verweist.
 *
 * Als eigener Schritt mit eigenem Reload, nach den Fehlerdateien: so stellt
 * jeder Teil bei einem Fehlschlag genau seine eigenen Dateien zurück, und
 * keiner muss wissen, ob der andere neu geladen hat. Der Preis ist ein zweiter
 * Reload, wenn sich beides ändert und eine Passwortsperre in Gebrauch ist.
 *
 * Dieser zweite Schritt läuft außerhalb des Locks aus `provision.ts`, das nicht
 * exportiert ist. Ein gleichzeitiger Vorgang dort schriebe dieselben drei
 * Dateien mit demselben Inhalt.
 */

import { createHash } from 'node:crypto';
import { sshExec } from '../ssh';
import { getSSHConfig } from '../helpers';
import { buildCommand } from '../shell';
import type { Server } from '../types';
import { HAPROXY_CFG, LOCK_PAGE_DIR, usesLockPages } from './config';
import { parseDigests, type ErrorPageEntry } from './error-pages';
import { lockPages, lockPageDigestCommand, lockPageWriteCommand } from './lock-page';
import { updateErrorPages, type ProvisionStep } from './provision';

const SHORT_MS = 30_000;
const RELOAD_MS = 60_000;

/** Dasselbe Kommando wie `RELOAD_ARGV` in `provision.ts`. */
const RELOAD_ARGV = ['hapm-reload'];

const previousOf = (path: string) => `${path}.hapm-previous`;

function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

async function updateLockPages(server: Server): Promise<ProvisionStep[]> {
  const ssh = await getSSHConfig(server);

  const config = await sshExec(ssh, buildCommand(['cat', HAPROXY_CFG]), SHORT_MS);
  // Ohne Verweis in der Konfiguration liest HAProxy die Seiten nicht. Sie
  // entstehen mit der ersten Passwortsperre, dann schon im gespeicherten Design.
  if (config.code !== 0 || !usesLockPages(config.stdout)) return [];

  const pages = lockPages().map((page) => ({
    path: `${LOCK_PAGE_DIR}/${page.file}`,
    html: page.html,
    digest: createHash('sha256').update(page.html, 'utf8').digest('hex'),
  }));
  const sums = await sshExec(ssh, lockPageDigestCommand(pages.map((page) => page.path)), SHORT_MS);
  const present = parseDigests(sums.stdout);
  const stale = pages.filter((page) => present.get(page.path) !== page.digest);
  if (stale.length === 0) return [];

  const steps: ProvisionStep[] = [];
  // Eine Seite, die es vorher nicht gab, bleibt bei einem Fehlschlag liegen:
  // die Konfiguration verweist auf sie, und ohne sie startete HAProxy nicht.
  const saved = stale.filter((page) => present.has(page.path));
  const restore = async () => {
    for (const page of saved) {
      await sshExec(ssh, buildCommand(['cp', '-a', '--', previousOf(page.path), page.path]), SHORT_MS).catch(
        () => null
      );
    }
  };
  const failed = (label: string, detail: string): ProvisionStep[] => [
    ...steps,
    { label, ok: false, detail: `${detail}. Die Seiten der Passwortabfrage sind wieder auf dem Stand von vorher.` },
  ];

  for (const page of saved) {
    const copy = await sshExec(ssh, buildCommand(['cp', '-a', '--', page.path, previousOf(page.path)]), SHORT_MS);
    if (copy.code !== 0) {
      return [...steps, { label: `${page.path} sichern`, ok: false, detail: tail(copy.stderr) }];
    }
  }

  for (const page of stale) {
    const write = await sshExec(ssh, lockPageWriteCommand(LOCK_PAGE_DIR, page.path, page.html), SHORT_MS);
    if (write.code !== 0) {
      await restore();
      return failed(`${page.path} schreiben`, tail(write.stderr));
    }
  }
  steps.push({
    label: `${stale.length} Seite(n) der Passwortabfrage geschrieben`,
    ok: true,
    detail: stale.map((page) => page.path).join('\n'),
  });

  const check = await sshExec(ssh, buildCommand(['haproxy', '-c', '-f', HAPROXY_CFG]), SHORT_MS);
  if (check.code !== 0) {
    await restore();
    return failed('Konfiguration prüfen', tail(check.stderr || check.stdout));
  }

  const reload = await sshExec(ssh, buildCommand(RELOAD_ARGV), RELOAD_MS);
  if (reload.code !== 0) {
    await restore();
    await sshExec(ssh, buildCommand(RELOAD_ARGV), RELOAD_MS).catch(() => null);
    return failed('HAProxy neu laden', tail(reload.stderr || reload.stdout));
  }
  steps.push({ label: 'HAProxy mit den Seiten der Passwortabfrage neu geladen', ok: true });
  return steps;
}

/**
 * Fehlerdateien und Passwortabfrage auf den Stand des gespeicherten Designs
 * bringen. Der Aufrufer hat es vorher geladen oder gespeichert
 * (`page-design-store.ts`).
 *
 * Zurück kommen die Schritte und, was die Maschine danach über ihre
 * Fehlerdateien sagt.
 */
export async function applyPageDesign(
  server: Server
): Promise<{ steps: ProvisionStep[]; entries: ErrorPageEntry[] }> {
  const errors = await updateErrorPages(server);
  if (errors.steps.some((step) => !step.ok)) return errors;
  return { steps: [...errors.steps, ...(await updateLockPages(server))], entries: errors.entries };
}
