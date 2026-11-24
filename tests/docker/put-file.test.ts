import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tarFileHeader } from '@/lib/docker/engine.mjs';

/**
 * `putFile` schickt eine Datei als tar an die Engine (so legt das
 * Zurückspielen die Datenbank in den Postgres-Container). Den Kopf baut
 * `tarFileHeader` von Hand. Ob er stimmt, sagt hier ein echtes `tar`.
 */

function shPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

let dir: string | null = null;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('tarFileHeader', () => {
  it('ergibt mit Inhalt und Auffüllung ein tar, das tar liest', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-tar-'));
    const content = Buffer.from('-- PostgreSQL database dump complete\n'.repeat(40));
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512 + 1024, 0);
    const file = path.join(dir, 'x.tar');
    fs.writeFileSync(file, Buffer.concat([tarFileHeader('hapm-restore-1.sql', content.length), content, padding]));

    const env = { ...process.env, F: shPath(file), D: shPath(dir) };
    const listing = execFileSync('sh', ['-c', 'LC_ALL=C tar -tvf "$F"'], { env, encoding: 'utf8' });
    expect(listing).toMatch(new RegExp(`^-rw------- \\S+\\s+${content.length} .* hapm-restore-1\\.sql\\s*$`));
    execFileSync('sh', ['-c', 'tar -xf "$F" -C "$D/"'], { env });
    expect(fs.readFileSync(path.join(dir, 'hapm-restore-1.sql'))).toEqual(content);
  });

  it('lehnt Namen mit Pfad ab', () => {
    expect(() => tarFileHeader('../x.sql', 1)).toThrow();
    expect(() => tarFileHeader('', 1)).toThrow();
  });
});
