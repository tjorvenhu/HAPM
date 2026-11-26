import { describe, it, expect } from 'vitest';
import {
  CRS_MODES,
  isValidBouncerKey,
  readCrsMode,
  renderAcquis,
  renderBackendParser,
  renderBouncerConfig,
  renderCrsMethods,
} from '@/lib/crowdsec/files';
import { CRS_METHODS_FILE } from '@/lib/crowdsec/paths';

/**
 * Die Dateien für CrowdSec. Ob CrowdSec sie annimmt, prüft
 * `scripts/verify-crowdsec.ts`; hier, dass sie so dastehen, wie es geprüft wurde.
 */

describe('renderAcquis', () => {
  it('liest das Log von HAProxy und öffnet die WAF im Netz des Stacks', () => {
    const text = renderAcquis('off');
    expect(text).toContain('  - /var/log/haproxy/haproxy.log');
    expect(text).toContain('  type: haproxy');
    expect(text).toContain('source: appsec');
    expect(text).toContain('listen_addr: 0.0.0.0:7422');
    expect(text).toContain('  - crowdsecurity/appsec-default');
    expect(text).not.toContain('crowdsecurity/crs');
  });

  it('nimmt die OWASP-Regeln je Modus auf und liest den Modus zurück', () => {
    for (const mode of CRS_MODES) {
      expect(readCrsMode(renderAcquis(mode)), mode).toBe(mode);
    }
    expect(renderAcquis('detect')).toContain('  - crowdsecurity/crs\n');
    expect(renderAcquis('block')).toContain('  - crowdsecurity/crs-inband\n');
    expect(readCrsMode(null)).toBe('off');
    expect(readCrsMode('irgendwas')).toBe('off');
  });
});

describe('renderBackendParser', () => {
  it('setzt target_backend und springt nicht über die übrigen Parser der Stufe', () => {
    const text = renderBackendParser();
    expect(text).toContain('meta: target_backend');
    expect(text).toContain('evt.Parsed.backend_name');
    // `onsuccess: next_stage` übersprünge http-logs, und kein Szenario spränge an.
    expect(text).not.toContain('onsuccess');
  });
});

describe('renderCrsMethods', () => {
  it('erlaubt PUT, PATCH und DELETE, aber nicht TRACE (Regel 911100)', () => {
    const text = renderCrsMethods();
    expect(text).toContain("setvar:'tx.allowed_methods=GET HEAD POST OPTIONS PUT PATCH DELETE'");
    expect(text).not.toContain('TRACE');
    // Eine Kennung aus dem Bereich der CRS-Plugins, phase:1 wie 901160.
    expect(text).toMatch(/SecAction "id:95\d{5},phase:1,/);
  });

  it('liegt dort, wo crowdsecurity/crs Plugins sucht (crs-plugins/*/*-config.conf im Datenordner)', () => {
    expect(CRS_METHODS_FILE).toMatch(/^data\/crs-plugins\/[^/]+\/[^/]+-config\.conf$/);
  });
});

describe('renderBouncerConfig', () => {
  it('spricht CrowdSec und die WAF über den Namen im Stack an und lauscht auf 7423', () => {
    const text = renderBouncerConfig('a'.repeat(48));
    expect(text).toContain('api_url: http://crowdsec:8080/');
    expect(text).toContain('appsec_url: http://crowdsec:7422/');
    expect(text).toContain('listen_tcp: 0.0.0.0:7423');
    expect(text).toContain(`api_key: ${'a'.repeat(48)}`);
    // Ohne Anbieter wäre ein captcha-Block nur ein Fehler im Log des Bouncers.
    expect(text).not.toContain('captcha');
  });

  it('nimmt nur Schlüssel aus Buchstaben und Ziffern', () => {
    expect(isValidBouncerKey('a'.repeat(48))).toBe(true);
    expect(isValidBouncerKey('kurz')).toBe(false);
    expect(isValidBouncerKey(`${'a'.repeat(40)}\nx: y`)).toBe(false);
  });
});
