import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { readHaproxyLog } from '@/lib/haproxy/log-read';

/**
 * Die letzten Zeilen des HAProxy-Logs für die Seite „Reverse-Proxy → Logs".
 * Was gelesen wird und warum `exists` und der Mitschnitt mitgehen:
 * `lib/haproxy/log-read.ts`.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);
    return ok(
      await readHaproxyLog({
        lines: url.searchParams.get('lines'),
        filter: url.searchParams.get('filter'),
        q: url.searchParams.get('q'),
      })
    );
  } catch (err) {
    return handleError(err);
  }
}
