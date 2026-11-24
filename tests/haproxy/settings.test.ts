import { describe, it, expect } from 'vitest';
import {
  parseGlobalSettings,
  applyGlobalSettings,
  validateGlobalSettings,
  readGlobalSettingsPatch,
  settingsEditable,
  HTTPS_MARKER,
  HaproxyConfigError,
  type GlobalSettings,
  type GlobalSettingsInput,
} from '@/lib/haproxy/config';

/**
 * Die globalen Einstellungen: der Block unter `# Globale HTTPS-Settings` und
 * die Umleitung für unbekannte Domains.
 *
 * Der Block ist Text und wird als Text zurückgeschrieben — deshalb ist die
 * wichtigste Probe hier der Rundlauf: was gelesen und unverändert gespeichert
 * wird, muss dieselbe Datei ergeben. Und die Zeilen, die den BLOCK zerschneiden
 * würden (ein Kommentar, ein `backend …`), werden abgelehnt, bevor irgendetwas
 * geschrieben wird: sie stünden danach in der Datei, aber außerhalb des
 * Bereichs, und alles darunter mit ihnen.
 */

const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

    # Globale HTTPS-Settings
    http-response set-header Strict-Transport-Security "max-age=31536000"
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    http-request set-header X-Forwarded-Port 443
    http-request set-header X-Forwarded-Host %[req.hdr(host)]

    # AUTO: website_intern
    acl host_website_intern hdr(host),lower -i example.org
    use_backend website_intern if host_website_intern

# END AUTO INTERN SERVICES

    default_backend default_404

# ============================================================

backend default_404
    http-request redirect location https://example.org/error?code=404 code 302

# END AUTO INTERN BACKENDS
`;

const LINES = [
  'http-response set-header Strict-Transport-Security "max-age=31536000"',
  'option forwardfor',
  'http-request set-header X-Forwarded-Proto https',
  'http-request set-header X-Forwarded-Port 443',
  'http-request set-header X-Forwarded-Host %[req.hdr(host)]',
];

const INPUT: GlobalSettingsInput = {
  httpsLines: LINES,
  adminIps: [],
};

describe('parseGlobalSettings', () => {
  it('liest den Block und die Umleitung', () => {
    const settings = parseGlobalSettings(CONFIG);
    expect(settings.httpsLines).toEqual(LINES);
    expect(settingsEditable(settings)).toBe(true);
  });

  it('liest eine Zeile mit, die kein Formular je abgebildet hätte', () => {
    // Der Fall, für den dieser Umbau gemacht wurde: solche Zeilen machten den
    // ganzen Block vorher unbearbeitbar. Jetzt sind sie einfach eine Zeile.
    const mit = CONFIG.replace(
      '    option forwardfor\n',
      '    option forwardfor\n    http-response set-header X-Content-Type-Options "nosniff"\n'
    );
    const settings = parseGlobalSettings(mit);
    expect(settings.httpsLines).toContain(
      'http-response set-header X-Content-Type-Options "nosniff"'
    );
    expect(settingsEditable(settings)).toBe(true);
  });

  it('endet am Ende des Blocks und liest nicht die halbe Datei', () => {
    // Die ACL des Dienstes steht nach einer Leerzeile und gehört nicht dazu.
    const settings = parseGlobalSettings(CONFIG);
    expect(settings.httpsLines).toEqual(LINES);
  });

  it('gibt null zurück, wenn der Marker fehlt', () => {
    const ohne = CONFIG.replace(`    ${HTTPS_MARKER}\n`, '');
    const settings = parseGlobalSettings(ohne);
    expect(settings.httpsLines).toBeNull();
    expect(settingsEditable(settings)).toBe(false);
  });

  it('unterscheidet einen leeren Block von einem fehlenden Marker', () => {
    // Leer heißt: der Block steht da und ist bearbeitbar. Null heißt: es gibt
    // keine Stelle, an die die Zeilen gehören.
    const leer = CONFIG.split('\n')
      .filter((line) => !LINES.includes(line.trim()))
      .join('\n');
    const settings = parseGlobalSettings(leer);
    expect(settings.httpsLines).toEqual([]);
    expect(settingsEditable(settings)).toBe(true);
  });

  it('fasst den Rest der Datei nicht an', () => {
    // Die Umleitung für unbekannte Domains gehört nicht zu den globalen
    // Einstellungen: der Fehlerfall wird mit einer eigenen Fehlerdatei bedient,
    // und dieses Modul liest und schreibt die Zeile nicht.
    const next = applyGlobalSettings(CONFIG, { ...INPUT, httpsLines: [] });
    expect(next).toContain(
      '    http-request redirect location https://example.org/error?code=404 code 302'
    );
  });
});

describe('applyGlobalSettings', () => {
  it('ändert nichts, wenn nichts geändert wurde', () => {
    // Die Probe darauf, dass Lesen und Schreiben dieselbe Form meinen: sonst
    // stünde nach jedem Öffnen der Seite eine Änderung an, die keine ist.
    expect(applyGlobalSettings(CONFIG, INPUT)).toBe(CONFIG);
  });

  it('entfernt eine gestrichene Zeile und behält die Einrückung', () => {
    const next = applyGlobalSettings(CONFIG, {
      ...INPUT,
      httpsLines: LINES.filter((line) => !line.includes('X-Forwarded-Port')),
    });
    expect(next).not.toContain('X-Forwarded-Port');
    expect(next).toContain('    option forwardfor');
    // Der Rest der Datei bleibt unberührt.
    expect(next).toContain('    acl host_website_intern hdr(host),lower -i example.org');
    expect(parseGlobalSettings(next).httpsLines).not.toContain(
      'http-request set-header X-Forwarded-Port 443'
    );
  });

  it('schreibt eine neue Zeile so, wie sie eingegeben wurde', () => {
    const zeile = 'http-response set-header X-Content-Type-Options "nosniff"';
    const next = applyGlobalSettings(CONFIG, { ...INPUT, httpsLines: [...LINES, zeile] });
    expect(next).toContain(`    ${zeile}`);
    // Und sie kommt genauso zurück: sonst stünde nach jedem Öffnen der Seite
    // eine Änderung an, die keine ist.
    expect(parseGlobalSettings(next).httpsLines).toEqual([...LINES, zeile]);
  });

  it('leert den Block, ohne den Marker zu verlieren', () => {
    const next = applyGlobalSettings(CONFIG, { ...INPUT, httpsLines: [] });
    // Ohne den Marker wüsste der nächste Lauf nicht mehr, wo der Block hingehört.
    expect(next).toContain(HTTPS_MARKER);
    expect(next).not.toContain('forwardfor');
    expect(parseGlobalSettings(next).httpsLines).toEqual([]);
  });

  it('weigert sich bei einer Zeile, die den Block zerschneiden würde', () => {
    const mit = { ...INPUT, httpsLines: [...LINES, 'backend etwas_anderes'] };
    expect(() => applyGlobalSettings(CONFIG, mit)).toThrow(HaproxyConfigError);
    expect(() => applyGlobalSettings(CONFIG, mit)).toThrow(/Konfigurationsabschnitt/);
  });

  it('weigert sich, wenn der Marker fehlt', () => {
    const ohne = CONFIG.replace(`    ${HTTPS_MARKER}\n`, '');
    expect(() => applyGlobalSettings(ohne, INPUT)).toThrow(/fehlt die Zeile/);
  });
});

describe('validateGlobalSettings', () => {
  it('nimmt den Normalfall an', () => {
    expect(validateGlobalSettings(INPUT)).toBeNull();
  });

  it('nimmt eine beliebige HAProxy-Zeile an — geprüft wird sie auf der Maschine', () => {
    expect(
      validateGlobalSettings({
        ...INPUT,
        httpsLines: ['http-request set-header X-Forwarded-For %[src]', 'unsinn ohne bedeutung'],
      })
    ).toBeNull();
  });

  it('lehnt einen Kommentar ab', () => {
    // Der Block endet am ersten Kommentar. Die Zeile stünde in der Datei, wäre
    // beim nächsten Lesen aber nicht mehr Teil des Blocks — alles darunter auch nicht.
    expect(
      validateGlobalSettings({ ...INPUT, httpsLines: ['# nur mal so', 'option forwardfor'] })
    ).toMatch(/Kommentar/);
  });

  it('lehnt eine Zeile ab, die einen neuen Abschnitt beginnt', () => {
    expect(validateGlobalSettings({ ...INPUT, httpsLines: ['frontend woanders'] })).toMatch(
      /Konfigurationsabschnitt/
    );
  });

});

/**
 * Der Teil-Patch aus `/api/internal/haproxy/settings`.
 *
 * Der Dialog schickt immer beide Listen, weil beide auf dem Bildschirm stehen.
 * Ein Dienst schickt die eine Zeile, um die es ihm geht — und ein fehlendes
 * Feld als „leer" zu lesen hieße, dass ein Aufruf zum Eintragen einer
 * Admin-Adresse nebenbei HSTS von der Maschine nimmt.
 */
describe('readGlobalSettingsPatch', () => {
  const CURRENT: GlobalSettings = {
    httpsLines: ['option forwardfor', 'http-request set-header X-Forwarded-Proto https'],
    adminIps: ['10.0.0.0/8', '203.0.113.4'],
    adminEditable: true,
    lockedServices: [],
  };

  /** Nimmt dem Test die Fallunterscheidung ab: hier wird der gültige Fall geprüft. */
  function patch(body: unknown): GlobalSettingsInput {
    const result = readGlobalSettingsPatch(body, CURRENT);
    if ('error' in result) throw new Error(`unerwartet abgelehnt: ${result.error}`);
    return result;
  }

  it('lässt stehen, was nicht im Rumpf steht', () => {
    expect(patch({})).toEqual({ httpsLines: CURRENT.httpsLines, adminIps: CURRENT.adminIps });
  });

  it('nimmt eine Adresse dazu, ohne die HTTPS-Zeilen anzufassen', () => {
    const result = patch({ addAdminIps: ['198.51.100.9'] });
    expect(result.adminIps).toEqual(['10.0.0.0/8', '203.0.113.4', '198.51.100.9']);
    expect(result.httpsLines).toEqual(CURRENT.httpsLines);
  });

  it('nimmt eine Adresse weg', () => {
    expect(patch({ removeAdminIps: ['10.0.0.0/8'] }).adminIps).toEqual(['203.0.113.4']);
  });

  it('behält die Reihenfolge und schreibt keine Adresse doppelt', () => {
    // Die Liste steht so in der Datei. Sie beim Hinzufügen umzusortieren wäre
    // eine Änderung im Diff, die niemand angefordert hat.
    expect(patch({ addAdminIps: ['203.0.113.4', '198.51.100.9'] }).adminIps).toEqual([
      '10.0.0.0/8',
      '203.0.113.4',
      '198.51.100.9',
    ]);
  });

  it('ersetzt die ganze Liste, wenn adminIps dasteht', () => {
    expect(patch({ adminIps: ['192.0.2.1'] }).adminIps).toEqual(['192.0.2.1']);
  });

  it('lässt die Liste leeren', () => {
    // Eine leere Liste ist eine Ansage und kein fehlendes Feld. Ob sie erlaubt
    // ist, entscheidet `applyGlobalSettings` anhand der gesperrten Dienste.
    expect(patch({ adminIps: [] }).adminIps).toEqual([]);
  });

  it('lehnt Setzen und Ändern in einem Aufruf ab', () => {
    // „Setze die Liste auf A und nimm B dazu" hat zwei vertretbare Ergebnisse,
    // und welches gemeint war, weiß nur der Aufrufer.
    const result = readGlobalSettingsPatch(
      { adminIps: ['192.0.2.1'], addAdminIps: ['198.51.100.9'] },
      CURRENT
    );
    expect(result).toHaveProperty('error');
  });

  it('macht aus einem fehlenden Marker keine erfundenen Zeilen', () => {
    // `httpsLines: null` heißt „den Block gibt es nicht". Der Patch reicht eine
    // leere Liste weiter, und `applyGlobalSettings` lehnt sie gleich danach mit
    // dem Grund ab — geraten wird hier nichts.
    const ohneMarker = readGlobalSettingsPatch({}, { ...CURRENT, httpsLines: null });
    expect(ohneMarker).toEqual({ httpsLines: [], adminIps: CURRENT.adminIps });
  });
});
