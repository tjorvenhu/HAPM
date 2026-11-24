/**
 * Alle Benachrichtigungen als HTML-Datei rendern, ohne etwas zu verschicken.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/preview-mail.ts
 *
 * Ruft dieselbe Funktion auf wie der Versand (`notificationMail`). Je Mail
 * entstehen unter `.data/mail-preview/` zwei Dateien: `name.html` und
 * `name.txt` (die Textfassung). `index.html` listet alles auf.
 *
 * Ein Unterschied zur versendeten Fassung, nur für den Browser: das Logo hängt
 * in der echten Mail als Anhang (`cid:`) und wird hier als data-URI eingesetzt.
 * Hell oder dunkel entscheidet der Browser wie ein Mailprogramm.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAIL_LOGO_CID, MAIL_LOGO_DARK_CID } from '../lib/mail/layout';
import { notificationMail, testMail, type NotificationMail, type NotificationMailContext } from '../lib/notifications/mails';
import type { NotificationEvent } from '../lib/notifications/events';

const OUT = resolve(process.cwd(), '.data', 'mail-preview');

const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const ahead = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60_000).toISOString();

const ctx: NotificationMailContext = {
  nodeName: 'proxy01',
  publicUrl: 'https://hapm.example.org',
  now,
  recoveryEnabled: true,
  autoUpdateHaproxy: false,
  autoUpdateTime: '04:00',
};

const EVENTS: NotificationEvent[] = [
  {
    type: 'certificate_renewal_failed',
    output:
      '[Tue Nov 24 03:17:04 UTC 2026] Renewing: \'shop.example.org\'\n[Tue Nov 24 03:17:09 UTC 2026] shop.example.org: Verify error: DNS problem: NXDOMAIN looking up A for shop.example.org\n[Tue Nov 24 03:17:09 UTC 2026] Error renewing shop.example.org.',
  },
  {
    type: 'certificate_expiring',
    certificates: [
      { mainDomain: 'shop.example.org', expiresAt: ahead(5), daysLeft: 5 },
      { mainDomain: '*.kunden.example.org', expiresAt: ahead(-2), daysLeft: -2 },
    ],
  },
  {
    type: 'backend_down',
    kind: 'service',
    id: 'kunde_shop',
    addresses: ['shop.example.org', 'www.shop.example.org'],
    targets: ['10.0.0.5:8080', '10.0.0.6:8080'],
    since: ago(4),
  },
  {
    type: 'backend_recovered',
    kind: 'service',
    id: 'kunde_shop',
    addresses: ['shop.example.org', 'www.shop.example.org'],
    up: 1,
    total: 2,
    downSince: ago(125),
  },
  { type: 'haproxy_down', container: 'hapm-haproxy', exists: true, status: 'exited', since: ago(4) },
  {
    type: 'run_failed',
    action: 'create',
    entry: 'kunde_shop',
    addresses: 'shop.example.org',
    error: 'Zertifikat ausstellen\nshop.example.org: Verify error: 203.0.113.7: Invalid response from http://shop.example.org/.well-known/acme-challenge/x: 404',
    triggeredBy: 'admin@example.org',
  },
  { type: 'update_available', component: 'haproxy', currentVersion: '3.4.8', latestVersion: '3.4.9', latestDigest: 'sha256:abc' },
  { type: 'update_completed', component: 'haproxy', runId: 'run', fromVersion: '3.4.8', toVersion: '3.4.9', triggeredBy: 'scheduler' },
  {
    type: 'update_failed',
    component: 'haproxy',
    fromVersion: '3.4.8',
    error: 'Die neue Fassung von HAProxy lehnt die vorhandene Konfiguration ab. Es wurde nichts geändert.',
    triggeredBy: 'scheduler',
  },
  { type: 'backup_failed', detail: 'Der Ordner /srv/hapm-backup ist nicht beschreibbar.' },
];

function logo(name: string): string {
  return `data:image/png;base64,${readFileSync(resolve(process.cwd(), 'public', 'email', name)).toString('base64')}`;
}

function forBrowser(html: string): string {
  return html
    .split(`cid:${MAIL_LOGO_DARK_CID}`)
    .join(logo('hapm-logo-dark.png'))
    .split(`cid:${MAIL_LOGO_CID}`)
    .join(logo('hapm-logo.png'));
}

mkdirSync(OUT, { recursive: true });

const mails: [string, NotificationMail][] = [
  ...EVENTS.map((event): [string, NotificationMail] => [event.type, notificationMail(event, ctx)]),
  ['test', testMail({ nodeName: ctx.nodeName, publicUrl: ctx.publicUrl })],
];

for (const [name, mail] of mails) {
  writeFileSync(resolve(OUT, `${name}.html`), forBrowser(mail.html));
  writeFileSync(resolve(OUT, `${name}.txt`), `Betreff: ${mail.subject}\n\n${mail.text}\n`);
}

const rows = mails
  .map(([name, mail]) => `<li><a href="${name}.html">${mail.subject}</a> (<a href="${name}.txt">Text</a>)</li>`)
  .join('\n');
writeFileSync(resolve(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Mails von HAPM</title><ul>\n${rows}\n</ul>\n`);

console.log(`${mails.length} Mails unter ${OUT}`);
