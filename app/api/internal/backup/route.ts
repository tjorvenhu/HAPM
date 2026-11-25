import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { backupOverview, changeBackupSettings, startBackupRun } from '@/lib/backup/actions';

/**
 * Die Sicherung, wie auf der Seite „Sicherung": Einstellungen, die letzten
 * Läufe, die Archive im Ordner. Dieselben Funktionen wie `/api/backup`
 * (`lib/backup/actions.ts`), dieselben Antworten.
 *
 * Das Zurückspielen gibt es hier bewusst nicht: es verlangt das Passwort eines
 * Menschen, ersetzt die Datenbank samt Konten und API-Keys und startet HAPM
 * neu (docs/mcp.md, „Was es bewusst nicht gibt").
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await backupOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** Teil-Patch der Einstellungen: `enabled`, `hostPath`, `time`, `keep`. */
export async function PATCH(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await changeBackupSettings(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Sicherung jetzt. Antwortet mit `runId`, der Stand steht unter `./runs/{runId}`. */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    return ok(await startBackupRun({ ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
