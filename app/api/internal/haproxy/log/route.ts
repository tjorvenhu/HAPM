import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { readHaproxyLog } from '@/lib/haproxy/log-read';

/**
 * Die letzten Zeilen des HAProxy-Logs, wie unter „Reverse-Proxy → Logs":
 * `?lines=` (bis 2000), `?filter=` (`all`, `requests`, `2xx` … `5xx`,
 * `system`, `problems`), `?q=` Suche. Ohne Audit, wie jede lesende Route.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
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
