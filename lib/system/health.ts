/**
 * Der Zustand der Installation als Urteil, für eine Überwachung von außen.
 *
 * `systemOverview` liefert Zahlen, diese Datei sagt, was sie bedeuten: je
 * Prüfung `ok`, `warn`, `fail` oder `unknown`, und daraus ein Gesamturteil.
 * Rein bis auf die Texte: `judge` rechnet aus einer Übersicht und dem Stand
 * der Sicherung, `tests/system/health.test.ts` rechnet nach.
 *
 * ── Was `fail` ist und was nicht ──
 *
 * `fail` heißt: der Proxy selbst arbeitet nicht oder nicht mehr lange (HAProxy
 * steht, die Docker-Engine ist weg, ein Zertifikat ist abgelaufen). Darauf
 * antwortet die Route mit 503, und daran darf eine Überwachung oder ein
 * vorgeschalteter Verteiler umschalten.
 *
 * Ein Ziel ohne erreichbares Backend ist `warn`: das Backend ist kaputt, nicht
 * der Proxy, und ein zweiter Knoten hätte dasselbe Problem. Wer deshalb auf
 * 503 umschaltete, nähme auch alle Ziele mit, die laufen.
 *
 * `unknown` ist nicht `ok`. Was nicht zu erfahren war, zieht das Gesamturteil
 * auf `warn`: eine Überwachung, die bei „unbekannt" grün zeigt, merkt den
 * Ausfall des Docker-Sockets nie.
 */

import type { Translator } from '../i18n';
import type { RunStatus } from '../types';
import type { SystemOverview } from './overview';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface HealthCheck {
  /** Fester Name, auch als Label in den Metriken. Ändert sich nicht mehr. */
  id: string;
  status: CheckStatus;
  /** Ein Satz, wenn es etwas zu sagen gibt. `null` bei `ok`. */
  message: string | null;
}

export interface HealthReport {
  status: Exclude<CheckStatus, 'unknown'>;
  generatedAt: string;
  version: string;
  checks: HealthCheck[];
}

/** Was die Prüfung der Sicherung wissen muss. `null`: nicht zu lesen. */
export interface BackupHealthInput {
  enabled: boolean;
  /** Der jüngste Lauf, gleich welcher Art. */
  lastRun: { status: RunStatus; startedAt: string } | null;
  /** Wann zuletzt eine Sicherung gelang. */
  lastSuccessAt: string | null;
}

/** Eine tägliche Sicherung, die so lange nicht gelang, ist ausgefallen. */
export const BACKUP_STALE_HOURS = 50;

const HOUR_MS = 60 * 60 * 1000;

function check(id: string, status: CheckStatus, message: string | null = null): HealthCheck {
  return { id, status, message };
}

function containerCheck(
  id: string,
  container: SystemOverview['haproxy'],
  stopped: CheckStatus,
  texts: { stopped: string; missing: string; unknown: string; unhealthy: string }
): HealthCheck {
  if (container.running === null) return check(id, 'unknown', texts.unknown);
  if (container.exists === false) return check(id, stopped, texts.missing);
  if (!container.running) return check(id, stopped, texts.stopped);
  if (container.health === 'unhealthy') return check(id, stopped, texts.unhealthy);
  return check(id, 'ok');
}

export function judge(
  overview: SystemOverview,
  backup: BackupHealthInput | null,
  { t, plural }: Translator,
  now = Date.now()
): HealthReport {
  const checks: HealthCheck[] = [];

  checks.push(
    overview.bootstrap.status === 'error'
      ? check('bootstrap', 'fail', t('Die Einrichtung beim Start ist gescheitert.'))
      : overview.bootstrap.status === 'ok' || overview.bootstrap.status === 'skipped'
        ? check('bootstrap', 'ok')
        : check('bootstrap', 'warn', t('Die Einrichtung beim Start läuft noch.'))
  );

  checks.push(
    overview.docker.available
      ? check('docker', 'ok')
      : check('docker', 'fail', t('Die Docker-Engine ist nicht erreichbar.'))
  );

  checks.push(
    containerCheck('haproxy', overview.haproxy, 'fail', {
      stopped: t('HAProxy läuft nicht.'),
      missing: t('Den Container von HAProxy gibt es nicht.'),
      unknown: t('Der Zustand von HAProxy ist nicht zu erfahren.'),
      unhealthy: t('HAProxy läuft, meldet sich aber als nicht bereit.'),
    })
  );

  const proxy = overview.proxy;
  if (proxy.error || proxy.services === null) {
    checks.push(check('targets', 'unknown', t('Die HAProxy-Konfiguration ist nicht lesbar.')));
  } else if (proxy.down === null || proxy.partial === null) {
    checks.push(check('targets', 'unknown', t('Über die Backends der Ziele ist nichts bekannt.')));
  } else if (proxy.down > 0) {
    checks.push(
      check(
        'targets',
        'warn',
        plural(proxy.down, {
          one: 'Ein Ziel hat kein erreichbares Backend.',
          other: '{count} Ziele haben kein erreichbares Backend.',
        })
      )
    );
  } else if (proxy.partial > 0) {
    checks.push(
      check(
        'targets',
        'warn',
        plural(proxy.partial, {
          one: 'Bei einem Ziel antwortet nur ein Teil der Backends.',
          other: 'Bei {count} Zielen antwortet nur ein Teil der Backends.',
        })
      )
    );
  } else {
    checks.push(check('targets', 'ok'));
  }

  const certs = overview.certificates;
  const expired = certs.due.filter((cert) => cert.daysLeft !== null && cert.daysLeft < 0).length;
  if (certs.total === null) {
    checks.push(check('certificates', 'unknown', t('Die Zertifikate sind nicht zu lesen.')));
  } else if (expired > 0) {
    checks.push(
      check(
        'certificates',
        'fail',
        plural(expired, { one: 'Ein Zertifikat ist abgelaufen.', other: '{count} Zertifikate sind abgelaufen.' })
      )
    );
  } else if (certs.due.length > 0) {
    checks.push(
      check(
        'certificates',
        'warn',
        plural(certs.due.length, {
          one: 'Ein Zertifikat läuft bald ab oder wurde nicht erneuert.',
          other: '{count} Zertifikate laufen bald ab oder wurden nicht erneuert.',
        })
      )
    );
  } else if (certs.unreadable > 0) {
    checks.push(
      check(
        'certificates',
        'warn',
        plural(certs.unreadable, {
          one: 'Bei einem Zertifikat ist das Ablaufdatum nicht lesbar.',
          other: 'Bei {count} Zertifikaten ist das Ablaufdatum nicht lesbar.',
        })
      )
    );
  } else {
    checks.push(check('certificates', 'ok'));
  }

  const renewal = overview.scheduler.lastRenewal;
  checks.push(
    renewal && !renewal.ok
      ? check('renewal', 'warn', t('Die letzte Erneuerung der Zertifikate meldet einen Fehler.'))
      : check('renewal', 'ok')
  );

  if (!overview.scheduler.started) {
    checks.push(check('scheduler', 'fail', t('Der Zeitplan von HAPM läuft nicht.')));
  } else if (overview.scheduler.lastStatsError) {
    checks.push(check('scheduler', 'warn', t('Der letzte Abruf der Statistik ist gescheitert.')));
  } else {
    checks.push(check('scheduler', 'ok'));
  }

  const runs = overview.runs;
  if (runs.failed === null) {
    checks.push(check('runs', 'unknown', t('Die Historie der Vorgänge ist nicht zu lesen.')));
  } else if (runs.failed > 0) {
    checks.push(
      check(
        'runs',
        'warn',
        plural(runs.failed, {
          one: 'Ein Vorgang ist gescheitert und noch offen.',
          other: '{count} Vorgänge sind gescheitert und noch offen.',
        })
      )
    );
  } else {
    checks.push(check('runs', 'ok'));
  }

  // CrowdSec zählt nur, wenn der Stack es mitbringt und ein Ziel es benutzt.
  const crowdsec = overview.crowdsec.summary;
  if (crowdsec?.inStack && (crowdsec.global || crowdsec.protectedServices > 0)) {
    checks.push(
      !crowdsec.running
        ? check('crowdsec', 'warn', t('CrowdSec läuft nicht, obwohl Ziele es benutzen.'))
        : !crowdsec.bouncerRunning
          ? check('crowdsec', 'warn', t('Der Bouncer von CrowdSec läuft nicht, obwohl Ziele ihn benutzen.'))
          : check('crowdsec', 'ok')
    );
  }

  // Ohne tägliche Sicherung gibt es nichts, was ausfallen kann.
  if (backup === null) {
    checks.push(check('backup', 'unknown', t('Der Stand der Sicherung ist nicht zu lesen.')));
  } else if (backup.enabled) {
    const lastSuccess = backup.lastSuccessAt ? Date.parse(backup.lastSuccessAt) : Number.NaN;
    if (backup.lastRun?.status === 'error') {
      checks.push(check('backup', 'warn', t('Die letzte Sicherung ist gescheitert.')));
    } else if (Number.isNaN(lastSuccess)) {
      checks.push(check('backup', 'warn', t('Es gibt noch keine gelungene Sicherung.')));
    } else if (now - lastSuccess > BACKUP_STALE_HOURS * HOUR_MS) {
      checks.push(
        check(
          'backup',
          'warn',
          t('Die letzte gelungene Sicherung ist älter als {hours} Stunden.', { hours: BACKUP_STALE_HOURS })
        )
      );
    } else {
      checks.push(check('backup', 'ok'));
    }
  }

  return {
    status: overall(checks),
    generatedAt: overview.generatedAt,
    version: overview.hapm.version,
    checks,
  };
}

export function overall(checks: HealthCheck[]): HealthReport['status'] {
  if (checks.some((entry) => entry.status === 'fail')) return 'fail';
  if (checks.some((entry) => entry.status === 'warn' || entry.status === 'unknown')) return 'warn';
  return 'ok';
}
