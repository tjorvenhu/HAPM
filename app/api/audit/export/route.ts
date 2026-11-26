import { requireCsrf, requireSession } from '@/lib/session';
import { handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { getT } from '@/lib/i18n/server';
import { startAuditExport } from '@/lib/audit-log/actions';

// Die Antwort ist ein Strom aus der Datenbank und darf nicht festgehalten werden.
export const dynamic = 'force-dynamic';

/**
 * Das gefilterte Protokoll als Datei (`format`: `csv` oder `jsonl`, dazu der
 * Filter der Seite). POST und nicht GET: der Export schreibt eine Zeile ins
 * Protokoll, und was schreibt, verlangt den CSRF-Token.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const { t, locale } = await getT();
    const file = await startAuditExport(
      body,
      { userId: session.userId, userEmail: session.email, ip: getClientIP(request) },
      { t, locale }
    );
    return new Response(file.stream, {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
