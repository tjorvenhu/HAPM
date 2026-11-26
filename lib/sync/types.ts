/**
 * Der Abgleich zwischen Knoten: Rollen und die Formen, die über die Leitung
 * und in die Oberfläche gehen.
 *
 * Rein, ohne Import außer `lib/i18n`: die Seite „Abgleich" liest hier dieselben
 * Namen wie der Server. Was der Abgleich ist und was nicht, steht in
 * `docs/hochverfuegbarkeit.md`.
 */

import { msgid } from '../i18n/translate';

/**
 * `single`: die Vorgabe, HAPM verwaltet eine Maschine und spricht mit keiner
 * anderen. `primary`: hier wird geändert, der Stand geht an die Folgeknoten.
 * `replica`: nimmt den Stand eines Hauptknotens an und ändert selbst nichts
 * daran.
 */
export const SYNC_ROLES = ['single', 'primary', 'replica'] as const;
export type SyncRole = (typeof SYNC_ROLES)[number];

export function isSyncRole(value: unknown): value is SyncRole {
  return typeof value === 'string' && (SYNC_ROLES as readonly string[]).includes(value);
}

export const SYNC_ROLE_LABELS: Record<SyncRole, string> = {
  single: msgid('Einzeln'),
  primary: msgid('Hauptknoten'),
  replica: msgid('Folgeknoten'),
};

/**
 * Die Fassung dessen, was zwischen zwei Knoten gesprochen wird: Umschlag,
 * Paket und Auskunft. Zwei Knoten mit verschiedenen Zahlen gleichen nicht ab,
 * statt einander halb zu verstehen.
 */
export const SYNC_PROTOCOL = 2;

/** Was ein Knoten einem anderen über sich sagt. Nur mit Kopplungsschlüssel zu lesen. */
export interface NodeReport {
  protocol: number;
  nodeId: string;
  name: string;
  role: SyncRole;
  hapmVersion: string;
  /** `null` heißt unbekannt (HAProxy antwortet gerade nicht), nicht „keins". */
  haproxyVersion: string | null;
  /** Ob CrowdSec auf dem Knoten da und eingeschaltet ist. */
  crowdsec: boolean;
  /** Art der Installation: `internal` oder `public`. */
  exposure: string;
  /** Der Hauptknoten, an den dieser Folgeknoten gebunden ist. */
  primary: { nodeId: string; name: string } | null;
  /** Der zuletzt übernommene Stand. `null`: es wurde noch nie etwas übernommen. */
  applied: {
    fingerprint: string;
    seq: number;
    at: string;
    /** Womit der Folgeknoten das Paket an sich angepasst hat, siehe `localVariant`. */
    variant: string;
    /** Fingerabdruck des übernommenen Datenteils (`lib/sync/data.ts`). `null`: noch keiner übernommen. */
    data: string | null;
    /** Fingerabdruck des übernommenen Stands von CrowdSec. `null`: noch keiner übernommen. */
    crowdsec: string | null;
  } | null;
  /** Womit er ein Paket jetzt anpassen würde. Weicht es von `applied.variant` ab, ist ein neuer Abgleich fällig. */
  variant: string;
  /**
   * Ob die Dateien noch so liegen wie nach dem letzten Abgleich. `false`:
   * jemand hat auf dem Folgeknoten etwas geändert. `null`: nicht zu sagen.
   */
  intact: boolean | null;
  /**
   * Dasselbe für die Daten: ob Konten, Einstellungen, Zonen und API-Keys noch
   * so in der Datenbank stehen wie nach dem letzten Abgleich.
   */
  dataIntact: boolean | null;
  /** Das Anwenden, das gerade läuft oder zuletzt lief. */
  apply: ApplyState | null;
}

export interface SyncStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ApplyState {
  seq: number;
  state: 'running' | 'success' | 'error';
  startedAt: string;
  completedAt: string | null;
  steps: SyncStep[];
  error: string | null;
}

/** Warum ein Knoten ein Paket nicht annimmt. Der Hauptknoten macht daraus einen Satz. */
export type RefusalCode =
  | 'protocol'
  | 'not_replica'
  | 'other_primary'
  | 'stale'
  | 'busy'
  | 'invalid';

export type NodeAnswer =
  | { ok: true; report: NodeReport }
  | { ok: true; accepted: true; seq: number }
  | { ok: false; code: RefusalCode; report: NodeReport | null; detail?: string };

/**
 * Was beim Vergleich zweier Knoten auffällt, ohne den Abgleich zu verhindern.
 * Als Kennung mit Werten und nicht als fertiger Satz: die Seite zeigt sie in
 * der Sprache des Betrachters.
 */
export type SyncWarning =
  | { code: 'hapm_version'; here: string; there: string }
  | { code: 'haproxy_version'; here: string; there: string }
  /** `haproxy.cfg` benutzt CrowdSec, auf dem Folgeknoten ist es nicht eingeschaltet. */
  | { code: 'crowdsec_off' }
  /** Verweise und Sonderdateien, die nicht übertragen werden. */
  | { code: 'skipped'; count: number };

export type SyncDirection = 'send' | 'receive';
export type SyncTrigger = 'manual' | 'change' | 'schedule' | 'incoming';

export const SYNC_TRIGGER_LABELS: Record<SyncTrigger, string> = {
  manual: msgid('Von Hand'),
  change: msgid('Nach einer Änderung'),
  schedule: msgid('Regelmäßige Prüfung'),
  incoming: msgid('Vom Hauptknoten'),
};
