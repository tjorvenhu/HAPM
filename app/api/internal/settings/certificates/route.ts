import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { changeCertificateSettings } from '@/lib/settings-actions';

/**
 * Woher Zertifikate kommen (`source`: `acme` oder `upload`), bei welchem
 * ACME-Server beantragt wird (`acmeDirectory`, leer: Let's Encrypt) und ob er
 * HAPM über Port 80 erreicht (`httpReachable`). Dieselbe Funktion wie unter
 * „Allgemein", nur ohne EAB-Schlüssel: der ist ein Geheimnis und wird in der
 * Oberfläche eingegeben.
 */
export async function PUT(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(
      await changeCertificateSettings(body, { ...serviceActor(service), ip: getClientIP(request) }, { allowEab: false })
    );
  } catch (err) {
    return handleError(err);
  }
}
