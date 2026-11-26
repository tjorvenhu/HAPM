import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect, fingerprintOf, pack, unpack, type RootName } from '@/lib/sync/bundle';
import { applyUnpacked, type ApplyDeps } from '@/lib/sync/apply-core';
import { recoverInterrupted, stage, swapIn } from '@/lib/sync/swap';
import { CROWDSEC_LINES } from '@/lib/haproxy/config';

/**
 * Das Anwenden eines Pakets auf einem Folgeknoten, über Temp-Verzeichnisse:
 * der Tausch, und das Zurücktauschen an jeder Stelle, an der es scheitern
 * kann. Prüfen und Neuladen sind Attrappen. Gegen ein echtes HAProxy läuft
 * dasselbe in `pnpm sync:verify`.
 */

let base: string;
let primary: Record<RootName, string>;
let replica: Record<RootName, string>;

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function read(dir: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
}

/** Alles, was in einem Ordner liegt, als Pfad → Inhalt. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      if (fs.statSync(path.join(dir, rel)).isDirectory()) walk(rel);
      else out[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
    }
  };
  walk('');
  return out;
}

const SENDER = { nodeId: 'a'.repeat(32), name: 'proxy01', hapmVersion: '0.6.1', haproxyVersion: '3.2.4', exposure: 'public', usesCrowdsec: false };
const PRIMARY_CFG = 'global\n    log stdout format raw local0\n\nfrontend https\n    bind :443\n';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-sync-apply-'));
  primary = { haproxy: path.join(base, 'a', 'haproxy'), acme: path.join(base, 'a', 'acme') };
  replica = { haproxy: path.join(base, 'b', 'haproxy'), acme: path.join(base, 'b', 'acme') };

  write(primary.haproxy, 'haproxy.cfg', PRIMARY_CFG);
  write(primary.haproxy, 'certs/example.org.pem', 'CERT vom Hauptknoten');
  write(primary.haproxy, 'errors/404.http', 'Seite vom Hauptknoten');
  write(primary.haproxy, 'hapm-crowdsec/allow.lst', '203.0.113.7\n');
  write(primary.haproxy, 'hapm-crowdsec/spoe.cfg', 'SPOE des Hauptknotens');
  write(primary.acme, 'account.conf', "SAVED_CF_Token='geheim'\n");
  write(primary.acme, 'example.org_ecc/example.org.conf', "Le_Domain='example.org'\n");
  write(primary.acme, 'acme.sh', 'acme.sh des Hauptknotens');

  write(replica.haproxy, 'haproxy.cfg', 'global\n    # alter Stand des Folgeknotens\n');
  write(replica.haproxy, 'certs/000-hapm-default.pem', 'Platzhalter');
  write(replica.haproxy, 'certs/alt.example.pem', 'gibt es beim Hauptknoten nicht mehr');
  write(replica.haproxy, 'errors/404.http', 'alte Seite');
  write(replica.haproxy, 'hapm-crowdsec/spoe.cfg', 'SPOE dieses Knotens');
  write(replica.haproxy, 'hapm-crowdsec/allow.lst', '');
  write(replica.haproxy, 'haproxy.cfg.backup-20261126-101500', 'Sicherungskopie von hier');
  write(replica.acme, 'acme.sh', 'acme.sh dieses Knotens');
  write(replica.acme, 'dnsapi/dns_cf.sh', 'Hook dieses Knotens');
  write(replica.acme, 'account.conf', '');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function bundleOf(dirs: Record<RootName, string> = primary) {
  return unpack(pack({ seq: Date.now(), sender: SENDER }, collect(dirs)).bundle);
}

function deps(patch: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    dirs: replica,
    local: { crowdsec: true, spoaAddress: '127.0.0.1:7423' },
    check: async () => ({ ok: true, detail: '' }),
    reload: async () => ({ ok: true, detail: '' }),
    ...patch,
  };
}

describe('ein Paket anwenden', () => {
  it('macht den Folgeknoten zum Abbild des Hauptknotens', async () => {
    const result = await applyUnpacked(bundleOf(), deps());
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(read(replica.haproxy, 'haproxy.cfg')).toBe(PRIMARY_CFG);
    expect(read(replica.haproxy, 'certs/example.org.pem')).toBe('CERT vom Hauptknoten');
    expect(read(replica.haproxy, 'hapm-crowdsec/allow.lst')).toBe('203.0.113.7\n');
    expect(read(replica.acme, 'example.org_ecc/example.org.conf')).toBe("Le_Domain='example.org'\n");
    // Was der Hauptknoten nicht mehr hat, gibt es hier auch nicht mehr.
    expect(read(replica.haproxy, 'certs/alt.example.pem')).toBeNull();
    expect(read(replica.haproxy, 'certs/000-hapm-default.pem')).toBeNull();
  });

  it('lässt liegen, was jeder Knoten selbst führt', async () => {
    await applyUnpacked(bundleOf(), deps());
    expect(read(replica.haproxy, 'hapm-crowdsec/spoe.cfg')).toBe('SPOE dieses Knotens');
    expect(read(replica.haproxy, 'haproxy.cfg.backup-20261126-101500')).toBe('Sicherungskopie von hier');
    expect(read(replica.acme, 'acme.sh')).toBe('acme.sh dieses Knotens');
    expect(read(replica.acme, 'dnsapi/dns_cf.sh')).toBe('Hook dieses Knotens');
  });

  it('räumt hinter sich auf', async () => {
    await applyUnpacked(bundleOf(), deps());
    for (const dir of [replica.haproxy, replica.acme]) {
      expect(fs.readdirSync(dir).filter((name) => name.startsWith('.hapm-sync'))).toEqual([]);
    }
  });

  it('meldet danach denselben Fingerabdruck wie der Hauptknoten', async () => {
    const result = await applyUnpacked(bundleOf(), deps());
    expect(result.localFingerprint).toBe(fingerprintOf(collect(primary).entries));
  });

  it('prüft erst nach dem Tausch und lädt erst nach der Prüfung', async () => {
    const order: string[] = [];
    await applyUnpacked(
      bundleOf(),
      deps({
        check: async () => {
          // `haproxy -c` muss den neuen Stand sehen: die Datei nennt ihre Zertifikate mit festen Pfaden.
          order.push(`check:${read(replica.haproxy, 'certs/example.org.pem')}`);
          return { ok: true, detail: '' };
        },
        reload: async () => {
          order.push('reload');
          return { ok: true, detail: '' };
        },
      })
    );
    expect(order).toEqual(['check:CERT vom Hauptknoten', 'reload']);
  });

  it('tut nichts, wenn der Stand schon so vorliegt', async () => {
    await applyUnpacked(bundleOf(), deps());
    const reload = vi.fn(async () => ({ ok: true, detail: '' }));
    const again = await applyUnpacked(bundleOf(), deps({ reload }));
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('tauscht nur die Ordner, die das Paket nennt', async () => {
    fs.rmSync(primary.acme, { recursive: true, force: true });
    const before = tree(replica.acme);
    const result = await applyUnpacked(bundleOf(), deps());
    expect(result.ok).toBe(true);
    expect(tree(replica.acme)).toEqual(before);
  });
});

describe('wenn es scheitert, gilt wieder der alte Stand', () => {
  it('nach einer abgelehnten Konfiguration', async () => {
    const before = { haproxy: tree(replica.haproxy), acme: tree(replica.acme) };
    const reload = vi.fn(async () => ({ ok: true, detail: '' }));
    const result = await applyUnpacked(
      bundleOf(),
      deps({ check: async () => ({ ok: false, detail: "[ALERT] parsing [/etc/haproxy/haproxy.cfg:4] : unknown keyword 'quic'" }), reload })
    );
    expect(result.ok).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(tree(replica.haproxy)).toEqual(before.haproxy);
    expect(tree(replica.acme)).toEqual(before.acme);
    const failed = result.steps.find((step) => !step.ok)!;
    expect(failed.detail).toContain("unknown keyword 'quic'");
    expect(result.steps.at(-1)).toMatchObject({ label: 'Bisheriger Stand wiederhergestellt', ok: true });
  });

  it('nach einem gescheiterten Neuladen, und HAProxy lädt den alten noch einmal', async () => {
    const before = tree(replica.haproxy);
    const seen: (string | null)[] = [];
    const result = await applyUnpacked(
      bundleOf(),
      deps({
        reload: async () => {
          seen.push(read(replica.haproxy, 'haproxy.cfg'));
          return seen.length === 1 ? { ok: false, detail: 'Success=0' } : { ok: true, detail: '' };
        },
      })
    );
    expect(result.ok).toBe(false);
    expect(tree(replica.haproxy)).toEqual(before);
    // Der zweite Aufruf sieht wieder die alte Datei.
    expect(seen).toEqual([PRIMARY_CFG, 'global\n    # alter Stand des Folgeknotens\n']);
    expect(result.steps.at(-1)).toMatchObject({ label: 'HAProxy mit dem bisherigen Stand neu geladen', ok: true });
  });

  it('nach einer Prüfung, die wirft', async () => {
    const before = tree(replica.haproxy);
    const result = await applyUnpacked(
      bundleOf(),
      deps({
        check: async () => {
          throw new Error('Zeitüberschreitung nach 60 s');
        },
      })
    );
    expect(result.ok).toBe(false);
    expect(tree(replica.haproxy)).toEqual(before);
    expect(fs.readdirSync(replica.haproxy).filter((name) => name.startsWith('.hapm-sync'))).toEqual([]);
  });

  it('meldet den Fingerabdruck des alten Stands', async () => {
    const before = fingerprintOf(collect(replica).entries);
    const result = await applyUnpacked(bundleOf(), deps({ check: async () => ({ ok: false, detail: 'nein' }) }));
    expect(result.localFingerprint).toBe(before);
  });
});

describe('ein Abbruch mitten im Tausch', () => {
  it('wird beim nächsten Anwenden zurückgenommen, bevor der neue Stand kommt', async () => {
    // HAPM wurde beendet, nachdem getauscht, aber bevor neu geladen war.
    const unpacked = bundleOf();
    stage('haproxy', replica.haproxy, unpacked.entries, unpacked.contents);
    swapIn('haproxy', replica.haproxy);
    expect(fs.existsSync(path.join(replica.haproxy, '.hapm-sync-old'))).toBe(true);

    const result = await applyUnpacked(bundleOf(), deps());
    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ label: 'Abgebrochenen Abgleich zurückgenommen', ok: true });
    expect(read(replica.haproxy, 'haproxy.cfg')).toBe(PRIMARY_CFG);
    expect(fs.existsSync(path.join(replica.haproxy, '.hapm-sync-old'))).toBe(false);
  });

  it('stellt beim Start den alten Stand wieder her', () => {
    const before = tree(replica.haproxy);
    const unpacked = bundleOf();
    stage('haproxy', replica.haproxy, unpacked.entries, unpacked.contents);
    swapIn('haproxy', replica.haproxy);
    expect(recoverInterrupted('haproxy', replica.haproxy)).toBe(true);
    expect(tree(replica.haproxy)).toEqual(before);
    expect(recoverInterrupted('haproxy', replica.haproxy)).toBe(false);
  });

  it('räumt einen nur bereitgelegten Stand weg, ohne etwas zu tauschen', () => {
    const before = tree(replica.haproxy);
    const unpacked = bundleOf();
    stage('haproxy', replica.haproxy, unpacked.entries, unpacked.contents);
    expect(recoverInterrupted('haproxy', replica.haproxy)).toBe(false);
    expect(tree(replica.haproxy)).toEqual(before);
  });
});

describe('CrowdSec auf dem Folgeknoten', () => {
  const crowdsecBackend = [
    '',
    'backend web',
    ...CROWDSEC_LINES.map((line) => `    ${line}`),
    '    server web1 10.0.0.5:8080 check',
    '',
    '# CrowdSec: Verbindung zum Bouncer (HAPM)',
    'backend hapm_crowdsec_spoa',
    '    mode tcp',
    '    timeout connect 1s',
    '    timeout server 30s',
    '    server bouncer 127.0.0.1:7423 check inter 5s',
    '',
  ].join('\n');

  it('bekommt den Port des eigenen Bouncers', async () => {
    write(primary.haproxy, 'haproxy.cfg', PRIMARY_CFG + crowdsecBackend);
    const result = await applyUnpacked(bundleOf(), deps({ local: { crowdsec: true, spoaAddress: '127.0.0.1:7999' } }));
    expect(result.crowdsec).toBe('kept');
    const cfg = read(replica.haproxy, 'haproxy.cfg')!;
    expect(cfg).toContain('server bouncer 127.0.0.1:7999 check inter 5s');
    expect(cfg).toContain(CROWDSEC_LINES[0]);
  });

  it('lässt eine von Hand geänderte Zeile zum Bouncer stehen', async () => {
    write(primary.haproxy, 'haproxy.cfg', PRIMARY_CFG + crowdsecBackend.replace('127.0.0.1:7423 check inter 5s', '10.9.9.9:7423 check'));
    await applyUnpacked(bundleOf(), deps({ local: { crowdsec: true, spoaAddress: '127.0.0.1:7999' } }));
    expect(read(replica.haproxy, 'haproxy.cfg')).toContain('server bouncer 10.9.9.9:7423 check');
  });

  it('ändert nichts, wenn die Datei CrowdSec nicht benutzt', async () => {
    const result = await applyUnpacked(bundleOf(), deps({ local: { crowdsec: false, spoaAddress: '127.0.0.1:7423' } }));
    expect(result.crowdsec).toBe('unused');
    expect(read(replica.haproxy, 'haproxy.cfg')).toBe(PRIMARY_CFG);
  });
});
