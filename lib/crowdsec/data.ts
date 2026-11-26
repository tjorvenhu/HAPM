/**
 * Was `cscli … -o json` liefert, in der Form, die Seite, API und MCP zeigen.
 *
 * Rein und ohne Importe außer Typen: die Ausgabe von `cscli` ändert sich
 * zwischen Fassungen, und jede Abweichung soll sich an einem festgehaltenen
 * Beispiel prüfen lassen (`tests/crowdsec/data.test.ts`), ohne dass CrowdSec
 * läuft. Fehlt ein Feld, steht `null` da und nicht eine Vermutung.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- die Ausgabe von cscli ist untypisiert */

export type AlertKind = 'waf' | 'scenario' | 'manual' | 'other';

export interface CrowdsecAlert {
  id: number;
  createdAt: string | null;
  scenario: string;
  kind: AlertKind;
  message: string;
  /** Adresse oder Bereich, von dem es ausging. */
  source: string;
  sourceScope: string;
  country: string | null;
  asName: string | null;
  /** Bei einem WAF-Treffer die Domain der Anfrage (`target_fqdn`). */
  targetHost: string | null;
  /** Bei einem Szenario aus dem Log von HAProxy das Backend (`target_backend`). */
  targetBackend: string | null;
  /** Die Pfade, um die es ging (höchstens fünf). */
  paths: string[];
  method: string | null;
  eventsCount: number;
  /** Wie viele Sperren daraus entstanden sind. */
  decisions: number;
  simulated: boolean;
}

export interface CrowdsecDecision {
  id: number;
  alertId: number | null;
  value: string;
  scope: string;
  type: string;
  origin: string;
  /** Der Grund: Szenario oder der Text, mit dem jemand von Hand gesperrt hat. */
  reason: string;
  /** Wann die Sperre endet, aus der Restdauer gerechnet. */
  until: string | null;
  createdAt: string | null;
  country: string | null;
  asName: string | null;
  simulated: boolean;
}

export interface AllowlistEntry {
  value: string;
  description: string;
  createdAt: string | null;
  /** `null`: gilt, bis jemand sie entfernt. */
  expiresAt: string | null;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const strOrNull = (value: unknown): string | null => {
  const text = str(value).trim();
  return text === '' ? null : text;
};

/** Die Zeitangaben von CrowdSec, als ISO-Zeit. `2026-11-26 07:25:07 +0000 UTC` kommt auch vor. */
export function isoTime(value: unknown): string | null {
  const text = str(value).trim();
  if (!text || text.startsWith('0001-01-01')) return null;
  const go = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? \+0000 UTC$/.exec(text);
  const parsed = Date.parse(go ? `${go[1]}T${go[2]}Z` : text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Eine Dauer, wie Go sie schreibt (`3h59m57.5s`, `-1m`), in Millisekunden. */
export function goDurationMs(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const re = /(-?\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g;
  let total = 0;
  let consumed = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const n = Number(match[1]);
    const factor: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, µs: 0.001, ns: 0.000001 };
    total += n * factor[match[2]];
    consumed += match[0].length;
  }
  return consumed === text.length ? total : null;
}

/** Die Metadaten eines Ereignisses oder Alarms als Liste von Werten je Schlüssel.
 *  In den Alarmen steht der Wert als JSON-Liste im Text (`["/a","/b"]`). */
function metaValues(meta: unknown, key: string): string[] {
  if (!Array.isArray(meta)) return [];
  const values: string[] = [];
  for (const entry of meta as any[]) {
    if (entry?.key !== key) continue;
    const raw = str(entry.value);
    if (raw.startsWith('[')) {
      try {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          values.push(...list.map(str).filter(Boolean));
          continue;
        }
      } catch {
        // Kein JSON: der Text selbst ist der Wert.
      }
    }
    if (raw) values.push(raw);
  }
  return values;
}

function firstMeta(alert: any, key: string): string | null {
  const own = metaValues(alert?.meta, key);
  if (own.length > 0) return own[0];
  for (const event of Array.isArray(alert?.events) ? alert.events : []) {
    const found = metaValues(event?.meta, key);
    if (found.length > 0) return found[0];
  }
  return null;
}

function allMeta(alert: any, keys: string[]): string[] {
  const seen = new Set<string>();
  for (const key of keys) {
    for (const value of metaValues(alert?.meta, key)) seen.add(value);
    for (const event of Array.isArray(alert?.events) ? alert.events : []) {
      for (const value of metaValues(event?.meta, key)) seen.add(value);
    }
  }
  return [...seen];
}

function alertKind(alert: any): AlertKind {
  const kind = str(alert?.kind);
  if (kind === 'waf') return 'waf';
  if (kind === 'cscli' || kind === 'manual') return 'manual';
  if (kind === 'crowdsec' || str(alert?.scenario).includes('/')) return 'scenario';
  return 'other';
}

export function parseAlerts(json: unknown): CrowdsecAlert[] {
  if (!Array.isArray(json)) return [];
  return (json as any[])
    .filter((alert) => alert && typeof alert === 'object')
    .map((alert) => {
      const source = alert.source ?? {};
      return {
        id: Number(alert.id ?? 0),
        createdAt: isoTime(alert.created_at ?? alert.start_at),
        scenario: str(alert.scenario),
        kind: alertKind(alert),
        message: str(alert.message),
        source: str(source.value ?? source.ip ?? source.range),
        sourceScope: str(source.scope) || 'Ip',
        country: strOrNull(source.cn),
        asName: strOrNull(source.as_name),
        targetHost: (firstMeta(alert, 'target_fqdn') ?? firstMeta(alert, 'target_host'))?.toLowerCase() ?? null,
        targetBackend: firstMeta(alert, 'target_backend'),
        paths: allMeta(alert, ['target_uri', 'uri', 'http_path']).slice(0, 5),
        method: firstMeta(alert, 'method') ?? firstMeta(alert, 'http_verb'),
        eventsCount: Number(alert.events_count ?? 0),
        decisions: Array.isArray(alert.decisions) ? alert.decisions.length : 0,
        simulated: alert.simulated === true,
      };
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id - a.id);
}

/**
 * Die Sperren. `cscli decisions list -o json` liefert Alarme mit ihren
 * Entscheidungen darin; eine Zeile je Entscheidung.
 */
export function parseDecisions(json: unknown, now: number): CrowdsecDecision[] {
  if (!Array.isArray(json)) return [];
  const rows: CrowdsecDecision[] = [];
  for (const alert of json as any[]) {
    const source = alert?.source ?? {};
    for (const decision of Array.isArray(alert?.decisions) ? alert.decisions : []) {
      const left = goDurationMs(str(decision.duration));
      rows.push({
        id: Number(decision.id ?? 0),
        alertId: alert?.id == null ? null : Number(alert.id),
        value: str(decision.value),
        scope: str(decision.scope) || 'Ip',
        type: str(decision.type) || 'ban',
        origin: str(decision.origin),
        reason: str(decision.scenario) || str(alert?.scenario),
        until: left === null ? null : new Date(now + Math.max(0, left)).toISOString(),
        createdAt: isoTime(alert?.created_at),
        country: strOrNull(source.cn),
        asName: strOrNull(source.as_name),
        simulated: decision.simulated === true,
      });
    }
  }
  return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id - a.id);
}

export function parseAllowlist(json: unknown): AllowlistEntry[] {
  const items = (json as any)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item: any) => ({
      value: str(item?.value),
      description: str(item?.description),
      createdAt: isoTime(item?.created_at),
      expiresAt: isoTime(item?.expiration),
    }))
    .filter((item) => item.value !== '');
}

/** Ein Ziel, so weit es für die Zuordnung zählt: seine Domains und Backends. */
export interface AlertTarget {
  id: string;
  domains: string[];
  /** Die Backends des Ziels: das eigene und die der Pfad-Regeln. */
  backends: string[];
}

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

/** Zu welchem Ziel ein Alarm gehört: über die Domain (WAF) oder das Backend (Log). */
export function alertTargetId(alert: CrowdsecAlert, targets: readonly AlertTarget[]): string | null {
  if (alert.targetBackend) {
    const hit = targets.find((target) => target.backends.includes(alert.targetBackend!));
    if (hit) return hit.id;
  }
  if (alert.targetHost) {
    // Eine exakte Domain schlägt eine Wildcard, wie bei HAProxy.
    const exact = targets.find((target) => target.domains.some((d) => !d.startsWith('*.') && hostMatches(d, alert.targetHost!)));
    if (exact) return exact.id;
    const wildcard = targets.find((target) => target.domains.some((d) => hostMatches(d, alert.targetHost!)));
    if (wildcard) return wildcard.id;
  }
  return null;
}

/* ── Statistik ── */

export interface CountRow {
  key: string;
  count: number;
}

export interface CrowdsecStats {
  from: string;
  to: string;
  /** Je Stunde (oder Tag bei langen Zeiträumen): Beginn und Zahl je Art. */
  series: { at: string; waf: number; scenario: number; manual: number }[];
  bucketMs: number;
  totals: { alerts: number; waf: number; scenario: number; manual: number; sources: number };
  scenarios: CountRow[];
  countries: CountRow[];
  sources: CountRow[];
  targets: CountRow[];
  paths: CountRow[];
}

function top(map: Map<string, number>, limit: number): CountRow[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function bump(map: Map<string, number>, key: string | null, by = 1): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Die Statistik aus den Alarmen eines Zeitraums. Ein WAF-Treffer ist eine
 * abgewiesene Anfrage, ein Szenario eine erkannte Adresse (mit Sperre), ein
 * Eintrag von Hand eine Sperre aus HAPM oder `cscli`.
 */
export function crowdsecStats(
  alerts: readonly CrowdsecAlert[],
  targets: readonly AlertTarget[],
  from: number,
  to: number
): CrowdsecStats {
  const span = to - from;
  const bucketMs = span > 3 * 24 * 3_600_000 ? 24 * 3_600_000 : 3_600_000;
  const start = Math.floor(from / bucketMs) * bucketMs;
  const buckets = Math.max(1, Math.ceil((to - start) / bucketMs));
  const series = Array.from({ length: buckets }, (_, i) => ({
    at: new Date(start + i * bucketMs).toISOString(),
    waf: 0,
    scenario: 0,
    manual: 0,
  }));

  const scenarios = new Map<string, number>();
  const countries = new Map<string, number>();
  const sources = new Map<string, number>();
  const byTarget = new Map<string, number>();
  const paths = new Map<string, number>();
  const totals = { alerts: 0, waf: 0, scenario: 0, manual: 0, sources: 0 };

  for (const alert of alerts) {
    const at = alert.createdAt ? Date.parse(alert.createdAt) : NaN;
    if (Number.isNaN(at) || at < from || at > to) continue;
    totals.alerts++;
    const bucket = series[Math.min(buckets - 1, Math.floor((at - start) / bucketMs))];
    if (alert.kind === 'waf') {
      totals.waf++;
      bucket.waf++;
    } else if (alert.kind === 'manual') {
      totals.manual++;
      bucket.manual++;
    } else {
      totals.scenario++;
      bucket.scenario++;
    }
    bump(scenarios, alert.scenario || null);
    bump(countries, alert.country);
    bump(sources, alert.source || null);
    bump(byTarget, alertTargetId(alert, targets));
    for (const path of alert.paths.slice(0, 1)) bump(paths, path);
  }
  totals.sources = sources.size;

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    series,
    bucketMs,
    totals,
    scenarios: top(scenarios, 10),
    countries: top(countries, 10),
    sources: top(sources, 10),
    targets: top(byTarget, 10),
    paths: top(paths, 10),
  };
}

/* ── Eingaben ── */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-fA-F:]{2,39}$/;

function validIpv4(text: string): boolean {
  const match = IPV4.exec(text);
  return !!match && match.slice(1).every((part) => Number(part) <= 255);
}

/** Acht Gruppen aus höchstens vier Hex-Ziffern, `::` höchstens einmal für eine
 *  oder mehrere Nullgruppen. Ohne `node:net`: das Formular prüft im Browser
 *  mit derselben Funktion. */
function validIpv6(text: string): boolean {
  if (!IPV6.test(text) || !text.includes(':')) return false;
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = halves.map((half) => (half === '' ? [] : half.split(':')));
  if (groups.some((list) => list.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group)))) return false;
  const count = groups.reduce((sum, list) => sum + list.length, 0);
  return halves.length === 2 ? count <= 7 : count === 8;
}

/** Eine Adresse oder ein Netz in CIDR-Schreibweise. Rein, damit Formular und Route dasselbe prüfen. */
export function parseAddress(value: string): { value: string; scope: 'ip' | 'range' } | null {
  const text = value.trim();
  const [address, prefix, extra] = text.split('/');
  if (extra !== undefined || !address) return null;
  const v4 = validIpv4(address);
  const v6 = !v4 && validIpv6(address);
  if (!v4 && !v6) return null;
  if (prefix === undefined) return { value: text, scope: 'ip' };
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const bits = Number(prefix);
  if (bits > (v4 ? 32 : 128)) return null;
  return { value: text, scope: 'range' };
}

/** Dauern für eine Sperre von Hand, wie `cscli` sie annimmt. */
export const BAN_DURATIONS = ['1h', '4h', '24h', '168h', '720h', '8760h'] as const;
export type BanDuration = (typeof BAN_DURATIONS)[number];

/** Wie lange eine Freigabe gelten soll. `null`: unbefristet. */
export const ALLOW_DURATIONS = ['24h', '168h', '720h'] as const;
export type AllowDuration = (typeof ALLOW_DURATIONS)[number];

/** Ein Grund oder eine Beschreibung: druckbar, ohne Zeilenumbruch, nicht zu lang. */
export function cleanNote(value: unknown, max = 120): string {
  return str(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

/** Woran man eine Sperre von Hand erkennt (`cscli decisions add`, `import`). */
const MANUAL_ORIGINS = new Set(['cscli', 'cscli-import']);

export function isManualBan(decision: Pick<CrowdsecDecision, 'origin'>): boolean {
  return MANUAL_ORIGINS.has(decision.origin);
}

export interface BanToRestore {
  value: string;
  scope: 'ip' | 'range';
  /** Die Restdauer in ganzen Sekunden, wie `cscli --duration` sie annimmt (`3600s`). */
  duration: string;
  reason: string;
}

/**
 * Die Sperren von Hand, die das Leeren der Ereignisse überstehen sollen.
 * `cscli alerts delete` nimmt die Sperre mit ihrem Ereignis weg, deshalb setzt
 * HAPM sie danach mit der Restdauer neu. Je Adresse die längste, Abgelaufenes
 * und was keine Adresse ist, fällt weg.
 */
export function bansToRestore(decisions: readonly CrowdsecDecision[], now: number): BanToRestore[] {
  const byValue = new Map<string, { left: number; ban: BanToRestore }>();
  for (const decision of decisions) {
    if (!isManualBan(decision) || decision.type !== 'ban' || decision.simulated || !decision.until) continue;
    const address = parseAddress(decision.value);
    if (!address) continue;
    const left = Math.floor((Date.parse(decision.until) - now) / 1000);
    if (!(left >= 60)) continue;
    const known = byValue.get(address.value);
    if (known && known.left >= left) continue;
    byValue.set(address.value, {
      left,
      ban: { ...address, duration: `${left}s`, reason: cleanNote(decision.reason) || 'Gesperrt in HAPM' },
    });
  }
  return [...byValue.values()].map((entry) => entry.ban);
}
