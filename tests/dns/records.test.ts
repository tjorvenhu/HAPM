import { describe, it, expect } from 'vitest';
import {
  validateRecordInput,
  readRecordInput,
  isEditableRecord,
  formatTtl,
  TTL_AUTO,
  type RecordInput,
} from '@/lib/dns/records';

/**
 * Dieselbe Funktion prüft im Dialog und in der Route. Was hier durchgeht, geht
 * an Cloudflare — und was Cloudflare ablehnt, soll gar nicht erst dorthin.
 */

function input(patch: Partial<RecordInput> = {}): RecordInput {
  return {
    type: 'A',
    name: 'app',
    content: '203.0.113.10',
    ttl: TTL_AUTO,
    proxied: false,
    priority: null,
    comment: null,
    ...patch,
  };
}

describe('validateRecordInput', () => {
  it('nimmt die üblichen Einträge an', () => {
    expect(validateRecordInput(input(), 'kunde.example')).toBeNull();
    expect(
      validateRecordInput(input({ type: 'CNAME', content: 'ziel.kunde.example' }), 'kunde.example')
    ).toBeNull();
    expect(
      validateRecordInput(input({ type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none' }), 'kunde.example')
    ).toBeNull();
    expect(
      validateRecordInput(input({ type: 'MX', content: 'mx.kunde.example', priority: 10 }), 'kunde.example')
    ).toBeNull();
    expect(validateRecordInput(input({ name: '*' }), 'kunde.example')).toBeNull();
  });

  it('unterscheidet Adresse und Name — der häufigste Tippfehler', () => {
    expect(validateRecordInput(input({ content: 'ziel.kunde.example' }), 'kunde.example')).toMatch(/IPv4/);
    expect(
      validateRecordInput(input({ type: 'CNAME', content: '203.0.113.10' }), 'kunde.example')
    ).toMatch(/Namen, nicht auf eine IP/);
    expect(validateRecordInput(input({ type: 'AAAA', content: '203.0.113.10' }), 'kunde.example')).toMatch(
      /IPv6/
    );
  });

  it('lässt keinen CNAME auf der Domain selbst zu', () => {
    expect(
      validateRecordInput(input({ type: 'CNAME', name: '@', content: 'ziel.example' }), 'kunde.example')
    ).toMatch(/NS- und MX-Einträge/);
  });

  it('verlangt bei MX eine Priorität und prüft ihren Bereich', () => {
    expect(
      validateRecordInput(input({ type: 'MX', content: 'mx.kunde.example', priority: null }), 'kunde.example')
    ).toMatch(/Priorität/);
    expect(
      validateRecordInput(input({ type: 'MX', content: 'mx.kunde.example', priority: 70000 }), 'kunde.example')
    ).toMatch(/zwischen 0 und 65535/);
  });

  it('kennt die TTL-Grenzen von Cloudflare, samt „automatisch“', () => {
    expect(validateRecordInput(input({ ttl: 1 }), 'kunde.example')).toBeNull();
    expect(validateRecordInput(input({ ttl: 30 }), 'kunde.example')).toMatch(/TTL/);
    expect(validateRecordInput(input({ ttl: 200_000 }), 'kunde.example')).toMatch(/TTL/);
  });

  it('lehnt ab, was dieses Formular nicht vollständig abbildet', () => {
    const srv = { ...input(), type: 'SRV' } as unknown as RecordInput;
    expect(validateRecordInput(srv, 'kunde.example')).toMatch(/SRV/);
  });

  it('lässt keinen Cloudflare-Proxy an einem Eintrag, der keinen haben kann', () => {
    expect(
      validateRecordInput(input({ type: 'TXT', content: 'hallo', proxied: true }), 'kunde.example')
    ).toMatch(/nicht über seine Server/);
  });
});

describe('readRecordInput', () => {
  it('normalisiert, ohne die Art zurechtzubiegen', () => {
    const parsed = readRecordInput({ type: 'cname', name: ' APP ', content: ' ziel.example ' });
    expect(parsed.type).toBe('CNAME');
    expect(parsed.name).toBe('app');
    expect(parsed.content).toBe('ziel.example');
    // Eine unbekannte Art bleibt stehen, damit die Prüfung sie benennen kann.
    expect(readRecordInput({ type: 'SRV' }).type).toBe('SRV');
  });

  it('wirft weg, was an dieser Art keine Bedeutung hat', () => {
    expect(readRecordInput({ type: 'TXT', proxied: true }).proxied).toBe(false);
    expect(readRecordInput({ type: 'A', priority: 10 }).priority).toBeNull();
    expect(readRecordInput({ type: 'MX', priority: 20 }).priority).toBe(20);
  });
});

describe('isEditableRecord', () => {
  it('lässt nur bekannte und nicht von Cloudflare gepflegte Arten zu', () => {
    expect(isEditableRecord({ type: 'A', locked: false })).toBe(true);
    expect(isEditableRecord({ type: 'SRV', locked: false })).toBe(false);
    expect(isEditableRecord({ type: 'A', locked: true })).toBe(false);
  });
});

describe('formatTtl', () => {
  it('nennt die 1 beim Namen — sie ist keine Sekunde', () => {
    expect(formatTtl(1)).toBe('auto');
    expect(formatTtl(300)).toBe('5 min');
    expect(formatTtl(3600)).toBe('1 h');
  });
});
