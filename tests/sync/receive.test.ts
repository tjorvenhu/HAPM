import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generatePairingKey, sealRequest, SYNC_HEADER, MAX_SKEW_MS } from '@/lib/sync/envelope';

/**
 * Der Endpunkt für andere Knoten, über echtes HTTP: ein Server auf einem
 * freien Port ruft `handleNodeRequest`, und `callNode` spricht ihn an, wie ein
 * Hauptknoten seinen Folgeknoten anspricht. Dahinter sind Auskunft und
 * Anwenden ersetzt: hier geht es um die Tür.
 */

const KEY = generatePairingKey();

const state = vi.hoisted(() => ({
  key: null as string | null,
  bundles: [] as Buffer[],
  reports: 0,
}));

vi.mock('@/lib/sync/store', () => ({
  getSyncSettings: vi.fn(async () => ({ pairingKey: state.key })),
  // Im Betrieb liegt der Schlüssel verschlüsselt: hier ist „gespeichert" der Klartext.
  openKey: (stored: string | null) => stored,
}));
vi.mock('@/lib/sync/apply', () => ({
  acceptBundle: vi.fn(async (bundle: Buffer) => {
    state.bundles.push(Buffer.from(bundle));
    return { ok: true, accepted: true, seq: 7 };
  }),
  currentApply: () => null,
}));
vi.mock('@/lib/sync/node', () => ({
  nodeReport: vi.fn(async () => {
    state.reports += 1;
    return { protocol: 1, name: 'proxy02', role: 'replica' };
  }),
}));

const { handleNodeRequest, resetSyncReceive, MAX_STATUS_BYTES } = await import('@/lib/sync/receive');
const { handleError } = await import('@/lib/api');
const { NodeCallError, askNode, callNode } = await import('@/lib/sync/send');

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(`http://node.test${req.url}`, { method: 'POST', headers, body: new Uint8Array(Buffer.concat(chunks)) });
      handleNodeRequest(request)
        .catch((err: unknown) => handleError(err))
        .then(async (response) => {
          res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
          res.end(Buffer.from(await response.arrayBuffer()));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  state.key = KEY;
  state.bundles = [];
  state.reports = 0;
  resetSyncReceive();
});

/** Eine rohe Anfrage, an `callNode` vorbei. */
function raw(header: string | null, body: Buffer): Promise<Response> {
  return fetch(`${url}/api/sync/node`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...(header === null ? {} : { [SYNC_HEADER]: header }) },
    body: new Uint8Array(body),
  });
}

describe('zwei Knoten mit demselben Schlüssel', () => {
  it('die Auskunft kommt an, und nur der Knoten mit dem Schlüssel kann sie geschrieben haben', async () => {
    await expect(askNode({ url, key: KEY })).resolves.toMatchObject({ name: 'proxy02', role: 'replica' });
  });

  it('ein Paket kommt Byte für Byte an', async () => {
    const bundle = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251));
    const answer = await callNode({ url, key: KEY }, 'apply', bundle, 10_000);
    expect(answer).toEqual({ ok: true, accepted: true, seq: 7 });
    expect(state.bundles).toHaveLength(1);
    expect(state.bundles[0].equals(bundle)).toBe(true);
  });

  it('über die Leitung geht nichts im Klartext', async () => {
    const secret = Buffer.from('-----BEGIN PRIVATE KEY-----');
    const sealed = sealRequest(KEY, 'apply', secret);
    expect(sealed.body.includes(secret)).toBe(false);
    const res = await raw(sealed.header, sealed.body);
    expect(res.status).toBe(200);
    // Auch die Antwort ist verschlüsselt: kein lesbares JSON.
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).not.toContain('accepted');
  });
});

describe('ohne den Schlüssel', () => {
  it('weist einen fremden Schlüssel ab, mit einem Satz für den Hauptknoten', async () => {
    const error = await askNode({ url, key: generatePairingKey() }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NodeCallError);
    expect((error as Error).message).toBe('Der Knoten lehnt den Kopplungsschlüssel ab.');
    expect(state.reports).toBe(0);
  });

  it('gibt dieselbe Absage, wenn hier gar kein Schlüssel gesetzt ist', async () => {
    state.key = null;
    const withKey = sealRequest(KEY, 'status', Buffer.from('{}'));
    const res = await raw(withKey.header, withKey.body);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(401);

    state.key = KEY;
    const wrong = sealRequest(generatePairingKey(), 'status', Buffer.from('{}'));
    const other = await raw(wrong.header, wrong.body);
    expect(other.status).toBe(401);
    expect(((await other.json()) as { error: string }).error).toBe(body.error);
  });

  it.each([[null], [''], ['v1;x'], ['Bearer hapm_abc']])('weist die Kopfzeile %j ab', async (header) => {
    const res = await raw(header, Buffer.from('irgendwas'));
    expect(res.status).toBe(401);
    expect(state.reports).toBe(0);
    expect(state.bundles).toEqual([]);
  });

  it('liest keinen Rumpf, bevor die Kopfzeile stimmt', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 }
    );
    const wrong = sealRequest(generatePairingKey(), 'apply', Buffer.alloc(1024));
    const request = new Request('http://node.test/api/sync/node', {
      method: 'POST',
      headers: { [SYNC_HEADER]: wrong.header },
      body,
      // @ts-expect-error `duplex` kennt der Typ von RequestInit noch nicht, Node verlangt es für einen Strom als Rumpf.
      duplex: 'half',
    });
    await expect(handleNodeRequest(request)).rejects.toMatchObject({ status: 401 });
    expect(pulled).toBe(0);
  });

  it('sperrt eine Adresse nach zwanzig Fehlversuchen, auch für den richtigen Schlüssel', async () => {
    for (let i = 0; i < 20; i++) expect((await raw('v1;kaputt', Buffer.alloc(1))).status).toBe(401);
    expect((await raw('v1;kaputt', Buffer.alloc(1))).status).toBe(429);
    const error = await askNode({ url, key: KEY }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NodeCallError);
    expect(state.reports).toBe(0);
  });
});

describe('mit dem Schlüssel, aber nicht so', () => {
  it('nimmt dieselbe Anfrage kein zweites Mal', async () => {
    const sealed = sealRequest(KEY, 'apply', Buffer.from('paket'));
    expect((await raw(sealed.header, sealed.body)).status).toBe(200);
    const replay = await raw(sealed.header, sealed.body);
    expect(replay.status).toBe(409);
    expect(state.bundles).toHaveLength(1);
  });

  it('nimmt keine alte Anfrage und sagt, dass es an der Uhr liegt', async () => {
    const sealed = sealRequest(KEY, 'status', Buffer.from('{}'), Date.now() - MAX_SKEW_MS - 60_000);
    const res = await raw(sealed.header, sealed.body);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Uhren');
    expect(state.reports).toBe(0);
  });

  it('nimmt keinen veränderten Rumpf', async () => {
    const sealed = sealRequest(KEY, 'apply', Buffer.from('paket'));
    const flipped = Buffer.from(sealed.body);
    flipped[flipped.length - 1] ^= 1;
    expect((await raw(sealed.header, flipped)).status).toBe(401);
    expect(state.bundles).toEqual([]);
  });

  it('nimmt keinen Rumpf, der länger ist als angekündigt', async () => {
    const sealed = sealRequest(KEY, 'apply', Buffer.from('paket'));
    const res = await raw(sealed.header, Buffer.concat([sealed.body, Buffer.alloc(64)]));
    expect(res.status).toBe(413);
    expect(state.bundles).toEqual([]);
  });

  it('nimmt eine Frage nach der Auskunft nicht als Weg für ein großes Paket', async () => {
    const sealed = sealRequest(KEY, 'status', Buffer.alloc(MAX_STATUS_BYTES + 1));
    const res = await raw(sealed.header, sealed.body);
    expect(res.status).toBe(413);
    expect(state.reports).toBe(0);
  });

  it('zählt das nicht als Fehlversuch: wer den Schlüssel hat, sperrt sich nicht aus', async () => {
    for (let i = 0; i < 25; i++) {
      const old = sealRequest(KEY, 'status', Buffer.from('{}'), Date.now() - MAX_SKEW_MS - 60_000);
      expect((await raw(old.header, old.body)).status).toBe(409);
    }
    await expect(askNode({ url, key: KEY })).resolves.toMatchObject({ name: 'proxy02' });
  });
});
