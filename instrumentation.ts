export async function register() {
  // Nicht beim Bauen.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  // Nur im Node-Server. Als Block und nicht als früher Rücksprung: so lässt Next
  // den Inhalt aus der Fassung für das Edge-Runtime ganz heraus.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { secrets } = await import('./lib/secrets');
    secrets();

    // Vor allem anderen: Einstellungen, Protokoll und Scheduler lesen die Datenbank.
    const { ensureDatabase } = await import('./lib/setup-db');
    const database = await ensureDatabase();
    if (database.status !== 'ok') {
      console.error(`[db] ${database.error}`);
      // Beenden und nicht werfen: nach einem Wurf liefe der Server weiter und
      // bliebe für immer ungesund. So startet Docker den Container neu und
      // versucht es damit wieder.
      process.exit(1);
    }

    // Erst die Maschine einrichten, dann den Scheduler: er liest gleich die Zähler
    // von HAProxy, und ohne Konfiguration gäbe es nur Fehlermeldungen.
    const { getSettings } = await import('./lib/settings');
    const { runBootstrap } = await import('./lib/bootstrap');
    const settings = await getSettings().catch(() => null);
    await runBootstrap(settings?.acmeEmail ?? null);

    const { initializeScheduler } = await import('./lib/scheduler');
    await initializeScheduler();
  }
}
