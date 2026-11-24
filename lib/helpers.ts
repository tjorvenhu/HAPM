import os from 'node:os';
import { ApiError } from './api';
import type { SSHConnectionConfig } from './ssh';
import type { Server } from './types';

/**
 * Die eine Maschine, die HAPM verwaltet.
 *
 * `lib/haproxy/` fragt überall nach einem Server über seine Kennung. Es gibt
 * genau einen, und er steht in keiner Tabelle.
 */
export const LOCAL_SERVER_ID = 'local';

export function localServer(): Server {
  return {
    $id: LOCAL_SERVER_ID,
    name: process.env.HAPM_NODE_NAME || os.hostname(),
    host: '127.0.0.1',
    roleReverseProxy: true,
  };
}

export async function getServer(serverId: string): Promise<Server> {
  if (serverId !== LOCAL_SERVER_ID) throw new ApiError('Server nicht gefunden', 404);
  return localServer();
}

/** Immer leer: jedes Kommando läuft lokal, Zugangsdaten gibt es nicht. Siehe `lib/ssh.ts`. */
export async function getSSHConfig(_server: Server): Promise<SSHConnectionConfig> {
  return {};
}
