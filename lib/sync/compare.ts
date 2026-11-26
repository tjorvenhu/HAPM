/**
 * Der Vergleich zweier Knoten vor einem Abgleich: nimmt die Gegenstelle
 * überhaupt an, was fällt auf, und trägt sie den Stand schon.
 *
 * Rein, damit `tests/sync/compare.test.ts` jede Regel nachrechnen kann.
 *
 * Abgelehnt wird nur, was sicher falsch ist (zwei Hauptknoten, ein fremder
 * Hauptknoten, eine andere Fassung des Abgleichs). Ob eine neuere `haproxy.cfg`
 * auf einem älteren HAProxy lädt, lässt sich aus zwei Versionsnummern nicht
 * sagen: das entscheidet dort `haproxy -c`, und lehnt es ab, bleibt dort der
 * alte Stand. Verschiedene Fassungen sind deshalb ein Hinweis und keine Absage.
 */

import type { BundleMeta } from './bundle';
import { SYNC_PROTOCOL, type NodeReport, type SyncWarning } from './types';

/** Warum eine Gegenstelle nichts annimmt, als Satz. `null`: sie nimmt an. */
export function refusalOf(report: NodeReport, ownNodeId: string): string | null {
  if (report.protocol !== SYNC_PROTOCOL) {
    return `${report.name} spricht eine andere Fassung des Abgleichs (${report.protocol} statt ${SYNC_PROTOCOL}). Beide Knoten brauchen dieselbe Fassung von HAPM.`;
  }
  if (report.nodeId === ownNodeId) return 'Die Adresse führt zu diesem Knoten selbst.';
  if (report.role === 'primary') {
    return `${report.name} ist selbst Hauptknoten. Zwei Hauptknoten gleichen nicht ab: einer von beiden muss Folgeknoten werden.`;
  }
  if (report.role !== 'replica') return `${report.name} ist nicht als Folgeknoten eingerichtet.`;
  if (report.primary && report.primary.nodeId !== ownNodeId) {
    return `${report.name} ist an den Hauptknoten ${report.primary.name} gebunden. Ein neuer Kopplungsschlüssel dort löst die Bindung.`;
  }
  return null;
}

/** Was auffällt, ohne den Abgleich zu verhindern. Ob HAProxy dort die Datei lädt, entscheidet seine eigene Prüfung. */
export function warningsFor(report: NodeReport, meta: BundleMeta): SyncWarning[] {
  const warnings: SyncWarning[] = [];
  const { sender } = meta;
  if (report.hapmVersion !== sender.hapmVersion) {
    warnings.push({ code: 'hapm_version', here: sender.hapmVersion, there: report.hapmVersion });
  }
  if (report.haproxyVersion && sender.haproxyVersion && report.haproxyVersion !== sender.haproxyVersion) {
    warnings.push({ code: 'haproxy_version', here: sender.haproxyVersion, there: report.haproxyVersion });
  }
  if (sender.usesCrowdsec && !report.crowdsec) warnings.push({ code: 'crowdsec_off' });
  if (meta.skipped.length > 0) warnings.push({ code: 'skipped', count: meta.skipped.length });
  return warnings;
}

/** Die Fingerabdrücke eines Pakets: Dateien, Daten, CrowdSec. */
export type StateMarks = Pick<BundleMeta, 'fingerprint' | 'dataFingerprint' | 'crowdsecFingerprint'>;

/**
 * Ob der Folgeknoten zuletzt genau diesen Stand übernommen hat: Dateien, Daten
 * und CrowdSec, mit der Anpassung, die er auch jetzt wählen würde (sonst hat
 * sich dort etwas geändert, das eine andere Datei ergäbe). Ein Teil, den das
 * Paket nicht trägt (`null`), zählt nicht: dann bleibt dort, was ist.
 */
export function tookState(report: NodeReport, state: StateMarks): boolean {
  const applied = report.applied;
  return (
    applied !== null &&
    applied.fingerprint === state.fingerprint &&
    applied.variant === report.variant &&
    (state.dataFingerprint === null || applied.data === state.dataFingerprint) &&
    (state.crowdsecFingerprint === null || applied.crowdsec === state.crowdsecFingerprint)
  );
}

/**
 * Ob der Folgeknoten den Stand trägt: er hat ihn übernommen (`tookState`), und
 * Dateien wie Daten liegen dort noch so wie danach.
 */
export function carriesState(report: NodeReport, state: StateMarks): boolean {
  return tookState(report, state) && report.intact !== false && (state.dataFingerprint === null || report.dataIntact !== false);
}
