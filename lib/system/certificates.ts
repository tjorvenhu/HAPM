/**
 * Wann ein Zertifikat abläuft und ob es Aufmerksamkeit braucht.
 *
 * `acme.sh --list` nennt nur, wann acme.sh erneuern WILL (`renewAt`). Wann das
 * Zertifikat wirklich abläuft, steht im Zertifikat selbst, also in der Datei,
 * die HAProxy lädt. Rein bis auf `node:crypto`, getestet in
 * `tests/system/certificates.test.ts`.
 */

import { X509Certificate } from 'node:crypto';
import type { AcmeCertificate } from '../haproxy/certs';

/** Ab hier gilt ein Zertifikat als „läuft bald ab". */
export const CERT_WARN_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CertificateDue {
  mainDomain: string;
  domains: string[];
  /** Aus dem PEM, das HAProxy lädt. `null` heißt: nicht lesbar. */
  expiresAt: string | null;
  daysLeft: number | null;
  renewAt: string | null;
  /** acme.sh hätte schon erneuern sollen und hat es nicht getan. */
  renewalOverdue: boolean;
}

/** Das Ablaufdatum aus dem PEM, das HAProxy lädt. Das erste Zertifikat der Datei ist das der Domain. */
export function pemExpiry(pem: string): Date | null {
  const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem);
  if (!block) return null;
  try {
    const expiry = new X509Certificate(block[0]).validToDate;
    return Number.isNaN(expiry.getTime()) ? null : expiry;
  } catch {
    return null;
  }
}

/**
 * Was an einem Zertifikat fällig ist.
 *
 * `renewAt` ist der Tag, an dem acme.sh erneuern will, nicht der Ablauf. Liegt
 * er mehr als einen Tag zurück, hat der tägliche Lauf es nicht geschafft, und
 * das fällt Wochen vor dem Ablauf auf.
 */
export function certificateDue(cert: AcmeCertificate, expiry: Date | null, now: number): CertificateDue {
  const renewAt = cert.renewAt ? Date.parse(cert.renewAt) : Number.NaN;
  return {
    mainDomain: cert.mainDomain,
    domains: cert.domains,
    expiresAt: expiry ? expiry.toISOString() : null,
    daysLeft: expiry ? Math.floor((expiry.getTime() - now) / DAY_MS) : null,
    renewAt: cert.renewAt,
    renewalOverdue: !Number.isNaN(renewAt) && renewAt < now - DAY_MS,
  };
}
