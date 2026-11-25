import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { readSetupView } from '@/lib/setup';
import { startSetupExecution } from '@/lib/setup/run';

/**
 * Schritt 7 der Einrichtung: ausführen.
 *
 * Die Antwort kommt, sobald die Folge gestartet ist. Gruppe, Zertifikat und
 * Ziel sind gewöhnliche Läufe und dauern Minuten; die Seite liest den
 * Fortschritt über `GET /api/setup`. Ein zweiter Aufruf nach einem Fehlschlag
 * startet dieselbe Folge noch einmal, und was schon eingerichtet ist, wird
 * dabei vorgefunden (`lib/setup/run.ts`).
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const ip = getClientIP(request);
    await startSetupExecution({ userId: session.userId, email: session.email, ip });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_started',
      resource: 'settings',
      ip,
    });

    return ok({ setup: await readSetupView() });
  } catch (err) {
    return handleError(err);
  }
}
