/**
 * Nach einer neuen GeoIP-Tabelle die Länderlisten der Ländersperre nachziehen
 * (`refreshGeoBlockFiles` in `lib/haproxy/provision.ts`).
 *
 * Abgekoppelt und ohne Fehler nach außen: die Tabelle ist gespeichert, und das
 * ist das, wonach gefragt wurde. Scheitert das Nachziehen, sperrt HAProxy bis
 * zum nächsten Vorgang nach den alten Listen, und das steht im Log.
 *
 * Der Import ist dynamisch, damit `./import.ts` nicht über `provision.ts` die
 * ganze Schicht zu HAProxy nachzieht, wo nur eine Tabelle gelesen wird.
 */
export function followGeoipChange(): void {
  void (async () => {
    try {
      const [{ refreshGeoBlockFiles }, { localServer }] = await Promise.all([
        import('../haproxy/provision'),
        import('../helpers'),
      ]);
      const result = await refreshGeoBlockFiles(localServer());
      if (result === 'reloaded') console.log('[geoip] Länderlisten der Ländersperre erneuert, HAProxy neu geladen.');
    } catch (err) {
      console.error('[geoip] Länderlisten nicht nachgezogen:', err instanceof Error ? err.message : err);
    }
  })();
}
