/**
 * CrowdSec für den Abgleich zwischen Knoten (docs/hochverfuegbarkeit.md): den
 * Stand lesen, den ein Hauptknoten weitergibt, und ihn auf einem Folgeknoten
 * herstellen.
 *
 * ── Was dazugehört ──
 *
 * Die Sperren von Hand, die Freigaben, der Schalter der OWASP-Regeln und die
 * zuschaltbaren Sammlungen: was jemand in HAPM eingestellt hat. Nicht dazu
 * gehört, was CrowdSec selbst tut: seine eigenen Sperren, die Ereignisse, die
 * Gemeinschaftsliste. Das verhängt und holt jeder Knoten für sich, und jede
 * neue Sperre dort wäre sonst ein Abgleich.
 *
 * Die Ausnahmen für Anwendungen stehen in `haproxy.cfg` (`# hapm-app:`) und
 * kommen mit den Dateien: `queueAppSync` gleicht sie nach jedem Stand ab.
 *
 * ── Kein Protokoll je Zeile ──
 *
 * Der Abgleich schreibt eine Zeile ins Protokoll (`sync_applied`). Zwanzig
 * übernommene Sperren sind dort nicht zwanzig Handlungen.
 */

import { cscli, cscliError, cscliJson, cscliOk } from './cscli';
import { isManualBan, parseAddress, parseAllowlist, parseDecisions } from './data';
import { CRS_MODES, OPTIONAL_COLLECTIONS, type CrsMode } from './files';
import { ALLOWLIST_NAME } from './paths';
import { enqueueRuleChange } from './rule-jobs';
import { currentCrsMode, ensureAllowlist } from './setup';
import { msgid } from '../i18n/translate';
import { planAllowlist, planBans, type SyncAllow, type SyncBan, type SyncCrowdsec } from '../sync/data';
import type { CrowdsecActor } from './actions';

/* eslint-disable @typescript-eslint/no-explicit-any -- Ausgabe von cscli */

async function manualBans() {
  const decisions = parseDecisions(await cscliJson(['decisions', 'list', '--limit', '1000']), Date.now());
  return decisions.filter((decision) => isManualBan(decision) && decision.type === 'ban' && !decision.simulated);
}

async function allowlist(): Promise<SyncAllow[]> {
  await ensureAllowlist();
  return parseAllowlist(await cscliJson(['allowlists', 'inspect', ALLOWLIST_NAME])).map((entry) => ({
    value: entry.value,
    description: entry.description,
    expiresAt: entry.expiresAt,
  }));
}

async function optionalCollections(): Promise<string[]> {
  const json = await cscliJson<any>(['hub', 'list']);
  const enabled = new Set<string>(
    (Array.isArray(json?.collections) ? json.collections : [])
      .filter((item: any) => String(item?.status ?? '').includes('enabled'))
      .map((item: any) => String(item.name))
  );
  return OPTIONAL_COLLECTIONS.map((entry) => entry.name).filter((name) => enabled.has(name));
}

/** Der Stand, den ein Hauptknoten weitergibt. Wirft, wenn CrowdSec nicht antwortet. */
export async function readCrowdsecState(): Promise<SyncCrowdsec> {
  const [bans, allow, collections] = await Promise.all([manualBans(), allowlist(), optionalCollections()]);
  const out: SyncBan[] = [];
  for (const ban of bans) {
    const address = parseAddress(ban.value);
    if (!address || !ban.until) continue;
    out.push({ value: address.value, scope: address.scope, reason: ban.reason, createdAt: ban.createdAt, until: ban.until });
  }
  return { bans: out, allowlist: allow, crs: currentCrsMode(), collections };
}

/**
 * Den Stand eines Hauptknotens hier herstellen. Gibt zurück, was sich geändert
 * hat, in Worten für den Lauf. Leer: es lag schon so vor.
 *
 * Die Freigaben vor den Sperren: CrowdSec hebt beim Freigeben die Sperren der
 * Adresse auf. Die Regeln zuletzt und nur, wenn sie abweichen: jede Änderung
 * dort startet CrowdSec neu, und solange gehen Anfragen ungeprüft durch.
 */
export async function applyCrowdsecState(wanted: SyncCrowdsec, actor: CrowdsecActor): Promise<string[]> {
  const notes: string[] = [];
  const now = Date.now();

  const allow = planAllowlist(wanted.allowlist, await allowlist(), now);
  for (const value of allow.remove) await cscliOk(['allowlists', 'remove', ALLOWLIST_NAME, value]);
  for (const entry of allow.add) {
    if (!parseAddress(entry.value)) continue;
    await cscliOk([
      'allowlists',
      'add',
      ALLOWLIST_NAME,
      entry.value,
      '-d',
      entry.description || 'HAPM',
      ...(entry.seconds === null ? [] : ['-e', `${entry.seconds}s`]),
    ]);
  }
  if (allow.add.length + allow.remove.length > 0) notes.push(`Freigaben: ${allow.add.length} gesetzt, ${allow.remove.length} entfernt`);

  const local = (await manualBans()).map((ban) => ({ id: ban.id, value: ban.value, until: ban.until }));
  const bans = planBans(wanted.bans, local, now);
  for (const id of bans.remove) await cscliOk(['decisions', 'delete', '--id', String(id)]);
  const refused: string[] = [];
  let allowed = 0;
  for (const ban of bans.add) {
    if (!parseAddress(ban.value)) continue;
    const result = await cscli([
      'decisions',
      'add',
      ban.scope === 'ip' ? '--ip' : '--range',
      ban.value,
      '--duration',
      `${ban.seconds}s`,
      '--type',
      'ban',
      '--reason',
      ban.reason || 'Gesperrt in HAPM',
    ]);
    if (result.code === 0) continue;
    // Eine freigegebene Adresse sperrt CrowdSec nicht (geprüft mit 1.8.2), und
    // HAProxy fragte es für sie ohnehin nicht: kein Fehler, die Freigabe gilt.
    if (/allowlisted/i.test(`${result.stderr}${result.stdout}`)) allowed++;
    else refused.push(`${ban.value}: ${cscliError(result)}`);
  }
  const set = bans.add.length - refused.length - allowed;
  if (set + bans.remove.length > 0) notes.push(`Sperren: ${set} gesetzt, ${bans.remove.length} aufgehoben`);
  if (refused.length > 0) throw new Error(`CrowdSec hat Sperren nicht angenommen: ${refused.join('; ').slice(0, 600)}`);

  const jobs: Promise<unknown>[] = [];
  const { setCrsMode, setCollection } = await import('./actions');
  const crs = CRS_MODES.includes(wanted.crs as CrsMode) ? (wanted.crs as CrsMode) : null;
  if (crs && crs !== currentCrsMode()) {
    jobs.push(
      enqueueRuleChange({
        key: 'crs',
        wanted: crs,
        label: { text: crs === 'off' ? msgid('OWASP-Regeln: aus') : msgid('OWASP-Regeln: an') },
        run: () => setCrsMode({ crs }, actor, { reload: false }),
      }).done
    );
    notes.push(`OWASP-Regeln: ${crs === 'off' ? 'aus' : 'an'}`);
  }
  const installed = new Set(await optionalCollections());
  for (const entry of OPTIONAL_COLLECTIONS) {
    const on = wanted.collections.includes(entry.name);
    if (on === installed.has(entry.name)) continue;
    jobs.push(
      enqueueRuleChange({
        key: entry.name,
        wanted: on,
        label: { text: on ? msgid('{name} einschalten') : msgid('{name} ausschalten'), name: entry.label },
        run: () => setCollection({ name: entry.name, installed: on }, actor, { reload: false }),
      }).done
    );
    notes.push(`${entry.label}: ${on ? 'an' : 'aus'}`);
  }
  await Promise.all(jobs);
  return notes;
}
