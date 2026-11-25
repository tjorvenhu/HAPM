/**
 * Was acme.sh beim Ausstellen meldet, in einem Satz, den man ohne die
 * Dokumentation von Let's Encrypt versteht.
 *
 * Bisher stand im Schritt nur die rohe Ausgabe von acme.sh. Beim häufigsten
 * Fall nach mehreren Einrichtungen, dem Limit für dieselbe Menge an Domains,
 * stand darin weder, was zu tun ist, noch, dass eine andere Menge sofort geht.
 *
 * Rein und ohne Umgebung: geprüft in `tests/haproxy/acme-errors.test.ts`.
 * Die Sätze stehen deutsch, weil Schritte mit eingesetzten Werten deutsch
 * gespeichert werden (siehe docs/dns.md, „Die Reihenfolge im Lauf“).
 */

const RATE_LIMITED = 'urn:ietf:params:acme:error:rateLimited';

/** Die Zeit hinter „retry after“, wie Let's Encrypt sie nennt (`2026-11-26 05:49:52 UTC`). */
function retryAfter(output: string): string | null {
  const match = /retry after (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?::\d{2})? UTC/i.exec(output);
  return match ? `${match[1]} UTC` : null;
}

/**
 * Eine Erklärung für eine bekannte Ablehnung, oder `null`. Die rohe Ausgabe
 * hängt der Aufrufer weiter an: sie ist das, was man beim Nachfragen braucht.
 */
export function explainAcmeFailure(output: string): string | null {
  if (!output.includes(RATE_LIMITED)) return null;
  const when = retryAfter(output);
  const until = when ? ` Wieder möglich ab ${when}.` : '';

  if (/exact set of identifiers/i.test(output)) {
    return (
      'Let\'s Encrypt hat für genau diese Domains in den letzten 7 Tagen schon 5 Zertifikate ausgestellt.' +
      until +
      ' Sofort geht es mit einer anderen Menge an Domains (etwa die Wildcard aus- oder einschalten) oder mit einem hochgeladenen Zertifikat.'
    );
  }
  if (/registered domain/i.test(output)) {
    return 'Let\'s Encrypt hat für diese Domain in den letzten 7 Tagen schon 50 Zertifikate ausgestellt.' + until;
  }
  if (/failed authorizations|failed validation/i.test(output)) {
    return (
      'Zu viele fehlgeschlagene Prüfungen für diese Domain in der letzten Stunde.' +
      until +
      ' Erst den Grund beheben (DNS-Eintrag, Port 80), dann erneut versuchen.'
    );
  }
  return 'Let\'s Encrypt hat den Antrag wegen eines Limits abgelehnt.' + until;
}
