import { describe, it, expect } from 'vitest';
import {
  parseAcmeList,
  certCovers,
  certificateCovers,
  findCertificateFor,
  pemFileName,
  parseDnsHooks,
  servedCertificate,
  certificateUse,
  certificateUsers,
  certificateKeepers,
  type AcmeCertificate,
} from '@/lib/haproxy/certs';
import { servedFiles } from '@/lib/haproxy/cert-upload';

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

/* ── Was HAProxy ausliefert, nicht was abdecken könnte ──
 *
 * Das Fehlerbild, aus dem das stammt: auf der Zertifikatsseite stand die
 * Wildcard `huether.tech, *.huether.tech` bei „Benutzt von" mit allen drei
 * Zielen, obwohl jedes sein eigenes Zertifikat hatte (und die Wildcard nie
 * ausgestellt war). Gezählt wurde jedes Zertifikat, das eine Domain abdeckt. */

describe('servedCertificate', () => {
  const wildcard = { file: 'huether.tech.pem', domains: ['huether.tech', '*.huether.tech'] };
  const own = { file: 'truenas.huether.tech.pem', domains: ['truenas.huether.tech'] };

  it('nimmt das Zertifikat mit genau diesem Namen vor der Wildcard', () => {
    expect(servedCertificate([wildcard, own], 'truenas.huether.tech')).toBe(own);
    expect(servedCertificate([own, wildcard], 'truenas.huether.tech')).toBe(own);
  });

  it('nimmt die Wildcard für einen Namen ohne eigenes Zertifikat', () => {
    expect(servedCertificate([wildcard, own], 'unifi.huether.tech')).toBe(wildcard);
    expect(servedCertificate([wildcard, own], 'huether.tech')).toBe(wildcard);
  });

  it('kennt die eine Ebene der Wildcard', () => {
    expect(servedCertificate([wildcard], 'a.b.huether.tech')).toBeNull();
    expect(servedCertificate([wildcard], 'fremd.example')).toBeNull();
  });

  it('bei gleichen Namen das erste der Liste, so lädt HAProxy das Verzeichnis', () => {
    const second = { file: 'z.pem', domains: ['truenas.huether.tech'] };
    expect(servedCertificate([own, second], 'truenas.huether.tech')).toBe(own);
  });

  it('bedient einen Dienst auf einer Wildcard mit dem Zertifikat dieses Musters', () => {
    expect(servedCertificate([own, wildcard], '*.huether.tech')).toBe(wildcard);
    expect(servedCertificate([own], '*.huether.tech')).toBeNull();
  });
});

describe('certificateUse', () => {
  const hapm = { id: 'hapm', domains: ['hapm.huether.tech'] };
  const truenas = { id: 'truenas_huether_tech', domains: ['truenas.huether.tech'] };
  const unifi = { id: 'unifi_huether_tech', domains: ['unifi.huether.tech'] };
  const services = [hapm, truenas, unifi];

  const wildcard = { file: 'huether.tech.pem', domains: ['huether.tech', '*.huether.tech'] };
  const ownHapm = { file: 'hapm.huether.tech.pem', domains: ['hapm.huether.tech'] };
  const ownTruenas = { file: 'truenas.huether.tech.pem', domains: ['truenas.huether.tech'] };
  const ownUnifi = { file: 'unifi.huether.tech.pem', domains: ['unifi.huether.tech'] };

  it('schreibt einen Dienst mit eigenem Zertifikat nicht zusätzlich unter die Wildcard', () => {
    const use = certificateUse([ownHapm, wildcard, ownTruenas, ownUnifi], services);
    expect(use.get(wildcard)).toEqual([]);
    expect(use.get(ownHapm)).toEqual([hapm]);
    expect(use.get(ownTruenas)).toEqual([truenas]);
    expect(use.get(ownUnifi)).toEqual([unifi]);
  });

  it('ohne eigene Zertifikate benutzen alle die Wildcard', () => {
    const use = certificateUse([wildcard], services);
    expect(use.get(wildcard)).toEqual(services);
  });

  it('ein Dienst auf der Wildcard benutzt auch ein genaues Zertifikat darunter, das bei ihm landet', () => {
    const catchAll = { id: 'alle', domains: ['*.huether.tech'] };
    const use = certificateUse([wildcard, ownTruenas], [catchAll]);
    expect(use.get(wildcard)).toEqual([catchAll]);
    expect(use.get(ownTruenas)).toEqual([catchAll]);
  });

  it('das genaue Zertifikat gehört dem Eintrag, bei dem die Anfrage landet', () => {
    const catchAll = { id: 'alle', domains: ['*.huether.tech'] };
    // Exakte Einträge stehen vor den Wildcards (`insertServiceBlock`).
    const use = certificateUse([wildcard, ownTruenas], [truenas, catchAll]);
    expect(use.get(ownTruenas)).toEqual([truenas]);
    expect(use.get(wildcard)).toEqual([catchAll]);
  });

  it('nennt einen Dienst mit mehreren Domains auf demselben Zertifikat nur einmal', () => {
    const both = { id: 'beide', domains: ['huether.tech', 'www.huether.tech'] };
    expect(certificateUse([wildcard], [both]).get(wildcard)).toEqual([both]);
  });
});

/* ── Wann ein Zertifikat von acme.sh gelöscht werden darf ──
 *
 * Die Zertifikatsseite bietet das Löschen nur an, wenn `certificateKeepers`
 * leer ist, und `removeAcmeCertificate` fragt im Lock dieselbe Funktion. Die
 * Regel: kein Ziel bekommt es ausgeliefert, und es deckt keine Domain eines
 * Ziels ab (`certificateUsers`, wie beim Löschen eines Dienstes). Im Zweifel
 * bleibt es stehen. */

function acmeCert(mainDomain: string, domains: string[], createdAt: string | null = '2026-05-01T00:00:00Z'): AcmeCertificate {
  return { mainDomain, domains, keyLength: 'ec-256', createdAt, renewAt: null };
}

describe('certificateUsers', () => {
  it('zählt jeden Dienst, dessen Domain das Zertifikat abdeckt', () => {
    const app = { id: 'app', domains: ['app.kunde.example'] };
    const other = { id: 'fremd', domains: ['fremd.example'] };
    const wildcard = acmeCert('kunde.example', ['kunde.example', '*.kunde.example']);
    expect(certificateUsers(wildcard, [app, other])).toEqual([app]);
  });

  it('eine Wildcard deckt nur eine Ebene ab', () => {
    const deep = { id: 'tief', domains: ['a.b.kunde.example'] };
    expect(certificateUsers(acmeCert('*.kunde.example', ['*.kunde.example']), [deep])).toEqual([]);
  });
});

describe('certificateKeepers', () => {
  const app = { id: 'app', domains: ['app.kunde.example'] };
  const other = { id: 'fremd', domains: ['fremd.example'] };

  const keepers = (cert: AcmeCertificate, all: AcmeCertificate[], services: { id: string; domains: string[] }[], deployed: string[] | null = null) =>
    certificateKeepers(cert, servedFiles(all, [], deployed), services).map((service) => service.id);

  it('ein Zertifikat, das kein Ziel betrifft, hält niemand', () => {
    const left = acmeCert('alt.example', ['alt.example']);
    expect(keepers(left, [left], [app, other])).toEqual([]);
  });

  it('das eigene Zertifikat eines Ziels hält das Ziel', () => {
    const own = acmeCert('app.kunde.example', ['app.kunde.example']);
    expect(keepers(own, [own], [app, other])).toEqual(['app']);
  });

  it('eine Wildcard bleibt, solange ein Ziel darunter liegt, auch wenn HAProxy ihm sein eigenes ausliefert', () => {
    const own = acmeCert('app.kunde.example', ['app.kunde.example']);
    const wildcard = acmeCert('kunde.example', ['kunde.example', '*.kunde.example']);
    // Ausgeliefert wird das eigene, „Benutzt von" der Wildcard ist leer …
    const files = servedFiles([own, wildcard], [], null);
    expect(certificateUse(files, [app]).get(files.find((f) => f.file === 'kunde.example.pem')!)).toEqual([]);
    // … und trotzdem bleibt sie: sie deckt app ab.
    expect(keepers(wildcard, [own, wildcard], [app])).toEqual(['app']);
  });

  it('ein genaues Zertifikat, das HAProxy einem Dienst auf der Wildcard ausliefert, bleibt', () => {
    const catchAll = { id: 'alle', domains: ['*.kunde.example'] };
    const own = acmeCert('app.kunde.example', ['app.kunde.example']);
    // `app.kunde.example` deckt `*.kunde.example` nicht ab, ausgeliefert wird es trotzdem.
    expect(certificateUsers(own, [catchAll])).toEqual([]);
    expect(keepers(own, [own], [catchAll])).toEqual(['alle']);
  });

  it('ein nicht ausgerolltes Zertifikat bleibt, solange es ein Ziel abdeckt', () => {
    const own = acmeCert('app.kunde.example', ['app.kunde.example']);
    expect(keepers(own, [own], [app], [])).toEqual(['app']);
    expect(keepers(own, [own], [other], [])).toEqual([]);
  });

  it('einen nie ausgestellten Antrag hält niemand: er deckt nichts ab', () => {
    const failed = acmeCert('kunde.example', ['kunde.example', '*.kunde.example'], null);
    expect(keepers(failed, [failed], [app])).toEqual([]);
  });

  it('nennt jeden Dienst einmal, in der Reihenfolge der Datei', () => {
    const both = { id: 'beide', domains: ['kunde.example', 'www.kunde.example'] };
    const wildcard = acmeCert('kunde.example', ['kunde.example', '*.kunde.example']);
    expect(keepers(wildcard, [wildcard], [both, app, other])).toEqual(['beide', 'app']);
  });
});
