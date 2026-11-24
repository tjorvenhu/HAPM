import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Das Aufräumen der Konfigurations-Sicherungen, von einer echten Bash
 * nachgerechnet.
 *
 * Jeder Schreibvorgang am Reverse-Proxy legt ein `haproxy.cfg.backup-<stamp>`
 * an, und ohne diese Aufbewahrung räumt sie niemand weg. Zwei Dinge können
 * an dem Befehl kaputtgehen, und beide fallen im Betrieb nicht auf:
 *
 *  - Zu viel löschen. Ein `rm -f` über ein Muster in `/etc/haproxy` — wenn das
 *    Muster daneben greift, ist die gültige Konfiguration weg.
 *  - Zu wenig löschen, und zwar still. Der ganze Ausdruck durch `shellEscape`
 *    macht aus dem Muster einen Dateinamen mit einem Sternchen darin: `ls`
 *    findet nichts, `xargs -r` läuft nicht, der Befehl endet mit 0, und das
 *    Aufräumen tut für immer nichts.
 */

let pruneBackupsCommand: typeof import('@/lib/haproxy/provision').pruneBackupsCommand;

beforeAll(async () => {
  // provision.ts hängt über die Helfer an lib/crypto; die beiden Secrets müssen
  // stehen, bevor das Modul lädt. Gleiche Reihenfolge wie in crypto.test.ts.
  process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-characters-long';
  process.env.SESSION_SECRET = 'a-totally-separate-session-secret-32-chars';
  ({ pruneBackupsCommand } = await import('@/lib/haproxy/provision'));
});

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Ein Verzeichnis mit der Konfiguration und `count` Sicherungen, deren Namen
 *  dieselbe feste Breite haben wie die aus `stamp()`. */
function setup(count: number): { cfg: string; dir: string } {
  dir = mkdtempSync(join(tmpdir(), 'haproxy-prune-'));
  const cfg = join(dir, 'haproxy.cfg');
  writeFileSync(cfg, 'global\n');
  for (let i = 0; i < count; i++) {
    const day = String(i + 1).padStart(2, '0');
    writeFileSync(`${cfg}.backup-202601${day}-120000`, `stand ${i}\n`);
  }
  // Eine Datei, die nicht zum Muster gehört: sie darf der Befehl nie anfassen.
  writeFileSync(join(dir, 'haproxy.cfg.hapm-new'), 'entwurf\n');
  return { cfg, dir };
}

/**
 * Der Pfad, wie ihn die Bash liest. Unter Windows liefert `mkdtemp` einen Pfad
 * mit Backslashes, und die sind in einfachen Anführungszeichen buchstäblich —
 * die Datei hieße dann wirklich `C:\Users\…`. Git Bash versteht `C:/Users/…`.
 * Betrifft nur den Test: auf der Gegenstelle steht ein Linux-Pfad.
 */
function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

function run(cfg: string, keep: number): string {
  return execFileSync('bash', ['-c', pruneBackupsCommand(keep, posix(cfg))], {
    encoding: 'utf8',
  }).trim();
}

describe('pruneBackupsCommand', () => {
  it('behält die neuesten und löscht den Rest', () => {
    const { cfg, dir: d } = setup(14);

    expect(run(cfg, 10)).toBe('10');

    const left = readdirSync(d)
      .filter((f) => f.includes('.backup-'))
      .sort();
    expect(left).toHaveLength(10);
    // Sortiert wird über den Zeitstempel im Namen: übrig bleiben die letzten
    // zehn, nicht irgendwelche zehn.
    expect(left[0]).toContain('20260105');
    expect(left[9]).toContain('20260114');
  });

  it('fasst die Konfiguration und fremde Dateien nicht an', () => {
    const { cfg, dir: d } = setup(12);
    run(cfg, 3);

    const left = readdirSync(d).sort();
    expect(left).toContain('haproxy.cfg');
    expect(left).toContain('haproxy.cfg.hapm-new');
    expect(left.filter((f) => f.includes('.backup-'))).toHaveLength(3);
  });

  it('macht nichts, wenn es weniger als die Grenze gibt', () => {
    const { cfg, dir: d } = setup(4);

    expect(run(cfg, 10)).toBe('4');
    expect(readdirSync(d).filter((f) => f.includes('.backup-'))).toHaveLength(4);
  });

  it('läuft ohne eine einzige Sicherung durch, statt zu scheitern', () => {
    const { cfg } = setup(0);
    expect(run(cfg, 10)).toBe('0');
  });

  it('expandiert das Muster wirklich — der Stern steht außerhalb der Anführungszeichen', () => {
    // Die Regressionsprobe zum stillen Fehlschlag: wäre der ganze Ausdruck
    // zitiert, bliebe die Zahl bei 12 stehen und der Test oben würde es nicht
    // merken, weil ein Befehl, der nichts tut, ebenfalls mit 0 endet.
    const { cfg } = setup(12);
    expect(pruneBackupsCommand(10, posix(cfg))).toContain(`'${posix(cfg)}'.backup-*`);
    expect(run(cfg, 10)).toBe('10');
  });

  it('behält ein Verzeichnis mit einem Leerzeichen im Pfad heil', () => {
    const base = mkdtempSync(join(tmpdir(), 'haproxy prune '));
    dir = base;
    const cfg = join(base, 'haproxy.cfg');
    writeFileSync(cfg, 'global\n');
    for (let i = 0; i < 5; i++) {
      writeFileSync(`${cfg}.backup-2026010${i + 1}-120000`, 'x\n');
    }

    expect(run(cfg, 2)).toBe('2');
    expect(readdirSync(base).filter((f) => f.includes('.backup-'))).toHaveLength(2);
  });
});
