/**
 * Was noch nicht über `t()`/`msg()` läuft, je Bereich und Datei.
 *
 *   pnpm i18n:report            Bereiche und Dateien
 *   pnpm i18n:report -- --texts Dazu jeder Text mit Zeile
 *   pnpm i18n:report -- lib/dns Nur Dateien unter diesem Pfad
 *
 * Eine Schätzung, kein Test: gezählt wird JSX-Text, jeder Wert eines sichtbaren
 * Attributs (`title`, `placeholder`, `aria-label` …) und jede Zeichenkette, die
 * nach einem deutschen Satz aussieht (Umlaut oder typisches Wort). Logzeilen,
 * Audit-Details und Importe zählen nicht. Was fehlt oder zu viel ist, zeigt
 * `--texts`. Regeln: docs/i18n.md.
 */

import { collectUntranslated, type Untranslated } from './i18n/scan';

/** Die Bereiche, nach denen die Arbeit verteilt wird. Der erste passende gewinnt. */
const AREAS: [string, RegExp][] = [
  ['Reverse-Proxy: Seiten', /^(app\/\(app\)\/reverse-proxy|components\/reverse-proxy)\//],
  ['Reverse-Proxy: Routen', /^app\/api\/(haproxy|internal|geoip)\//],
  ['Reverse-Proxy: lib', /^lib\/(haproxy|geoip|acme\.ts|haproxy-log\.ts|ip-allow\.ts)/],
  ['DNS', /^(app\/\(app\)\/dns|components\/dns|app\/api\/dns|lib\/dns)\b/],
  ['Übersicht', /^(app\/\(app\)\/dashboard|components\/(SetupReminder|GeoipReminder|CountryFlag))/],
  ['Updates', /^(app\/\(app\)\/updates|app\/api\/updates|lib\/updates|lib\/docker)\b/],
  ['Sicherung', /^(app\/\(app\)\/backup|app\/api\/backup|lib\/backup)\b/],
  ['Benachrichtigungen und Mails', /^(app\/\(app\)\/notifications|app\/api\/mail|lib\/mail|lib\/notifications|lib\/auth\/mail|ui\/mail)\b/],
  ['System und Benutzer', /^(app\/\(app\)\/(system|users)|app\/api\/(system|settings|users|activity|health|nav-counts|search)|components\/(system|systems)|lib\/(system|systems|settings|scheduler))\b/],
  ['Fehlerseiten von HAProxy', /^ui\/static\//],
  ['Einrichtung', /^(app\/setup|app\/api\/setup|lib\/setup)\b/],
  ['Anmeldung und Konto', /^(app\/(login|forgot-password|reset-password|\(app\)\/konto)|app\/api\/(auth|account)|lib\/auth|ui\/auth)\b/],
  ['Rahmen und ui/', /^(ui|components)\//],
];

function areaOf(file: string): string {
  return AREAS.find(([, pattern]) => pattern.test(file))?.[0] ?? `Sonstiges (${file.split('/').slice(0, 2).join('/')})`;
}

const args = process.argv.slice(2);
const showTexts = args.includes('--texts');
const prefix = args.find((arg) => !arg.startsWith('--'));

const found = collectUntranslated(process.cwd()).filter((entry) => !prefix || entry.file.startsWith(prefix));

const byFile = new Map<string, Untranslated[]>();
for (const entry of found) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);

const byArea = new Map<string, { files: string[]; ui: number; messages: number }>();
for (const [file, entries] of byFile) {
  const area = areaOf(file);
  const row = byArea.get(area) ?? { files: [], ui: 0, messages: 0 };
  row.files.push(file);
  for (const entry of entries) {
    if (entry.kind === 'message') row.messages++;
    else row.ui++;
  }
  byArea.set(area, row);
}

const pad = (value: string | number, width: number) => String(value).padStart(width);
const areas = [...byArea].sort((a, b) => b[1].ui + b[1].messages - (a[1].ui + a[1].messages));

console.log('Deutsche Texte, die noch nicht über t()/msg() laufen (Schätzung)\n');
console.log(`${'Bereich'.padEnd(34)} ${pad('Dateien', 7)} ${pad('Texte', 6)} ${pad('davon Meldungen', 15)}`);
let total = 0;
for (const [area, row] of areas) {
  const count = row.ui + row.messages;
  total += count;
  console.log(`${area.padEnd(34)} ${pad(row.files.length, 7)} ${pad(count, 6)} ${pad(row.messages, 15)}`);
}
console.log(`${'Summe'.padEnd(34)} ${pad(byFile.size, 7)} ${pad(total, 6)}\n`);

for (const [area, row] of areas) {
  console.log(`── ${area}`);
  const files = row.files.sort((a, b) => (byFile.get(b)?.length ?? 0) - (byFile.get(a)?.length ?? 0));
  for (const file of files) {
    const entries = byFile.get(file) ?? [];
    console.log(`  ${pad(entries.length, 4)}  ${file}`);
    if (showTexts) {
      for (const entry of entries) {
        console.log(`          ${pad(entry.line, 4)}${entry.kind === 'message' ? ' [Meldung]' : ''}  ${entry.text.slice(0, 110)}`);
      }
    }
  }
  console.log('');
}
