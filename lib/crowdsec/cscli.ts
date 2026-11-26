/**
 * `cscli` im Container von CrowdSec.
 *
 * HAPM spricht CrowdSec nicht über die lokale API an, sondern über `cscli` per
 * `exec` (Docker-Socket, wie `haproxy -c` im HAProxy-Container). Die API kennt
 * zwei Arten Zugang: ein Bouncer darf nur Sperren lesen, eine Maschine braucht
 * eigene Zugangsdaten und kann Freigabelisten trotzdem nicht ändern. `cscli`
 * kann alles, was die Seite braucht, und gibt JSON aus.
 *
 * Jedes Kommando ist ein argv (`engine.exec`), nie ein Text für eine Shell.
 */

import { ApiError } from '../api';
import { msg } from '../i18n';
import { engine, DockerError } from '../docker';
import { crowdsecContainerName } from './paths';

export class CrowdsecUnavailable extends ApiError {
  constructor(detail?: string) {
    super(
      detail
        ? msg('CrowdSec ist nicht erreichbar: {detail}', { detail })
        : msg('CrowdSec ist nicht erreichbar. Läuft der Container {name}?', { name: crowdsecContainerName() }),
      503
    );
    this.name = 'CrowdsecUnavailable';
  }
}

export interface CscliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function cscli(args: string[], timeoutMs = 30_000): Promise<CscliResult> {
  try {
    return await engine.exec(crowdsecContainerName(), ['cscli', ...args], { timeoutMs });
  } catch (err) {
    if (err instanceof DockerError && (err.status === 404 || err.status === 409)) {
      throw new CrowdsecUnavailable();
    }
    throw new CrowdsecUnavailable(err instanceof Error ? err.message : String(err));
  }
}

/** Die letzte Zeile, die etwas sagt: `cscli` schreibt Meldungen als `level=… msg="…"`. */
export function cscliError(result: CscliResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const quoted = /msg="((?:[^"\\]|\\.)*)"/.exec(last);
  return (quoted ? quoted[1] : last).slice(0, 400) || `exit ${result.code}`;
}

export async function cscliOk(args: string[], timeoutMs?: number): Promise<CscliResult> {
  const result = await cscli(args, timeoutMs);
  if (result.code !== 0) {
    throw new ApiError(msg('CrowdSec lehnt ab: {detail}', { detail: cscliError(result) }), 409);
  }
  return result;
}

export async function cscliJson<T = unknown>(args: string[], timeoutMs?: number): Promise<T> {
  const result = await cscliOk([...args, '-o', 'json'], timeoutMs);
  const text = result.stdout.trim();
  if (text === '' || text === 'null') return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CrowdsecUnavailable(text.slice(0, 200));
  }
}
