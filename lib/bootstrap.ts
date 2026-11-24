/**
 * Die Ersteinrichtung der Maschine.
 *
 * Läuft bei jedem Start von HAPM und tut nur, was fehlt: Verzeichnisse,
 * Fehlerseiten, ein Platzhalter-Zertifikat, die Grundkonfiguration und acme.sh.
 * Danach kann HAProxy starten, und in der Oberfläche lässt sich das erste Ziel
 * anlegen. Vorhandenes wird nie überschrieben.
 *
 * Geschrieben wird hier direkt über `fs` und nicht über Kommandos: `/etc/haproxy`
 * ist ein Volume dieses Containers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HAPROXY_CFG, HAPROXY_CERT_DIR, LOCK_PAGE_DIR } from './haproxy/config';
import { ERROR_DIR, renderBaseConfig } from './haproxy/base-config';
import { errorFiles } from './haproxy/error-pages';
import { defaultPageDesign, type PageDesign } from './haproxy/page-design';
import { loadPageDesign } from './haproxy/page-design-store';
import { ensureAcme } from './acme';
import { localExec } from './ssh';
import { buildCommand } from './shell';
import { engine, haproxyContainerName } from './docker';

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
  if (present) return { label: 'Platzhalter-Zertifikat', ok: true, detail: 'Es liegen schon Zertifikate vor.' };

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
      return { label: 'Platzhalter-Zertifikat', ok: false, detail: res.stdout.trim().slice(-300) };
    }
    const pem = fs.readFileSync(`${dir}/cert.pem`, 'utf8') + fs.readFileSync(`${dir}/key.pem`, 'utf8');
    fs.writeFileSync(FALLBACK_PEM, pem, { mode: 0o600 });
    return { label: 'Platzhalter-Zertifikat', ok: true, detail: 'Selbst signiertes Zertifikat angelegt.' };
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
} {
  const files = errorFiles(stored.design);
  let written = 0;
  for (const file of files) {
    const target = path.posix.join(ERROR_DIR, `${file.status}.http`);
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, file.content);
    written++;
  }
  return {
    step: {
      label: 'Fehlerseiten',
      ok: true,
      detail: (written ? `${written} Fehlerseiten angelegt.` : 'Alle Fehlerseiten liegen vor.') + stored.note,
    },
    statuses: files.map((file) => file.status),
  };
}

function ensureBaseConfig(errorStatuses: number[]): BootstrapStep {
  if (fs.existsSync(HAPROXY_CFG)) {
    return { label: 'Konfiguration', ok: true, detail: `${HAPROXY_CFG} liegt vor und bleibt unverändert.` };
  }
  const ipv6 = fs.existsSync('/proc/net/if_inet6') && fs.readFileSync('/proc/net/if_inet6', 'utf8').trim() !== '';
  fs.writeFileSync(HAPROXY_CFG, renderBaseConfig({ ipv6, errorStatuses }), { mode: 0o644 });
  return {
    label: 'Konfiguration',
    ok: true,
    detail: `Grundkonfiguration angelegt${ipv6 ? '' : ' (ohne IPv6, die Maschine hat keins)'}.`,
  };
}

/**
 * HAProxy starten, falls sein Container steht. Beim allerersten Start wartet
 * Compose mit ihm ohnehin, bis HAPM bereit ist. Hier geht es um den Fall, dass
 * er ohne Konfiguration schon einmal gescheitert ist.
 */
async function ensureHaproxyRunning(): Promise<BootstrapStep> {
  const name = haproxyContainerName();
  try {
    const container = (await engine.findContainer(name)) as { State?: { Running?: boolean } } | null;
    if (!container) {
      return { label: 'HAProxy', ok: true, detail: `Der Container "${name}" existiert noch nicht.` };
    }
    if (container.State?.Running) return { label: 'HAProxy', ok: true, detail: 'läuft' };
    await engine.start(name);
    return { label: 'HAProxy', ok: true, detail: 'war gestoppt und wurde gestartet.' };
  } catch (err) {
    return { label: 'HAProxy', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runBootstrap(acmeEmail: string | null): Promise<BootstrapState> {
  const state = bootstrapState();
  if (state.status === 'running') return state;

  const design = await storedDesign();

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
    add({ label: 'Verzeichnisse', ok: true });

    const errors = ensureErrorFiles(design);
    add(errors.step);
    add(await ensureFallbackCertificate());
    add(ensureBaseConfig(errors.statuses));

    const acme = await ensureAcme(acmeEmail);
    add({ label: 'acme.sh', ok: acme.ok, detail: acme.detail });

    add(await ensureHaproxyRunning());
  } catch (err) {
    add({ label: 'Einrichtung', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  state.status = state.steps.every((step) => step.ok) ? 'ok' : 'error';
  state.finishedAt = new Date().toISOString();
  return state;
}
