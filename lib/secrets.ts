import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dataDir, dataPath } from './paths';

/**
 * Die zwei Geheimnisse der Installation.
 *
 * `sessionSecret` signiert den CSRF-Token und darf erneuert werden (meldet alle
 * ab). `encryptionKey` verschlüsselt, was in der Datenbank nicht im Klartext
 * stehen soll (TOTP-Geheimnisse, DNS-Tokens) und darf sich nie ändern: es gibt
 * keinen Weg, alte Werte umzuschlüsseln.
 *
 * Beide entstehen beim ersten Start und liegen im Daten-Volume. Wer HAPM
 * aufsetzt, muss dafür nichts eintragen. `SESSION_SECRET` und `ENCRYPTION_KEY`
 * aus der Umgebung gewinnen, falls jemand sie lieber selbst verwaltet.
 */
interface Secrets {
  sessionSecret: string;
  encryptionKey: string;
}

let cached: Secrets | null = null;

function readFile(): Partial<Secrets> {
  try {
    return JSON.parse(fs.readFileSync(dataPath('secrets.json'), 'utf8')) as Partial<Secrets>;
  } catch {
    return {};
  }
}

export function secrets(): Secrets {
  if (cached) return cached;

  const stored = readFile();
  let changed = false;
  if (!stored.sessionSecret) {
    stored.sessionSecret = randomBytes(32).toString('hex');
    changed = true;
  }
  if (!stored.encryptionKey) {
    stored.encryptionKey = randomBytes(32).toString('hex');
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(dataPath('secrets.json'), JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  cached = {
    sessionSecret: process.env.SESSION_SECRET || stored.sessionSecret!,
    encryptionKey: process.env.ENCRYPTION_KEY || stored.encryptionKey!,
  };
  return cached;
}
