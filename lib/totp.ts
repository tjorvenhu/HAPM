import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { encrypt, decrypt } from './crypto';

const ISSUER = 'HAPM';

/** Generate a new TOTP secret for a user. */
export function generateTOTPSecret(email: string): {
  secret: string;          // base32 secret (plaintext, for encryption before storage)
  uri: string;             // otpauth:// URI for QR code
  manualCode: string;      // human-readable secret for manual entry
} {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
    manualCode: totp.secret.base32,
  };
}

/** Generate a QR code data URL from an otpauth URI. */
export async function generateQRCodeDataURL(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: { dark: '#0f0f0f', light: '#f5f4f0' },
  });
}

const PERIOD_S = 30;

/**
 * Der Zeitschritt, zu dem ein Code gehört, oder `null`, wenn er nicht stimmt.
 * Erlaubt einen Schritt davor und danach (Uhren gehen nicht gleich).
 *
 * Der Schritt und nicht nur „stimmt": ein Code gilt 30 Sekunden, mit der
 * Toleranz bis zu 90. Wer ihn mitliest, könnte ihn in dieser Zeit noch einmal
 * zeigen. Der Aufrufer merkt sich deshalb den letzten Schritt je Konto und
 * nimmt keinen an, der nicht neuer ist (`consumeTOTPCode` in `lib/two-factor.ts`).
 */
export function matchTOTPStep(secret: string, code: string, now = Date.now()): number | null {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_S,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token: code, window: 1, timestamp: now });
  return delta === null ? null : Math.floor(now / 1000 / PERIOD_S) + delta;
}

/** Verify a TOTP code against a secret. Allows ±1 time step window. */
export function verifyTOTPCode(secret: string, code: string): boolean {
  return matchTOTPStep(secret, code) !== null;
}

/** Encrypt a TOTP secret for database storage. */
export function encryptTOTPSecret(secret: string): string {
  return encrypt(secret);
}

/** Decrypt a TOTP secret from database storage. */
export function decryptTOTPSecret(encrypted: string): string {
  return decrypt(encrypted);
}
