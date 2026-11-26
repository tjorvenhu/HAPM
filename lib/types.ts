export interface DbDoc {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
}

/* ── Sitzung ── */
export interface SessionData {
  userId: string;
  email: string;
  name: string;
  /** `false` nur, solange ein eingerichteter zweiter Faktor noch nicht gezeigt wurde. */
  twoFactorVerified: boolean;
  /** Der zweite Faktor ist freiwillig: immer `false`. Das Feld bleibt, weil
   *  `ToolShell` (`ui/tool/ToolShell.tsx`) es in der Sitzung erwartet. */
  twoFactorSetupRequired: boolean;
  csrfToken: string;
  /** Die gewählte Sprache der Oberfläche, `null` ohne Wahl. Nur in `/api/auth/me`. */
  locale?: 'de' | 'en' | null;
  /** Was diese Installation mitbringt. Nur in `/api/auth/me`. */
  /** `crowdsec`: da und eingeschaltet. `crowdsecPresent`: da, auch wenn abgeschaltet. */
  features?: { crowdsec: boolean; crowdsecPresent?: boolean };
}

/* ── Konten ──
 *
 * Konten, Passwörter, Sitzungen und Passkeys gehören dem Anmeldedienst
 * (`lib/auth`) und liegen in dessen Tabellen (`auth_*`, siehe `lib/db/auth-tables.ts`). Hier steht nur,
 * was HAPM daneben je Konto hält.
 */

/** Der zweite Faktor (TOTP) eines Kontos. Freiwillig, also oft gar keine Zeile. */
export interface TwoFactorConfig extends DbDoc {
  userId: string;
  /** Verschlüsselt (`lib/crypto.ts`). */
  secret: string;
  /** `false`, solange die Einrichtung begonnen, der erste Code aber noch nicht gezeigt ist. */
  enabled: boolean;
  /**
   * Die noch nicht benutzten Wiederherstellungscodes, als HMAC (`lib/recovery-codes.ts`).
   * Fehlt bei Konten, deren zweiter Faktor vor den Codes eingerichtet wurde.
   */
  recoveryCodes?: string[];
  /** Wann die gültigen Codes erzeugt wurden (ISO). */
  recoveryCodesCreatedAt?: string | null;
  /**
   * Der Zeitschritt des zuletzt angenommenen Codes aus der App. Ein Code, der
   * nicht neuer ist, gilt nicht noch einmal (`consumeTOTPCode`).
   */
  lastTotpStep?: number | null;
}

/** Eine Zeile je Konto, Kennung ist die des Kontos. */
export interface UserState extends DbDoc {
  lastLoginAt: string | null;
  /** Die Sprache der Oberfläche. Fehlt sie, gilt der Browser (`lib/i18n/locale.ts`). */
  locale?: 'de' | 'en' | null;
  /** Wann das Fenster „Konto absichern“ weggeklickt wurde. Danach kommt es nicht wieder. */
  securityPromptDismissedAt?: string | null;
}

/* ── Die Maschine ──
 *
 * HAPM verwaltet genau ein HAProxy: das im selben Compose-Stack. `lib/haproxy/`
 * ist für mehrere Proxy-Maschinen geschrieben und reicht überall eine
 * `serverId` durch. Sie bleibt als Feld erhalten (Historie, Metriken) und trägt
 * immer `LOCAL_SERVER_ID`.
 */
export interface Server {
  $id: string;
  name: string;
  host: string;
  roleReverseProxy: boolean;
}

/* ── Läufe ── */
export type RunStatus = 'running' | 'success' | 'warning' | 'error' | 'cancelled';

export type HaproxyAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'settings'
  | 'scope-add'
  | 'scope-remove'
  | 'stream-create'
  | 'stream-update'
  | 'stream-delete'
  /** Ein Zertifikat ohne Ziel, etwa die Wildcard aus der Einrichtung. */
  | 'certificate'
  /** Mehrere Einträge aus einer fremden Konfiguration (`import-run.ts`). */
  | 'import';

export type HaproxyPhase =
  /** Wartet am Lock des Proxys, bis der Vorgang davor fertig ist. */
  | 'queued'
  | 'dns'
  | 'preflight'
  | 'certificate'
  | 'checking'
  | 'installing'
  | 'cleanup'
  | 'done';

export interface HaproxyStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface HaproxyRun extends DbDoc {
  serverId: string;
  serverName: string;
  action: HaproxyAction;
  serviceId: string;
  renamedTo: string | null;
  domains: string | null;
  targets: string | null;
  status: RunStatus;
  phase: HaproxyPhase | null;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  steps: string | null;
  error: string | null;
  triggeredBy: string | null;
  triggeredByTokenId: string | null;
  acknowledged: boolean | null;
}

export interface AuditLog extends DbDoc {
  userId: string;
  userEmail: string;
  action: string;
  resource: string | null;
  resourceId: string | null;
  details: string | null;
  ip: string | null;
  timestamp: string;
}

export interface GeoipTable extends DbDoc {
  version: string;
  source: string;
  builtAt: string;
  uploadedAt: string;
  uploadedBy: string | null;
  countryCount: number;
  v4Count: number;
  v6Count: number;
  payload: string;
  /** Von db-ip.com geholt und nicht von Hand hochgeladen. */
  fetched?: boolean;
  /** Jeden Monat selbsttätig erneuern. Fehlt das Feld, gilt: an. */
  autoRefresh?: boolean;
  lastAttemptAt?: string | null;
  lastAttemptError?: string | null;
}

export interface HaproxyMetric extends DbDoc {
  serverId: string;
  scope: string;
  kind: 'frontend' | 'backend';
  collectedAt: string;
  requests: number | null;
  http2xx: number | null;
  http3xx: number | null;
  http4xx: number | null;
  http5xx: number | null;
  httpOther: number | null;
  denied: number | null;
  errors: number | null;
  retries: number | null;
  bytesInKb: number | null;
  bytesOutKb: number | null;
  responseMs: number | null;
  totalMs: number | null;
  queueMs: number | null;
  sessionsCurrent: number | null;
  sessionsMax: number | null;
}

export type DnsZoneStatus = 'ok' | 'error';

export interface DnsZone extends DbDoc {
  /**
   * Fehlt an Zeilen aus der Zeit, in der es nur Cloudflare gab. Gelesen wird
   * deshalb über `providerOf` (`lib/dns/zones.ts`), nie über das Feld.
   */
  provider?: 'cloudflare' | 'hetzner';
  name: string;
  /** Die Kennung der Zone beim Anbieter. */
  zoneId: string;
  apiToken: string;
  status: DnsZoneStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
}

/** Ein gespeichertes Ziel, siehe `lib/haproxy/saved-targets.ts`. */
export interface SavedTargetDoc extends DbDoc {
  name: string;
  host: string;
  port: number | null;
}

export interface ServiceToken extends DbDoc {
  name: string;
  tokenHash: string;
  prefix: string;
  description: string | null;
  createdBy: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  scopes: string | null;
  areas: string | null;
  allowedIps: string | null;
}

/* ── Einstellungen (eine Zeile, Kennung SETTINGS_ID) ── */
export interface Settings extends DbDoc {
  /** Kontaktadresse, mit der acme.sh das Konto bei Let's Encrypt anmeldet. */
  acmeEmail: string | null;
  /**
   * Die Adresse, unter der HAPM von außen erreichbar ist: `https://hapm.example.org`,
   * ohne Schrägstrich am Ende. `null`, solange keine eingerichtet ist. An ihr
   * hängen Links in Mails und die Domain, an die Passkeys gebunden werden.
   */
  publicUrl: string | null;
  /** Abgeleitet: ob `autoUpdate` HAProxy enthält. Bleibt für Aufrufer der API
   *  von vor der Auswahl je Bestandteil. */
  autoUpdateHaproxy: boolean;
  /** Was HAPM zur Uhrzeit `autoUpdateTime` selbst aktualisiert, je Bestandteil. */
  autoUpdate: UpdateComponent[];
  /** Uhrzeit (HH:MM, Ortszeit des Containers) für selbsttätige Updates. */
  autoUpdateTime: string;
  /** SMTP-Konto für alle Mails von HAPM. Ohne Host und Absender wird nichts verschickt. */
  smtpHost: string | null;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUser: string | null;
  /** Verschlüsselt (`lib/crypto.ts`). Verlässt den Server nie, die Route nennt nur `smtpPassSet`. */
  smtpPass: string | null;
  /** Absender: `hapm@example.org` oder `Name <hapm@example.org>`. */
  mailFrom: string | null;
  /** Wer die Benachrichtigungen bekommt. Leer heißt: es wird keine verschickt. */
  notifyRecipients: string[];
  /** Je Ereignis ein Schalter. Ein Ereignis, das hier fehlt, gilt als eingeschaltet. */
  notifyEvents: Record<NotificationEventType, boolean>;
  /**
   * Die Sprache aller Mails von HAPM. Eine für alle: eine Benachrichtigung geht
   * an mehrere Empfänger. Fehlt sie (Zeile von vor der Einstellung), Deutsch.
   */
  mailLocale: 'de' | 'en';
  /**
   * Ob Let's Encrypt diesen Server erreicht. `internal`: nein, jedes Zertifikat
   * geht über DNS-01. `public`: HTTP-01, DNS-01 nur für Wildcards.
   */
  exposure: Exposure;
  /**
   * Woher Zertifikate kommen. `acme`: HAPM beantragt sie über acme.sh.
   * `upload`: HAPM beantragt nie selbst, ein Ziel braucht ein hochgeladenes
   * (oder schon vorhandenes) Zertifikat.
   */
  certificateSource: CertificateSource;
  /**
   * Die Directory-URL eines eigenen ACME-Servers, etwa einer CA im eigenen
   * Netz. `null`: Let's Encrypt, oder was `HAPM_ACME_SERVER` nennt. Gilt für
   * künftige Anträge, acme.sh merkt sich den Server je Zertifikat.
   */
  acmeDirectory: string | null;
  /**
   * Ob der eigene ACME-Server HAPM über Port 80 erreicht. Dann gilt HTTP-01
   * auch in einer internen Installation (`lib/haproxy/challenge.ts`). Ohne
   * eigenen Server bedeutungslos.
   */
  acmeHttpReachable: boolean;
  /**
   * Der Stand der Einrichtung nach dem ersten Konto. `null` steht in jeder
   * Zeile, die es vor dem Assistenten gab: mit Konto gilt sie als abgeschlossen.
   */
  setupStatus: SetupStatus | null;
}

export type Exposure = 'internal' | 'public';

export type CertificateSource = 'acme' | 'upload';

/** `skipped`: ausdrücklich nicht zu Ende geführt, die Übersicht erinnert nicht mehr. */
export type SetupStatus = 'open' | 'done' | 'skipped';

/* ── Der Assistent der Einrichtung (eine Zeile, Kennung SETUP_ID) ──
 *
 * Was der Benutzer im Assistenten gewählt hat und wie weit das Ausführen kam.
 * Ein Token steht hier nie: er geht durch nach `account.conf`.
 */
export type SetupStageKey = 'dns' | 'scope' | 'certificate' | 'access' | 'service' | 'crowdsec' | 'publicUrl';
export type SetupStageStatus = 'pending' | 'running' | 'ok' | 'error';

export interface SetupStage {
  key: SetupStageKey;
  status: SetupStageStatus;
  detail: string | null;
  /** Der Lauf in `haproxy_runs`, falls der Schritt einer war. */
  runId: string | null;
}

export interface SetupExecution {
  startedAt: string;
  /** `true`, solange der Prozess daran arbeitet. Nach einem Neustart steht es noch da, siehe `settleExecution`. */
  running: boolean;
  stages: SetupStage[];
}

/* ── Umzug der Oberfläche auf eine neue Adresse (`lib/address-move/`) ── */

export type AddressMoveStageKey = 'certificate' | 'service' | 'publicUrl' | 'cleanup';

export interface AddressMoveStage {
  key: AddressMoveStageKey;
  status: SetupStageStatus;
  detail: string | null;
  runId: string | null;
}

export interface AddressMoveState extends DbDoc {
  /** Die neue Domain, ohne Schema. */
  domain: string;
  /** Die Adresse davor, wie sie in den Einstellungen stand. `null`: es gab keine. */
  previousUrl: string | null;
  startedAt: string;
  /** `true`, solange der Prozess daran arbeitet. Nach einem Neustart steht es noch da. */
  running: boolean;
  stages: AddressMoveStage[];
}

export interface SetupState extends DbDoc {
  /** `null`, solange im Assistenten nichts gewählt wurde. */
  exposure: Exposure | null;
  /**
   * `manual`: eigener DNS-Server, HAPM legt bei keinem Anbieter etwas an und
   * nennt stattdessen die Einträge. `skipped` steht in Zeilen von vor dieser
   * Wahl und heißt dasselbe, nur für eine öffentliche Installation.
   */
  dns: 'pending' | 'configured' | 'skipped' | 'manual';
  /** Der acme.sh-Hook des gewählten Anbieters. */
  dnsHook: string | null;
  /**
   * Ob die Frage nach den Zertifikaten beantwortet ist. Was gewählt wurde,
   * steht in den Einstellungen (`certificateSource`, `acmeDirectory`,
   * `acmeHttpReachable`): die Wahl gilt sofort, wie die Erreichbarkeit.
   */
  certificates: 'pending' | 'set';
  /**
   * Ob der Schritt zum SMTP-Konto beantwortet ist. Das Konto selbst steht in
   * den Einstellungen (`smtpHost` usw.), wie unter „Benachrichtigungen".
   * Fehlt das Feld (Zeile von vor diesem Schritt), siehe `mailAnswerOf`.
   */
  mail: 'pending' | 'set' | 'skipped';
  address: 'pending' | 'set' | 'skipped';
  domain: string | null;
  wildcard: boolean;
  /** Die Basis der Wildcard: `example.org` für `*.example.org`. */
  wildcardBase: string | null;
  /**
   * Ob CrowdSec am Ende für alle Ziele eingeschaltet wird. Der Assistent
   * schlägt es bei einer Installation aus dem Internet vor. `null` oder
   * fehlend: nicht gefragt (intern, ohne CrowdSec im Stack, ältere Zeile).
   */
  crowdsec?: boolean | null;
  /**
   * Von welchen Adressen und Netzen die Oberfläche unter ihrer Domain
   * aufrufbar sein soll. Leer oder fehlend: von überall. Das Ausführen trägt
   * sie in die Admin-IPs ein und sperrt das Ziel der Oberfläche darauf.
   */
  surfaceIps?: string[];
  execution: SetupExecution | null;
  /**
   * Das Token des gewählten DNS-Anbieters, verschlüsselt, und nur solange die
   * Einrichtung offen ist. Zwischen Schritt 3 (Token) und Schritt 4 (Domain)
   * muss es irgendwo liegen: erst mit der Domain steht fest, welche Zone unter
   * „DNS" eingerichtet und wo der Eintrag gesetzt wird. Geht nie an den Browser
   * (`getSetupState` liest das Feld nicht) und wird mit dem Ende der
   * Einrichtung gelöscht.
   */
  dnsAccess?: { hook: string; token: string } | null;
}

export const SETUP_ID = 'main';

export const SETTINGS_ID = 'main';

/** `starttls`: Klartext beginnen und auf TLS heben (587). `tls`: von Anfang an TLS (465). */
export type SmtpSecurity = 'starttls' | 'tls' | 'none';

/* ── Benachrichtigungen ── */
export const NOTIFICATION_EVENT_TYPES = [
  'certificate_renewal_failed',
  'certificate_expiring',
  'backend_down',
  'backend_recovered',
  'haproxy_down',
  'run_failed',
  'update_available',
  'update_completed',
  'update_failed',
  'backup_failed',
  'crowdsec_down',
  'crowdsec_report',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * Was zu einem Ereignis und einer Sache zuletzt verschickt wurde. Die Kennung
 * der Zeile ist aus beidem abgeleitet, gesucht wird nie über ein Feld.
 */
export interface NotificationState extends DbDoc {
  type: NotificationEventType;
  /** Die Sache: ein Dienst, ein Bestandteil, eine Fassung. */
  subject: string;
  lastSentAt: string;
  /** Nur bei Zuständen mit Entwarnung: seit wann der gemeldete Zustand vorbei ist. */
  resolvedAt: string | null;
}

/** Der letzte Versuch, eine Mail zu verschicken. Eine Zeile, Kennung `NOTIFICATION_DELIVERY_ID`. */
export interface NotificationDelivery extends DbDoc {
  at: string;
  ok: boolean;
  /** `test` ist die Testmail von der Seite „Benachrichtigungen". */
  kind: NotificationEventType | 'test';
  mailSubject: string;
  /** An wie viele Adressen die Mail ging. */
  delivered: number;
  /** Wie viele Empfänger es waren. */
  recipients: number;
  error: string | null;
}

export const NOTIFICATION_DELIVERY_ID = 'last_delivery';

/* ── Updates ──
 *
 * Was die letzte Prüfung über die Abbilder und acme.sh ergeben hat. Eine Zeile
 * je Bestandteil, Kennung ist der Name (`haproxy`, `hapm`, `acme`).
 */
export type UpdateComponent = 'haproxy' | 'hapm' | 'acme' | 'crowdsec' | 'crowdsec-bouncer';

export interface UpdateState extends DbDoc {
  component: UpdateComponent;
  /** Was läuft: Abbild samt Tag, bei acme.sh der Name. */
  reference: string | null;
  currentVersion: string | null;
  currentDigest: string | null;
  latestVersion: string | null;
  latestDigest: string | null;
  /** `null` heißt unbekannt (Registry nicht erreichbar), nicht „aktuell". */
  updateAvailable: boolean | null;
  checkedAt: string | null;
  error: string | null;
}

export interface UpdateRun extends DbDoc {
  component: UpdateComponent;
  status: RunStatus;
  fromVersion: string | null;
  /** Kennung des Abbilds vor dem Update. Daran zeigt sich, ob ein neuer Container läuft. */
  fromImage: string | null;
  toVersion: string | null;
  startedAt: string;
  completedAt: string | null;
  steps: string | null;
  error: string | null;
  triggeredBy: string | null;
}

export const COLLECTIONS = {
  TWO_FACTOR: 'two_factor',
  USER_STATE: 'user_state',
  SETTINGS: 'settings',
  AUDIT_LOGS: 'audit_logs',
  HAPROXY_RUNS: 'haproxy_runs',
  HAPROXY_METRICS: 'haproxy_metrics',
  GEOIP_TABLE: 'geoip_table',
  PAGE_DESIGN: 'page_design',
  DNS_ZONES: 'dns_zones',
  SERVICE_TOKENS: 'service_tokens',
  UPDATE_STATE: 'update_state',
  UPDATE_RUNS: 'update_runs',
  NOTIFICATION_STATE: 'notification_state',
  BACKUP_SETTINGS: 'backup_settings',
  BACKUP_RUNS: 'backup_runs',
  RESTORE_RUNS: 'restore_runs',
  SETUP_STATE: 'setup_state',
  SAVED_TARGETS: 'saved_targets',
  BRANDING: 'branding',
  PAGE_FILES: 'page_files',
  ADDRESS_MOVE: 'address_move',
} as const;
