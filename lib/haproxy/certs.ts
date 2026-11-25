/**
 * Was an Zertifikaten auf der Maschine liegt — gelesen, nicht gespeichert.
 *
 * ── Warum es diese Datei gibt ──
 *
 * Die einfache Annahme wäre: ein Zertifikat gehört genau einem Dienst, es
 * entsteht mit ihm (`issueAndDeploy` beim Anlegen) und vergeht mit ihm
 * (`dropCertificate` beim Löschen). Das trägt, solange jede Domain genau einem
 * Eintrag gehört — dafür sorgt die Konfliktprüfung.
 *
 * Mit Wildcards trägt es nicht, und zwar genau da, wo Wildcards ihren Sinn
 * haben: `app.kunde.example` und `api.kunde.example` sind zwei Dienste auf EINEM
 * Zertifikat `*.kunde.example`. Den ersten zu löschen nähme dem zweiten das PEM weg.
 * Das fällt nicht heute auf, sondern beim nächsten Start von HAProxy — dieselbe
 * Sorte Fehler, wegen der das PEM beim Löschen vor der Prüfung beiseitegelegt
 * wird und nicht danach.
 *
 * Die Wahrheit über die Zertifikate bleibt deshalb da, wo auch die Wahrheit über
 * die Konfiguration liegt: auf der Maschine. `acme.sh --list --listraw` sagt,
 * was es gibt und welche Domains drinstehen. Keine Collection dahinter, aus
 * demselben Grund wie beim Dienst — eine Spiegelung wäre genau dann falsch, wenn
 * jemand auf der Maschine von Hand ein Zertifikat ausgestellt hat, also in dem
 * Moment, in dem man sie braucht.
 *
 * Rein und ohne Zugriff auf die Maschine, damit `tests/haproxy/certs.test.ts`
 * an echter Ausgabe nachrechnen kann — dieselbe Bauweise wie `config.ts`.
 */

import { domainCovers, isWildcardDomain } from './config';

/** Ein Zertifikat, wie acme.sh es führt. */
export interface AcmeCertificate {
  /** Die erste Domain. Nach ihr heißt der Erneuerungseintrag und die PEM-Datei. */
  mainDomain: string;
  /** Hauptdomain und SANs zusammen — alles, was das Zertifikat abdeckt. */
  domains: string[];
  /** `ec-256`, `4096`, … `null` heißt: stand nicht in der Zeile. */
  keyLength: string | null;
  /** Wann das Zertifikat ausgestellt wurde. `null` heißt: nie. acme.sh führt
   *  auch einen Antrag, der gescheitert ist, weiter in seiner Liste, mit
   *  Schlüssel und ohne Zertifikat. Ein solcher Eintrag deckt nichts ab. */
  createdAt: string | null;
  /** Wann acme.sh es das nächste Mal erneuert. Roher Text, wie er dasteht. */
  renewAt: string | null;
}

/**
 * `acme.sh --list --listraw` auswerten.
 *
 * `--listraw` und nicht `--list`: die schöne Ausgabe ist eine Tabelle mit
 * Leerzeichen als Spaltentrenner, und eine Domain mit passender Länge verschiebt
 * die Zuordnung. Die rohe trennt mit `|` und ist damit die einzige, die sich
 * ohne Raten lesen lässt.
 *
 * Tolerant gegen die Kopfzeile, gegen Anführungszeichen um die Schlüssellänge
 * und gegen `no` als SAN-Liste — alles drei kommt in echten Ausgaben vor.
 */
/**
 * Wo die Spalten stehen, wenn die Ausgabe keine Kopfzeile trägt: die Reihenfolge
 * älterer Fassungen (`Main_Domain|KeyLength|SAN_Domains|CA|Created|Renew`).
 */
const LEGACY_COLUMNS = { keyLength: 1, sans: 2, created: 4, renew: 5 };

/**
 * Die Spalten aus der Kopfzeile, nie aus ihrer Nummer.
 *
 * acme.sh hat zwischen `SAN_Domains` und `CA` eine Spalte `Profile` eingefügt.
 * Mit fester Nummer gelesen stand danach das Ausstellungsdatum dort, wo der
 * Erneuerungstermin erwartet wurde: ein plausibles Datum, also ein Fehler, den
 * niemand sieht. Dieselbe Regel wie bei `show stat` in `stats-parse.ts`.
 */
function listColumns(header: string[]): typeof LEGACY_COLUMNS {
  const at = (name: string, fallback: number) => {
    const index = header.findIndex((field) => field.trim() === name);
    return index === -1 ? fallback : index;
  };
  return {
    keyLength: at('KeyLength', LEGACY_COLUMNS.keyLength),
    sans: at('SAN_Domains', LEGACY_COLUMNS.sans),
    created: at('Created', LEGACY_COLUMNS.created),
    renew: at('Renew', LEGACY_COLUMNS.renew),
  };
}

export function parseAcmeList(raw: string): AcmeCertificate[] {
  const certs: AcmeCertificate[] = [];
  let columns = LEGACY_COLUMNS;

  for (const line of raw.split('\n')) {
    const fields = line.trim().split('|');
    if (fields.length < 2) continue;

    const mainDomain = unquote(fields[0]);
    if (!mainDomain) continue;
    if (mainDomain === 'Main_Domain') {
      columns = listColumns(fields);
      continue;
    }

    const sans = unquote(fields[columns.sans] ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && d !== 'no');

    // Die Hauptdomain steht in manchen Fassungen auch in der SAN-Liste. Zweimal
    // dieselbe Domain wäre kein Fehler, aber sie stünde zweimal in der Anzeige.
    const domains = [mainDomain];
    for (const san of sans) {
      if (!domains.some((d) => d.toLowerCase() === san.toLowerCase())) domains.push(san);
    }

    certs.push({
      mainDomain,
      domains,
      keyLength: unquote(fields[columns.keyLength] ?? '') || null,
      createdAt: unquote(fields[columns.created] ?? '') || null,
      renewAt: unquote(fields[columns.renew] ?? '') || null,
    });
  }

  return certs;
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1').trim();
}

/**
 * Ob ein Zertifikatseintrag den Hostnamen abdeckt.
 *
 * Das ist NICHT dieselbe Regel wie bei der ACL. `*.kunde.example` deckt im
 * Zertifikat genau eine Ebene ab: `a.kunde.example` ja, `a.b.kunde.example` nein, und die
 * nackte `kunde.example` auch nicht. Die ACL vergleicht dagegen mit `-m end` und
 * trifft jede Tiefe.
 *
 * Der Unterschied ist der Grund, warum das hier eine eigene Funktion ist und
 * nicht `domainCovers` aus `config.ts`. Wer beide zusammenlegt, bekommt genau
 * einen von zwei Fehlern: entweder wird für einen Host, den das Zertifikat gar
 * nicht abdeckt, keins beantragt (Zertifikatswarnung im Browser), oder es wird
 * bei jedem Anlegen eins beantragt, das schon da ist (Kontingent bei Let's
 * Encrypt).
 */
export function certCovers(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (!p.startsWith('*.')) return p === h;

  const suffix = p.slice(1);
  if (!h.endsWith(suffix)) return false;
  // Genau eine Ebene: was vor dem Suffix steht, darf keinen Punkt mehr haben
  // und muss überhaupt da sein.
  const label = h.slice(0, h.length - suffix.length);
  return label.length > 0 && !label.includes('.');
}

/** Ob dieses Zertifikat ALLE geforderten Domains abdeckt. */
export function certificateCovers(cert: AcmeCertificate, domains: string[]): boolean {
  return domains.every((domain) => cert.domains.some((p) => certCovers(p, domain)));
}

/**
 * Das Zertifikat, das für diese Domains schon da ist — oder `null`.
 *
 * Gesucht wird das erste, das alles abdeckt. Es gibt keine Rangfolge unter
 * mehreren Treffern: dass zwei Zertifikate dieselbe Domainmenge abdecken, ist
 * schon der Zustand, den `dropCertificate` beim Wechsel der Hauptdomain
 * vermeidet — zwei Erneuerungseinträge für überlappende Domains nehmen sich
 * gegenseitig die Challenge weg.
 */
export function findCertificateFor(
  certs: AcmeCertificate[],
  domains: string[]
): AcmeCertificate | null {
  // Nur was ausgestellt ist. Ein gescheiterter Antrag bleibt in der Liste von
  // acme.sh stehen: als „schon vorhanden" gelesen, entstünde der Dienst beim
  // zweiten Versuch ohne Zertifikat, und HAProxy antwortete mit dem Platzhalter.
  return certs.find((cert) => cert.createdAt !== null && certificateCovers(cert, domains)) ?? null;
}

/**
 * Welches der geladenen Zertifikate HAProxy für diesen Namen ausliefert.
 *
 * HAProxy lädt `/etc/haproxy/certs` als Ganzes und wählt per SNI: zuerst ein
 * Zertifikat, das genau diesen Namen trägt, erst danach eins, dessen Wildcard
 * ihn abdeckt. Liegen für `app.kunde.example` ein eigenes Zertifikat und
 * `*.kunde.example` daneben, bekommt der Browser das eigene, und die Wildcard
 * bedient den Namen nicht. „Deckt ab" (`certCovers`) ist deshalb nicht
 * „wird benutzt": die Zertifikatsseite zählte sonst beide als benutzt.
 *
 * Bei Gleichstand das erste der Liste. HAProxy liest das Verzeichnis in der
 * Reihenfolge der Dateinamen, so reicht der Aufrufer die Liste herein.
 *
 * Ein Name, der selbst eine Wildcard ist (`*.kunde.example` als Domain eines
 * Dienstes), steht für die Namen darunter, für die es kein eigenes Zertifikat
 * gibt: bedient wird er von dem Zertifikat, das genau dieses Muster trägt.
 */
export function servedCertificate<T extends { domains: string[] }>(certs: readonly T[], host: string): T | null {
  const h = host.toLowerCase();
  return (
    certs.find((cert) => cert.domains.some((name) => name.toLowerCase() === h)) ??
    certs.find((cert) => cert.domains.some((name) => isWildcardDomain(name) && certCovers(name, h))) ??
    null
  );
}

/**
 * Welche Dienste welches Zertifikat benutzen: das, was HAProxy für ihre Namen
 * ausliefert (`servedCertificate`), nicht jedes, das sie abdecken könnte.
 *
 * Ein Dienst auf einer Wildcard (`*.kunde.example`) benutzt außerdem jedes
 * Zertifikat mit einem genauen Namen darunter, wenn HAProxy es für diesen Namen
 * ausliefert und die Anfrage bei diesem Dienst landet. Landen heißt: der erste
 * Dienst in der Reihenfolge der Datei, dessen ACL den Namen trifft
 * (`domainCovers`), wie bei `shadowedBy`. Hat der Name einen eigenen Eintrag,
 * gehört das Zertifikat diesem.
 *
 * `services` in der Reihenfolge der Datei, `certs` in der der Dateinamen.
 */
export function certificateUse<T extends { domains: string[] }, S extends { domains: string[] }>(
  certs: readonly T[],
  services: readonly S[]
): Map<T, S[]> {
  const use = new Map<T, S[]>(certs.map((cert) => [cert, []]));
  const add = (cert: T | null, service: S) => {
    const users = cert ? use.get(cert) : undefined;
    if (users && !users.includes(service)) users.push(service);
  };
  const routedTo = (host: string) => services.find((s) => s.domains.some((d) => domainCovers(d, host)));

  for (const service of services) {
    for (const domain of service.domains) {
      add(servedCertificate(certs, domain), service);
      if (!isWildcardDomain(domain)) continue;
      for (const cert of certs) {
        for (const name of cert.domains) {
          if (isWildcardDomain(name) || !domainCovers(domain, name)) continue;
          if (routedTo(name) === service && servedCertificate(certs, name) === cert) add(cert, service);
        }
      }
    }
  }
  return use;
}

/**
 * Der Dateiname, unter dem das PEM in `/etc/haproxy/certs` liegt.
 *
 * Für eine Wildcard wird der Stern zum Unterstrich. HAProxy braucht den Namen
 * nicht — es lädt das Verzeichnis als Ganzes und macht die SNI-Zuordnung aus dem
 * Zertifikat selbst; der Name steht deshalb an keiner Stelle in `haproxy.cfg`.
 * Gebraucht wird er beim Löschen und beim Beiseitelegen, und ein Stern in einem
 * Dateinamen ist genau dort ein Zeichen, das man in keinem Shell-Muster haben
 * will. Nicht-Wildcards behalten ihren Namen unverändert.
 */
export function pemFileName(mainDomain: string): string {
  return `${mainDomain.replace(/\*/g, '_')}.pem`;
}

/**
 * Welche acme.sh-DNS-Hooks auf der Maschine eingerichtet sind.
 *
 * Abgeleitet und nicht hinterlegt: die Probe liefert je Zeile den Pfad einer
 * `dnsapi/dns_*.sh`, deren Zugangsdaten in `account.conf` als `SAVED_*` stehen.
 * Ein fest verdrahteter Anbietername stimmt nur, bis jemand anders
 * einrichtet.
 *
 * Die Zuordnung kann mehr treffen als gemeint — eine Variable, die in zwei Hooks
 * vorkommt, erscheint zweimal in der Liste. Das ist der richtige Fehler von
 * beiden: ein Hook zu viel zur Auswahl kostet einen fehlgeschlagenen Antrag mit
 * klarer Meldung, ein Hook zu wenig macht die Wildcard unausstellbar, ohne dass
 * jemand sagen kann warum.
 */
export function parseDnsHooks(raw: string): string[] {
  const hooks = new Set<string>();
  for (const line of raw.split('\n')) {
    const match = /(?:^|\/)(dns_[A-Za-z0-9_]+)\.sh\s*$/.exec(line.trim());
    if (match) hooks.add(match[1]);
  }
  return [...hooks].sort();
}
