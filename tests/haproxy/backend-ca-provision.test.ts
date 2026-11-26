import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@/lib/api';
import { SECTION_SEP, HEREDOC_DELIMITER } from '@/lib/shell';
import { addService, backendCaFile, type CreateServiceInput } from '@/lib/haproxy/config';
import { inspectCaUpload, type InspectedCa } from '@/lib/haproxy/backend-ca';
import { WITHOUT_SURFACE_PROTECTION } from '@/lib/haproxy/protected';
import { germanText } from '@/lib/i18n/translate';
import { ISSUING_CERT, ROOT_CERT } from './fixtures/ca-certs';

/**
 * Hinterlegen, Ersetzen und Entfernen einer Zertifizierungsstelle gegen eine
 * nachgebaute Maschine: welche Datei wann wo liegt, wann HAProxy neu geladen
 * wird und was nach einem abgelehnten `haproxy -c` zurückbleibt.
 *
 * Die Maschine ist ein Verzeichnis im Speicher, das genau die Kommandos
 * versteht, die `provision.ts` für diese Vorgänge schickt. Ein Kommando, das
 * sie nicht kennt, lässt den Test scheitern, statt still „gelungen" zu melden.
 */

const machine = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** Was `haproxy -c` antwortet. */
  checkCode: 0,
  reloadCode: 0,
  log: [] as string[],
}));

const CFG = '/etc/haproxy/haproxy.cfg';
const DIR = '/etc/haproxy/hapm-ca';

/** `'a' 'b'` in seine Wörter zerlegen: `buildCommand` setzt jedes Argument in einfache Anführungszeichen. */
function words(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) => match[1].replace(/'\\''/g, "'"));
}

vi.mock('@/lib/ssh', () => ({
  sshExec: vi.fn(async (_ssh: unknown, command: string) => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: code === 0 ? '' : stdout });
    const { files } = machine;

    // Die Runde von `probeProxy`: Version, acme.sh, Prüfsumme, DNS-Hooks, die Datei.
    if (command.includes('sha256sum')) {
      const config = files.get(CFG) ?? '';
      return out(['HAProxy version 3.4.0-abc 2026/01/01', 'ja', 'f'.repeat(64), '', config].join(`\n${SECTION_SEP}\n`));
    }
    if (command.startsWith(`for f in '${DIR}'/*.pem`)) {
      return out(
        [...files.entries()]
          .filter(([path]) => path.startsWith(`${DIR}/`) && path.endsWith('.pem'))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, content]) => `==> ${path.slice(DIR.length + 1)}\n${content}\n`)
          .join('')
      );
    }
    if (command.includes('cat > "$1"')) {
      const body = command.slice(command.indexOf('\n') + 1, command.lastIndexOf(`\n${HEREDOC_DELIMITER}`) + 1);
      // `sh -c <skript> sh <ziel> <ordner>`: das Ziel ist `$1`.
      const target = words(command.slice(0, command.indexOf(' <<')))[4];
      files.set(target, body);
      machine.log.push(`write ${target}`);
      return out('');
    }
    if (command.startsWith("'cp' '-a' '--'")) {
      const [, , , from, to] = words(command);
      if (!files.has(from)) return out('cp: no such file', 1);
      files.set(to, files.get(from)!);
      return out('');
    }
    if (command.startsWith("'rm' '-f' '--'")) {
      for (const path of words(command).slice(3)) files.delete(path);
      return out('');
    }
    const copy = /^cat '([^']+)' > '([^']+)'(?: && chmod 644 '[^']+')?$/.exec(command);
    if (copy) {
      if (!files.has(copy[1])) return out('cat: no such file', 1);
      files.set(copy[2], files.get(copy[1])!);
      machine.log.push(`install ${copy[2]}`);
      return out('');
    }
    if (command === `'haproxy' '-c' '-f' '${CFG}'`) {
      machine.log.push('check');
      return out(machine.checkCode === 0 ? 'Configuration file is valid' : 'unable to load CA file', machine.checkCode);
    }
    if (command === "'hapm-reload'") {
      machine.log.push('reload');
      return out('', machine.reloadCode);
    }
    if (command.startsWith("test -f '")) {
      return out(
        [...command.matchAll(/test -f '([^']+)'/g)].map((match) => (files.has(match[1]) ? 'ja' : 'nein')).join('\n')
      );
    }
    throw new Error(`Die nachgebaute Maschine kennt dieses Kommando nicht: ${command.slice(0, 120)}`);
  }),
}));

const { precheckUpdate, readBackendCas, removeBackendCa, uploadBackendCa } = await import('@/lib/haproxy/provision');

const server = { $id: 'local', name: 'test', host: '127.0.0.1', roleReverseProxy: true };

const BASE = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

# END AUTO INTERN SERVICES

# END AUTO INTERN BACKENDS
`;

const INPUT: CreateServiceInput = {
  scope: 'INTERN',
  id: 'app',
  domains: ['app.example.org'],
  servers: [{ name: 'server1', target: '10.0.0.5:8443', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  crowdsec: false,
  app: null,
  healthcheck: true,
  backendTls: 'off',
};

function inspected(name: string, certificate: string): InspectedCa {
  const checked = inspectCaUpload({ name, certificate }, Date.parse('2027-01-01T00:00:00Z'));
  if (!checked.ok) throw new Error(germanText(checked.message));
  return checked.value;
}

async function refused(run: Promise<unknown>): Promise<{ status: number; text: string }> {
  try {
    await run;
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, text: err.message };
    throw err;
  }
  throw new Error('nicht abgelehnt');
}

const ROOT = inspected('intern', ROOT_CERT);
const BUNDLE = inspected('intern', `${ISSUING_CERT}\n${ROOT_CERT}`);
const FILE = backendCaFile('intern');

beforeEach(() => {
  machine.files = new Map([[CFG, BASE]]);
  machine.checkCode = 0;
  machine.reloadCode = 0;
  machine.log = [];
});

describe('hinterlegen', () => {
  it('legt die Datei ab und lädt nicht neu: noch benutzt sie kein Ziel', async () => {
    const result = await uploadBackendCa(server, ROOT, false);
    expect(result).toEqual({ reloaded: false, usedBy: [] });
    expect(machine.files.get(FILE)).toBe(ROOT.pem);
    expect(machine.log).not.toContain('check');
    expect(machine.log).not.toContain('reload');
    // Die Zwischendatei liegt neben dem Ordner und ist danach weg.
    expect([...machine.files.keys()].sort()).toEqual([CFG, FILE].sort());
    expect((await readBackendCas(server))?.map((ca) => [ca.name, ca.certificates.length])).toEqual([['intern', 1]]);
  });

  it('überschreibt einen vergebenen Namen nicht, solange niemand „ersetzen" sagt', async () => {
    await uploadBackendCa(server, ROOT, false);
    const answer = await refused(uploadBackendCa(server, BUNDLE, false));
    expect(answer.status).toBe(409);
    expect(answer.text).toContain('schon eine Zertifizierungsstelle hinterlegt');
    expect(machine.files.get(FILE)).toBe(ROOT.pem);
  });

  it('ersetzt nichts, was nicht da ist', async () => {
    const answer = await refused(uploadBackendCa(server, ROOT, true));
    expect(answer.status).toBe(404);
    expect(machine.files.has(FILE)).toBe(false);
  });
});

describe('ersetzen', () => {
  it('tauscht eine unbenutzte Datei ohne Neuladen', async () => {
    await uploadBackendCa(server, ROOT, false);
    const result = await uploadBackendCa(server, BUNDLE, true);
    expect(result.reloaded).toBe(false);
    expect(machine.files.get(FILE)).toBe(BUNDLE.pem);
    expect(machine.log).not.toContain('reload');
  });

  it('prüft und lädt neu, wenn ein Ziel die Datei benutzt, und nennt das Ziel', async () => {
    await uploadBackendCa(server, ROOT, false);
    machine.files.set(CFG, addService(BASE, { ...INPUT, backendTls: 'ca:intern' }));
    machine.log = [];
    const result = await uploadBackendCa(server, BUNDLE, true);
    expect(result).toEqual({ reloaded: true, usedBy: ['app'] });
    expect(machine.files.get(FILE)).toBe(BUNDLE.pem);
    // Erst die Datei, dann prüfen, dann laden.
    expect(machine.log.filter((entry) => !entry.startsWith('write'))).toEqual([`install ${FILE}`, 'check', 'reload']);
    expect([...machine.files.keys()].sort()).toEqual([CFG, FILE].sort());
  });

  it('legt die bisherige Datei zurück, wenn HAProxy die neue ablehnt', async () => {
    await uploadBackendCa(server, ROOT, false);
    machine.files.set(CFG, addService(BASE, { ...INPUT, backendTls: 'ca:intern' }));
    machine.checkCode = 1;
    machine.log = [];
    const answer = await refused(uploadBackendCa(server, BUNDLE, true));
    expect(answer.text).toContain('Es wurde nichts geändert');
    expect(machine.files.get(FILE)).toBe(ROOT.pem);
    expect(machine.log).not.toContain('reload');
  });

  it('legt sie auch zurück, wenn das Neuladen scheitert, und lädt mit dem alten Stand', async () => {
    await uploadBackendCa(server, ROOT, false);
    machine.files.set(CFG, addService(BASE, { ...INPUT, backendTls: 'ca:intern' }));
    machine.reloadCode = 1;
    machine.log = [];
    const answer = await refused(uploadBackendCa(server, BUNDLE, true));
    expect(answer.text).toContain('Der vorherige Stand ist zurückgespielt');
    expect(machine.files.get(FILE)).toBe(ROOT.pem);
    expect(machine.log.filter((entry) => entry === 'reload')).toHaveLength(2);
  });
});

describe('entfernen', () => {
  it('nimmt eine unbenutzte Datei weg, ohne Neuladen', async () => {
    await uploadBackendCa(server, ROOT, false);
    const removed = await removeBackendCa(server, 'intern');
    expect(removed.name).toBe('intern');
    expect(machine.files.has(FILE)).toBe(false);
    expect(machine.log).not.toContain('reload');
  });

  it('lehnt ab, solange ein Ziel sie benutzt, und nennt es', async () => {
    await uploadBackendCa(server, ROOT, false);
    machine.files.set(CFG, addService(BASE, { ...INPUT, backendTls: 'ca:intern' }));
    const answer = await refused(removeBackendCa(server, 'intern'));
    expect(answer.status).toBe(409);
    expect(answer.text).toContain('wird noch benutzt: app');
    expect(machine.files.get(FILE)).toBe(ROOT.pem);
  });

  it('lehnt ab, wenn nur eine Pfad-Regel sie benutzt', async () => {
    await uploadBackendCa(server, ROOT, false);
    machine.files.set(
      CFG,
      addService(BASE, {
        ...INPUT,
        routes: [{ name: 'api', paths: ['/api'], servers: [{ name: 'api', target: '10.0.0.6:8443' }], check: false, backendTls: 'ca:intern' }],
      })
    );
    expect((await refused(removeBackendCa(server, 'intern'))).text).toContain('wird noch benutzt: app');
  });

  it('lehnt ab, wenn eine Zeile von Hand die Datei nennt: sonst lüde HAProxy nicht mehr', async () => {
    await uploadBackendCa(server, ROOT, false);
    machine.files.set(CFG, `${BASE}\nbackend von_hand\n    server s 10.0.0.9:443 ssl verify required ca-file ${FILE} verifyhost x.lan\n`);
    const answer = await refused(removeBackendCa(server, 'intern'));
    expect(answer.status).toBe(409);
    expect(answer.text).toContain('in einer Zeile, die HAPM nicht geschrieben hat');
    expect(machine.files.has(FILE)).toBe(true);
  });

  it('kennt nur, was hinterlegt ist', async () => {
    expect((await refused(removeBackendCa(server, 'intern'))).status).toBe(404);
  });
});

describe('ein Ziel auf eine Zertifizierungsstelle umstellen', () => {
  const challenge = {} as Parameters<typeof precheckUpdate>[3];

  beforeEach(() => {
    machine.files.set(CFG, addService(BASE, INPUT));
  });

  it('geht, wenn sie hinterlegt ist', async () => {
    await uploadBackendCa(server, ROOT, false);
    const current = await precheckUpdate(server, 'app', { ...INPUT, backendTls: 'ca:intern' }, challenge, WITHOUT_SURFACE_PROTECTION);
    expect(current.id).toBe('app');
  });

  it('wird vor dem Lauf abgelehnt, wenn sie fehlt, mit dem Weg zum Hinterlegen', async () => {
    const answer = await refused(
      precheckUpdate(server, 'app', { ...INPUT, backendTls: 'ca:intern' }, challenge, WITHOUT_SURFACE_PROTECTION)
    );
    expect(answer.status).toBe(409);
    expect(answer.text).toContain('Die Zertifizierungsstelle intern ist nicht hinterlegt');
    expect(answer.text).toContain('Reiter Zertifizierungsstellen');
  });

  it('nennt jede fehlende, auch die einer Pfad-Regel', async () => {
    await uploadBackendCa(server, ROOT, false);
    const answer = await refused(
      precheckUpdate(
        server,
        'app',
        {
          ...INPUT,
          backendTls: 'ca:intern',
          routes: [{ name: 'api', paths: ['/api'], servers: [{ name: 'api', target: '10.0.0.6:8443' }], check: false, backendTls: 'ca:zweite' }],
        },
        challenge,
        WITHOUT_SURFACE_PROTECTION
      )
    );
    expect(answer.text).toContain('Die Zertifizierungsstelle zweite ist nicht hinterlegt');
    expect(answer.text).not.toContain('intern ist');
  });
});
