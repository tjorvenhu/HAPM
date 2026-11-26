import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { postJson, SyslogConnection, TransportError, type SyslogTarget } from '@/lib/audit-log/transport';
import { TEST_CA_PEM } from './fixtures/ca';

/**
 * Die Weiterleitung gegen echte Empfänger auf 127.0.0.1: UDP, TCP, TLS und
 * HTTP(S). Nichts ist ersetzt: was hier ankommt, ist, was ein Syslog-Server
 * oder ein SIEM bekäme.
 *
 * Für TLS entsteht je Lauf ein selbst signiertes Zertifikat mit `openssl`
 * (unter Windows bringt Git Bash es mit). Fehlt `openssl`, werden nur diese
 * Fälle übersprungen, mit einer Zeile, die es sagt.
 */

interface Pair {
  cert: string;
  key: string;
}

function selfSigned(): Pair | null {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hapm-audit-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        '-subj', '/CN=localhost', '-days', '2',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' }
    );
    return { cert: readFileSync(path.join(dir, 'cert.pem'), 'utf8'), key: readFileSync(path.join(dir, 'key.pem'), 'utf8') };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pair = selfSigned();
if (!pair) console.warn('[tests/audit-log/transport] TLS-Fälle übersprungen: openssl ist nicht im PATH.');
const withTls = pair ? it : it.skip;

function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > until) return reject(new Error('Der Empfänger hat nicht bekommen, worauf der Test wartet.'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Zerlegt einen Strom mit vorangestellter Länge (RFC 6587) in Nachrichten. */
function octetFrames(data: Buffer): string[] {
  const out: string[] = [];
  let rest = data;
  while (rest.length > 0) {
    const space = rest.indexOf(0x20);
    if (space < 0) break;
    const length = Number(rest.subarray(0, space).toString('ascii'));
    if (!Number.isInteger(length) || rest.length < space + 1 + length) break;
    out.push(rest.subarray(space + 1, space + 1 + length).toString('utf8'));
    rest = rest.subarray(space + 1 + length);
  }
  return out;
}

interface StreamReceiver {
  port: number;
  received: () => Buffer;
  connections: () => number;
  dropAll: () => void;
  close: () => Promise<void>;
}

function streamReceiver(secure: Pair | null): Promise<StreamReceiver> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    let count = 0;
    const onSocket = (socket: net.Socket) => {
      count += 1;
      sockets.add(socket);
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
    };
    const server = secure
      ? tls.createServer({ cert: secure.cert, key: secure.key }, onSocket)
      : net.createServer(onSocket);
    server.on('tlsClientError', () => undefined);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received: () => Buffer.concat(chunks),
        connections: () => count,
        dropAll: () => sockets.forEach((socket) => socket.destroy()),
        close: () =>
          new Promise((done) => {
            sockets.forEach((socket) => socket.destroy());
            server.close(() => done());
          }),
      });
    });
  });
}

const open: { close: () => unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

function target(patch: Partial<SyslogTarget> & { port: number }): SyslogTarget {
  return { host: '127.0.0.1', protocol: 'tcp', framing: 'octet', caPem: null, ...patch };
}

function connection(patch: Partial<SyslogTarget> & { port: number }): SyslogConnection {
  const created = new SyslogConnection(target(patch));
  open.push(created);
  return created;
}

describe('Syslog über UDP', () => {
  it('schickt je Nachricht ein Datagramm, in der Reihenfolge', async () => {
    const socket = dgram.createSocket('udp4');
    const got: string[] = [];
    socket.on('message', (message) => got.push(message.toString('utf8')));
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    open.push({ close: () => new Promise<void>((resolve) => socket.close(() => resolve())) });

    await connection({ port: socket.address().port, protocol: 'udp' }).send(['<134>1 eins', '<134>1 zwei für später']);
    await waitFor(() => got.length === 2);
    expect(got).toEqual(['<134>1 eins', '<134>1 zwei für später']);
  });
});

describe('Syslog über TCP', () => {
  it('stellt jeder Nachricht ihre Länge voran', async () => {
    const receiver = await streamReceiver(null);
    open.push(receiver);
    const messages = ['<134>1 a - - - - eins', '<134>1 a - - - - Schlüssel für später', `<134>1 ${'x'.repeat(5000)}`];

    await connection({ port: receiver.port }).send(messages);
    await waitFor(() => octetFrames(receiver.received()).length === 3);
    expect(octetFrames(receiver.received())).toEqual(messages);
  });

  it('trennt auf Wunsch mit einem Zeilenende', async () => {
    const receiver = await streamReceiver(null);
    open.push(receiver);

    await connection({ port: receiver.port, framing: 'newline' }).send(['eins', 'zwei']);
    await waitFor(() => receiver.received().toString('utf8') === 'eins\nzwei\n');
    expect(receiver.received().toString('utf8')).toBe('eins\nzwei\n');
  });

  it('benutzt eine Verbindung für mehrere Abgaben und hält die Reihenfolge', async () => {
    const receiver = await streamReceiver(null);
    open.push(receiver);
    const sender = connection({ port: receiver.port });

    await Promise.all([sender.send(['1', '2']), sender.send(['3']), sender.send(['4', '5'])]);
    await waitFor(() => octetFrames(receiver.received()).length === 5);
    expect(octetFrames(receiver.received())).toEqual(['1', '2', '3', '4', '5']);
    expect(receiver.connections()).toBe(1);
  });

  it('verbindet sich neu, nachdem der Empfänger die Verbindung geschlossen hat', async () => {
    const receiver = await streamReceiver(null);
    open.push(receiver);
    const sender = connection({ port: receiver.port });

    await sender.send(['vorher']);
    await waitFor(() => receiver.connections() === 1 && octetFrames(receiver.received()).length === 1);
    receiver.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await sender.send(['nachher']);
    await waitFor(() => octetFrames(receiver.received()).includes('nachher'));
    expect(receiver.connections()).toBe(2);
  });

  it('meldet einen Empfänger, der nicht da ist, mit Adresse und Grund', async () => {
    // Ein Port, an dem gerade noch jemand hörte und jetzt niemand mehr.
    const receiver = await streamReceiver(null);
    const port = receiver.port;
    await receiver.close();

    const failed = connection({ port }).send(['x']);
    await expect(failed).rejects.toBeInstanceOf(TransportError);
    await expect(failed).rejects.toThrow(`127.0.0.1:${port}`);
  });

  it('erholt sich nach einem Fehler: die nächste Abgabe gelingt wieder', async () => {
    const first = await streamReceiver(null);
    const port = first.port;
    await first.close();
    const sender = connection({ port });
    await expect(sender.send(['geht verloren'])).rejects.toBeInstanceOf(TransportError);

    const server = net.createServer();
    const chunks: Buffer[] = [];
    server.on('connection', (socket) => socket.on('data', (chunk: Buffer) => chunks.push(chunk)));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });

    await sender.send(['kommt an']);
    await waitFor(() => octetFrames(Buffer.concat(chunks)).length === 1);
    expect(octetFrames(Buffer.concat(chunks))).toEqual(['kommt an']);
    sender.close();
  });
});

describe('Syslog über TLS', () => {
  let secure: StreamReceiver;

  beforeAll(async () => {
    if (pair) secure = await streamReceiver(pair);
  });
  afterAll(async () => {
    await secure?.close();
  });

  withTls('schickt verschlüsselt, wenn die CA des Empfängers hinterlegt ist', async () => {
    const before = secure.received().length;
    await connection({ port: secure.port, host: 'localhost', protocol: 'tls', caPem: pair!.cert }).send(['<134>1 geheim']);
    await waitFor(() => secure.received().length > before);
    expect(octetFrames(secure.received().subarray(before))).toEqual(['<134>1 geheim']);
  });

  withTls('prüft auch eine IP-Adresse gegen das Zertifikat', async () => {
    const before = secure.received().length;
    await connection({ port: secure.port, host: '127.0.0.1', protocol: 'tls', caPem: pair!.cert }).send(['über die Adresse']);
    await waitFor(() => secure.received().length > before);
    expect(octetFrames(secure.received().subarray(before))).toEqual(['über die Adresse']);
  });

  withTls('lehnt ein Zertifikat ab, dessen CA nicht hinterlegt ist', async () => {
    const before = secure.received().length;
    const failed = connection({ port: secure.port, host: 'localhost', protocol: 'tls', caPem: null }).send(['darf nicht ankommen']);
    await expect(failed).rejects.toBeInstanceOf(TransportError);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secure.received().length).toBe(before);
  });

  withTls('lehnt ein Zertifikat ab, das eine andere CA ausgestellt hat', async () => {
    const failed = connection({ port: secure.port, host: 'localhost', protocol: 'tls', caPem: TEST_CA_PEM }).send(['x']);
    await expect(failed).rejects.toBeInstanceOf(TransportError);
  });

  withTls('schickt nichts im Klartext an einen Empfänger ohne TLS', async () => {
    const plain = await streamReceiver(null);
    open.push(plain);
    const failed = connection({ port: plain.port, host: 'localhost', protocol: 'tls', caPem: pair!.cert }).send(['<134>1 geheim']);
    // Der Empfänger antwortet nie auf den Beginn von TLS: es endet an der Frist für die Verbindung.
    await expect(failed).rejects.toBeInstanceOf(TransportError);
    expect(plain.received().toString('latin1')).not.toContain('geheim');
  }, 15_000);
});

describe('HTTP-Endpunkt', () => {
  interface Seen {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  function endpoint(status: number, secure: Pair | null, reply = ''): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const seen: Seen[] = [];
      const handler = (request: http.IncomingMessage, response: http.ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
          response.statusCode = status;
          response.end(reply);
        });
      };
      const server = secure ? https.createServer({ cert: secure.cert, key: secure.key }, handler) : http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        resolve({
          url: `${secure ? 'https://localhost' : 'http://127.0.0.1'}:${port}/in?quelle=hapm`,
          seen,
          close: () =>
            new Promise((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        });
      });
    });
  }

  it('schickt JSON per POST mit der eingestellten Kopfzeile', async () => {
    const server = await endpoint(200, null);
    open.push(server);

    await postJson({ url: server.url, headerName: 'Authorization', headerValue: 'Splunk abc-123', caPem: null }, '{"action":"login","details":"für später"}');
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0].method).toBe('POST');
    expect(server.seen[0].url).toBe('/in?quelle=hapm');
    expect(server.seen[0].headers.authorization).toBe('Splunk abc-123');
    expect(server.seen[0].headers['content-type']).toBe('application/json');
    expect(server.seen[0].headers['content-length']).toBe(String(Buffer.byteLength('{"action":"login","details":"für später"}')));
    expect(JSON.parse(server.seen[0].body)).toEqual({ action: 'login', details: 'für später' });
  });

  it('schickt ohne Wert keine Kopfzeile mit', async () => {
    const server = await endpoint(204, null);
    open.push(server);
    await postJson({ url: server.url, headerName: 'X-Token', headerValue: null, caPem: null }, '{}');
    expect(server.seen[0].headers['x-token']).toBeUndefined();
  });

  it.each([400, 401, 403, 500, 503])('wertet die Antwort %i als nicht zugestellt und nennt sie', async (status) => {
    const server = await endpoint(status, null, 'Invalid token');
    open.push(server);
    const failed = postJson({ url: server.url, headerName: null, headerValue: null, caPem: null }, '{}');
    await expect(failed).rejects.toBeInstanceOf(TransportError);
    await expect(failed).rejects.toThrow(String(status));
    await expect(postJson({ url: server.url, headerName: null, headerValue: null, caPem: null }, '{}')).rejects.toThrow('Invalid token');
  });

  it('folgt keiner Weiterleitung: der Wert der Kopfzeile geht nur an die eingetragene Adresse', async () => {
    const elsewhere = await endpoint(200, null);
    open.push(elsewhere);
    const redirecting = http.createServer((_request, response) => {
      response.writeHead(307, { Location: elsewhere.url });
      response.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    open.push({ close: () => new Promise<void>((resolve) => redirecting.close(() => resolve())) });
    const port = (redirecting.address() as net.AddressInfo).port;

    await expect(
      postJson({ url: `http://127.0.0.1:${port}/`, headerName: 'Authorization', headerValue: 'Bearer geheim', caPem: null }, '{}')
    ).rejects.toThrow('307');
    expect(elsewhere.seen).toHaveLength(0);
  });

  it('meldet einen Endpunkt, der nicht da ist', async () => {
    const server = await endpoint(200, null);
    const url = server.url;
    await server.close();
    await expect(postJson({ url, headerName: null, headerValue: null, caPem: null }, '{}')).rejects.toBeInstanceOf(TransportError);
  });

  withTls('prüft bei https das Zertifikat gegen die hinterlegte CA', async () => {
    const server = await endpoint(200, pair);
    open.push(server);

    await postJson({ url: server.url, headerName: null, headerValue: null, caPem: pair!.cert }, '{"ok":true}');
    expect(server.seen).toHaveLength(1);

    await expect(postJson({ url: server.url, headerName: null, headerValue: null, caPem: null }, '{}')).rejects.toBeInstanceOf(TransportError);
    await expect(postJson({ url: server.url, headerName: null, headerValue: null, caPem: TEST_CA_PEM }, '{}')).rejects.toBeInstanceOf(TransportError);
    expect(server.seen).toHaveLength(1);
  });
});
