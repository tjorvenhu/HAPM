import { NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-auth';
import { handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { readHealth } from '@/lib/system/monitoring';

/**
 * Das Urteil über die Installation, für eine Überwachung (Icinga, Zabbix,
 * Uptime Kuma, ein Skript von keepalived): je Prüfung `ok`, `warn`, `fail`
 * oder `unknown`, dazu ein Gesamturteil.
 *
 * **Der Statuscode ist das Urteil.** 200 bei `ok` und `warn`, 503 bei `fail`:
 * eine Überwachung, die nur den Code liest, schlägt genau dann an, wenn der
 * Proxy selbst nicht arbeitet. Was `fail` ist, steht in `lib/system/health.ts`.
 * Mit `?strict=1` gilt auch `warn` als 503.
 *
 * Mit Token, anders als `/api/health`: das hier nennt Ziele, Zertifikate und
 * Fehler. Ob der Prozess antwortet, fragt der Container ohne Token dort.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const strict = new URL(request.url).searchParams.get('strict') === '1';
    const report = await readHealth(await getT());
    const healthy = report.status === 'ok' || (report.status === 'warn' && !strict);
    return NextResponse.json(
      { success: healthy, data: report },
      { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return handleError(err);
  }
}
