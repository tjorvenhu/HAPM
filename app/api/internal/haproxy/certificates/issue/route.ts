import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { haproxyActor } from '@/lib/haproxy/internal';
import { reissueCertificate } from '@/lib/haproxy/certificate-actions';

/**
 * Einen Antrag, den acme.sh führt, der aber nie ausgestellt wurde
 * (`createdAt: null`), noch einmal stellen: `{ "mainDomain": "…", "dnsHook"?: "dns_cf" }`.
 * Nur für einen solchen Eintrag und nur mit seinen Domains, wie auf der
 * Zertifikatsseite (`reissueCertificate`). Antwortet mit `runId`; den Stand
 * liefert `../../runs/{runId}`.
 */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody<{ mainDomain?: unknown; dnsHook?: unknown }>(request);
    return ok(await reissueCertificate(body, haproxyActor(serviceActor(service), request)));
  } catch (err) {
    return handleError(err);
  }
}
