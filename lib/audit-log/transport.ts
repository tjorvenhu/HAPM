/**
 * Der Weg einer Nachricht nach draußen: Syslog über UDP, TCP oder TLS, und
 * HTTP(S) per POST. Nur Node (`dgram`, `net`, `tls`, `http`, `https`), kein
 * Kommando.
 *
 * ── Was „zugestellt" hier heißt ──
 *
 * UDP: das Datagramm ist abgeschickt. Ob es ankommt, erfährt niemand.
 * TCP und TLS: das Betriebssystem hat die Bytes angenommen. Syslog kennt keine
 * Quittung des Empfängers, eine gerade abgerissene Verbindung fällt deshalb
 * erst beim nächsten Schreiben auf. Wer jede Nachricht quittiert haben will,
 * nimmt den HTTP-Endpunkt: dort zählt die Antwort mit 2xx.
 *
 * ── TLS prüft immer ──
 *
 * Es gibt keinen Schalter „Zertifikat nicht prüfen". Ein Empfänger mit einem
 * Zertifikat aus der eigenen PKI bekommt das CA-Zertifikat als PEM mitgegeben.
 */

import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { frame, type SyslogFraming } from './format';
import type { SyslogProtocol } from './settings';

const CONNECT_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 10_000;
/** Eine Verbindung ohne Verkehr wird nach dieser Zeit geschlossen. */
const IDLE_MS = 120_000;

export interface SyslogTarget {
  host: string;
  port: number;
  protocol: SyslogProtocol;
  framing: SyslogFraming;
  caPem: string | null;
}

export function sameTarget(a: SyslogTarget, b: SyslogTarget): boolean {
  return a.host === b.host && a.port === b.port && a.protocol === b.protocol && a.framing === b.framing && a.caPem === b.caPem;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/** Die Meldung mit dem Ziel davor, außer sie nennt es schon selbst (`connect ECONNREFUSED 10.0.0.5:514`). */
function at(target: string, err: unknown): string {
  const message = describe(err);
  return message.includes(target) ? message : `${target}: ${message}`;
}

/** Ein Fehler beim Verschicken, mit einem Text, den die Seite zeigen kann. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

function connectStream(target: SyslogTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, socket?: net.Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err || !socket) reject(err);
      else resolve(socket);
    };

    const socket: net.Socket =
      target.protocol === 'tls'
        ? tls.connect({
            host: target.host,
            port: target.port,
            ca: target.caPem ?? undefined,
            // SNI nur für Namen: eine IP-Adresse dort lehnt Node ab.
            servername: net.isIP(target.host) === 0 ? target.host : undefined,
          })
        : net.connect({ host: target.host, port: target.port });

    const timer = setTimeout(() => {
      socket.destroy();
      done(new TransportError(`Keine Verbindung zu ${target.host}:${target.port} innerhalb von ${CONNECT_TIMEOUT_MS / 1000} Sekunden.`));
    }, CONNECT_TIMEOUT_MS);

    socket.once(target.protocol === 'tls' ? 'secureConnect' : 'connect', () => done(null, socket));
    socket.once('error', (err) => {
      socket.destroy();
      done(new TransportError(at(`${target.host}:${target.port}`, err)));
    });
  });
}

/**
 * Eine Verbindung zu einem Syslog-Server, die offen bleibt, solange geschickt
 * wird. `send` schickt die Nachrichten in ihrer Reihenfolge und endet, wenn
 * alle abgegeben sind, oder wirft.
 */
export class SyslogConnection {
  private stream: net.Socket | null = null;
  private udp: dgram.Socket | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly target: SyslogTarget) {}

  /** Nacheinander: zwei Aufrufe mischen ihre Nachrichten nicht. */
  send(messages: string[]): Promise<void> {
    const run = this.queue.then(() => this.sendNow(messages));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.stream?.destroy();
    this.stream = null;
    try {
      this.udp?.close();
    } catch {
      // Schon geschlossen.
    }
    this.udp = null;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  private async sendNow(messages: string[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      if (this.target.protocol === 'udp') await this.sendUdp(messages);
      else await this.sendStream(messages);
      this.touch();
    } catch (err) {
      this.close();
      throw err instanceof TransportError ? err : new TransportError(at(`${this.target.host}:${this.target.port}`, err));
    }
  }

  private async sendUdp(messages: string[]): Promise<void> {
    if (!this.udp) {
      const socket = dgram.createSocket(net.isIPv6(this.target.host) ? 'udp6' : 'udp4');
      // Ohne Zuhörer wäre ein ICMP „unreachable" eine unbehandelte Ausnahme.
      socket.on('error', () => this.close());
      socket.unref();
      this.udp = socket;
    }
    const socket = this.udp;
    for (const message of messages) {
      await new Promise<void>((resolve, reject) => {
        socket.send(Buffer.from(message, 'utf8'), this.target.port, this.target.host, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  private async sendStream(messages: string[]): Promise<void> {
    if (!this.stream || this.stream.destroyed || !this.stream.writable) {
      this.stream?.destroy();
      const socket = await connectStream(this.target);
      socket.setKeepAlive(true, 30_000);
      socket.unref();
      // Der Empfänger schickt nichts. Was trotzdem kommt, wird verworfen, damit der Puffer nicht wächst.
      socket.on('data', () => undefined);
      const drop = () => {
        if (this.stream === socket) this.stream = null;
        socket.destroy();
      };
      socket.on('error', drop);
      socket.on('close', drop);
      socket.on('end', drop);
      this.stream = socket;
    }
    const socket = this.stream;
    const data = Buffer.concat(messages.map((message) => frame(message, this.target.framing)));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('error', done);
        socket.off('close', onClose);
        if (err) reject(err);
        else resolve();
      };
      const onClose = () => done(new TransportError(`${this.target.host}:${this.target.port} hat die Verbindung geschlossen.`));
      const timer = setTimeout(
        () => done(new TransportError(`${this.target.host}:${this.target.port} nimmt seit ${WRITE_TIMEOUT_MS / 1000} Sekunden nichts an.`)),
        WRITE_TIMEOUT_MS
      );
      socket.once('error', done);
      socket.once('close', onClose);
      socket.write(data, (err) => done(err ?? null));
    });
  }
}

export interface HttpTarget {
  url: string;
  headerName: string | null;
  headerValue: string | null;
  caPem: string | null;
}

/** Ein POST mit JSON. Zugestellt heißt: der Endpunkt antwortet mit 2xx. */
export function postJson(target: HttpTarget, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(target.url);
    const secure = url.protocol === 'https:';
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'HAPM',
    };
    if (target.headerName && target.headerValue) headers[target.headerName] = target.headerValue;

    const request = (secure ? https : http).request(
      url,
      {
        method: 'POST',
        headers,
        timeout: HTTP_TIMEOUT_MS,
        // Ein eigener Agent je Anfrage: eine CA gilt nur für dieses Ziel.
        agent: false,
        ...(secure && target.caPem ? { ca: target.caPem } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size < 2048) chunks.push(chunk);
          size += chunk.length;
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve();
          const text = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 200);
          reject(new TransportError(`${url.host} antwortet mit ${status}${text ? `: ${text}` : ''}`));
        });
        response.on('error', (err) => reject(new TransportError(at(url.host, err))));
      }
    );
    request.on('timeout', () => {
      request.destroy(new TransportError(`${url.host} antwortet nicht innerhalb von ${HTTP_TIMEOUT_MS / 1000} Sekunden.`));
    });
    request.on('error', (err) => reject(err instanceof TransportError ? err : new TransportError(at(url.host, err))));
    request.end(body);
  });
}
