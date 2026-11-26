/**
 * Die Einstellungen der Sicherung. Eine eigene Zeile, getrennt von den
 * allgemeinen Einstellungen: sie wird beim Sichern selbst gelesen und soll
 * dabei von nichts anderem abhängen.
 */

import { getSingleton, updateDocument } from '../db';
import { ApiError } from '../api';
import { decrypt, encrypt } from '../crypto';
import { msg, msgid, type Message } from '../i18n';
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
  /**
   * Der Sicherungsschlüssel, verschlüsselt mit `encryptionKey` (`lib/crypto.ts`).
   * `null` heißt: die Archive werden nicht verschlüsselt. Er liegt hier und
   * nicht nur im Kopf des Benutzers, weil der nächtliche Lauf ihn braucht.
   * Nach außen geht nur, ob einer gesetzt ist (`./actions.ts`).
   */
  passphrase: string | null;
}

export type BackupSettingsInput = Partial<Pick<BackupSettings, 'enabled' | 'hostPath' | 'time' | 'keep'>>;

const DEFAULTS: Omit<BackupSettings, keyof DbDoc> = {
  enabled: false,
  hostPath: null,
  time: '02:30',
  keep: 14,
  passphrase: null,
};

/** Gespeichert, aber mit dem Schlüssel, mit dem HAPM gerade läuft, nicht zu lesen. */
export const PASSPHRASE_UNREADABLE = msgid(
  'Der gespeicherte Sicherungsschlüssel ist nicht mehr lesbar. Bitte tragen Sie ihn unter „Sicherung“ neu ein.'
);

/**
 * Der Sicherungsschlüssel im Klartext, `null` ohne Verschlüsselung.
 *
 * Wirft, wenn er sich nicht entschlüsseln lässt (`ENCRYPTION_KEY` wurde
 * geändert). Wer hier `null` bekäme, schriebe die nächste Sicherung
 * unverschlüsselt in einen Ordner, für den jemand Verschlüsselung eingestellt
 * hat: der Lauf soll dann scheitern und es sagen.
 */
export function readPassphrase(settings: Pick<BackupSettings, 'passphrase'>): string | null {
  if (!settings.passphrase) return null;
  try {
    return decrypt(settings.passphrase);
  } catch {
    throw new ApiError(PASSPHRASE_UNREADABLE);
  }
}

export function passphraseState(settings: Pick<BackupSettings, 'passphrase'>): { encrypted: boolean; passphraseUnreadable: boolean } {
  if (!settings.passphrase) return { encrypted: false, passphraseUnreadable: false };
  try {
    decrypt(settings.passphrase);
    return { encrypted: true, passphraseUnreadable: false };
  } catch {
    return { encrypted: true, passphraseUnreadable: true };
  }
}

/** Den Sicherungsschlüssel setzen (`null`: ab jetzt unverschlüsselt). Geprüft wird in `./passphrase.ts`. */
export async function storePassphrase(passphrase: string | null): Promise<void> {
  await getBackupSettings();
  await updateDocument<BackupSettings>(BACKUP_SETTINGS, SETTINGS_ID, {
    passphrase: passphrase === null ? null : encrypt(passphrase),
  });
}

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
export function checkHostPath(input: string): { path: string } | { error: Message } {
  const value = input.trim();
  if (!value) return { error: msg('Der Ordner fehlt.') };
  if (!value.startsWith('/')) return { error: msg('Der Ordner muss mit / beginnen (ein Pfad auf dem Server).') };
  if (value.length > 400) return { error: msg('Der Pfad ist zu lang.') };
  if (!/^[A-Za-z0-9/_.\- ]+$/.test(value)) {
    return { error: msg('Der Pfad darf nur Buchstaben, Ziffern, Leerzeichen und / _ . - enthalten.') };
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) {
    return { error: msg('Der Pfad darf kein . oder .. enthalten.') };
  }
  const path = `/${parts.join('/')}`;
  if (FORBIDDEN_ROOTS.includes(path) || ['/proc/', '/sys/', '/dev/'].some((root) => path.startsWith(root))) {
    return {
      error: msg('In {path} legt HAPM keine Sicherungen ab. Bitte einen eigenen Ordner angeben, etwa /srv/hapm-backup.', {
        path,
      }),
    };
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
    if (!validTime(input.time)) throw new ApiError(msg('Die Uhrzeit hat nicht die Form HH:MM.'));
    patch.time = input.time;
  }
  if (input.keep !== undefined) {
    const keep = Number(input.keep);
    if (!Number.isInteger(keep) || keep < BACKUP_KEEP_MIN || keep > BACKUP_KEEP_MAX) {
      throw new ApiError(
        msg('Aufbewahrt werden zwischen {min} und {max} Sicherungen.', { min: BACKUP_KEEP_MIN, max: BACKUP_KEEP_MAX })
      );
    }
    patch.keep = keep;
  }
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);

  const next = { ...current, ...patch };
  if (next.enabled && !next.hostPath) {
    throw new ApiError(msg('Ohne Ordner lässt sich die tägliche Sicherung nicht einschalten.'));
  }

  await updateDocument<BackupSettings>(BACKUP_SETTINGS, SETTINGS_ID, patch);
  return getBackupSettings();
}
