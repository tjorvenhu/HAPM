import { describe, it, expect } from 'vitest';
import { describeReason } from '@/lib/crowdsec/describe';

/** Die Namen stammen aus echten Ereignissen (CrowdSec 1.8.2, appsec-crs out-of-band). */
describe('describeReason', () => {
  it('nennt die Kategorie eines OWASP-Treffers in Worten und sagt, dass er nur gemeldet ist', () => {
    const result = describeReason('anomaly score out-of-band: lfi: 5, anomaly: 5, ');
    expect(result?.labels).toEqual(['Zugriff auf Dateien des Servers']);
    expect(result?.hints.at(-1)).toMatch(/^Nur gemeldet/);
  });

  it('gleiche Kategorie mit anderer Punktzahl ist dieselbe Beschriftung', () => {
    expect(describeReason('anomaly score out-of-band: lfi: 5, anomaly: 10, ')?.labels).toEqual(
      describeReason('anomaly score out-of-band: lfi: 5, anomaly: 5, ')?.labels
    );
  });

  it('nur Gesamtpunkte ohne Kategorie: allgemeine Regel', () => {
    expect(describeReason('anomaly score out-of-band: anomaly: 5, ')?.labels).toEqual(['Auffällige Anfrage']);
  });

  it('mehrere Kategorien, jede einmal', () => {
    expect(describeReason('anomaly score out-of-band: sql_injection: 5, xss: 5, anomaly: 10, ')?.labels).toEqual([
      'Eingeschleuste Datenbankabfrage',
      'Eingeschleustes Skript',
    ]);
    expect(describeReason('anomaly score out-of-band: rce: 15, anomaly: 15, ')?.labels).toEqual(['Eingeschleuste Befehle']);
  });

  it('OWASP an: der Treffer wurde abgewiesen, nicht nur gemeldet', () => {
    const result = describeReason('anomaly score block: lfi: 40, rce: 10, anomaly: 55, ');
    expect(result?.labels).toEqual(['Zugriff auf Dateien des Servers', 'Eingeschleuste Befehle']);
    expect(result?.hints.at(-1)).toBe('Die Anfrage wurde mit 403 abgewiesen.');
    expect(result?.hints.some((hint) => hint.startsWith('Nur gemeldet'))).toBe(false);
    expect(describeReason('anomaly score block: anomaly: 5, ')?.labels).toEqual(['Auffällige Anfrage']);
  });

  it('Regeln und Szenarien nach Namen, mit und ohne Autor', () => {
    expect(describeReason('crowdsecurity/vpatch-env-access')?.labels).toEqual(['Abruf einer .env-Datei']);
    expect(describeReason('crowdsecurity/http-probing')?.labels).toEqual(['Viele Abrufe von Seiten, die es nicht gibt']);
    expect(describeReason('http-sensitive-files')?.labels).toEqual(['Suche nach vertraulichen Dateien']);
    expect(describeReason('crowdsecurity/crowdsec-appsec-outofband')?.labels).toEqual(['Wiederholt auffällige Anfragen']);
  });

  it('Familien: CVE, virtuelle Patches, Passwörter, WordPress, Überlastung', () => {
    expect(describeReason('crowdsecurity/vpatch-CVE-2024-4577')?.labels).toEqual(['Angriff auf eine bekannte Lücke']);
    expect(describeReason('crowdsecurity/apache_log4j2_cve-2021-44228')?.labels).toEqual(['Angriff auf eine bekannte Lücke']);
    expect(describeReason('crowdsecurity/http-generic-bf')?.labels).toEqual(['Passwörter durchprobiert']);
    expect(describeReason('crowdsecurity/http-bf-wordpress_bf')?.labels).toEqual(['Passwörter durchprobiert']);
    expect(describeReason('crowdsecurity/http-wordpress-scan')?.labels).toEqual(['Angriff auf WordPress']);
    expect(describeReason('crowdsecurity/http-dos-random-uri')?.labels).toEqual(['Überlastungsversuch']);
  });

  it('Unbekanntes und Gründe von Hand bleiben, wie sie sind', () => {
    expect(describeReason('crowdsecurity/irgendwas-neues')).toBeNull();
    expect(describeReason('Spam im Kontaktformular')).toBeNull();
    expect(describeReason('')).toBeNull();
  });
});
