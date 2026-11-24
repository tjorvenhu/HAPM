// @ts-check
/**
 * Die Docker-Engine über ihren Socket.
 *
 * Reines JavaScript ohne Abhängigkeiten und ohne Build, weil es an zwei Stellen
 * läuft: in der Anwendung (`lib/docker/`) und in `bin/hapm-ctl.mjs`, dem
 * Kommando, das im Container hinter `haproxy` und `hapm-reload` steht. Das
 * zweite wird auch vom Deploy-Hook von acme.sh aufgerufen, also ohne die
 * Anwendung.
 *
 * Der Socket ist root auf dem Host. HAPM braucht ihn für drei Dinge: die
 * Konfiguration mit genau dem HAProxy prüfen, das läuft (`exec`), Abbilder
 * holen und Container ersetzen (Updates), und das Log von HAProxy lesen.
 */

import http from 'node:http';

/** @returns {string} */
export function socketPath() {
  if (process.env.DOCKER_SOCKET) return process.env.DOCKER_SOCKET;
  return process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

export class DockerError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }
}

/**
 * @typedef {object} RequestOptions
 * @property {Record<string, string | number | boolean | undefined>} [query]
 * @property {unknown} [body]
 * @property {Record<string, string>} [headers]
 * @property {number} [timeoutMs]
 */

/**
 * @param {string} path
 * @param {Record<string, string | number | boolean | undefined>} [query]
 */
function withQuery(path, query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * Eine Anfrage, deren Antwort als Strom zurückkommt.
 *
 * @param {string} method
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
export function stream(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request(
      {
        socketPath: socketPath(),
        method,
        path: withQuery(path, options.query),
        headers: {
          Host: 'docker',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
          ...options.headers,
        },
      },
      resolve
    );
    req.on('error', (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES') {
        reject(
          new DockerError(
            `Der Docker-Socket ist nicht erreichbar (${socketPath()}). Er muss in den HAPM-Container eingebunden sein.`,
            0
          )
        );
      } else reject(err);
    });
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => req.destroy(new Error('Zeitüberschreitung bei der Docker-Engine')));
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {import('node:http').IncomingMessage} res
 * @returns {Promise<Buffer>}
 */
function collect(res) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/**
 * Eine Anfrage mit JSON-Antwort. Wirft bei jedem Status ab 400.
 *
 * @param {string} method
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
export async function request(method, path, options = {}) {
  const res = await stream(method, path, { timeoutMs: 60_000, ...options });
  const body = await collect(res);
  const status = res.statusCode ?? 0;
  const text = body.toString('utf8');
  if (status >= 400) {
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      // Kein JSON, der Text bleibt.
    }
    throw new DockerError(message || `Docker antwortet mit ${status}`, status);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Zerlegt den gebündelten Strom der Engine (ohne TTY) in stdout und stderr.
 * Jeder Rahmen: ein Byte Kanal, drei Füllbytes, vier Bytes Länge, dann der Inhalt.
 *
 * @param {(channel: 1 | 2, chunk: Buffer) => void} onFrame
 */
export function demuxer(onFrame) {
  /** @type {Buffer} */
  let pending = Buffer.alloc(0);
  /** @param {Buffer} chunk */
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 8) {
      const length = pending.readUInt32BE(4);
      if (pending.length < 8 + length) break;
      const channel = pending[0] === 2 ? 2 : 1;
      onFrame(channel, pending.subarray(8, 8 + length));
      pending = pending.subarray(8 + length);
    }
  };
}

/**
 * Ein Kommando in einem laufenden Container ausführen.
 *
 * @param {string} container
 * @param {string[]} argv
 * @param {{ timeoutMs?: number, user?: string }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function exec(container, argv, options = {}) {
  const created = await request('POST', `/containers/${encodeURIComponent(container)}/exec`, {
    body: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: argv, User: options.user },
  });
  const res = await stream('POST', `/exec/${created.Id}/start`, {
    body: { Detach: false, Tty: false },
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if ((res.statusCode ?? 0) >= 400) {
    const text = (await collect(res)).toString('utf8');
    throw new DockerError(text || `exec scheitert mit ${res.statusCode}`, res.statusCode ?? 0);
  }

  /** @type {Buffer[]} */
  const out = [];
  /** @type {Buffer[]} */
  const err = [];
  const feed = demuxer((channel, chunk) => (channel === 2 ? err : out).push(chunk));
  await new Promise((resolve, reject) => {
    res.on('data', feed);
    res.on('end', resolve);
    res.on('error', reject);
  });

  const info = await request('GET', `/exec/${created.Id}/json`);
  return {
    code: typeof info.ExitCode === 'number' ? info.ExitCode : 1,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

/** @param {string} container */
export function inspectContainer(container) {
  return request('GET', `/containers/${encodeURIComponent(container)}/json`);
}

/**
 * Wie `inspectContainer`, aber `null` statt eines Fehlers, wenn es ihn nicht gibt.
 * @param {string} container
 */
export async function findContainer(container) {
  try {
    return await inspectContainer(container);
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return null;
    throw err;
  }
}

/** @param {string} reference */
export function inspectImage(reference) {
  return request('GET', `/images/${encodeURIComponent(reference)}/json`);
}

/**
 * @param {string} container
 * @param {string} signal
 */
export function kill(container, signal) {
  return request('POST', `/containers/${encodeURIComponent(container)}/kill`, { query: { signal } });
}

/** @param {string} container */
export function start(container) {
  return request('POST', `/containers/${encodeURIComponent(container)}/start`);
}

/**
 * @param {string} container
 * @param {number} [graceSeconds]
 */
export function stop(container, graceSeconds = 30) {
  return request('POST', `/containers/${encodeURIComponent(container)}/stop`, {
    query: { t: graceSeconds },
    timeoutMs: (graceSeconds + 30) * 1000,
  });
}

/** @param {string} container */
export function restart(container) {
  return request('POST', `/containers/${encodeURIComponent(container)}/restart`, { timeoutMs: 90_000 });
}

/**
 * @param {string} container
 * @param {string} name
 */
export function rename(container, name) {
  return request('POST', `/containers/${encodeURIComponent(container)}/rename`, { query: { name } });
}

/**
 * @param {string} container
 * @param {{ force?: boolean, volumes?: boolean }} [options]
 */
export function removeContainer(container, options = {}) {
  return request('DELETE', `/containers/${encodeURIComponent(container)}`, {
    query: { force: options.force ?? false, v: options.volumes ?? false },
  });
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} body
 */
export function createContainer(name, body) {
  return request('POST', '/containers/create', { query: { name }, body });
}

/**
 * Wartet, bis ein Container endet, und liefert seinen Exit-Code.
 * @param {string} container
 * @param {number} [timeoutMs]
 * @returns {Promise<number>}
 */
export async function wait(container, timeoutMs = 120_000) {
  const result = await request('POST', `/containers/${encodeURIComponent(container)}/wait`, { timeoutMs });
  return typeof result?.StatusCode === 'number' ? result.StatusCode : 1;
}

/**
 * Die Ausgabe eines Containers als Text.
 * @param {string} container
 * @param {{ tail?: number, since?: number }} [options]
 * @returns {Promise<string>}
 */
export async function logs(container, options = {}) {
  const res = await stream('GET', `/containers/${encodeURIComponent(container)}/logs`, {
    query: { stdout: true, stderr: true, tail: options.tail ?? 200, since: options.since },
    timeoutMs: 30_000,
  });
  const body = await collect(res);
  if ((res.statusCode ?? 0) >= 400) throw new DockerError(body.toString('utf8'), res.statusCode ?? 0);
  /** @type {Buffer[]} */
  const parts = [];
  demuxer((_channel, chunk) => parts.push(chunk))(body);
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Ein Abbild holen. Die Engine meldet den Fortschritt zeilenweise als JSON, und
 * ein Fehler steht in einer dieser Zeilen, nicht im Status der Antwort.
 *
 * @param {string} reference  z. B. `haproxy:lts`
 * @param {(line: string) => void} [onProgress]
 */
export async function pullImage(reference, onProgress) {
  const res = await stream('POST', '/images/create', { query: { fromImage: reference }, timeoutMs: 15 * 60_000 });
  if ((res.statusCode ?? 0) >= 400) {
    const text = (await collect(res)).toString('utf8');
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      // Kein JSON.
    }
    throw new DockerError(message, res.statusCode ?? 0);
  }

  let buffer = '';
  /** @type {string | null} */
  let failure = null;
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.error) failure = String(event.error);
          else if (event.status && onProgress) onProgress(event.id ? `${event.id}: ${event.status}` : event.status);
        } catch {
          // Eine halbe Zeile, sie kommt mit dem nächsten Stück.
        }
      }
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  if (failure) throw new DockerError(failure, 500);
}

/** @param {string} reference */
export function removeImage(reference) {
  return request('DELETE', `/images/${encodeURIComponent(reference)}`);
}

export function version() {
  return request('GET', '/version', { timeoutMs: 5000 });
}

/**
 * Die Kennung des Containers, in dem dieser Prozess läuft.
 *
 * Der Hostname taugt dafür nicht: mit `network_mode: host` ist er der des
 * Hosts. In `mountinfo` steht dagegen immer der Pfad, aus dem Docker
 * `/etc/hostname` einbindet, und darin die Kennung.
 *
 * @param {(path: string) => string} readFile
 * @returns {string | null}
 */
export function ownContainerId(readFile) {
  for (const file of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
    try {
      const match = /\/(?:containers|docker)[/-]([0-9a-f]{64})/.exec(readFile(file));
      if (match) return match[1];
    } catch {
      // Datei fehlt (kein Linux, kein Container).
    }
  }
  return null;
}
