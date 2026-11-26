import { readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, it, expect } from 'vitest';
import {
  APP_RULES,
  appLogo,
  crsPluginVariable,
  localRuleExpression,
  renderAppWhitelist,
  renderCrsAppScopes,
  type AppUse,
  type LocalRule,
} from '@/lib/crowdsec/apps';

/**
 * Die eigenen Ausnahmen gegen die Fälle aus den Quellen. Dieselben Zeilen hat
 * `cscli explain` in CrowdSec 1.8.2 gegen das Log von HAProxy bestätigt (alle
 * Treffer „whitelisted“, alle Gegenproben nicht). Hier prüft sie JavaScript
 * statt RE2; die Muster nutzen nichts, was sich dort unterscheidet.
 */
function matches(rule: LocalRule, verb: string, status: string, path: string): boolean {
  const insensitive = rule.path.startsWith('(?i)');
  const pattern = new RegExp(insensitive ? rule.path.slice(4) : rule.path, insensitive ? 'i' : '');
  return rule.verbs.includes(verb) && rule.statuses.includes(status) && !path.includes('..') && pattern.test(path);
}

function allowed(verb: string, status: string, path: string): string | null {
  for (const app of APP_RULES) {
    if (app.local?.some((rule) => matches(rule, verb, status, path))) return app.id;
  }
  return null;
}

describe('eigene Ausnahmen je Anwendung', () => {
  it.each([
    ['nextcloud', 'HEAD', '404', '/remote.php/dav/files/anna/Photos/x.jpg'],
    ['nextcloud', 'PROPFIND', '403', '/remote.php/dav/calendars/anna/personal/'],
    ['nextcloud', 'POST', '403', '/apps/text/session/12/sync'],
    ['nextcloud', 'GET', '200', '/index.php/apps/deck/api/v1.1/boards/1/stacks/2/cards/3'],
    ['nextcloud', 'GET', '200', '/ocs/v1.php/cloud/capabilities?format=json'],
    ['nextcloud', 'POST', '404', '/login/v2/poll'],
    ['nextcloud', 'PROPFIND', '404', '/public.php/webdav/Ordner/.nomedia'],
    ['jellyfin', 'GET', '404', '/Items/abc123/Images/Backdrop?maxWidth=1920'],
    ['jellyfin', 'GET', '404', '/Videos/aa/bb/Subtitles/3/0/Stream.srt'],
    ['plex', 'GET', '200', '/hubs/sections/1?count=12'],
    ['matrix', 'GET', '404', '/_matrix/client/v3/rooms/!abc:x.org/state/m.room.encryption/'],
    ['matrix', 'GET', '200', '/_matrix/client/v1/media/thumbnail/x.org/AbC?width=96'],
    ['matrix', 'GET', '404', '/.well-known/matrix/client'],
    ['immich', 'GET', '200', '/api/assets/0b6f0c3e-1111-2222-3333-444455556666/thumbnail?size=thumbnail'],
    ['seafile', 'GET', '200', '/seafhttp/repo/0b6f0c3e-1111-2222-3333-444455556666/block/abcdef0123'],
    ['onlyoffice', 'GET', '200', '/7.5.1-0123456789abcdef0123/fonts/023'],
    ['onlyoffice', 'GET', '101', '/onlyoffice/7.5.1-0123456789abcdef0123/doc/abc/c/?EIO=4'],
    ['synology', 'GET', '404', '/webapi/AudioStation/cover.cgi?api=SYNO.AudioStation.Cover&id=1'],
    ['synology', 'GET', '404', '/webapi/entry.cgi?path=%2Fx&api=SYNO.FileStation.Thumb&version=2'],
    ['audiobookshelf', 'GET', '404', '/api/authors/0b6f0c3e-1111/image?ts=123'],
    ['navidrome', 'GET', '404', '/share/img/eyJhbGciOi'],
    ['git', 'HEAD', '302', '/group/sub/repo.git'],
  ])('%s: %s %s %s', (app, verb, status, path) => {
    expect(allowed(verb, status, path)).toBe(app);
  });

  it.each([
    ['GET', '200', '/.git'],
    ['GET', '200', '/.git/config'],
    ['GET', '200', '/foo/.git'],
    ['HEAD', '404', '/group/repo.git'],
    ['GET', '404', '/.env'],
    ['GET', '500', '/remote.php/dav/files/x'],
    ['GET', '404', '/wp-login.php'],
    ['GET', '404', '/api/assets/../../etc/passwd'],
    // Ein ausgenommener Pfad als Parameter angehängt nimmt nichts aus.
    ['GET', '200', "/index.php?id=1' UNION SELECT 1&x=/apps/deck/api/v1/boards/1/stacks/1/cards/1"],
    ['POST', '403', '/xmlrpc.php?/apps/text/session/1/sync'],
    ['POST', '403', '/xmlrpc.php/apps/text/session/1/sync'],
    // Auch nicht hinter einem ausgenommenen Anfang.
    ['GET', '404', '/Items/abc/Images/Backdrop/../../.env'],
    ['HEAD', '404', '/remote.php/dav/files/../../.env'],
    ['GET', '404', '/share/img/x/../../wp-login.php'],
    ['GET', '404', '/.well-known/matrix/../../.git/config'],
  ])('nimmt Scanner nicht aus: %s %s %s', (verb, status, path) => {
    expect(allowed(verb, status, path)).toBeNull();
  });

  it('verankert jedes Muster am Anfang', () => {
    for (const app of APP_RULES) {
      for (const rule of app.local ?? []) expect(rule.path.replace(/^\(\?i\)/, '').startsWith('^'), `${app.id}: ${rule.path}`).toBe(true);
    }
  });

  it('nennt für jede Ausnahme eine Quelle', () => {
    for (const app of APP_RULES) {
      for (const rule of app.local ?? []) expect(rule.source).toMatch(/^https:\/\//);
    }
  });

  it('jede Anwendung hat etwas zu installieren und eine eindeutige Kennung', () => {
    const ids = APP_RULES.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const app of APP_RULES) expect(app.hub.length + (app.local?.length ?? 0)).toBeGreaterThan(0);
  });
});

describe('renderAppWhitelist', () => {
  it('schreibt jeden Ausdruck als JSON-String mit der Quelle darüber', () => {
    const app = APP_RULES.find((entry) => entry.id === 'git')!;
    const text = renderAppWhitelist(app, ['git']);
    expect(text).toContain('name: hapm/git-allowlist\n');
    expect(text).toContain('    # https://github.com/crowdsecurity/hub/issues/1774\n');
    const line = text.split('\n').find((l) => l.startsWith('    - '))!;
    expect(JSON.parse(line.slice(6))).toBe(localRuleExpression(app.local![0]));
  });

  it('maskiert Backslashes für die Ausdruckssprache', () => {
    expect(localRuleExpression({ verbs: ['GET'], statuses: ['404'], path: String.raw`^/a\.b`, source: 'x' })).toBe(
      String.raw`evt.Meta.http_verb in ['GET'] && evt.Meta.http_status in ['404'] && !(evt.Meta.http_path contains '..') && evt.Meta.http_path matches '^/a\\.b'`
    );
  });
});

describe('Anwendungen nur für ihre Ziele', () => {
  const app = (id: string) => APP_RULES.find((entry) => entry.id === id)!;
  const use = (id: string, domains: string[], backends: string[] = [id]): AppUse => ({
    app: app(id),
    services: [{ id: backends[0], domains }],
    backends,
    domains,
  });

  it('nimmt die Whitelist nur für die Backends der Ziele', () => {
    const text = renderAppWhitelist(app('immich'), ['fotos', 'fotos_api']);
    const filter = JSON.parse(text.split('\n').find((line) => line.startsWith('filter: '))!.slice(8));
    expect(filter).toContain("evt.Parsed.backend_name in ['fotos', 'fotos_api']");
  });

  it('kennt die Variable jedes OWASP-Plugins', () => {
    const owasp = APP_RULES.filter((entry) => entry.kinds.includes('owasp'));
    expect(owasp.map(crsPluginVariable)).toEqual(owasp.map((entry) => `tx.${entry.id}-rule-exclusions-plugin_enabled`));
    expect(crsPluginVariable(app('immich'))).toBeNull();
  });

  it('schaltet jedes OWASP-Plugin aus und nur für die Hosts seiner Ziele an', () => {
    const text = renderCrsAppScopes([use('wordpress', ['blog.example.org', '*.news.example.org'], ['blog'])]);
    const lines = text.trim().split('\n').slice(1);
    const plugins = APP_RULES.filter((entry) => crsPluginVariable(entry));
    // Je Plugin ein Aus, dazu ein An für WordPress.
    expect(lines).toHaveLength(plugins.length + 1);
    const off = lines.find((line) => line.includes('tx.wordpress-rule-exclusions-plugin_enabled=0'))!;
    const on = lines.find((line) => line.includes('tx.wordpress-rule-exclusions-plugin_enabled=1'))!;
    expect(off).toMatch(/^SecAction "id:95991\d\d,phase:1,pass,nolog,t:none,setvar:'tx\.wordpress-rule-exclusions-plugin_enabled=0'"$/);
    expect(on).toContain(String.raw`"@rx ^(?:blog\.example\.org|[^.]+\.news\.example\.org)(?::[0-9]+)?$"`);
    expect(on).toContain('t:lowercase');
    const ids = lines.map((line) => /id:(\d+)/.exec(line)![1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passt mit dem Muster auf genau die Hosts der Ziele', () => {
    const text = renderCrsAppScopes([use('nextcloud', ['cloud.example.org', '*.files.example.org'])]);
    const on = text.split('\n').find((line) => line.includes('nextcloud-rule-exclusions-plugin_enabled=1'))!;
    const pattern = new RegExp(/"@rx ([^"]+)"/.exec(on)![1]);
    expect(pattern.test('cloud.example.org')).toBe(true);
    expect(pattern.test('cloud.example.org:443')).toBe(true);
    expect(pattern.test('a.files.example.org')).toBe(true);
    expect(pattern.test('a.b.files.example.org')).toBe(false);
    expect(pattern.test('cloudxexample.org')).toBe(false);
    expect(pattern.test('evil.example.org')).toBe(false);
    expect(pattern.test('cloud.example.org.evil.net')).toBe(false);
  });
});

describe('Logos der Anwendungen', () => {
  const dir = path.join(process.cwd(), 'public', 'apps');

  it('jede Anwendung mit Logo hat ihre Datei, 64 px', async () => {
    for (const app of APP_RULES) {
      const logo = appLogo(app);
      if (!logo) continue;
      const meta = await sharp(path.join(process.cwd(), 'public', logo)).metadata();
      expect([app.id, meta.width, meta.height]).toEqual([app.id, 64, 64]);
    }
  });

  it('keine Datei ohne Anwendung', () => {
    const ids = new Set(APP_RULES.filter((app) => appLogo(app)).map((app) => `${app.id}.png`));
    expect(readdirSync(dir).filter((file) => !ids.has(file))).toEqual([]);
  });
});
