import path from 'node:path';

/**
 * Wo HAPM seinen eigenen Zustand ablegt: Datenbank, Geheimnisse, Zähler der
 * Anmeldeversuche. Im Container ein Volume unter `/data`, in der Entwicklung
 * `.data` im Projektordner.
 */
export function dataDir(): string {
  if (process.env.HAPM_DATA_DIR) return process.env.HAPM_DATA_DIR;
  return process.env.NODE_ENV === 'production' ? '/data' : path.join(process.cwd(), '.data');
}

export function dataPath(...parts: string[]): string {
  return path.join(dataDir(), ...parts);
}
