import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getClientIP } from '@/lib/audit';
import { precheckCertificate, readCertificateInventory } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { localServer } from '@/lib/helpers';
import { challengeFor, getSettings } from '@/lib/settings';

/**
 * Einen Antrag, den acme.sh führt, der aber nie durchgekommen ist, noch einmal
 * stellen.
 *
 * Der Fall: die Wildcard aus der Einrichtung scheiterte (DNS-Hook, Token,
 * Kontingent). acme.sh behält den Eintrag mit Domains und ohne
 * Ausstellungsdatum, ein Zertifikat gibt es nicht. Jedes Ziel darunter bekam
 * deshalb ein eigenes, und ohne diesen Weg bliebe die Wildcard für immer ein
 * Eintrag ohne Zertifikat: einen Antrag ohne Ziel stellt sonst nur der
 * Assistent.
 *
 * Nur für einen nie ausgestellten Eintrag und nur mit dessen Domains. Was
 * ausgestellt ist, erneuert acme.sh selbst; ein beliebiges neues Zertifikat
 * ohne Ziel ist nicht der Zweck. Derselbe Lauf wie aus dem Assistenten
 * (`action: 'certificate'`), mit Vorabprüfung; den Eintrag in die Historie
 * schreibt der Lauf.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ mainDomain?: unknown; dnsHook?: unknown }>(request);
    const mainDomain = typeof body.mainDomain === 'string' ? body.mainDomain.trim().toLowerCase() : '';
    if (!mainDomain) throw new ApiError(msg('Es wurde kein Zertifikat angegeben.'));

    const server = localServer();
    const { acme } = await readCertificateInventory(server);
    const entry = acme.find((cert) => cert.mainDomain.toLowerCase() === mainDomain);
    if (!entry) throw new ApiError(msg('acme.sh führt kein Zertifikat für {domain}.', { domain: mainDomain }), 404);
    if (entry.createdAt !== null) {
      throw new ApiError(msg('Das Zertifikat für {domain} ist ausgestellt. acme.sh erneuert es selbst.', { domain: mainDomain }), 409);
    }

    // Wie beim Anlegen eines Ziels: ohne Angabe nimmt die Regel den einen eingerichteten Hook.
    const dnsHook = typeof body.dnsHook === 'string' && body.dnsHook.trim() ? body.dnsHook.trim() : null;
    const challenge = challengeFor(await getSettings(), dnsHook);
    await precheckCertificate(server, entry.domains, challenge);

    const run = await startHaproxyRun({
      server,
      action: 'certificate',
      serviceId: entry.mainDomain,
      certificateDomains: entry.domains,
      challenge,
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}
