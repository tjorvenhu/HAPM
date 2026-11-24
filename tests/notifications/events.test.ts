import { describe, expect, it } from 'vitest';
import { LONG_TEXT } from '@/ui/primitives/hint-text';
import {
  NOTIFICATION_EVENT_GROUPS,
  NOTIFICATION_EVENT_LABELS,
  REPEAT_AFTER_MS,
  deliveryDecision,
  eventSubject,
  repeatAfterMs,
  type NotificationEvent,
} from '@/lib/notifications/events';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/types';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-24T12:00:00.000Z');

const ready = { enabled: true, recipients: 2, configured: true, lastSentAt: null, now: NOW, repeatAfterMs: REPEAT_AFTER_MS };

describe('deliveryDecision', () => {
  it('verschickt, wenn Schalter, Empfänger und Konto da sind', () => {
    expect(deliveryDecision(ready)).toBe('send');
  });

  it('nennt den ersten Grund, aus dem nichts rausgeht', () => {
    expect(deliveryDecision({ ...ready, enabled: false, recipients: 0, configured: false })).toBe('disabled');
    expect(deliveryDecision({ ...ready, recipients: 0, configured: false })).toBe('no_recipients');
    expect(deliveryDecision({ ...ready, configured: false })).toBe('not_configured');
  });

  it('schweigt einen Tag lang zu derselben Sache', () => {
    const sentAt = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
    expect(deliveryDecision({ ...ready, lastSentAt: sentAt(0.05) })).toBe('dampened');
    expect(deliveryDecision({ ...ready, lastSentAt: sentAt(12) })).toBe('dampened');
    expect(deliveryDecision({ ...ready, lastSentAt: sentAt(22.9) })).toBe('dampened');
    expect(deliveryDecision({ ...ready, lastSentAt: sentAt(25) })).toBe('send');
  });

  it('lässt einen täglichen Lauf durch, der heute etwas schneller war als gestern', () => {
    const yesterdayAFewMinutesLater = new Date(NOW - 24 * HOUR + 4 * 60 * 1000).toISOString();
    expect(deliveryDecision({ ...ready, lastSentAt: yesterdayAFewMinutesLater })).toBe('send');
  });

  it('meldet eine neue Fassung nur einmal', () => {
    const longAgo = new Date(NOW - 90 * 24 * HOUR).toISOString();
    expect(
      deliveryDecision({ ...ready, lastSentAt: longAgo, repeatAfterMs: repeatAfterMs('update_available') })
    ).toBe('dampened');
    expect(repeatAfterMs('backend_down')).toBe(REPEAT_AFTER_MS);
  });

  it('verschickt lieber, als an einem unlesbaren Zeitpunkt zu hängen', () => {
    expect(deliveryDecision({ ...ready, lastSentAt: 'kein datum' })).toBe('send');
  });
});

describe('eventSubject', () => {
  const down = (id: string): NotificationEvent => ({
    type: 'backend_down',
    kind: 'service',
    id,
    addresses: [],
    targets: [],
    since: '2026-11-24T12:00:00.000Z',
  });

  it('trennt Einträge voneinander und Ziele von Weiterleitungen gleichen Namens', () => {
    expect(eventSubject(down('shop'))).not.toBe(eventSubject(down('blog')));
    expect(eventSubject(down('db'))).not.toBe(eventSubject({ ...down('db'), kind: 'stream' } as NotificationEvent));
  });

  it('nimmt Ausfall und Entwarnung desselben Eintrags als dieselbe Sache', () => {
    expect(eventSubject(down('shop'))).toBe(
      eventSubject({ type: 'backend_recovered', kind: 'service', id: 'shop', addresses: [], up: 1, total: 1, downSince: null })
    );
  });

  it('meldet jede neue Fassung eines Bestandteils für sich', () => {
    const available = (latestDigest: string | null, latestVersion: string | null): NotificationEvent => ({
      type: 'update_available',
      component: 'haproxy',
      currentVersion: '3.4.8',
      latestVersion,
      latestDigest,
    });
    expect(eventSubject(available('sha256:aaa', '3.4.9'))).not.toBe(eventSubject(available('sha256:bbb', '3.4.9')));
    expect(eventSubject(available(null, '3.1.2'))).not.toBe(eventSubject(available(null, '3.1.3')));
    expect(eventSubject(available('sha256:aaa', '3.4.9'))).toBe(eventSubject(available('sha256:aaa', '3.4.9')));
  });

  it('dämpft gelungene Updates nicht gegeneinander, gescheiterte je Bestandteil', () => {
    const completed = (runId: string): NotificationEvent => ({
      type: 'update_completed',
      component: 'haproxy',
      runId,
      fromVersion: null,
      toVersion: null,
      triggeredBy: null,
    });
    expect(eventSubject(completed('a'))).not.toBe(eventSubject(completed('b')));
    expect(eventSubject({ type: 'update_failed', component: 'acme', fromVersion: null, error: 'x', triggeredBy: null })).toBe(
      'acme'
    );
  });
});

describe('die Tabelle der Ereignisse', () => {
  const listed = NOTIFICATION_EVENT_GROUPS.flatMap((group) => group.events);

  it('führt jedes Ereignis genau einmal', () => {
    expect(listed.map((event) => event.type).sort()).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
    for (const type of NOTIFICATION_EVENT_TYPES) expect(NOTIFICATION_EVENT_LABELS[type]).toBeTruthy();
  });

  it('kennt keine Meldung für ein neues Gerät', () => {
    expect(NOTIFICATION_EVENT_TYPES as readonly string[]).not.toContain('login_new_device');
  });

  it('beschreibt jedes Ereignis in einem kurzen Satz ohne Gedankenstrich', () => {
    for (const event of listed) {
      expect(event.description.length, event.type).toBeLessThanOrEqual(LONG_TEXT);
      expect(`${event.label} ${event.description}`, event.type).not.toMatch(/[–—]/);
      expect(event.description.endsWith('.'), event.type).toBe(true);
    }
  });
});
