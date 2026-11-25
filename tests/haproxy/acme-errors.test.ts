import { describe, it, expect } from 'vitest';
import { explainAcmeFailure } from '@/lib/haproxy/acme-errors';

// Die Ausgabe von acme.sh, wie sie bei einem Benutzer ankam (gekürzt).
const EXACT_SET = `[Wed Nov 25 11:25:49 CET 2026] Error creating new order. Le_OrderFinalize not found. {
  "type": "urn:ietf:params:acme:error:rateLimited",
  "detail": "too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after 2026-11-26 05:49:52 UTC: see https://letsencrypt.org/docs/rate-limits/#new-certificates-per-exact-set-of-identifiers",
  "status": 429
}`;

describe('explainAcmeFailure', () => {
  it('erklärt das Limit für dieselbe Menge an Domains, mit Zeitpunkt und Ausweg', () => {
    const text = explainAcmeFailure(EXACT_SET);
    expect(text).toContain('genau diese Domains');
    expect(text).toContain('Wieder möglich ab 2026-11-26 05:49 UTC.');
    expect(text).toContain('Wildcard aus- oder einschalten');
  });

  it('erklärt das Limit je registrierter Domain', () => {
    const out = '"type": "urn:ietf:params:acme:error:rateLimited", "detail": "too many certificates (50) already issued for this registered domain in the last 168h0m0s, retry after 2026-12-01 10:00:00 UTC"';
    expect(explainAcmeFailure(out)).toContain('50 Zertifikate');
  });

  it('erklärt zu viele fehlgeschlagene Prüfungen', () => {
    const out = '"type": "urn:ietf:params:acme:error:rateLimited", "detail": "too many failed authorizations (5) for \\"example.org\\" in the last 1h0m0s"';
    expect(explainAcmeFailure(out)).toContain('fehlgeschlagene Prüfungen');
  });

  it('nimmt sonst nichts an, was es nicht erkennt', () => {
    expect(explainAcmeFailure('Verify error: Invalid response from http://example.org')).toBeNull();
    expect(explainAcmeFailure('')).toBeNull();
  });
});
