import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP, serviceActor } from '@/lib/audit';
import {
  listCertificateAuthorities,
  removeCertificateAuthority,
  saveCertificateAuthority,
} from '@/lib/haproxy/ca-actions';

/**
 * Die hinterlegten Zertifizierungsstellen, gegen die ein Ziel das Zertifikat
 * seines Backends prüfen kann (`backendTls: "ca:<name>"`), samt der Ziele, die
 * sie benutzen.
 *
 * Hochladen geht hier, anders als bei den Zertifikaten der Domains: in der
 * Datei steht kein privater Schlüssel (`inspectCaUpload` lehnt ihn ab), und
 * ein Key kann ein Ziel ohnehin auf „nicht prüfen" stellen. Die Logik steht in
 * `lib/haproxy/ca-actions.ts`.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const { t } = await getT();
    return ok(await listCertificateAuthorities(t));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * `{ "name": "intern-root", "certificate": "-----BEGIN CERTIFICATE-----…", "replace"?: true }`.
 * Ohne `replace` wird ein vergebener Name nicht überschrieben (409). Synchron;
 * `reloaded` sagt, ob HAProxy neu geladen hat (nur, wenn ein Ziel sie benutzt).
 */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const { t } = await getT();
    const body = await jsonBody<{ name?: unknown; certificate?: unknown; replace?: unknown }>(request);
    return ok(await saveCertificateAuthority(body, { ...serviceActor(service), ip: getClientIP(request) }, t));
  } catch (err) {
    return handleError(err);
  }
}

/** `?name=`. Abgelehnt (409), solange `haproxy.cfg` die Datei nennt. */
export async function DELETE(request: Request) {
  try {
    const service = await requireServiceToken(request);
    return ok(
      await removeCertificateAuthority(new URL(request.url).searchParams.get('name'), {
        ...serviceActor(service),
        ip: getClientIP(request),
      })
    );
  } catch (err) {
    return handleError(err);
  }
}
