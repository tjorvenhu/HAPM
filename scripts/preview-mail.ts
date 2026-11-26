/**
 * Alle Benachrichtigungen als HTML-Datei rendern, ohne etwas zu verschicken.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/preview-mail.ts          (beide Sprachen)
 *   node node_modules/tsx/dist/cli.mjs scripts/preview-mail.ts en       (nur Englisch)
 *   node node_modules/tsx/dist/cli.mjs scripts/preview-mail.ts de --brand
 *       mit einer Darstellung: Name, Farbe und Logo. Einzeln setzbar mit
 *       --brand-name=…, --brand-color=#rrggbb und --brand-logo=datei.png
 *       (ohne Datei ein Beispiel-SVG).
 *
 * Ruft dieselben Funktionen auf wie der Versand (`notificationMail`,
 * `testMail`, `authMail`, `passkeyChangeMail`). Je Mail und Sprache entstehen
 * unter `.data/mail-preview/` zwei Dateien: `name.de.html` und `name.de.txt`
 * (die Textfassung). `index.html` listet alles auf.
 *
 * Ein Unterschied zur versendeten Fassung, nur für den Browser: das Logo hängt
 * in der echten Mail als Anhang (`cid:`) und wird hier als data-URI eingesetzt.
 * Hell oder dunkel entscheidet der Browser wie ein Mailprogramm.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAIL_BRAND_LOGO_CID, MAIL_LOGO_CID, MAIL_LOGO_DARK_CID } from '../lib/mail/layout';
import { rememberMailBranding } from '../lib/mail/installation';
import { mailLogoSize } from '../lib/mail/branding';
import { imageDimensions, checkImageBytes } from '../lib/branding/branding';
import { authMail, passkeyChangeMail } from '../lib/auth/mail';
import { resetPasswordMail } from '../lib/auth/core/mail';
import { LOCALES, isLocale, type Locale } from '../lib/i18n';
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
    type: 'backend_ca_expiring',
    authorities: [{ name: 'intern-root', expiresAt: ahead(12), daysLeft: 12, usedBy: ['kunde_shop', 'intern_wiki'] }],
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

/* ── Darstellung, nur mit --brand… ── */

const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const branded = process.argv.some((arg) => arg.startsWith('--brand'));

const SAMPLE_LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60"><rect width="60" height="60" rx="14" fill="#c2410c"/>' +
  '<text x="76" y="41" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="#1f2937">Beispiel</text></svg>';

let brandLogoUri: string | null = null;
if (branded) {
  const file = option('brand-logo');
  const bytes = new Uint8Array(file ? readFileSync(resolve(process.cwd(), file)) : Buffer.from(SAMPLE_LOGO));
  const image = checkImageBytes(bytes);
  if ('error' in image) throw new Error(image.error);
  const natural = imageDimensions(bytes, image.value.mime);
  brandLogoUri = `data:${image.value.mime};base64,${image.value.data}`;
  rememberMailBranding({
    name: option('brand-name') ?? 'Beispiel GmbH',
    accent: option('brand-color') ?? '#c2410c',
    logo: natural ? mailLogoSize(natural) : null,
    logoDark: false,
  });
}

function forBrowser(html: string): string {
  return html
    .split(`cid:${MAIL_BRAND_LOGO_CID}`)
    .join(brandLogoUri ?? '')
    .split(`cid:${MAIL_LOGO_DARK_CID}`)
    .join(logo('hapm-logo-dark.png'))
    .split(`cid:${MAIL_LOGO_CID}`)
    .join(logo('hapm-logo.png'));
}

mkdirSync(OUT, { recursive: true });

const wanted = process.argv[2];
const locales: readonly Locale[] = isLocale(wanted) ? [wanted] : LOCALES;

function mailsIn(locale: Locale): [string, NotificationMail][] {
  const reset = resetPasswordMail({
    appName: 'HAPM',
    userName: 'Erika Mustermann',
    url: `${ctx.publicUrl}/reset-password?token=beispiel`,
    expiresInSeconds: 3600,
  });
  return [
    ...EVENTS.map((event): [string, NotificationMail] => [event.type, notificationMail(event, { ...ctx, locale })]),
    ['test', testMail({ nodeName: ctx.nodeName, publicUrl: ctx.publicUrl, locale })],
    ['reset-password', authMail(reset, locale)],
    [
      'passkey-added',
      passkeyChangeMail({ userName: 'Erika Mustermann', passkeyName: 'MacBook', change: 'added' }, ctx.publicUrl, locale),
    ],
  ];
}

const mails: [string, NotificationMail][] = locales.flatMap((locale) =>
  mailsIn(locale).map(([name, mail]): [string, NotificationMail] => [`${name}.${locale}`, mail])
);

for (const [name, mail] of mails) {
  writeFileSync(resolve(OUT, `${name}.html`), forBrowser(mail.html));
  writeFileSync(resolve(OUT, `${name}.txt`), `Betreff: ${mail.subject}\n\n${mail.text}\n`);
}

const rows = mails
  .map(([name, mail]) => `<li><a href="${name}.html">${mail.subject}</a> (<a href="${name}.txt">Text</a>)</li>`)
  .join('\n');
writeFileSync(resolve(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Mails von HAPM</title><ul>\n${rows}\n</ul>\n`);

console.log(`${mails.length} Mails unter ${OUT}`);
