/**
 * Die Adresse von HAPM ändern: prüfen, Zertifikat, neues Ziel, Adresse, altes
 * Ziel weg. Der Assistent dazu steht unter „Allgemein"
 * (`components/system/AddressMoveWizard.tsx`).
 *
 * ── Kein zweiter Schreibweg ──
 *
 * Wie in der Einrichtung (`lib/setup/run.ts`) ist jeder Schritt, der HAProxy
 * oder ein Zertifikat anfasst, ein gewöhnlicher Lauf mit derselben
 * Vorabprüfung wie in der Oberfläche. Hier stehen nur Reihenfolge und Warten.
 *
 * ── Warum ein neues Ziel und nicht die Domain am alten tauschen ──
 *
 * Getauscht wäre die Oberfläche in dem Augenblick unter der alten Adresse weg,
 * in dem HAProxy neu lädt. Wer den Assistenten unter der alten Adresse offen
 * hat, sähe das Ende nicht mehr. Und beide Domains an einem Ziel verlangten ein
 * Zertifikat, das beide abdeckt (`findCertificateFor` sucht eins für alle
 * Domains eines Ziels). Ein eigenes Ziel für die neue Domain braucht nur deren
 * Zertifikat, und das alte geht erst ganz am Ende.
 *
 * Das neue Ziel übernimmt vom alten, was der Zugriff braucht: Sperre auf
 * Admin-IPs oder Passwort, Kopfzeilen, Ziele. Sonst stünde die Oberfläche nach
 * dem Umzug offen, wo sie vorher gesperrt war.
 *
 * ── Im Prozess ──
 *
 * Wie die Einrichtung überlebt der Umzug keinen Neustart. Die Zeile trägt dann
 * weiter `running`, und `settle` liest sie als abgebrochen.
 */

import { ApiError } from '../api';
import { msg, msgid } from '../i18n/translate';
import { logAudit } from '../audit';
import { createDocument, getDocument, updateDocument } from '../db';
import { COLLECTIONS, type AddressMoveStage, type AddressMoveStageKey, type AddressMoveState, type CertificateSource, type Exposure, type HaproxyRun } from '../types';
import { localServer } from '../helpers';
import { challengeFor, getSettings, passkeysDroppedBy, updateSettings } from '../settings';
import { checkDomainAddress, serverAddresses, type AddressCheck } from '../setup/address';
import { SETUP_SCOPE, SETUP_SERVICE_ID, hapmServiceInput, listenPort, normalizeSetupDomain, validateSetupDomain } from '../setup/rules';
import { needsDnsChallenge, type ChallengeChoice } from '../haproxy/challenge';
import { findCertificateFor } from '../haproxy/certs';
import { uploadedCoverage } from '../haproxy/cert-upload';
import {
  HaproxyConfigError,
  assignServiceId,
  findScope,
  parseScopes,
  toCreateInput,
  type CreateServiceInput,
  type HaproxyService,
} from '../haproxy/config';
import {
  precheckCertificate,
  precheckCreate,
  precheckDelete,
  precheckScope,
  precheckUpdate,
  probeProxy,
  readCertificateInventory,
} from '../haproxy/provision';
import { surfaceHost, surfaceTarget } from '../haproxy/protected';
import { parseSteps, startHaproxyRun, waitForRun, type HaproxyActor } from '../haproxy/runner';
import { zoneForDomain } from '../dns/store';
import { hookForDnsProvider, providerOf, type DnsProviderId } from '../dns/zones';
import { checkGate, movePlan, newMoveStages, offerRecord, type CheckGate, type Issuance } from './rules';

const MOVE_ID = 'current';

/** Ein Zertifikat darf fünf Minuten brauchen, dazu Prüfung und Neuladen. */
const RUN_TIMEOUT_MS = 8 * 60_000;

/**
 * Wie lange das alte Ziel auf das Fenster wartet. Danach geht es auch, wenn
 * niemand zusieht (Fenster zu, Browser weg).
 */
const CLIENT_WAIT_MS = 90_000;

const g = globalThis as typeof globalThis & {
  __hapm_move_alive?: boolean;
  /** Eine Abfrage des Stands hat „Adresse umgestellt“ gesehen, siehe `cleanup`. */
  __hapm_move_seen?: boolean;
};

function moveAlive(): boolean {
  return g.__hapm_move_alive === true;
}

/* ══════════════════════════════════════════════════════════════════════
 * Lesen
 * ══════════════════════════════════════════════════════════════════════ */

export interface AddressMoveView {
  currentUrl: string | null;
  exposure: Exposure;
  certificateSource: CertificateSource;
  listenPort: number;
  serverAddresses: string[];
  /** Der letzte Umzug, oder `null`. */
  move: Omit<AddressMoveState, '$id' | '$createdAt' | '$updatedAt'> | null;
}

async function readMove(): Promise<AddressMoveState | null> {
  return getDocument<AddressMoveState>(COLLECTIONS.ADDRESS_MOVE, MOVE_ID).catch(() => null);
}

/** Ein Umzug, von dem dieser Prozess nichts weiß, ist mit einem Neustart abgebrochen. */
function settle(move: AddressMoveState): AddressMoveView['move'] {
  const { domain, previousUrl, startedAt, stages } = move;
  if (!move.running || moveAlive()) return { domain, previousUrl, startedAt, running: move.running, stages };
  return {
    domain,
    previousUrl,
    startedAt,
    running: false,
    stages: stages.map((stage) =>
      stage.status === 'running'
        ? { ...stage, status: 'error', detail: msgid('Abgebrochen: HAPM wurde neu gestartet. Der Umzug lässt sich erneut starten.') }
        : stage
    ),
  };
}

export async function readAddressMoveView(): Promise<AddressMoveView> {
  const [settings, move] = await Promise.all([getSettings(), readMove()]);
  // Wer den Stand mit umgestellter Adresse gelesen hat, weiß, wohin es geht:
  // ab jetzt darf das alte Ziel weg (`cleanup`).
  if (move?.running && move.stages.some((stage) => stage.key === 'publicUrl' && stage.status === 'ok')) {
    g.__hapm_move_seen = true;
  }
  return {
    currentUrl: settings.publicUrl,
    exposure: settings.exposure,
    certificateSource: settings.certificateSource,
    listenPort: listenPort(process.env.PORT),
    serverAddresses: serverAddresses(),
    move: move ? settle(move) : null,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * Prüfen
 * ══════════════════════════════════════════════════════════════════════ */

export interface AddressMoveCheck extends AddressCheck {
  issuance: Issuance;
  gate: CheckGate;
  /** Die Zone unter „DNS", in der die Domain liegt. */
  zone: { name: string; provider: DnsProviderId } | null;
  /** Ob der Assistent anbietet, den Eintrag selbst zu setzen (`offerRecord`). */
  recordOffer: boolean;
  /** Die Domains eines Zertifikats, das die neue schon abdeckt, oder `null`. */
  certificate: string[] | null;
}

/** Ob ein Ziel zu HAPM selbst führt: jedes seiner Ziele auf den Port von HAPM auf diesem Rechner. */
function leadsToHapm(service: HaproxyService): boolean {
  const port = listenPort(process.env.PORT);
  return (
    service.servers.length > 0 &&
    service.servers.every((server) => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(server.target.replace(/:\d+$/, '')) &&
      server.target.endsWith(`:${port}`))
  );
}

function exactOwner(services: HaproxyService[], domain: string): HaproxyService | null {
  return services.find((service) => service.domains.some((entry) => entry.toLowerCase() === domain)) ?? null;
}

/** Die Domain lesen und ablehnen, was kein Umzug ist. */
function readDomain(input: string, currentUrl: string | null): string {
  const domain = normalizeSetupDomain(input);
  const invalid = validateSetupDomain(domain);
  if (invalid) throw new ApiError(invalid);
  if (surfaceHost(currentUrl) === domain) {
    throw new ApiError(msg('{domain} ist schon die Adresse von HAPM.', { domain }));
  }
  return domain;
}

export async function checkAddressMove(input: string): Promise<AddressMoveCheck> {
  const settings = await getSettings();
  const domain = readDomain(input, settings.publicUrl);
  const server = localServer();

  const [check, zone, probe, inventory] = await Promise.all([
    checkDomainAddress(domain),
    zoneForDomain(domain),
    probeProxy(server),
    readCertificateInventory(server).catch(() => null),
  ]);

  // Eine Domain, die schon ein anderes Ziel bedient, kann nicht zur Oberfläche
  // werden, ohne dass dieses Ziel aufhört zu antworten.
  const owner = probe.configReadable ? exactOwner(probe.services, domain) : null;
  if (owner && !leadsToHapm(owner)) {
    throw new ApiError(
      msg('{domain} gehört schon zum Ziel {id}, das nicht zu HAPM führt. Wählen Sie eine andere Domain oder entfernen Sie sie dort.', {
        domain,
        id: owner.id,
      }),
      409
    );
  }

  const certificate = inventory
    ? findCertificateFor([...inventory.acme, ...uploadedCoverage(inventory.uploaded, Date.now())], [domain])
    : null;
  const issuance: Issuance =
    settings.certificateSource === 'upload'
      ? 'upload'
      : needsDnsChallenge([domain], settings.exposure, challengeFor(settings, null).httpReachable)
        ? 'dns'
        : 'http';

  let gate = checkGate(check.verdict);
  // Ohne eigenes Ausstellen geht es nur mit einem Zertifikat, das schon da ist.
  if (issuance === 'upload' && !certificate) gate = 'blocked';

  return {
    ...check,
    issuance,
    gate,
    zone: zone ? { name: zone.name, provider: providerOf(zone) } : null,
    recordOffer: offerRecord(settings.exposure, check.verdict, zone !== null),
    certificate: certificate ? certificate.domains : null,
  };
}

/** Der Hook für DNS-01: der Anbieter der Zone, in der die Domain liegt, sonst entscheidet `planChallenge`. */
async function challengeOf(domain: string, dnsHooks: string[]): Promise<ChallengeChoice> {
  const settings = await getSettings();
  const zone = await zoneForDomain(domain);
  const hook = zone ? hookForDnsProvider(providerOf(zone)) : null;
  return challengeFor(settings, hook && dnsHooks.includes(hook) ? hook : null);
}

/* ══════════════════════════════════════════════════════════════════════
 * Ausführen
 * ══════════════════════════════════════════════════════════════════════ */

interface StageContext {
  domain: string;
  previousUrl: string | null;
  challenge: ChallengeChoice;
  actor: HaproxyActor;
  attachRun: (runId: string) => Promise<void>;
}

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

async function prechecked<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (err instanceof HaproxyConfigError) throw new ApiError(err, 409);
    throw err;
  }
}

/**
 * Das neue Ziel: wie das alte, nur mit der neuen Domain. Ohne altes Ziel (oder
 * eines, das das Formular nicht abbildet) eins wie aus der Einrichtung.
 */
function newServiceInput(
  domain: string,
  previous: HaproxyService | null,
  raw: string,
  services: HaproxyService[]
): CreateServiceInput {
  const base =
    previous && previous.editable && previous.scope
      ? toCreateInput(previous)
      : hapmServiceInput(domain, listenPort(process.env.PORT));
  const input: CreateServiceInput = {
    ...base,
    domains: [domain],
    lockedDomains: base.lockedDomains.length > 0 ? [domain] : [],
    redirect: null,
  };
  const taken = services.some((service) => service.id === SETUP_SERVICE_ID);
  return { ...input, id: taken ? assignServiceId(raw, input) : SETUP_SERVICE_ID };
}

const STAGES: Record<AddressMoveStageKey, (context: StageContext) => Promise<string>> = {
  async certificate(context) {
    const server = localServer();
    const domains = [context.domain];
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
      serviceId: context.domain,
      certificateDomains: domains,
      challenge: context.challenge,
      actor: context.actor,
    });
    await finished(run, context);
    return `Ausgestellt für ${context.domain}.`;
  },

  async service(context) {
    const server = localServer();
    let probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(msg('Die HAProxy-Konfiguration ist nicht lesbar. Der Grund steht in der Übersicht.'));
    }

    const owner = exactOwner(probe.services, context.domain);
    if (owner) return `Das Ziel ${owner.id} führt schon zu HAPM.`;

    const surface = context.previousUrl ? surfaceTarget(probe.services, { publicUrl: context.previousUrl }) : null;
    const previous = surface ? (probe.services.find((service) => service.id === surface.serviceId) ?? null) : null;
    const scope = surface?.scope ?? SETUP_SCOPE;

    if (!findScope(parseScopes(probe.raw), scope)?.complete) {
      await prechecked(() => precheckScope(server, scope, 'add'));
      const run = await startHaproxyRun({ server, action: 'scope-add', serviceId: scope, actor: context.actor });
      await finished(run, context);
      probe = await probeProxy(server);
    }

    const input = { ...newServiceInput(context.domain, previous, probe.raw, probe.services), scope };
    const checked = await prechecked(() => precheckCreate(server, input, context.challenge));
    const run = await startHaproxyRun({
      server,
      action: 'create',
      serviceId: checked.id,
      input: checked,
      challenge: context.challenge,
      actor: context.actor,
    });
    await finished(run, context);
    return `Angelegt: ${checked.id} für ${context.domain}.`;
  },

  async publicUrl(context) {
    const before = await getSettings();
    const settings = await updateSettings({ publicUrl: `https://${context.domain}` });
    // Gelöscht hat sie `updateSettings`: an die alte Domain gebunden, melden sie niemanden mehr an.
    const dropped = passkeysDroppedBy(before, settings);
    await logAudit({
      userId: context.actor.userId,
      userEmail: context.actor.email,
      action: 'settings_updated',
      resource: 'settings',
      details: `Adresse von HAPM: ${context.previousUrl ?? ''} → ${settings.publicUrl ?? ''}${dropped ? ', alle Passkeys gelöscht' : ''}`,
      ip: context.actor.ip ?? undefined,
    });
    return dropped ? `${settings.publicUrl}, alle Passkeys gelöscht.` : `${settings.publicUrl}`;
  },

  async cleanup(context) {
    const oldHost = surfaceHost(context.previousUrl);
    if (!oldHost || !context.previousUrl) return msgid('Es gab keine alte Adresse.');

    /* Erst warten, bis das Fenster den Stand „Adresse umgestellt“ abgeholt hat.
     * Es fragt über die alte Adresse ab, und ohne dieses Warten ist sie weg,
     * bevor es davon erfährt: ein ganzer Umzug dauert keine fünfzehn Sekunden,
     * und jedes Neuladen von HAProxy kostet das Fenster ein, zwei Abfragen. Es
     * bliebe auf „Zertifikat“ stehen, obwohl alles durch ist. */
    const deadline = Date.now() + CLIENT_WAIT_MS;
    while (!g.__hapm_move_seen && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const server = localServer();
    const probe = await probeProxy(server);
    const old = surfaceTarget(probe.services, { publicUrl: context.previousUrl });
    const service = old ? probe.services.find((entry) => entry.id === old.serviceId) : null;
    if (!service) return msgid('Für die alte Adresse gab es kein Ziel mehr.');

    // Ab hier gilt die neue Adresse: geschützt ist ihr Ziel, nicht mehr das alte.
    const protection = { publicUrl: `https://${context.domain}` };
    const remaining = service.domains.filter((entry) => entry.toLowerCase() !== oldHost);

    // Die alte Adresse lief über eine Wildcard: das Ziel bedient mehr als sie und bleibt.
    if (remaining.length === service.domains.length) {
      return `Die alte Adresse lief über ${service.id}, das weitere Domains bedient. Es bleibt stehen.`;
    }

    if (remaining.length === 0) {
      const current = await prechecked(() => precheckDelete(server, service.id, protection));
      const run = await startHaproxyRun({
        server,
        action: 'delete',
        serviceId: service.id,
        service: current,
        protection,
        dns: { remove: [] },
        actor: context.actor,
      });
      await finished(run, context);
      return `Entfernt: ${service.id} (${oldHost}).`;
    }

    if (!service.editable || !service.scope) {
      throw new ApiError(
        msg(
          'Das Ziel {id} trägt neben {host} weitere Domains und lässt sich nicht selbsttätig ändern. Die Domain {host} entfernen Sie unter Reverse-Proxy.',
          { id: service.id, host: oldHost }
        )
      );
    }
    const base = toCreateInput(service);
    const input: CreateServiceInput = {
      ...base,
      domains: remaining,
      lockedDomains: base.lockedDomains.filter((entry) => entry.toLowerCase() !== oldHost),
    };
    await prechecked(() => precheckUpdate(server, service.id, input, context.challenge, protection));
    const run = await startHaproxyRun({
      server,
      action: 'update',
      serviceId: service.id,
      input,
      challenge: context.challenge,
      protection,
      actor: context.actor,
    });
    await finished(run, context);
    return `${oldHost} aus ${service.id} entfernt.`;
  },
};

/**
 * Den Umzug starten. Kehrt zurück, sobald die Zeile steht. Die Seite liest
 * den Fortschritt über `GET /api/settings/address`.
 *
 * `confirmed`: die Prüfung hat nicht „zeigt auf diesen Server" ergeben, und
 * der Benutzer will trotzdem weiter (`checkGate` = `confirm`).
 */
export async function startAddressMove(
  domainInput: string,
  confirmed: boolean,
  actor: HaproxyActor
): Promise<AddressMoveView> {
  if (moveAlive()) throw new ApiError(msg('Der Umzug läuft bereits.'), 409);
  // Gleich vormerken: zwei Aufrufe kurz nacheinander (zwei Fenster, zwei
  // Domains) kämen sonst beide an der Prüfung vorbei.
  g.__hapm_move_alive = true;
  try {
    return await beginAddressMove(domainInput, confirmed, actor);
  } catch (err) {
    g.__hapm_move_alive = false;
    throw err;
  }
}

async function beginAddressMove(
  domainInput: string,
  confirmed: boolean,
  actor: HaproxyActor
): Promise<AddressMoveView> {
  const check = await checkAddressMove(domainInput);
  const domain = check.domain;
  if (check.gate === 'blocked') {
    throw new ApiError(
      check.issuance === 'upload' && !check.certificate
        ? msg('Für {domain} liegt kein Zertifikat vor. Laden Sie es zuerst unter Reverse-Proxy, Zertifikate hoch.', { domain })
        : msg('Für {domain} gibt es keinen DNS-Eintrag. Ohne ihn wäre HAPM nach dem Umzug nicht mehr erreichbar.', { domain })
    );
  }
  if (check.gate === 'confirm' && !confirmed) {
    throw new ApiError(msg('Die Prüfung hat nicht ergeben, dass {domain} auf diesen Server zeigt. Bitte bestätigen Sie, dass es trotzdem stimmt.', { domain }));
  }

  const server = localServer();
  const probe = await probeProxy(server);
  const challenge = await challengeOf(domain, probe.dnsHooks);
  if (!check.certificate) await prechecked(() => precheckCertificate(server, [domain], challenge));

  const previousUrl = (await getSettings()).publicUrl;
  const row: Omit<AddressMoveState, '$id' | '$createdAt' | '$updatedAt'> = {
    domain,
    previousUrl,
    startedAt: new Date().toISOString(),
    running: true,
    stages: newMoveStages(movePlan(previousUrl !== null)),
  };

  g.__hapm_move_alive = true;
  g.__hapm_move_seen = false;
  try {
    const exists = await readMove();
    if (exists) await updateDocument<AddressMoveState>(COLLECTIONS.ADDRESS_MOVE, MOVE_ID, row);
    else await createDocument<AddressMoveState>(COLLECTIONS.ADDRESS_MOVE, row, MOVE_ID);
  } catch (err) {
    g.__hapm_move_alive = false;
    throw err;
  }

  let stages: AddressMoveStage[] = row.stages;
  const save = async (index: number, patch: Partial<AddressMoveStage>) => {
    stages = stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage));
    // Die Datenbank ist für das, was an HAProxy geschieht, nicht zuständig.
    await updateDocument<AddressMoveState>(COLLECTIONS.ADDRESS_MOVE, MOVE_ID, { stages }).catch(() => {});
  };

  const work = (async () => {
    let failure: string | null = null;
    for (const [index, stage] of stages.entries()) {
      await save(index, { status: 'running' });
      try {
        const detail = await STAGES[stage.key]({
          domain,
          previousUrl,
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

    await updateDocument<AddressMoveState>(COLLECTIONS.ADDRESS_MOVE, MOVE_ID, { running: false }).catch(() => {});
    await logAudit({
      userId: actor.userId,
      userEmail: actor.email,
      action: failure ? 'address_move_failed' : 'address_move_finished',
      resource: 'settings',
      details: failure ? `Umzug nach ${domain} abgebrochen: ${failure}` : `HAPM unter https://${domain}`,
      ip: actor.ip ?? undefined,
    });
  })();

  // Nicht awaitet, und das `.catch` ist nicht optional: siehe `lib/haproxy/runner.ts`.
  work
    .catch((err) => {
      console.error('[adresse] Umzug fehlgeschlagen:', err);
      return updateDocument<AddressMoveState>(COLLECTIONS.ADDRESS_MOVE, MOVE_ID, { running: false }).catch(() => {});
    })
    .finally(() => {
      g.__hapm_move_alive = false;
    });

  return readAddressMoveView();
}
