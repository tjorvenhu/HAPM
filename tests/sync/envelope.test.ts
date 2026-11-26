import { describe, it, expect } from 'vitest';
import {
  ENVELOPE_OVERHEAD,
  MAX_SKEW_MS,
  NonceCache,
  generatePairingKey,
  isPairingKey,
  openRequest,
  openResponse,
  parseHeader,
  sealRequest,
  sealResponse,
  verifyHeader,
} from '@/lib/sync/envelope';

/**
 * Der Umschlag zwischen zwei Knoten. Ein Paket trägt private Schlüssel und
 * reist womöglich über unverschlüsseltes HTTP: jede Regel hier ist die, an der
 * ein Mitleser oder ein Fremder scheitern muss.
 */

const key = generatePairingKey();
const NOW = 1_800_000_000_000;

describe('Kopplungsschlüssel', () => {
  it('trägt ein erkennbares Präfix und ist jedes Mal ein anderer', () => {
    expect(key).toMatch(/^hapmsync_[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, generatePairingKey)).size).toBe(200);
  });

  it('erkennt, was keiner ist', () => {
    expect(isPairingKey(key)).toBe(true);
    for (const wrong of ['', 'hapm_abc', `${key}x`, key.slice(0, -1), ` ${key}`, null, 42]) {
      expect(isPairingKey(wrong)).toBe(false);
    }
  });
});

describe('Anfrage', () => {
  it('kommt mit dem richtigen Schlüssel wieder heraus', () => {
    const payload = Buffer.from('{"frage":"stand"}');
    const sealed = sealRequest(key, 'status', payload, NOW);
    const header = parseHeader(sealed.header)!;
    expect(header.kind).toBe('status');
    expect(header.length).toBe(payload.length + ENVELOPE_OVERHEAD);
    expect(sealed.body.length).toBe(header.length);
    expect(verifyHeader(key, header, NOW)).toBe('ok');
    expect(openRequest(key, header, sealed.body).equals(payload)).toBe(true);
  });

  it('verrät den Inhalt nicht', () => {
    const secret = Buffer.from('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n');
    const sealed = sealRequest(key, 'apply', secret, NOW);
    expect(sealed.body.includes(Buffer.from('PRIVATE KEY'))).toBe(false);
    expect(sealed.header).not.toContain('PRIVATE');
  });

  it('lehnt einen fremden Schlüssel schon an der Kopfzeile ab', () => {
    const sealed = sealRequest(key, 'apply', Buffer.from('x'), NOW);
    const header = parseHeader(sealed.header)!;
    expect(verifyHeader(generatePairingKey(), header, NOW)).toBe('mac');
  });

  it('lehnt jede veränderte Angabe der Kopfzeile ab', () => {
    const sealed = sealRequest(key, 'status', Buffer.from('{}'), NOW);
    const header = parseHeader(sealed.header)!;
    expect(verifyHeader(key, { ...header, kind: 'apply' }, NOW)).toBe('mac');
    expect(verifyHeader(key, { ...header, ts: header.ts + 1 }, NOW)).toBe('mac');
    expect(verifyHeader(key, { ...header, length: header.length + 1 }, NOW)).toBe('mac');
    // Ein anderes letztes Zeichen, gleich welches dort stand.
    const other = header.nonce.endsWith('A') ? 'B' : 'A';
    expect(verifyHeader(key, { ...header, nonce: `${header.nonce.slice(0, -1)}${other}` }, NOW)).toBe('mac');
  });

  it('lehnt eine alte Anfrage ab und eine aus der Zukunft', () => {
    const sealed = sealRequest(key, 'status', Buffer.from('{}'), NOW);
    const header = parseHeader(sealed.header)!;
    expect(verifyHeader(key, header, NOW + MAX_SKEW_MS)).toBe('ok');
    expect(verifyHeader(key, header, NOW + MAX_SKEW_MS + 1)).toBe('time');
    expect(verifyHeader(key, header, NOW - MAX_SKEW_MS - 1)).toBe('time');
  });

  it('lässt sich nicht mit einem veränderten Rumpf öffnen', () => {
    const sealed = sealRequest(key, 'apply', Buffer.from('haproxy.cfg'), NOW);
    const header = parseHeader(sealed.header)!;
    const flipped = Buffer.from(sealed.body);
    flipped[flipped.length - 1] ^= 1;
    expect(() => openRequest(key, header, flipped)).toThrow();
    expect(() => openRequest(key, header, sealed.body.subarray(0, sealed.body.length - 1))).toThrow();
    expect(() => openRequest(generatePairingKey(), header, sealed.body)).toThrow();
  });

  it('bindet den Rumpf an seine Kopfzeile', () => {
    // Derselbe Rumpf unter der Kopfzeile einer anderen Anfrage: die Art wäre sonst austauschbar.
    const status = sealRequest(key, 'status', Buffer.from('{}'), NOW);
    const apply = sealRequest(key, 'apply', Buffer.from('{}'), NOW);
    expect(() => openRequest(key, parseHeader(apply.header)!, status.body)).toThrow();
  });
});

describe('parseHeader', () => {
  it('nimmt nur die eigene Form', () => {
    const good = sealRequest(key, 'status', Buffer.from('{}'), NOW).header;
    expect(parseHeader(good)).not.toBeNull();
    for (const wrong of [
      null,
      '',
      'v2;1;a;status;1;b',
      good.replace('v1;', 'v0;'),
      good.replace(';status;', ';delete;'),
      `${good};mehr`,
      good.split(';').slice(0, 5).join(';'),
      'x'.repeat(500),
    ]) {
      expect(parseHeader(wrong)).toBeNull();
    }
  });
});

describe('Antwort', () => {
  it('gehört zu genau einer Anfrage', () => {
    const first = sealRequest(key, 'status', Buffer.from('{}'), NOW);
    const second = sealRequest(key, 'status', Buffer.from('{}'), NOW);
    const answer = sealResponse(key, first.nonce, Buffer.from('{"ok":true}'));
    expect(openResponse(key, first.nonce, answer).toString()).toBe('{"ok":true}');
    // Eine mitgeschnittene Antwort passt nicht zu einer späteren Anfrage.
    expect(() => openResponse(key, second.nonce, answer)).toThrow();
    expect(() => openResponse(generatePairingKey(), first.nonce, answer)).toThrow();
  });

  it('ist nicht als Anfrage zu gebrauchen', () => {
    const request = sealRequest(key, 'status', Buffer.from('{}'), NOW);
    const answer = sealResponse(key, request.nonce, Buffer.from('{}'));
    expect(() => openRequest(key, { ...parseHeader(request.header)!, length: answer.length }, answer)).toThrow();
  });
});

describe('NonceCache', () => {
  it('lässt jeden Einmalwert einmal gelten', () => {
    const cache = new NonceCache();
    expect(cache.claim('a', NOW)).toBe(true);
    expect(cache.claim('a', NOW + 1000)).toBe(false);
    expect(cache.claim('b', NOW + 1000)).toBe(true);
  });

  it('vergisst erst, was die Zeitprüfung ohnehin ablehnt', () => {
    const cache = new NonceCache();
    cache.claim('a', NOW);
    expect(cache.claim('a', NOW + 2 * MAX_SKEW_MS - 1)).toBe(false);
    expect(cache.claim('a', NOW + 2 * MAX_SKEW_MS + 1)).toBe(true);
  });

  it('lehnt ab, statt zu vergessen, wenn er voll ist', () => {
    const cache = new NonceCache(3);
    expect(cache.claim('a', NOW)).toBe(true);
    expect(cache.claim('b', NOW)).toBe(true);
    expect(cache.claim('c', NOW)).toBe(true);
    expect(cache.claim('d', NOW)).toBe(false);
    expect(cache.claim('a', NOW)).toBe(false);
  });
});
