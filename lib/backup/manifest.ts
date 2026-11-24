/**
 * `manifest.json` im Archiv: woher eine Sicherung stammt.
 *
 * Archive vor 0.5 tragen keins. Für sie bleiben Fassung und Schlüssel
 * unbekannt, und der Zeitpunkt kommt aus dem Dateinamen.
 *
 * Rein: kein `lib/db`, kein Docker. Die Prüfung der Archive und die Sicherung
 * benutzen dieselben Funktionen.
 */

import { createHash } from 'node:crypto';

export const MANIFEST_NAME = 'manifest.json';
const FORMAT = 1;

export type BackupKind = 'manual' | 'scheduled' | 'before-restore';

export interface BackupManifest {
  app: 'hapm';
  format: number;
  /** `HAPM_VERSION` des Abbilds, `null` außerhalb eines gebauten Abbilds. */
  version: string | null;
  createdAt: string;
  kind: BackupKind;
  /**
   * Fingerabdruck des Schlüssels, mit dem die Werte in `database.sql`
   * verschlüsselt sind. Kommt er aus `ENCRYPTION_KEY`, ist es nicht der aus
   * `data/secrets.json`, und genau das muss das Zurückspielen wissen.
   */
  keyFingerprint: string;
  keyFromEnvironment: boolean;
}

/**
 * Ein Hash über den Schlüssel, gekürzt. Er verrät nichts über einen
 * Zufallswert von 256 Bit, reicht aber, um zwei Schlüssel zu unterscheiden.
 */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(`hapm-encryption-key:${key}`).digest('hex').slice(0, 16);
}

export function hapmVersion(): string | null {
  return process.env.HAPM_VERSION || null;
}

export function buildManifest(input: {
  kind: BackupKind;
  encryptionKey: string;
  keyFromEnvironment: boolean;
  now?: Date;
}): BackupManifest {
  return {
    app: 'hapm',
    format: FORMAT,
    version: hapmVersion(),
    createdAt: (input.now ?? new Date()).toISOString(),
    kind: input.kind,
    keyFingerprint: keyFingerprint(input.encryptionKey),
    keyFromEnvironment: input.keyFromEnvironment,
  };
}

/** `null`, wenn der Text kein Manifest von HAPM ist. */
export function parseManifest(text: string): BackupManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.app !== 'hapm' || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    return null;
  }
  const kind = value.kind === 'scheduled' || value.kind === 'before-restore' ? value.kind : 'manual';
  return {
    app: 'hapm',
    format: typeof value.format === 'number' ? value.format : FORMAT,
    version: typeof value.version === 'string' && value.version ? value.version : null,
    createdAt: value.createdAt,
    kind,
    keyFingerprint: typeof value.keyFingerprint === 'string' ? value.keyFingerprint : '',
    keyFromEnvironment: value.keyFromEnvironment === true,
  };
}

/**
 * Vergleicht zwei Fassungen der Form `1.2.3`. `null`, wenn eine davon anders
 * aussieht (`dev`, ein Commit): dann ist die Reihenfolge unbekannt.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
