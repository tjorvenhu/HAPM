import { describe, it, expect } from 'vitest';
import {
  parseAcmeList,
  certCovers,
  certificateCovers,
  findCertificateFor,
  pemFileName,
  parseDnsHooks,
} from '@/lib/haproxy/certs';

/**
 * Die Ausgabe ist die von `acme.sh --list --listraw`, samt Kopfzeile, samt
 * Anführungszeichen um die Schlüssellänge und samt `no` für „keine SANs" — alle
 * drei stehen so in echten Ausgaben.
 */
const LISTRAW = `Main_Domain|KeyLength|SAN_Domains|CA|Created|Renew
cloud.example.org|"ec-256"|no|LetsEncrypt.org|2026-05-01T09:12:00Z|2026-06-30T09:12:00Z
example.net|"ec-256"|www.example.net|LetsEncrypt.org|2026-05-02T10:00:00Z|2026-07-01T10:00:00Z
*.kunde.example|"ec-256"|kunde.example|LetsEncrypt.org|2026-05-03T11:00:00Z|2026-07-02T11:00:00Z
`;

describe('parseAcmeList', () => {
  const certs = parseAcmeList(LISTRAW);

  it('überspringt die Kopfzeile und liest jede Zeile als ein Zertifikat', () => {
    expect(certs.map((c) => c.mainDomain)).toEqual([
      'cloud.example.org',
      'example.net',
      '*.kunde.example',
    ]);
  });

  it('nimmt Hauptdomain und SANs zusammen, ohne no und ohne Anführungszeichen', () => {
    expect(certs[0].domains).toEqual(['cloud.example.org']);
    expect(certs[1].domains).toEqual(['example.net', 'www.example.net']);
    expect(certs[0].keyLength).toBe('ec-256');
  });

  it('trägt den Erneuerungszeitpunkt roh mit', () => {
    expect(certs[0].renewAt).toBe('2026-06-30T09:12:00Z');
  });

  it('ist leer, wenn acme.sh nichts sagt — nicht kaputt', () => {
    expect(parseAcmeList('')).toEqual([]);
    expect(parseAcmeList('bash: acme.sh: command not found')).toEqual([]);
  });
});

describe('parseAcmeList mit der Spalte Profile', () => {
  // So schreibt es acme.sh seit der Fassung mit Profilen. Die zweite Zeile ist
  // ein Antrag, der gescheitert ist: Schlüssel da, Zertifikat nie ausgestellt.
  const NEWER = `[Tue Nov 24 15:49:11 CET 2026] Ein Hinweis von acme.sh vor der Tabelle
Main_Domain|KeyLength|SAN_Domains|Profile|CA|Created|Renew
cloud.example.org|"ec-256"|www.example.org||LetsEncrypt.org|2026-05-01T09:12:00Z|2026-06-30T09:12:00Z
demo.example.org|"ec-256"|no||LetsEncrypt.org||
`;
  const certs = parseAcmeList(NEWER);

  it('findet Ausstellung und Erneuerung über die Kopfzeile, nicht über die Nummer', () => {
    expect(certs[0].createdAt).toBe('2026-05-01T09:12:00Z');
    expect(certs[0].renewAt).toBe('2026-06-30T09:12:00Z');
    expect(certs[0].domains).toEqual(['cloud.example.org', 'www.example.org']);
  });

  it('führt einen gescheiterten Antrag als nie ausgestellt', () => {
    expect(certs[1].mainDomain).toBe('demo.example.org');
    expect(certs[1].createdAt).toBeNull();
    expect(certs[1].renewAt).toBeNull();
  });

  it('hält einen gescheiterten Antrag nicht für ein vorhandenes Zertifikat', () => {
    // Sonst entsteht der Dienst beim zweiten Versuch ohne PEM.
    expect(findCertificateFor(certs, ['demo.example.org'])).toBeNull();
    expect(findCertificateFor(certs, ['www.example.org'])?.mainDomain).toBe('cloud.example.org');
  });
});

describe('certCovers', () => {
  it('deckt bei einer Wildcard GENAU eine Ebene ab', () => {
    // Das ist der Unterschied zur ACL, die mit `-m end` jede Tiefe trifft. Wer
    // beide Regeln zusammenlegt, beantragt entweder zu viel oder zu wenig.
    expect(certCovers('*.kunde.example', 'app.kunde.example')).toBe(true);
    expect(certCovers('*.kunde.example', 'a.b.kunde.example')).toBe(false);
    expect(certCovers('*.kunde.example', 'kunde.example')).toBe(false);
  });

  it('lässt sich nicht von einer ähnlich endenden Domain täuschen', () => {
    expect(certCovers('*.kunde.example', 'fremdekunde.example')).toBe(false);
  });

  it('vergleicht ohne Wildcard exakt und ohne Groß-/Kleinschreibung', () => {
    expect(certCovers('kunde.example', 'KUNDE.example')).toBe(true);
    expect(certCovers('kunde.example', 'app.kunde.example')).toBe(false);
  });

  it('deckt eine Wildcard sich selbst ab', () => {
    // Sonst hielte `certificateUsers` einen Dienst auf `*.kunde.example` nicht für
    // einen Nutzer seines eigenen Zertifikats.
    expect(certCovers('*.kunde.example', '*.kunde.example')).toBe(true);
  });
});

describe('findCertificateFor', () => {
  const certs = parseAcmeList(LISTRAW);

  it('findet das Wildcard-Zertifikat für eine neue Subdomain', () => {
    // Der Fall, für den es die Suche gibt: der zweite Dienst unter derselben
    // Wildcard bekommt keinen zweiten Antrag bei Let's Encrypt.
    expect(findCertificateFor(certs, ['api.kunde.example'])?.mainDomain).toBe('*.kunde.example');
  });

  it('deckt Apex und Subdomain zusammen ab, weil beide im Zertifikat stehen', () => {
    expect(findCertificateFor(certs, ['kunde.example', 'app.kunde.example'])?.mainDomain).toBe('*.kunde.example');
  });

  it('gibt null, sobald EINE Domain nicht abgedeckt ist', () => {
    expect(findCertificateFor(certs, ['app.kunde.example', 'neu.example'])).toBeNull();
    // Zwei Ebenen tief: das Zertifikat deckt das nicht ab, es muss ein eigenes her.
    expect(findCertificateFor(certs, ['a.b.kunde.example'])).toBeNull();
  });

  it('sagt bei einem Zertifikat ohne SANs nur Ja zu genau seiner Domain', () => {
    expect(certificateCovers(certs[0], ['cloud.example.org'])).toBe(true);
    expect(certificateCovers(certs[0], ['www.example.org'])).toBe(false);
  });
});

describe('pemFileName', () => {
  it('lässt eine gewöhnliche Domain unangetastet — so liegen die Dateien schon da', () => {
    expect(pemFileName('kunde.example')).toBe('kunde.example.pem');
  });

  it('macht aus dem Stern einen Unterstrich', () => {
    // Ein `*` im Dateinamen wäre in jedem Shell-Muster ein Zeichen zu viel.
    expect(pemFileName('*.kunde.example')).toBe('_.kunde.example.pem');
  });
});

describe('parseDnsHooks', () => {
  it('macht aus den gefundenen Pfaden die Hook-Namen', () => {
    expect(
      parseDnsHooks('/root/.acme.sh/dnsapi/dns_cf.sh\n/root/.acme.sh/dnsapi/dns_hetzner.sh\n')
    ).toEqual(['dns_cf', 'dns_hetzner']);
  });

  it('nennt jeden Hook einmal, auch wenn zwei Variablen auf ihn zeigen', () => {
    expect(
      parseDnsHooks('/root/.acme.sh/dnsapi/dns_cf.sh\n/root/.acme.sh/dnsapi/dns_cf.sh')
    ).toEqual(['dns_cf']);
  });

  it('ist leer, wenn nichts eingerichtet ist — und nicht etwa alles', () => {
    expect(parseDnsHooks('')).toEqual([]);
    expect(parseDnsHooks('grep: /root/.acme.sh/dnsapi: No such file or directory')).toEqual([]);
  });
});
