/**
 * Gespeicherte Ziele: ein Server, den mehrere Einträge benutzen, einmal mit
 * Namen hinterlegt statt in jedem Dialog neu getippt.
 *
 * **Eine Eingabehilfe, keine Verknüpfung.** In `haproxy.cfg` steht weiter nur
 * `host:port`, und die Datei bleibt die Wahrheit. Wer im Dialog ein
 * gespeichertes Ziel wählt, bekommt dessen Adresse ins Feld geschrieben, mehr
 * nicht. Eine Verknüpfung bräuchte eine Kennung in der Konfiguration, die
 * `toCreateInput` beim Zurücklesen erfinden müsste.
 *
 * **Der Port ist freiwillig.** Ein Server mit fünf Diensten hat einen Host und
 * fünf Ports: hinterlegt wird dann nur der Host, und beim Wählen bleibt der Port
 * im Feld stehen. Mit Port ist es ein bestimmter Dienst, und die ganze Adresse
 * wird eingesetzt.
 *
 * Rein und ohne Import außer `lib/i18n`: das Formular im Browser prüft und setzt
 * mit denselben Funktionen wie die Route.
 */

import { msgid } from '../i18n';

export interface SavedTargetInput {
  name: string;
  host: string;
  port: number | null;
}

export interface SavedTarget extends SavedTargetInput {
  $id: string;
}

/** Wie `BACKEND_TARGET` in `config.ts`, nur ohne Port: der Host geht unverändert in eine server-Zeile. */
const HOST = /^[A-Za-z0-9.-]+$/;

/** Name, Host und Port aufgeräumt, wie sie gespeichert werden. */
export function normalizeSavedTarget(input: { name?: unknown; host?: unknown; port?: unknown }): SavedTargetInput {
  const rawPort = typeof input.port === 'number' ? input.port : String(input.port ?? '').trim();
  return {
    name: String(input.name ?? '').trim(),
    host: String(input.host ?? '').trim().toLowerCase(),
    port: rawPort === '' ? null : Number(rawPort),
  };
}

/** Die Meldung (`msgid`, übersetzt erst, wer sie zeigt) oder `null`. */
export function validateSavedTarget(target: SavedTargetInput): string | null {
  if (target.name === '') return msgid('Bitte einen Namen angeben.');
  if (target.name.length > 60) return msgid('Der Name ist zu lang.');
  if (target.host === '') return msgid('Bitte eine IP-Adresse oder einen Hostnamen angeben.');
  if (!HOST.test(target.host) || target.host.length > 253) {
    return msgid('Erlaubt sind für den Host a-z, 0-9, Bindestrich und Punkt.');
  }
  if (target.port !== null && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
    return msgid('Der Port liegt zwischen 1 und 65535.');
  }
  return null;
}

/** So, wie das Ziel in einer Liste steht: `10.0.0.5:8080` oder nur der Host. */
export function savedTargetAddress(target: SavedTargetInput): string {
  return target.port === null ? target.host : `${target.host}:${target.port}`;
}

/**
 * Das Adressfeld, nachdem ein gespeichertes Ziel gewählt wurde. Ohne Port im
 * Ziel bleibt der Port stehen, der im Feld schon stand; fehlt auch der, endet
 * die Adresse auf `:`, und der Cursor gehört dorthin.
 */
export function applySavedTarget(current: string, target: SavedTargetInput): string {
  if (target.port !== null) return `${target.host}:${target.port}`;
  const colon = current.lastIndexOf(':');
  const port = colon >= 0 ? current.slice(colon + 1).trim() : '';
  return `${target.host}:${/^[0-9]{1,5}$/.test(port) ? port : ''}`;
}

/** Das gespeicherte Ziel, dessen Host (und Port, wenn hinterlegt) in einer Adresse steht. */
export function findSavedTarget<T extends SavedTargetInput>(address: string, targets: readonly T[]): T | null {
  const colon = address.lastIndexOf(':');
  if (colon < 0) return null;
  const host = address.slice(0, colon).toLowerCase();
  const port = Number(address.slice(colon + 1));
  return (
    targets.find((t) => t.host === host && t.port === port) ??
    targets.find((t) => t.host === host && t.port === null) ??
    null
  );
}
