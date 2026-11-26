/**
 * Die Ersteinrichtung der Maschine.
 *
 * Läuft bei jedem Start von HAPM und tut nur, was fehlt: Verzeichnisse,
 * Fehlerseiten, ein Platzhalter-Zertifikat, die Grundkonfiguration und acme.sh.
 * Danach kann HAProxy starten, und in der Oberfläche lässt sich das erste Ziel
 * anlegen. Vorhandenes wird hier nie überschrieben. Danach zieht
 * `followPagesAfterStart` die Fehlerseiten nach, die HAPM selbst geschrieben
 * hat und die nach einem Update anders aussähen.
 *
 * Geschrieben wird hier direkt über `fs` und nicht über Kommandos: `/etc/haproxy`
 * ist ein Volume dieses Containers.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CROWDSEC_SPOE_DIR,
  CROWDSEC_SPOE_FILE,
  CROWDSEC_ALLOW_FILE,
  HAPROXY_CFG,
  HAPROXY_CERT_DIR,
  LOCK_PAGE_DIR,
  crowdsecSpoeConfig,
} from './haproxy/config';
import { reloadForCrowdsec } from './haproxy/provision';
import { localServer } from './helpers';
import { writeCrowdsecFiles } from './crowdsec/setup';
import { crowdsecDisabled, crowdsecInStack } from './crowdsec/paths';
import { ERROR_DIR, renderBaseConfig } from './haproxy/base-config';
import { errorFiles } from './haproxy/error-pages';
import { defaultPageDesign, type PageDesign } from './haproxy/page-design';
import { loadPageDesign } from './haproxy/page-design-store';
import { rememberWrittenPages } from './haproxy/page-files';
import { loadMailBranding } from './mail/branding';
import { ensureAcme } from './acme';
import { localExec } from './ssh';
import { buildCommand } from './shell';
import { engine, haproxyContainerName } from './docker';
import { msgid } from './i18n/translate';

/** Feste Beschriftungen und Details sind deutsche Schlüssel (`msgid`), die
 *  Übersicht übersetzt sie beim Zeigen. Details mit Werten bleiben deutsch. */
export interface BootstrapStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface BootstrapState {
  status: 'pending' | 'running' | 'ok' | 'error' | 'skipped';
  steps: BootstrapStep[];
  finishedAt: string | null;
}

const globalState = globalThis as unknown as { __hapmBootstrap?: BootstrapState };

export function bootstrapState(): BootstrapState {
  return (globalState.__hapmBootstrap ??= { status: 'pending', steps: [], finishedAt: null });
}

/** Das Zertifikat, das HAProxy zeigt, solange es für eine Domain kein eigenes gibt. */
const FALLBACK_PEM = `${HAPROXY_CERT_DIR}/000-hapm-default.pem`;

/**
 * HAProxy lädt `crt /etc/haproxy/certs/` als Ganzes und startet nicht, wenn das
 * Verzeichnis leer ist. Vor dem ersten echten Zertifikat liegt deshalb ein
 * selbst signiertes darin. Sein Name sortiert es nach vorn: HAProxy nimmt das
 * zuerst geladene für Anfragen, zu deren Namen kein Zertifikat passt.
 */
async function ensureFallbackCertificate(): Promise<BootstrapStep> {
  const present = fs.readdirSync(HAPROXY_CERT_DIR).some((name) => name.endsWith('.pem'));
  if (present) return { label: msgid('Platzhalter-Zertifikat'), ok: true, detail: msgid('Es liegen schon Zertifikate vor.') };

  const dir = fs.mkdtempSync('/tmp/hapm-cert-');
  try {
    const res = await localExec(
      buildCommand([
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
        '-subj', '/CN=hapm.invalid',
        '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`,
      ]) + ' 2>&1',
      60_000
    );
    if (res.code !== 0) {
      return { label: msgid('Platzhalter-Zertifikat'), ok: false, detail: res.stdout.trim().slice(-300) };
    }
    const pem = fs.readFileSync(`${dir}/cert.pem`, 'utf8') + fs.readFileSync(`${dir}/key.pem`, 'utf8');
    fs.writeFileSync(FALLBACK_PEM, pem, { mode: 0o600 });
    return { label: msgid('Platzhalter-Zertifikat'), ok: true, detail: msgid('Selbst signiertes Zertifikat angelegt.') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Das gespeicherte Design der Fehlerseiten. Gelesen wird es bei jedem Start,
 * auch wenn darunter nichts einzurichten ist: danach gilt es im Prozess, und
 * die Seiten der Passwortsperre entstehen bei jedem Schreibvorgang daraus
 * (`lib/haproxy/page-design.ts`).
 *
 * Lässt es sich nicht lesen, entstehen fehlende Dateien im Design von HAPM:
 * ohne sie startete HAProxy nicht.
 */
async function storedDesign(): Promise<{ design: PageDesign; note: string }> {
  try {
    return { design: await loadPageDesign(), note: '' };
  } catch (err) {
    console.error('[bootstrap] Design der Fehlerseiten nicht lesbar:', err);
    return {
      design: defaultPageDesign(),
      note: ' Das gespeicherte Design ließ sich nicht lesen, es gilt das von HAPM.',
    };
  }
}

function ensureErrorFiles(stored: { design: PageDesign; note: string }): {
  step: BootstrapStep;
  statuses: number[];
  written: { path: string; content: string }[];
} {
  const files = errorFiles(stored.design);
  const written: { path: string; content: string }[] = [];
  for (const file of files) {
    const target = path.posix.join(ERROR_DIR, `${file.status}.http`);
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, file.content);
    written.push({ path: target, content: file.content });
  }
  return {
    step: {
      label: msgid('Fehlerseiten'),
      ok: true,
      detail:
        (written.length ? `${written.length} Fehlerseiten angelegt.` : msgid('Alle Fehlerseiten liegen vor.')) +
        stored.note,
    },
    statuses: files.map((file) => file.status),
    written,
  };
}

/** Wie lange das Nachziehen nach dem Start wartet: HAProxy soll stehen, bevor es neu lädt. */
const FOLLOW_DELAY_MS = 20_000;

/**
 * Die Fehlerseiten nachziehen, die HAPM selbst geschrieben hat und die nach
 * einem Update anders aussähen (`followPageChanges`). Mit Abstand zum Start
 * und ohne ihn aufzuhalten: beim allerersten `compose up` startet HAProxy erst,
 * wenn HAPM bereit ist, und ein Reload davor scheiterte. Scheitert es trotzdem,
 * stehen die Dateien wie vorher, und der nächste Start versucht es wieder.
 */
function followPagesAfterStart(): void {
  setTimeout(() => {
    void (async () => {
      try {
        const [{ followPageChanges }, { getProxyServer }, { systemActor }, { LOCAL_SERVER_ID }] = await Promise.all([
          import('./haproxy/page-design-apply'),
          import('./haproxy/provision'),
          import('./audit'),
          import('./helpers'),
        ]);
        // Auf einem Folgeknoten kommen die Fehlerseiten mit dem Abgleich.
        if (await (await import('./sync/role')).isReplica()) return;
        await loadPageDesign();
        await followPageChanges(await getProxyServer(LOCAL_SERVER_ID), systemActor(), 'Start');
      } catch (err) {
        console.error('[fehlerseiten] Nachziehen nach dem Start gescheitert:', err instanceof Error ? err.message : err);
      }
    })();
  }, FOLLOW_DELAY_MS);
}

function ensureBaseConfig(errorStatuses: number[]): BootstrapStep {
  if (fs.existsSync(HAPROXY_CFG)) {
    return { label: msgid('Konfiguration'), ok: true, detail: `${HAPROXY_CFG} liegt vor und bleibt unverändert.` };
  }
  const ipv6 = fs.existsSync('/proc/net/if_inet6') && fs.readFileSync('/proc/net/if_inet6', 'utf8').trim() !== '';
  fs.writeFileSync(HAPROXY_CFG, renderBaseConfig({ ipv6, errorStatuses }), { mode: 0o644 });
  return {
    label: msgid('Konfiguration'),
    ok: true,
    detail: msgid(ipv6 ? 'Grundkonfiguration angelegt.' : 'Grundkonfiguration angelegt (ohne IPv6, die Maschine hat keins).'),
  };
}

/**
 * HAProxy starten, falls sein Container steht. Beim allerersten Start wartet
 * Compose mit ihm ohnehin, bis HAPM bereit ist. Hier geht es um den Fall, dass
 * er ohne Konfiguration schon einmal gescheitert ist.
 */
/**
 * Die Dateien für CrowdSec: die SPOE-Datei für HAProxy (immer, sie ist klein
 * und wird nur geladen, wenn `haproxy.cfg` sie nennt) und, wenn der Stack
 * CrowdSec mitbringt, Quellen, Parser und Bouncer. Den Bouncer meldet
 * `reconcileCrowdsec` im Scheduler an, sobald CrowdSec läuft: Compose startet
 * es erst, wenn HAPM gesund ist, also nach diesem Schritt.
 */
function ensureCrowdsecFiles(): { step: BootstrapStep | null; spoeChanged: boolean } {
  fs.mkdirSync(CROWDSEC_SPOE_DIR, { recursive: true });
  const spoe = crowdsecSpoeConfig();
  let current: string | null = null;
  try {
    current = fs.readFileSync(CROWDSEC_SPOE_FILE, 'utf8');
  } catch {
    // Gibt es noch nicht.
  }
  if (current !== spoe) fs.writeFileSync(CROWDSEC_SPOE_FILE, spoe);
  if (!fs.existsSync(CROWDSEC_ALLOW_FILE)) fs.writeFileSync(CROWDSEC_ALLOW_FILE, '');
  // Neu geschrieben über eine alte: ein laufendes HAProxy kennt nur die alte.
  const spoeChanged = current !== null && current !== spoe;

  if (!crowdsecInStack()) return { step: null, spoeChanged };
  if (crowdsecDisabled()) {
    return { step: { label: 'CrowdSec', ok: true, detail: msgid('In der Oberfläche abgeschaltet.') }, spoeChanged };
  }
  const files = writeCrowdsecFiles();
  return {
    step: files.mounted
      ? { label: 'CrowdSec', ok: true }
      : { label: 'CrowdSec', ok: true, detail: msgid('Der Ordner für CrowdSec ist nicht eingebunden.') },
    spoeChanged,
  };
}

async function ensureHaproxyRunning(): Promise<BootstrapStep> {
  const name = haproxyContainerName();
  try {
    const container = (await engine.findContainer(name)) as { State?: { Running?: boolean } } | null;
    if (!container) {
      return { label: 'HAProxy', ok: true, detail: `Der Container "${name}" existiert noch nicht.` };
    }
    if (container.State?.Running) return { label: 'HAProxy', ok: true, detail: msgid('läuft') };
    await engine.start(name);
    return { label: 'HAProxy', ok: true, detail: msgid('war gestoppt und wurde gestartet.') };
  } catch (err) {
    return { label: 'HAProxy', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runBootstrap(acmeEmail: string | null): Promise<BootstrapState> {
  const state = bootstrapState();
  if (state.status === 'running') return state;

  const design = await storedDesign();
  // Die Mails lesen die Darstellung nicht selbst: ihr Rahmen ist synchron.
  await loadMailBranding().catch((err) => console.error('[bootstrap] Darstellung für die Mails nicht lesbar:', err));

  // Auf einem Entwicklungsrechner ohne Container gibt es nichts einzurichten.
  if (process.platform !== 'linux' || process.env.HAPM_BOOTSTRAP === '0') {
    state.status = 'skipped';
    state.finishedAt = new Date().toISOString();
    return state;
  }

  state.status = 'running';
  state.steps = [];
  const add = (step: BootstrapStep) => {
    state.steps.push(step);
    console.log(`[bootstrap] ${step.label}: ${step.ok ? 'ok' : 'FEHLER'}${step.detail ? ` (${step.detail})` : ''}`);
  };

  try {
    for (const dir of [HAPROXY_CERT_DIR, ERROR_DIR, LOCK_PAGE_DIR, '/run/haproxy', '/var/log/haproxy']) {
      fs.mkdirSync(dir, { recursive: true });
    }
    add({ label: msgid('Verzeichnisse'), ok: true });

    const errors = ensureErrorFiles(design);
    add(errors.step);
    await rememberWrittenPages(errors.written);
    add(await ensureFallbackCertificate());
    add(ensureBaseConfig(errors.statuses));

    const acme = await ensureAcme(acmeEmail);
    add({ label: 'acme.sh', ok: acme.ok, detail: acme.detail });

    let spoeChanged = false;
    try {
      const crowdsec = ensureCrowdsecFiles();
      spoeChanged = crowdsec.spoeChanged;
      if (crowdsec.step) add(crowdsec.step);
    } catch (err) {
      add({ label: 'CrowdSec', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    const haproxy = await ensureHaproxyRunning();
    add(haproxy);
    // Lief HAProxy schon (Update von HAPM), lädt es die neue SPOE-Datei erst jetzt.
    if (spoeChanged && haproxy.ok && haproxy.detail === msgid('läuft')) {
      try {
        if ((await reloadForCrowdsec(localServer())) === 'reloaded') {
          add({ label: 'CrowdSec', ok: true, detail: msgid('HAProxy hat die neue Anbindung an CrowdSec geladen.') });
        }
      } catch (err) {
        add({ label: 'CrowdSec', ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
    followPagesAfterStart();
  } catch (err) {
    add({ label: msgid('Einrichtung'), ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  state.status = state.steps.every((step) => step.ok) ? 'ok' : 'error';
  state.finishedAt = new Date().toISOString();
  return state;
}
