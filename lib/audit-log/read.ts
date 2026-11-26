/**
 * Das Protokoll lesen: die eine Funktion hinter der Seite „Protokoll", der
 * internen API (`GET /api/internal/audit`), dem MCP-Werkzeug `list_audit_log`,
 * dem Export und der Weiterleitung.
 *
 * ── Zwei Leserichtungen ──
 *
 * Absteigend (die Vorgabe): das Neueste zuerst, weiter mit `before`. So liest
 * ein Mensch. Aufsteigend (`after` oder `order=asc`): vom Ältesten an, weiter
 * mit `after`. So liest ein Programm, das nichts verpassen will. Aufsteigend
 * endet die Antwort `SETTLE_MS` vor jetzt (`lib/db/audit-query.ts`, „Der Rand,
 * an dem noch geschrieben wird"): wer mit dem `cursor` der Antwort weiterliest,
 * bekommt jeden Eintrag genau einmal.
 */

import { ApiError } from '../api';
import { msg } from '../i18n/translate';
import type { WithMeta } from '../db';
import { idAtTime, queryAudit, type AuditActorType, type AuditFilter } from '../db/audit-query';
import type { AuditLog } from '../types';
import { actionsOfArea, areaOf, isAuditArea, isFailure, type AuditArea } from './labels';

/** So lange gilt der jüngste Rand des Protokolls als noch nicht fest. */
export const SETTLE_MS = 1500;

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 1000;

export const AUDIT_ACTOR_TYPES = ['user', 'service', 'system'] as const;

/** Ein Eintrag, wie Seite, API, Export und Weiterleitung ihn sehen. */
export interface AuditEntry {
  id: string;
  /** ISO-Zeit in UTC. */
  timestamp: string;
  /** Der Name der Handlung, etwa `login_failed`. */
  action: string;
  area: AuditArea | null;
  actorType: AuditActorType;
  /** Adresse des Kontos, Name des API-Keys oder `scheduler`. */
  actor: string;
  actorId: string;
  resource: string | null;
  resourceId: string | null;
  details: string | null;
  ip: string | null;
  outcome: 'success' | 'failure';
}

export interface AuditQuery {
  from?: string;
  to?: string;
  actor?: AuditActorType;
  area?: AuditArea;
  q?: string;
  limit: number;
  before?: string;
  after?: string;
  order: 'asc' | 'desc';
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Die Kennung des letzten Eintrags: absteigend als `before`, aufsteigend als `after` weiterreichen. */
  cursor: string | null;
  /** Ob hinter dieser Seite noch etwas steht. */
  more: boolean;
}

export function actorTypeOf(userId: string): AuditActorType {
  if (userId === 'system') return 'system';
  if (userId.startsWith('service:')) return 'service';
  return 'user';
}

export function toEntry(row: WithMeta<AuditLog>): AuditEntry {
  const userId = row.userId ?? '';
  return {
    id: row.$id,
    timestamp: row.timestamp || row.$createdAt,
    action: row.action,
    area: areaOf(row.action),
    actorType: actorTypeOf(userId),
    actor: row.userEmail ?? '',
    actorId: userId,
    resource: row.resource ?? null,
    resourceId: row.resourceId ?? null,
    details: row.details ?? null,
    ip: row.ip ?? null,
    outcome: isFailure(row.action) ? 'failure' : 'success',
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isoTime(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ApiError(msg('{field} ist kein Zeitpunkt. Erwartet wird ISO 8601, etwa 2026-11-26T08:00:00Z.', { field }));
  }
  return new Date(ms).toISOString();
}

function cursor(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{32}$/.test(value)) throw new ApiError(msg('{field} ist keine Kennung aus dem Protokoll.', { field }));
  return value;
}

/**
 * Die Parameter einer Abfrage prüfen. Für die Adresszeile einer Route, den
 * Rumpf des Exports und die Argumente des MCP-Werkzeugs dieselbe Regel.
 */
export function readAuditQuery(input: Record<string, unknown>): AuditQuery {
  const actor = text(input.actor);
  if (actor !== undefined && !(AUDIT_ACTOR_TYPES as readonly string[]).includes(actor)) {
    throw new ApiError(msg('actor ist user, service oder system.'));
  }
  const area = text(input.area);
  if (area !== undefined && !isAuditArea(area)) throw new ApiError(msg('Diesen Bereich kennt das Protokoll nicht.'));

  const q = text(input.q);
  if (q !== undefined && q.length > 200) throw new ApiError(msg('Der Suchtext ist zu lang.'));

  let limit = AUDIT_PAGE_DEFAULT;
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) {
      throw new ApiError(msg('limit ist eine ganze Zahl zwischen 1 und {max}.', { max: AUDIT_PAGE_MAX }));
    }
  }

  const before = cursor(text(input.before), 'before');
  const after = cursor(text(input.after), 'after');
  if (before && after) throw new ApiError(msg('before und after schließen sich aus.'));

  const order = text(input.order);
  if (order !== undefined && order !== 'asc' && order !== 'desc') throw new ApiError(msg('order ist asc oder desc.'));
  if (after && order === 'desc') throw new ApiError(msg('after liest aufsteigend und passt nicht zu order=desc.'));
  if (before && order === 'asc') throw new ApiError(msg('before liest absteigend und passt nicht zu order=asc.'));

  return {
    from: isoTime(text(input.from), 'from'),
    to: isoTime(text(input.to), 'to'),
    actor: actor as AuditActorType | undefined,
    area: area as AuditArea | undefined,
    q,
    limit,
    before,
    after,
    order: after || order === 'asc' ? 'asc' : 'desc',
  };
}

/** Der Teil einer Abfrage, der auswählt (ohne Blättern). */
export function filterOf(query: Pick<AuditQuery, 'from' | 'to' | 'actor' | 'area' | 'q'>): AuditFilter {
  return {
    from: query.from,
    to: query.to,
    actor: query.actor,
    actions: query.area ? actionsOfArea(query.area) : undefined,
    search: query.q,
  };
}

/** Bis hierhin steht das Protokoll fest. */
export function settledId(now: number = Date.now()): string {
  return idAtTime(now - SETTLE_MS);
}

export async function readAuditLog(query: AuditQuery): Promise<AuditPage> {
  const filter: AuditFilter = { ...filterOf(query), before: query.before, after: query.after };
  if (query.order === 'asc') filter.upTo = settledId();

  const rows = await queryAudit(filter, query.order, query.limit + 1);
  const page = rows.slice(0, query.limit);
  const entries = page.map(toEntry);
  return {
    entries,
    cursor: entries.length > 0 ? entries[entries.length - 1].id : (query.after ?? query.before ?? null),
    more: rows.length > query.limit,
  };
}
