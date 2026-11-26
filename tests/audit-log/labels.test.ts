import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { en } from '@/lib/i18n/en';
import {
  AUDIT_ACTIONS,
  AUDIT_AREAS,
  AUDIT_AREA_LABELS,
  actionsOfArea,
  areaOf,
  isFailure,
  labelOf,
} from '@/lib/audit-log/labels';

/**
 * Jede Handlung des Protokolls hat einen Text und einen Bereich.
 *
 * Die Namen stehen in `lib/audit.ts` als Typ und sind zur Laufzeit nicht da.
 * Deshalb liest der Test sie aus dem Quelltext: wer dort eine Handlung
 * ergänzt und sie in `lib/audit-log/labels.ts` vergisst, sieht es hier (und
 * schon beim Übersetzen, `Record<AuditAction, …>`).
 */

function declaredActions(): string[] {
  const source = readFileSync('lib/audit.ts', 'utf8');
  const start = source.indexOf('export type AuditAction');
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
}

describe('Texte der Handlungen', () => {
  const declared = declaredActions();

  it('findet die Handlungen im Quelltext, damit ein kaputtes Lesen den Test nicht grün macht', () => {
    expect(declared.length).toBeGreaterThan(80);
    expect(declared).toContain('login');
    expect(declared).toContain('crowdsec_cleared');
  });

  it('kennt jede Handlung aus lib/audit.ts', () => {
    expect(declared.filter((action) => !Object.hasOwn(AUDIT_ACTIONS, action))).toEqual([]);
  });

  it('führt keine Handlung, die es nicht mehr gibt', () => {
    expect(Object.keys(AUDIT_ACTIONS).filter((action) => !declared.includes(action))).toEqual([]);
  });

  it.each(Object.entries(AUDIT_ACTIONS))('%s hat einen Text, eine Übersetzung und einen Bereich', (_action, info) => {
    expect(info.label.trim()).not.toBe('');
    expect(Object.hasOwn(en, info.label)).toBe(true);
    expect(AUDIT_AREAS).toContain(info.area);
  });

  it('übersetzt jeden Bereich, und jeder Bereich hat Handlungen', () => {
    for (const area of AUDIT_AREAS) {
      expect(Object.hasOwn(en, AUDIT_AREA_LABELS[area])).toBe(true);
      expect(actionsOfArea(area).length).toBeGreaterThan(0);
    }
  });

  it('verteilt jede Handlung auf genau einen Bereich', () => {
    const all = AUDIT_AREAS.flatMap((area) => actionsOfArea(area));
    expect(all.length).toBe(Object.keys(AUDIT_ACTIONS).length);
    expect(new Set(all).size).toBe(all.length);
  });

  it('gibt für eine unbekannte Handlung nichts zurück statt zu werfen', () => {
    expect(labelOf('gibt_es_nicht')).toBeNull();
    expect(areaOf('gibt_es_nicht')).toBeNull();
    // Kein Zugriff auf geerbte Eigenschaften des Objekts.
    expect(labelOf('constructor')).toBeNull();
    expect(labelOf('toString')).toBeNull();
  });

  it('erkennt Fehlschläge und Abweisungen am Namen', () => {
    expect(isFailure('login_failed')).toBe(true);
    expect(isFailure('service_token_ip_rejected')).toBe(true);
    expect(isFailure('2fa_failed')).toBe(true);
    expect(isFailure('login')).toBe(false);
    expect(isFailure('haproxy_failure_acknowledged')).toBe(false);
  });
});
