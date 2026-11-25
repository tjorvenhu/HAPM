import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { serviceActor } from '@/lib/audit';
import { haproxyActor } from '@/lib/haproxy/internal';
import { changeScope, listScopes } from '@/lib/haproxy/api-actions';

/**
 * Die Gruppen des Reverse-Proxys: die Marker-Paare, in denen die Einträge
 * stehen. `scope` ist beim Anlegen eines Ziels Pflicht, und welche es gibt,
 * sagt `haproxy.cfg` und nicht eine Liste im Code.
 *
 * Anlegen und Entfernen ist je ein Lauf. Die Antwort trägt `runs` trotzdem als
 * Liste, und die Route nimmt kein `serverId`.
 *
 * Vorabgeprüft wird, BEVOR der Lauf startet (`changeScope` in
 * `lib/haproxy/api-actions.ts`). Sonst endete ein Tippfehler als Zeile in der
 * Historie, statt dem Aufrufer zurückgegeben zu werden.
 */

/** Welche Gruppen es gibt. Eine Liste mit einem Eintrag, wie `/proxies`. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const { t } = await getT();
    return ok(await listScopes(t));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody<{ name?: string }>(request);
    return ok(await changeScope(body.name, 'scope-add', haproxyActor(serviceActor(service), request)));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine Gruppe entfernen. Sie muss leer sein — geprüft wird das im Lauf noch
 * einmal, denn zwischen Anzeige und Vorgang kann jemand etwas angelegt haben.
 */
export async function DELETE(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody<{ name?: string }>(request);
    return ok(
      await changeScope(body.name, 'scope-remove', haproxyActor(serviceActor(service), request))
    );
  } catch (err) {
    return handleError(err);
  }
}
