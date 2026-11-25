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

/**
 * Dasselbe für ein hochgeladenes Zertifikat. Länger, weil es niemand von
 * selbst erneuert: ein neues muss bei der CA beantragt und hochgeladen werden,
 * und das braucht oft jemand anderen als den, der die Warnung liest.
 */
export const UPLOAD_WARN_DAYS = 30;

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
  /** Hochgeladen: niemand erneuert es von selbst. */
  uploaded: boolean;
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
export function certificateDue(
  cert: AcmeCertificate,
  expiry: Date | null,
  now: number,
  uploaded = false
): CertificateDue {
  const renewAt = cert.renewAt ? Date.parse(cert.renewAt) : Number.NaN;
  return {
    mainDomain: cert.mainDomain,
    domains: cert.domains,
    expiresAt: expiry ? expiry.toISOString() : null,
    daysLeft: expiry ? Math.floor((expiry.getTime() - now) / DAY_MS) : null,
    renewAt: cert.renewAt,
    renewalOverdue: !Number.isNaN(renewAt) && renewAt < now - DAY_MS,
    uploaded,
  };
}

/** Ab wann ein Zertifikat Aufmerksamkeit braucht: hochgeladene früher. */
export function warnDaysFor(due: Pick<CertificateDue, 'uploaded'>): number {
  return due.uploaded ? UPLOAD_WARN_DAYS : CERT_WARN_DAYS;
}

/** Ein hochgeladenes Zertifikat in der Form, die `certificateDue` liest. */
export function uploadedDue(
  cert: { mainDomain: string | null; file: string; domains: string[]; notBefore: string | null; notAfter: string | null },
  now: number
): CertificateDue {
  const expiry = cert.notAfter ? new Date(cert.notAfter) : null;
  return certificateDue(
    {
      mainDomain: cert.mainDomain ?? cert.file,
      domains: cert.domains,
      keyLength: null,
      createdAt: cert.notBefore,
      renewAt: null,
    },
    expiry && !Number.isNaN(expiry.getTime()) ? expiry : null,
    now,
    true
  );
}
