/**
 * Was die Benachrichtigungen sich merken: wann zu welcher Sache zuletzt eine
 * Mail rausging (Dämpfung) und wie der letzte Versand ausging (Oberfläche).
 *
 * Jede Zeile wird über ihre Kennung gelesen, nie über ein Feld. Die Kennung
 * ist aus Ereignis und Sache abgeleitet.
 */

import { createHash } from 'node:crypto';
import { createDocument, deleteWhere, getDocument, updateDocument, NotFoundError, Query } from '../db';
import {
  COLLECTIONS,
  NOTIFICATION_DELIVERY_ID,
  type NotificationDelivery,
  type NotificationEventType,
  type NotificationState,
} from '../types';
import { STATE_RETENTION_DAYS } from './events';

type StateData = Omit<NotificationState, '$id' | '$createdAt' | '$updatedAt'>;
export type DeliveryData = Omit<NotificationDelivery, '$id' | '$createdAt' | '$updatedAt'>;

export function stateId(type: NotificationEventType, subject: string): string {
  return `n_${createHash('sha256').update(`${type}\n${subject}`).digest('hex').slice(0, 40)}`;
}

async function upsert<T>(id: string, data: Partial<T>): Promise<void> {
  try {
    await updateDocument<T>(COLLECTIONS.NOTIFICATION_STATE, id, data);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    await createDocument<T>(COLLECTIONS.NOTIFICATION_STATE, data, id);
  }
}

/** `null` heißt: zu dieser Sache ging noch nichts raus. Ein Fehler der Datenbank wird geworfen. */
export async function readState(type: NotificationEventType, subject: string): Promise<NotificationState | null> {
  try {
    return await getDocument<NotificationState>(COLLECTIONS.NOTIFICATION_STATE, stateId(type, subject));
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export async function recordSent(type: NotificationEventType, subject: string, at: string): Promise<void> {
  await upsert<StateData>(stateId(type, subject), { type, subject, lastSentAt: at, resolvedAt: null });
}

/**
 * Einen gemeldeten Zustand als vorbei vermerken. Gibt die Zeile zurück, wenn
 * er offen war: nur dann ist eine Entwarnung fällig.
 */
export async function resolveState(
  type: NotificationEventType,
  subject: string,
  at: string
): Promise<NotificationState | null> {
  const state = await readState(type, subject);
  if (!state || state.resolvedAt) return null;
  await updateDocument<StateData>(COLLECTIONS.NOTIFICATION_STATE, state.$id, { resolvedAt: at });
  return state;
}

export async function recordDelivery(delivery: DeliveryData): Promise<void> {
  await upsert<DeliveryData>(NOTIFICATION_DELIVERY_ID, delivery);
}

export async function lastDelivery(): Promise<NotificationDelivery | null> {
  try {
    return await getDocument<NotificationDelivery>(COLLECTIONS.NOTIFICATION_STATE, NOTIFICATION_DELIVERY_ID);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/** Die Zeile des letzten Versands trägt kein `lastSentAt` und bleibt deshalb stehen. */
export async function pruneStates(now = Date.now()): Promise<number> {
  const before = new Date(now - STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return deleteWhere(COLLECTIONS.NOTIFICATION_STATE, [Query.lessThan('lastSentAt', before)]);
}
