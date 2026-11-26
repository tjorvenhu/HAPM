/**
 * Das Ausführen der Einrichtung: Gruppe, Zertifikat, Ziel, Adresse.
 *
 * ── Kein zweiter Schreibweg ──
 *
 * Jeder Schritt, der HAProxy oder ein Zertifikat anfasst, ist ein gewöhnlicher
 * Lauf (`startHaproxyRun`) mit derselben Vorabprüfung wie in der Oberfläche.
 * Hier steht nur die Reihenfolge und das Warten dazwischen. Die Läufe stehen
 * deshalb auch in der Historie.
 *
 * ── Jeder Schritt fragt zuerst, ob er schon getan ist ──
 *
 * Scheitern ist kein Ende: nach einem falschen Token oder einem DNS-Fehler wird
 * dieselbe Folge noch einmal gestartet. Was beim ersten Mal durchkam (die
 * Gruppe, das Zertifikat), wird dabei vorgefunden und nicht wiederholt. Gefragt
 * wird die Maschine, nicht die eigene Zeile: die Wahrheit über Gruppe, Ziel und
 * Zertifikat steht in `haproxy.cfg` und bei acme.sh.
 *
 * ── Im Prozess ──
 *
 * Wie jeder Lauf überlebt auch diese Folge keinen Neustart von HAPM. Die Zeile
 * trägt dann weiter `running`; `settleExecution` liest sie als abgebrochen,
 * sobald dieser Prozess nichts davon weiß (`setupExecutionAlive`).
 */

import { ApiError } from '../api';
import { msg, msgid } from '../i18n/translate';
import { logAudit } from '../audit';
import { localServer } from '../helpers';
import { challengeFor, getSettings, updateSettings } from '../settings';
import { findCertificateFor } from '../haproxy/certs';
import { uploadedCoverage } from '../haproxy/cert-upload';
import { planChallenge, type ChallengeChoice } from '../haproxy/challenge';
import {
  HaproxyConfigError,
  findScope,
  parseScopes,
  validateCreateInput,
} from '../haproxy/config';
import {
  precheckCertificate,
  precheckCreate,
  precheckScope,
  precheckUpdate,
  probeProxy,
  readCertificateInventory,
  readGlobalSettings,
  precheckSettings,
} from '../haproxy/provision';
import { WITHOUT_SURFACE_PROTECTION } from '../haproxy/protected';
import { parseSteps, startHaproxyRun, waitForRun, type HaproxyActor } from '../haproxy/runner';
import type { HaproxyRun, SetupExecution, SetupStageKey } from '../types';
import {
  SETUP_SCOPE,
  SETUP_SERVICE_ID,
  certificateDomains,
  certificateFactsOf,
  executionPlan,
  hapmServiceInput,
  listenPort,
  newExecution,
  resumeStep,
  type SetupChoices,
} from './rules';
import { getSetupState, setDnsAccess, updateSetupState } from './store';

/** Ein Zertifikat darf fünf Minuten brauchen, dazu Prüfung und Neuladen. */
const RUN_TIMEOUT_MS = 8 * 60_000;

const g = globalThis as typeof globalThis & { __hapm_setup_alive?: boolean };

/** Ob dieser Prozess die Einrichtung gerade ausführt. */
export function setupExecutionAlive(): boolean {
  return g.__hapm_setup_alive === true;
}

/**
 * Die Antworten des Assistenten lassen sich nur ändern, solange die Einrichtung
 * offen ist und nicht gerade läuft. Für jede Route unter `/api/setup`, die etwas
 * speichert: nach „abgeschlossen" oder „übersprungen" gehören Adresse, DNS und
 * Zertifikate den Seiten der Oberfläche.
 */
export async function assertSetupOpen(): Promise<void> {
  if ((await getSettings()).setupStatus !== 'open') {
    throw new ApiError(msg('Die Einrichtung ist schon abgeschlossen.'), 409);
  }
  if (setupExecutionAlive()) throw new ApiError(msg('Die Einrichtung läuft bereits.'), 409);
}

interface StageContext {
  state: SetupChoices;
  challenge: ChallengeChoice;
  actor: HaproxyActor;
  /** Den Lauf an den Schritt hängen, sobald er gestartet ist. */
  attachRun: (runId: string) => Promise<void>;
}

/**
 * Was ein gescheiterter Lauf als Grund nennt.
 *
 * Was ein Schritt zurückgibt oder wirft, steht als `detail` in der Zeile, auf
 * Deutsch. Die Seite schlägt es mit `t()` nach: ein Satz ohne eingesetzte Werte
 * (`msgid`) wird übersetzt, einer mit Domain oder Grund aus dem Lauf bleibt deutsch.
 */
function failureOf(run: HaproxyRun): string {
  if (run.status === 'running') {
    return msgid('Der Vorgang lief nach acht Minuten noch. Sein Ergebnis steht im Protokoll des Reverse-Proxys.');
  }
  if (run.error) return run.error;
  const failed = parseSteps(run.steps).find((step) => !step.ok);
  return failed ? [failed.label, failed.detail].filter(Boolean).join(': ') : msgid('Der Vorgang nennt keinen Grund.');
}

async function finished(run: HaproxyRun, context: StageContext): Promise<void> {
  await context.attachRun(run.$id);
  const done = await waitForRun(run.$id, RUN_TIMEOUT_MS);
  if (done.status !== 'success') throw new ApiError(failureOf(done));
}

/** Ein Konflikt aus der Vorabprüfung ist eine Auskunft und bleibt eine Meldung. */
async function prechecked<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (err instanceof HaproxyConfigError) throw new ApiError(err, 409);
    throw err;
  }
}

const STAGES: Record<SetupStageKey, (context: StageContext) => Promise<string>> = {
  async dns({ state, challenge }) {
    const probe = await probeProxy(localServer());
    const plan = planChallenge(certificateDomains(state), challenge, probe.dnsHooks);
    if (plan.method === 'unavailable') throw new ApiError(plan.message);
    return plan.method === 'dns' ? `${plan.hook} ist bei acme.sh eingerichtet.` : msgid('Nicht nötig.');
  },

  async scope(context) {
    const server = localServer();
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(msg('Die HAProxy-Konfiguration ist nicht lesbar. Der Grund steht in der Übersicht.'));
    }
    if (findScope(parseScopes(probe.raw), SETUP_SCOPE)?.complete) return msgid('Die Gruppe besteht schon.');

    await prechecked(() => precheckScope(server, SETUP_SCOPE, 'add'));
    const run = await startHaproxyRun({
      server,
      action: 'scope-add',
      serviceId: SETUP_SCOPE,
      actor: context.actor,
    });
    await finished(run, context);
    return msgid('Angelegt.');
  },

  async certificate(context) {
    const server = localServer();
    const domains = certificateDomains(context.state);
    const inventory = await readCertificateInventory(server);
    const existing = findCertificateFor(
      [...inventory.acme, ...uploadedCoverage(inventory.uploaded, Date.now())],
      domains
    );
    if (existing) return `Schon vorhanden: ${existing.domains.join(', ')}.`;
    if (context.challenge.source === 'upload') {
      throw new ApiError(
        msg('Für {domains} ist kein Zertifikat hochgeladen. HAPM stellt in dieser Installation keins selbst aus.', {
          domains: domains.join(', '),
        })
      );
    }

    await precheckCertificate(server, domains, context.challenge);
    const run = await startHaproxyRun({
      server,
      action: 'certificate',
      serviceId: domains[0],
      certificateDomains: domains,
      challenge: context.challenge,
      actor: context.actor,
    });
    await finished(run, context);
    return `Ausgestellt für ${domains.join(', ')}.`;
  },

  async service(context) {
    const server = localServer();
    const input = hapmServiceInput(context.state.domain!, listenPort(process.env.PORT));
    const invalid = validateCreateInput(input);
    if (invalid) throw new ApiError(invalid);

    const probe = await probeProxy(server);
    const current = probe.services.find((service) => service.id === SETUP_SERVICE_ID);
    const target = input.servers[0].target;

    if (current) {
      const same =
        current.domains.length === 1 &&
        current.domains[0].toLowerCase() === input.domains[0] &&
        current.servers.length === 1 &&
        current.servers[0].target === target;
      if (same) return `Das Ziel besteht schon: ${input.domains[0]} → ${target}.`;

      // Eine geänderte Domain nach einem früheren Durchlauf: derselbe Eintrag, neu geschrieben.
      // Ohne den Schutz des Ziels der Oberfläche: die Einrichtung verlegt sie, und die
      // Adresse in den Einstellungen folgt erst im letzten Schritt.
      const protection = WITHOUT_SURFACE_PROTECTION;
      await prechecked(() => precheckUpdate(server, SETUP_SERVICE_ID, input, context.challenge, protection));
      const run = await startHaproxyRun({
        server,
        action: 'update',
        serviceId: SETUP_SERVICE_ID,
        input,
        challenge: context.challenge,
        protection,
        actor: context.actor,
      });
      await finished(run, context);
      return `Geändert: ${input.domains[0]} → ${target}.`;
    }

    await prechecked(() => precheckCreate(server, input, context.challenge));
    const run = await startHaproxyRun({
      server,
      action: 'create',
      serviceId: SETUP_SERVICE_ID,
      input,
      challenge: context.challenge,
      actor: context.actor,
    });
    await finished(run, context);
    return `Angelegt: ${input.domains[0]} → ${target}.`;
  },

  async crowdsec(context) {
    const server = localServer();
    const { settings } = await readGlobalSettings(server);
    if (settings.crowdsec === true) return msgid('Ist schon eingeschaltet.');
    const input = { httpsLines: [], adminIps: [], fromFile: true, crowdsec: true };
    await prechecked(() => precheckSettings(server, input));
    const run = await startHaproxyRun({
      server,
      action: 'settings',
      serviceId: 'globale-einstellungen',
      settings: input,
      actor: context.actor,
    });
    await finished(run, context);
    return msgid('Eingeschaltet. Sperren und Freigaben stehen unter Reverse-Proxy, CrowdSec.');
  },

  async publicUrl({ state }) {
    // Zusammen mit dem Abschluss: sonst gäbe es eine fertige Einrichtung, an die die Übersicht weiter erinnert.
    const settings = await updateSettings({ publicUrl: `https://${state.domain}`, setupStatus: 'done' });
    // Das Token des DNS-Anbieters lag nur für die Einrichtung beim Assistenten.
    await setDnsAccess(null);
    return `${settings.publicUrl}`;
  },
};

/**
 * Die Folge starten. Kehrt zurück, sobald die Zeile steht, nicht wenn die
 * Einrichtung fertig ist: die Seite pollt `/api/setup`.
 */
export async function startSetupExecution(actor: HaproxyActor): Promise<SetupExecution> {
  if (setupExecutionAlive()) throw new ApiError(msg('Die Einrichtung läuft bereits.'), 409);
  // Gleich hier und nicht erst nach den Abfragen: zwei Aufrufe kurz
  // nacheinander kämen sonst beide an der Prüfung vorbei.
  g.__hapm_setup_alive = true;

  let state: Awaited<ReturnType<typeof getSetupState>>;
  let settings: Awaited<ReturnType<typeof getSettings>>;
  let challenge: ChallengeChoice;
  let execution: SetupExecution;
  try {
    state = await getSetupState();
    settings = await getSettings();
    // Abgeschlossen und übersprungen sind endgültig: ein Assistent, der in einem
    // zweiten Fenster noch offen ist, setzte sonst die Adresse von HAPM zurück
    // und löschte damit alle Passkeys.
    if (settings.setupStatus !== 'open') throw new ApiError(msg('Die Einrichtung ist schon abgeschlossen.'), 409);
    const certificates = certificateFactsOf(settings);
    // Die Hooks prüft der erste Schritt an der Maschine, hier zählt nur, ob alles beantwortet ist.
    if (resumeStep(state, { hasAccount: true, dnsHooks: null, certificates }) !== 'run') {
      throw new ApiError(msg('Die Einrichtung ist noch nicht vollständig beantwortet.'));
    }
    challenge = challengeFor(settings, state.dnsHook);
    execution = newExecution(executionPlan(state, certificates), new Date().toISOString());
    await updateSetupState({ execution });
  } catch (err) {
    g.__hapm_setup_alive = false;
    throw err;
  }

  const save = async (index: number, patch: Partial<SetupExecution['stages'][number]>) => {
    execution = {
      ...execution,
      stages: execution.stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)),
    };
    // Die Datenbank ist für das, was an HAProxy geschieht, nicht zuständig.
    await updateSetupState({ execution }).catch(() => {});
  };

  const work = (async () => {
    let failure: string | null = null;

    for (const [index, stage] of execution.stages.entries()) {
      await save(index, { status: 'running' });
      try {
        const detail = await STAGES[stage.key]({
          state,
          challenge,
          actor,
          attachRun: (runId) => save(index, { runId }),
        });
        await save(index, { status: 'ok', detail });
      } catch (err) {
        failure = err instanceof Error ? err.message : msgid('Der Schritt ist fehlgeschlagen.');
        await save(index, { status: 'error', detail: failure });
        break;
      }
    }

    execution = { ...execution, running: false };
    await updateSetupState({ execution }).catch(() => {});

    await logAudit({
      userId: actor.userId,
      userEmail: actor.email,
      action: failure ? 'setup_failed' : 'setup_finished',
      resource: 'settings',
      details: failure ? `Einrichtung abgebrochen: ${failure}` : `Oberfläche unter https://${state.domain}`,
      ip: actor.ip ?? undefined,
    });
  })();

  // Nicht awaitet, und das `.catch` ist nicht optional: siehe `lib/haproxy/runner.ts`.
  work
    .catch((err) => {
      console.error('[setup] Einrichtung fehlgeschlagen:', err);
      return updateSetupState({ execution: { ...execution, running: false } }).catch(() => {});
    })
    .finally(() => {
      g.__hapm_setup_alive = false;
    });

  return execution;
}
