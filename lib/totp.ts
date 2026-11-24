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

/** Verify a TOTP code against a secret. Allows ±1 time step window. */
export function verifyTOTPCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

/** Encrypt a TOTP secret for database storage. */
export function encryptTOTPSecret(secret: string): string {
  return encrypt(secret);
}

/** Decrypt a TOTP secret from database storage. */
export function decryptTOTPSecret(encrypted: string): string {
  return decrypt(encrypted);
}
