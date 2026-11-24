import { describe, expect, it } from 'vitest';
import { getClientIP } from '@/lib/audit';

/**
 * An dieser Adresse hängen die Sperre nach Fehlversuchen und die Bindung eines
 * API-Schlüssels an Adressen. Eine Kopfzeile schreibt der Aufrufer: sie zählt
 * nur, wenn die Anfrage vom eigenen HAProxy kommt.
 */
function request(headers: Record<string, string>): Request {
  return new Request('http://hapm.test/api/x', { headers });
}

describe('getClientIP', () => {
  it('nimmt bei direktem Zugriff die Gegenstelle und glaubt keiner Kopfzeile', () => {
    expect(
      getClientIP(
        request({
          'x-hapm-remote-addr': '203.0.113.9',
          'x-forwarded-for': '10.0.0.1',
          'x-real-ip': '10.0.0.2',
        })
      )
    ).toBe('203.0.113.9');
  });

  it('nimmt hinter dem eigenen HAProxy den letzten Eintrag, den es angehängt hat', () => {
    expect(
      getClientIP(request({ 'x-hapm-remote-addr': '127.0.0.1', 'x-forwarded-for': '10.9.9.9, 198.51.100.7' }))
    ).toBe('198.51.100.7');
    expect(getClientIP(request({ 'x-hapm-remote-addr': '::1', 'x-forwarded-for': '198.51.100.7' }))).toBe(
      '198.51.100.7'
    );
  });

  it('kürzt die IPv4-Schreibweise in IPv6', () => {
    expect(getClientIP(request({ 'x-hapm-remote-addr': '::ffff:192.0.2.4' }))).toBe('192.0.2.4');
    expect(
      getClientIP(request({ 'x-hapm-remote-addr': '::ffff:127.0.0.1', 'x-forwarded-for': '198.51.100.7' }))
    ).toBe('198.51.100.7');
  });

  it('bleibt bei einem lokalen Aufruf ohne Proxy bei der lokalen Adresse', () => {
    expect(getClientIP(request({ 'x-hapm-remote-addr': '127.0.0.1' }))).toBe('127.0.0.1');
  });

  it('liest X-Real-IP nie', () => {
    expect(getClientIP(request({ 'x-real-ip': '10.0.0.2' }))).toBe('unknown');
  });
});
