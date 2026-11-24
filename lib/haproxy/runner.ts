/**
 * Der Reverse-Proxy-Vorgang als abgekoppelter Lauf.
 *
 * ── Warum er abgekoppelt ist ──
 *
 * Anlegen dauert. Zwischen dem Klick auf „Anlegen" und dem Reload liegen eine
 * Zertifikatsausstellung bei Let's Encrypt, ein `haproxy -c` und ein
 * Reload — in der Praxis Minuten, im schlechten Fall bis zum Timeout von fünf
 * Minuten allein für das Zertifikat. Ein Dialog, der so lange auf die Antwort
 * der Route wartet, hängt genau diese Zeit mit einem Spinner fest: nichts
 * anderes geht in der Oberfläche, und ein Reload der Seite bedeutet, das
 * Ergebnis nie zu sehen.
 *
 * Deshalb legt die Route diese Zeile an, gibt ihre ID zurück und lässt den
 * Rest laufen. Die Pille unten rechts liest sie über `/api/activity`, das
 * Overlay pollt sie einzeln.
 *
 * ── Was die Zeile SONST noch ist ──
 *
 * Die einzige Historie, die es für den Reverse-Proxy gibt. `haproxy.cfg` kennt
 * nur ihren aktuellen Stand; wer wann welche Domain umgehängt oder entfernt
 * hat, steht danach nirgends. Deshalb tragen die Zeilen Domains und Ziele
 * denormalisiert mit, und deshalb überleben sie das Löschen des Dienstes.
 * Sie sind KEINE Spiegelung der Konfiguration — die steht allein in
 * `haproxy.cfg`.
 *
 * ── Das `.catch` ist nicht optional ──
 *
 * Node beendet den Prozess bei einer unbehandelten Rejection. Ein nicht
 * aufgefangener Fehler in einem Lauf, den niemand mehr awaitet, wäre also ein
 * Neustart von HAPM — und damit ein Ausfall aller Zeitpläne, weil jemand
 * eine Domain angelegt hat.
 */

import { createDocument, updateDocument } from '../db';
import { COLLECTIONS } from '../types';
import { logAudit, type AuditAction } from '../audit';
import { notify } from '../notifications';
import {
  createService,
  updateService,
  deleteService,
  createStream,
  updateStream,
  deleteStream,
  updateGlobalSettings,
  updateScopes,
  type ProvisionStep,
  type ProvisionReporter,
} from './provision';
import { ensureProxyRecords, removeProxyRecords } from '../dns/sync';
import type { CreateServiceInput, HaproxyService, GlobalSettingsInput } from './config';
import type { CreateStreamInput, HaproxyStream } from './streams';
import type { Server, HaproxyRun, HaproxyAction, HaproxyPhase, RunStatus } from '../types';

export interface HaproxyActor {
  userId: string;
  email: string;
  ip: string | null;
}

/**
 * Das Token hinter dem Lauf, falls es eins war.
 *
 * `serviceActor` baut die Kennung als `service:<id>` (siehe `lib/audit.ts`),
 * und hier wird sie wieder auseinandergenommen. Das passiert an dieser einen
 * Stelle statt in jeder Route, weil es sonst fünf Aufrufstellen wären, von
 * denen eine es vergisst — und dann fehlte genau der Lauf in „Reverse-Proxy →
 * API", den jemand sucht.
 */
function tokenIdOf(actor: HaproxyActor): string | null {
  return actor.userId.startsWith('service:') ? actor.userId.slice('service:'.length) : null;
}

interface RunOptions {
  server: Server;
  action: HaproxyAction;
  /** Beim Ändern die ALTE Dienst-ID; sie steht im Pfad der Route. Bei den
   *  globalen Einstellungen gibt es keinen Dienst — dort steht, worum es geht. */
  serviceId: string;
  /** Anlegen und Ändern. Beim Löschen gibt es keine Eingabe. */
  input?: CreateServiceInput;
  /**
   * Welcher acme.sh-DNS-Hook die Challenge setzt. Nur nötig, wenn eine Wildcard
   * unter den Domains ist — HTTP-01 stellt sie nicht aus.
   *
   * Bewusst NICHT Teil von `CreateServiceInput`: er steht in keiner Zeile von
   * `haproxy.cfg` und käme deshalb beim Zurücklesen nicht wieder mit. Ein Feld
   * darin wäre eines, das `toCreateInput` erfinden müsste. Er ist ein Parameter
   * des Vorgangs und keine Eigenschaft des Dienstes — die Zone merkt sich acme.sh
   * ohnehin selbst, für jede spätere Erneuerung.
   */
  dnsHook?: string | null;
  /** Löschen: der Dienst, wie ihn die Vorabprüfung gerade gelesen hat. */
  service?: HaproxyService;
  /** Dasselbe für eine TCP-Weiterleitung: die Eingabe beim Anlegen und Ändern,
   *  der gelesene Stand beim Löschen. Beides steht denormalisiert in der Zeile,
   *  weil es nach dem Löschen nirgends mehr steht. */
  streamInput?: CreateStreamInput;
  stream?: HaproxyStream;
  /**
   * Der DNS-Teil des Vorgangs (lib/dns/sync.ts). Fehlt er, wird bei Cloudflare
   * nichts angefasst — der Normalfall für jede Domain, deren Zone hier nicht
   * eingerichtet ist.
   *
   * `ensure` läuft VOR allem anderen: Let's Encrypt prüft über HTTP-01, also
   * über die Domain selbst, und ein Fehlversuch zählt gegen ein Kontingent.
   * `remove` läuft danach und nur, wenn der Vorgang durchgekommen ist — sonst
   * nähme ein gescheitertes Löschen dem noch stehenden Dienst seinen Eintrag
   * weg.
   */
  dns?: { ensure?: string[]; remove?: string[] };
  /** Die globalen Einstellungen. Nur bei `action: 'settings'`. */
  settings?: GlobalSettingsInput;
  actor: HaproxyActor;
}

/**
 * Was in der Historie unter „Domains" und „Ziele" steht.
 *
 * Die Ziele der Pfad-Regeln stehen mit drin, und zwar mit ihrem Pfad davor: bei
 * Coolify sind die interessanten Ports gerade die der Regeln (6001, 6002), und
 * eine Zeile, die nur 8000 nennt, verschwiege den halben Eintrag.
 */
function describe(opts: RunOptions): { domains: string | null; targets: string | null } {
  if (opts.action === 'scope-add' || opts.action === 'scope-remove') {
    // Eine Gruppe hat weder Domains noch Ziele. Der Name steht in `serviceId`.
    return { domains: null, targets: null };
  }
  /* Eine TCP-Weiterleitung hat keine Domain. In der Domain-Spalte steht deshalb
   * der Port — es ist die Adresse, unter der sie erreichbar war, und genau die
   * lässt sich nach dem Löschen nirgends mehr nachsehen. */
  const stream = opts.streamInput ?? opts.stream;
  if (stream) {
    return {
      domains: stream.port === null ? null : `Port ${stream.port}`,
      targets: stream.servers.map((s) => s.target).join(', ') || null,
    };
  }

  if (opts.settings) {
    // Kein Dienst, keine Domains. Was sich geändert hat, steht als Zusammenfassung
    // in der Ziel-Spalte — sonst wäre die Zeile in der Historie leer.
    const { httpsLines } = opts.settings;
    const written = httpsLines.join(' · ') || 'nichts gesetzt';
    return {
      domains: null,
      // Die Spalte fasst 1024 Zeichen. Ein Block, der darüber hinausgeht, soll
      // die Historie kürzen und nicht den ganzen Lauf am INSERT scheitern lassen.
      targets: written.length > 1024 ? `${written.slice(0, 1021)}...` : written,
    };
  }

  const source = opts.input ?? opts.service;
  if (!source) return { domains: null, targets: null };

  const targets = [
    // Bei einer Weiterleitung steht das Ziel an der Stelle, an der sonst die
    // Backend-Adresse steht. Ohne sie wäre die Zeile in der Historie leer, und
    // nach dem Löschen gibt es nichts mehr, woraus sie sich lesen ließe.
    ...(source.redirect ? [`→ ${source.redirect.to}`] : []),
    ...source.servers.map((s) => s.target),
    ...source.routes.flatMap((route) =>
      route.servers.map((s) => `${route.paths[0] ?? '?'} → ${s.target}`)
    ),
  ];

  return {
    domains: source.domains.join(', ') || null,
    targets: targets.join(', ') || null,
  };
}

/** Der neue Name, wenn dieser Vorgang einer ist, der umbenennt. `serviceId`
 *  trägt bei jedem Vorgang die ALTE Kennung, unter der der Eintrag stand, als
 *  er begann — bei einer TCP-Weiterleitung genauso wie bei einem Dienst. */
function renamedTo(opts: RunOptions): string | null {
  const next = opts.input?.id ?? opts.streamInput?.id ?? null;
  return next && next !== opts.serviceId ? next : null;
}

const AUDIT_ACTIONS: Record<HaproxyAction, { ok: AuditAction; failed: AuditAction }> = {
  create: { ok: 'haproxy_service_created', failed: 'haproxy_service_failed' },
  update: { ok: 'haproxy_service_updated', failed: 'haproxy_service_failed' },
  delete: { ok: 'haproxy_service_deleted', failed: 'haproxy_service_delete_failed' },
  settings: { ok: 'haproxy_settings_updated', failed: 'haproxy_settings_failed' },
  'scope-add': { ok: 'haproxy_scope_created', failed: 'haproxy_scope_failed' },
  'scope-remove': { ok: 'haproxy_scope_deleted', failed: 'haproxy_scope_failed' },
  'stream-create': { ok: 'haproxy_stream_created', failed: 'haproxy_stream_failed' },
  'stream-update': { ok: 'haproxy_stream_updated', failed: 'haproxy_stream_failed' },
  'stream-delete': { ok: 'haproxy_stream_deleted', failed: 'haproxy_stream_delete_failed' },
};

function auditDetails(opts: RunOptions, failure: string | null): string {
  const { serviceId, input } = opts;
  const suffix = failure ? `, fehlgeschlagen: ${failure}` : '';
  if (opts.action === 'scope-add' || opts.action === 'scope-remove') {
    const what = opts.action === 'scope-add' ? 'angelegt' : 'entfernt';
    return `Gruppe "${serviceId}" ${what}${suffix}`;
  }
  if (opts.settings) {
    const { targets } = describe(opts);
    return `Globale Einstellungen: ${targets}${suffix}`;
  }
  if (opts.streamInput ?? opts.stream) {
    /* Die Absenderliste steht mit im Text und nicht nur der Port. „Port 5432
     * offen" und „Port 5432 für zwei Adressen" sind zwei verschiedene
     * Vorgänge, und im Protokoll soll stehen, welcher es war. */
    const s = opts.streamInput ?? opts.stream!;
    const renamedStream = opts.streamInput && opts.streamInput.id !== serviceId
      ? ` → ${opts.streamInput.id}`
      : '';
    const sources =
      s.allowedSources.length > 0 ? `nur von ${s.allowedSources.join(', ')}` : 'von überall';
    return (
      `TCP ${serviceId}${renamedStream}: Port ${s.port} → ` +
      `${s.servers.map((t) => t.target).join(', ')} (${sources})${suffix}`
    );
  }
  const renamed = input && input.id !== serviceId ? ` → ${input.id}` : '';
  const what = input
    ? `: ${input.domains.join(', ')} → ${
        input.redirect ? input.redirect.to : input.servers.map((s) => s.target).join(', ')
      }`
    : '';
  return `${serviceId}${renamed}${what}${suffix}`;
}

/**
 * Die Zeile anlegen und den Vorgang starten. Kehrt zurück, sobald die Zeile
 * steht — nicht, wenn der Vorgang fertig ist.
 *
 * Die Vorabprüfung (`precheck*` in provision.ts) gehört NICHT hierher, sondern
 * vor den Aufruf: ein Namenskonflikt ist eine Auskunft an das Formular und
 * keine Zeile in der Historie.
 */
export async function startHaproxyRun(opts: RunOptions): Promise<HaproxyRun> {
  const { server, action, serviceId, input, actor } = opts;
  const startedAt = new Date();
  const { domains, targets } = describe(opts);

  const run = await createDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, {
    serverId: server.$id,
    serverName: server.name, // denormalisiert, siehe Kopf
    action,
    serviceId,
    renamedTo: renamedTo(opts),
    domains,
    targets,
    status: 'running',
    phase: 'preflight',
    startedAt: startedAt.toISOString(),
    completedAt: null,
    duration: null,
    steps: null,
    error: null,
    triggeredBy: actor.email,
    triggeredByTokenId: tokenIdOf(actor),
  });

  const runId = run.$id;

  /**
   * Die Schritte, die schon vor dem HAProxy-Teil feststanden — der DNS-Eintrag.
   *
   * `provision.ts` meldet seine eigene Liste und weiß von dieser nichts. Ohne
   * das Voranstellen hier verschwände der DNS-Schritt aus der Zeile, sobald der
   * erste HAProxy-Schritt gemeldet wird: der Lauf sähe dann aus, als hätte er
   * nie einen Eintrag angefasst.
   */
  let prefix: ProvisionStep[] = [];

  const reporter: ProvisionReporter = {
    onPhase: (phase) =>
      updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, runId, { phase }).then(() => {}),
    onStep: (steps) =>
      updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, runId, {
        steps: JSON.stringify([...prefix, ...steps]),
      }).then(() => {}),
  };

  const work = (async () => {
    let steps: ProvisionStep[] = [];
    let error: string | null = null;

    /* ── DNS zuerst ──
     *
     * Vor der Zertifikatsausstellung, nicht danach: eine frisch angelegte
     * Domain löst sonst noch nirgendwohin auf, HTTP-01 scheitert, und der
     * Fehlversuch zählt gegen das Kontingent bei Let's Encrypt.
     *
     * Ein Fehlschlag hier hält den Vorgang NICHT auf. Der Dienst wird trotzdem
     * angelegt — eine Domain, die schon woanders aufgelöst wird, funktioniert
     * auch ohne unseren Eintrag —, aber der Schritt steht als Fehler in der
     * Zeile, und der Lauf endet auf `error` mit dem Grund daneben.
     */
    const toEnsure = opts.dns?.ensure ?? [];
    if (toEnsure.length > 0) {
      await reporter.onPhase?.('dns');
      const dnsSteps = await ensureProxyRecords(toEnsure).catch((err: unknown) => [
        {
          label: 'DNS-Einträge',
          ok: false,
          detail: err instanceof Error ? err.message : 'Unbekannter Fehler',
        },
      ]);
      prefix = dnsSteps;
      steps = [...dnsSteps];
      await updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, runId, {
        steps: JSON.stringify(steps),
      }).catch(() => {});
    }

    try {
      const result =
        action === 'scope-add' || action === 'scope-remove'
          ? await updateScopes(
              server,
              serviceId,
              action === 'scope-add' ? 'add' : 'remove',
              reporter
            )
          : action === 'stream-create'
          ? await createStream(server, opts.streamInput!, reporter)
          : action === 'stream-update'
          ? await updateStream(server, serviceId, opts.streamInput!, reporter)
          : action === 'stream-delete'
          ? await deleteStream(server, serviceId, reporter)
          : action === 'settings'
          ? await updateGlobalSettings(server, opts.settings!, reporter)
          : action === 'delete'
            ? await deleteService(server, serviceId, reporter)
            : action === 'update'
              ? await updateService(server, serviceId, input!, opts.dnsHook ?? null, reporter)
              : await createService(server, input!, opts.dnsHook ?? null, reporter);
      steps = [...prefix, ...result.steps];
    } catch (err) {
      // Alles, was die Vorabprüfung nicht sehen konnte, weil es erst zwischen
      // ihr und dem Lauf entstanden ist: eine Domain, die inzwischen jemand
      // anders belegt, ein Server, der gerade weg ist.
      error = err instanceof Error ? err.message : 'Der Vorgang ist fehlgeschlagen.';
    }

    /* ── DNS zuletzt: die Einträge, die niemand mehr braucht ──
     *
     * Nur wenn der Vorgang durchgekommen ist. Ein gescheitertes Löschen lässt
     * den Dienst stehen, und ihm dann den CNAME wegzunehmen nähme eine laufende
     * Domain offline — der Fehler wäre nicht der abgebrochene Vorgang, sondern
     * das, was danach fehlt. Entfernt wird ohnehin nur, was HAPM
     * gesetzt hat (`isProxyRecord`).
     */
    const toRemove = opts.dns?.remove ?? [];
    if (toRemove.length > 0 && !error && !steps.some((step) => !step.ok)) {
      await reporter.onPhase?.('cleanup');
      const removed = await removeProxyRecords(toRemove).catch((err: unknown) => [
        {
          label: 'DNS-Einträge entfernen',
          ok: false,
          detail: err instanceof Error ? err.message : 'Unbekannter Fehler',
        },
      ]);
      steps = [...steps, ...removed];
      await updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, runId, {
        steps: JSON.stringify(steps),
      }).catch(() => {});
    }

    const failed = steps.find((step) => !step.ok);
    const status: RunStatus = error || failed ? 'error' : 'success';
    const completedAt = new Date();

    await updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, runId, {
      status,
      phase: 'done' as HaproxyPhase,
      completedAt: completedAt.toISOString(),
      duration: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
      steps: JSON.stringify(steps),
      error,
    }).catch(() => {});

    await logAudit({
      userId: actor.userId,
      userEmail: actor.email,
      action: status === 'success' ? AUDIT_ACTIONS[action].ok : AUDIT_ACTIONS[action].failed,
      resource: 'server',
      resourceId: server.$id,
      details: auditDetails(opts, error ?? failed?.label ?? null),
      ip: actor.ip ?? undefined,
    }).catch(() => {});

    // Benachrichtigung. Hält den Lauf nicht auf und wirft nie.
    if (status === 'error') {
      void notify({
        type: 'run_failed',
        action,
        entry: serviceId,
        addresses: domains,
        error: error ?? (failed ? [failed.label, failed.detail].filter(Boolean).join('\n') : 'Der Vorgang nennt keinen Grund.'),
        triggeredBy: actor.email,
      });
    }
  })();

  // Bewusst nicht awaitet. Das `.catch` fängt, was die innere Behandlung nicht
  // erwischt (ein Fehler im Schreiben des Ergebnisses selbst) — ohne es wäre
  // das ein Prozessabbruch.
  work.catch((err) => {
    console.error('[haproxy] Lauf fehlgeschlagen:', err);
    updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, runId, {
      status: 'error',
      phase: 'done',
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  });

  return run;
}

/** Die Schritte einer Zeile, tolerant gegen eine halb geschriebene Spalte. */
export function parseSteps(raw: string | null): ProvisionStep[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProvisionStep[]) : [];
  } catch {
    return [];
  }
}

/**
 * Die Schritte als Protokolltext, wie ihn das Overlay zeigt.
 *
 * Es ist dasselbe Overlay wie beim Update-Lauf, und das erwartet eine
 * Textausgabe — hier gibt es stattdessen eine Liste aus Schritt und Ergebnis.
 * Die Übersetzung steht deshalb an einer Stelle und nicht in der Route und der
 * Seite je einmal.
 */
export function stepsAsLog(steps: ProvisionStep[]): string {
  return steps
    .map((step) => {
      const head = `${step.ok ? '[ok]' : '[fehler]'} ${step.label}`;
      if (!step.detail) return head;
      const detail = step.detail
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      return `${head}\n${detail}`;
    })
    .join('\n');
}
