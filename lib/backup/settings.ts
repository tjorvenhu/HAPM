/**
 * Die Einstellungen der Sicherung. Eine eigene Zeile, getrennt von den
 * allgemeinen Einstellungen: sie wird beim Sichern selbst gelesen und soll
 * dabei von nichts anderem abhängen.
 */

import { getSingleton, updateDocument } from '../db';
import { ApiError } from '../api';
import type { DbDoc } from '../types';

export const BACKUP_SETTINGS = 'backup_settings';
export const BACKUP_RUNS = 'backup_runs';
const SETTINGS_ID = 'main';

export interface BackupSettings extends DbDoc {
  /** Täglich von selbst sichern. */
  enabled: boolean;
  /** Der Ordner auf dem Server (nicht im Container), in dem die Archive landen. */
  hostPath: string | null;
  /** Uhrzeit des täglichen Laufs, `HH:MM` in der Zeitzone des Containers. */
  time: string;
  /** Wie viele Archive liegen bleiben. Ältere räumt der Lauf weg. */
  keep: number;
}

export type BackupSettingsInput = Partial<Pick<BackupSettings, 'enabled' | 'hostPath' | 'time' | 'keep'>>;

const DEFAULTS: Omit<BackupSettings, keyof DbDoc> = {
  enabled: false,
  hostPath: null,
  time: '02:30',
  keep: 14,
};

export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 365;

/**
 * Ordner, in die keine Sicherung gehört: der Lauf räumt dort alte Archive weg
 * und schreibt als root. In `/` oder `/etc` hat das nichts verloren, und unter
 * `/proc`, `/sys` und `/dev` gibt es nichts, was eine Datei hielte.
 */
const FORBIDDEN_ROOTS = ['/', '/etc', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev', '/run', '/var/run', '/var/lib/docker'];

/**
 * Prüft den Ordner und gibt ihn bereinigt zurück, oder eine Meldung.
 *
 * Der Pfad geht als Einbindung an Docker und nie in eine Kommandozeile. Geprüft
 * wird er trotzdem eng: Docker liest in einer Einbindung den Doppelpunkt als
 * Trenner (`pfad:ziel:optionen`), ein Pfad damit bände etwas anderes ein, als
 * dasteht.
 */
export function checkHostPath(input: string): { path: string } | { error: string } {
  const value = input.trim();
  if (!value) return { error: 'Der Ordner fehlt.' };
  if (!value.startsWith('/')) return { error: 'Der Ordner muss mit / beginnen (ein Pfad auf dem Server).' };
  if (value.length > 400) return { error: 'Der Pfad ist zu lang.' };
  if (!/^[A-Za-z0-9/_.\- ]+$/.test(value)) {
    return { error: 'Der Pfad darf nur Buchstaben, Ziffern, Leerzeichen und / _ . - enthalten.' };
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) {
    return { error: 'Der Pfad darf kein . oder .. enthalten.' };
  }
  const path = `/${parts.join('/')}`;
  if (FORBIDDEN_ROOTS.includes(path) || ['/proc/', '/sys/', '/dev/'].some((root) => path.startsWith(root))) {
    return { error: `In ${path} legt HAPM keine Sicherungen ab. Bitte einen eigenen Ordner angeben, etwa /srv/hapm-backup.` };
  }
  return { path };
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function getBackupSettings(): Promise<BackupSettings> {
  const row = await getSingleton<BackupSettings>(BACKUP_SETTINGS, SETTINGS_ID, DEFAULTS);
  return { ...DEFAULTS, ...row };
}

export async function updateBackupSettings(input: BackupSettingsInput): Promise<BackupSettings> {
  const current = await getBackupSettings();
  const patch: BackupSettingsInput = {};

  if (input.hostPath !== undefined) {
    if (input.hostPath === null || input.hostPath.trim() === '') patch.hostPath = null;
    else {
      const checked = checkHostPath(input.hostPath);
      if ('error' in checked) throw new ApiError(checked.error);
      patch.hostPath = checked.path;
    }
  }
  if (input.time !== undefined) {
    if (!validTime(input.time)) throw new ApiError('Die Uhrzeit hat nicht die Form HH:MM.');
    patch.time = input.time;
  }
  if (input.keep !== undefined) {
    const keep = Number(input.keep);
    if (!Number.isInteger(keep) || keep < BACKUP_KEEP_MIN || keep > BACKUP_KEEP_MAX) {
      throw new ApiError(`Aufbewahrt werden zwischen ${BACKUP_KEEP_MIN} und ${BACKUP_KEEP_MAX} Sicherungen.`);
    }
    patch.keep = keep;
  }
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);

  const next = { ...current, ...patch };
  if (next.enabled && !next.hostPath) {
    throw new ApiError('Ohne Ordner lässt sich die tägliche Sicherung nicht einschalten.');
  }

  await updateDocument<BackupSettings>(BACKUP_SETTINGS, SETTINGS_ID, patch);
  return getBackupSettings();
}
