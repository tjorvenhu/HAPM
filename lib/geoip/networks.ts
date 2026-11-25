/**
 * Aus der Länder-Tabelle die Netze eines Landes machen, für die Ländersperre
 * in HAProxy (`acl hapm_blocked_countries src -f /etc/haproxy/hapm-geo/XX.lst`).
 *
 * Rein wie `./format.ts`, damit der Test ohne Datenbank nachrechnen kann.
 *
 * ── Warum Dateien und keine Map in HAProxy ──
 *
 * Eine Map aller 700 000 Bereiche (`src,map_ip(...)`) hielte die ganze Welt im
 * Speicher von HAProxy, auch wenn ein einziges Land gesperrt ist. Eine Datei je
 * gesperrtem Land lädt nur, was gebraucht wird, und welche Länder gesperrt
 * sind, steht lesbar in `haproxy.cfg`.
 *
 * ── IPv6 ──
 *
 * Die Tabelle führt von IPv6 nur die oberen 64 Bit (siehe Kopf von
 * `./format.ts`). Die Netze sind deshalb höchstens /64 lang, und das ist auch
 * die feinste Einheit, in der Länder vergeben werden.
 */

import { parseAddress, UNKNOWN_COUNTRY, type GeoTable } from './format';

const V4_BITS = 32n;
const V6_BITS = 64n;

/** Ein Bereich [start, end] als möglichst wenige CIDR-Netze. */
function rangeToCidrs(start: bigint, end: bigint, bits: bigint): { base: bigint; prefix: bigint }[] {
  const out: { base: bigint; prefix: bigint }[] = [];
  let current = start;
  while (current <= end) {
    // Größter Block, der bei `current` ausgerichtet beginnt …
    let size = bits;
    while (size > 0n && (current & ((1n << size) - 1n)) !== 0n) size--;
    // … und nicht über das Ende hinausreicht.
    while (size > 0n && current + (1n << size) - 1n > end) size--;
    out.push({ base: current, prefix: bits - size });
    current += 1n << size;
  }
  return out;
}

function formatV4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join('.');
}

/** Die oberen 64 Bit als Adresse. Die unteren sind null, also `::` am Ende. */
function formatV6(upper: bigint): string {
  const groups = [48n, 32n, 16n, 0n].map((shift) => ((upper >> shift) & 0xffffn).toString(16));
  return `${groups.join(':')}::`;
}

function networksOf(
  starts: ArrayLike<bigint | number>,
  codes: Uint8Array,
  index: number,
  bits: bigint,
  format: (value: bigint) => string
): string[] {
  const out: string[] = [];
  const max = (1n << bits) - 1n;
  let i = 0;
  while (i < codes.length) {
    if (codes[i] !== index) {
      i++;
      continue;
    }
    const start = BigInt(starts[i]);
    // Benachbarte Bereiche desselben Landes zusammenfassen: weniger Zeilen.
    let j = i + 1;
    while (j < codes.length && codes[j] === index) j++;
    const end = j < codes.length ? BigInt(starts[j]) - 1n : max;
    for (const cidr of rangeToCidrs(start, end, bits)) out.push(`${format(cidr.base)}/${cidr.prefix}`);
    i = j;
  }
  return out;
}

/** Alle Netze eines Landes, erst IPv4, dann IPv6. Leer, wenn die Tabelle das
 *  Land nicht kennt. */
export function countryNetworks(table: GeoTable, country: string): string[] {
  const index = table.countries.indexOf(country.toUpperCase());
  if (index === -1 || country.toUpperCase() === UNKNOWN_COUNTRY) return [];
  return [
    ...networksOf(table.starts4, table.codes4, index, V4_BITS, formatV4),
    ...networksOf(table.starts6, table.codes6, index, V6_BITS, formatV6),
  ];
}

/** Der Inhalt der Datei, die HAProxy für ein Land lädt. Die Kopfzeilen sind
 *  Kommentare, HAProxy überspringt sie. */
export function geoBlockFileContent(table: GeoTable, country: string): string {
  const networks = countryNetworks(table, country);
  return [
    `# ${country}: ${networks.length} Netze aus ${table.source} ${table.version}.`,
    '# Erzeugt von HAPM aus der GeoIP-Tabelle. Nicht von Hand ändern, HAPM schreibt die Datei neu.',
    ...networks,
    '',
  ].join('\n');
}

/** Die Länder, die die Tabelle kennt, ohne den Unbekannt-Eintrag. */
export function knownCountries(table: GeoTable): string[] {
  return table.countries.filter((code) => /^[A-Z]{2}$/.test(code) && code !== UNKNOWN_COUNTRY).sort();
}

/**
 * Ob eine Adresse in einer Adresse oder einem Netz liegt (`10.0.0.0/8`,
 * `2001:db8::/32`, `203.0.113.7`). Eine unlesbare Angabe trifft nie.
 */
export function addressInNetwork(address: string, network: string): boolean {
  const [base, length] = network.split('/');
  const ip = parseAddress(address);
  const net = parseAddress(base ?? '');
  if (!ip || !net || ip.family !== net.family) return false;
  const bits = ip.family === 4 ? 32 : 128;
  const prefix = length === undefined ? bits : Number(length);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const shift = BigInt(bits - prefix);
  return ip.key >> shift === net.key >> shift;
}
