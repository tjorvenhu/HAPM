/**
 * Die Handlungen des Protokolls in Worten, und zu welchem Bereich sie gehören.
 *
 * Rein: nur Tabellen. Die Seite „Protokoll" zeigt die Texte mit `t()`, der
 * Filter „Bereich" nimmt die Listen, und der Export schreibt den Bereich mit.
 * Im Protokoll selbst steht weiter der Name der Handlung (`login_failed`):
 * den lesen Programme, und er ändert sich nicht mit der Sprache.
 *
 * `Record<AuditAction, …>` ist der Wächter: eine neue Handlung in
 * `lib/audit.ts` ohne Zeile hier übersetzt nicht. `tests/audit-log/labels.test.ts`
 * liest dazu die Namen aus dem Quelltext und prüft, dass keiner fehlt und
 * keiner übrig ist.
 */

import { msgid } from '../i18n/translate';
import type { AuditAction } from '../audit';

export const AUDIT_AREAS = [
  'auth',
  'accounts',
  'proxy',
  'certificates',
  'dns',
  'crowdsec',
  'backup',
  'updates',
  'settings',
  'tokens',
  'audit',
] as const;

export type AuditArea = (typeof AUDIT_AREAS)[number];

export const AUDIT_AREA_LABELS: Record<AuditArea, string> = {
  auth: msgid('Anmeldung'),
  accounts: msgid('Konten'),
  proxy: msgid('Reverse-Proxy'),
  certificates: msgid('Zertifikate'),
  dns: msgid('DNS'),
  crowdsec: msgid('CrowdSec'),
  backup: msgid('Sicherung'),
  updates: msgid('Updates'),
  settings: msgid('Einstellungen'),
  tokens: msgid('API-Keys'),
  audit: msgid('Protokoll'),
};

interface ActionInfo {
  area: AuditArea;
  /** Schlüssel für `t()`. */
  label: string;
}

const info = (area: AuditArea, label: string): ActionInfo => ({ area, label });

export const AUDIT_ACTIONS: Record<AuditAction, ActionInfo> = {
  login: info('auth', msgid('Angemeldet')),
  login_failed: info('auth', msgid('Anmeldung gescheitert')),
  logout: info('auth', msgid('Abgemeldet')),
  '2fa_verified': info('auth', msgid('Zweiter Faktor bestätigt')),
  '2fa_failed': info('auth', msgid('Zweiter Faktor gescheitert')),
  '2fa_recovery_code_used': info('auth', msgid('Wiederherstellungscode benutzt')),
  password_reset_requested: info('auth', msgid('Neues Passwort angefordert')),
  password_reset_completed: info('auth', msgid('Passwort über Link neu gesetzt')),

  password_changed: info('accounts', msgid('Passwort geändert')),
  passkey_added: info('accounts', msgid('Passkey hinterlegt')),
  passkey_renamed: info('accounts', msgid('Passkey umbenannt')),
  passkey_removed: info('accounts', msgid('Passkey entfernt')),
  '2fa_setup': info('accounts', msgid('Zweiter Faktor eingerichtet')),
  '2fa_disabled': info('accounts', msgid('Zweiter Faktor abgeschaltet')),
  '2fa_recovery_codes_created': info('accounts', msgid('Wiederherstellungscodes erzeugt')),
  user_created: info('accounts', msgid('Benutzer angelegt')),
  user_deleted: info('accounts', msgid('Benutzer entfernt')),

  haproxy_service_created: info('proxy', msgid('Ziel angelegt')),
  haproxy_service_updated: info('proxy', msgid('Ziel geändert')),
  haproxy_service_failed: info('proxy', msgid('Vorgang am Ziel gescheitert')),
  haproxy_service_deleted: info('proxy', msgid('Ziel entfernt')),
  haproxy_service_delete_failed: info('proxy', msgid('Entfernen des Ziels gescheitert')),
  haproxy_settings_updated: info('proxy', msgid('Einstellungen des Reverse-Proxys geändert')),
  haproxy_settings_failed: info('proxy', msgid('Einstellungen des Reverse-Proxys gescheitert')),
  haproxy_stream_created: info('proxy', msgid('TCP-Weiterleitung angelegt')),
  haproxy_stream_updated: info('proxy', msgid('TCP-Weiterleitung geändert')),
  haproxy_stream_deleted: info('proxy', msgid('TCP-Weiterleitung entfernt')),
  haproxy_stream_failed: info('proxy', msgid('Vorgang an der TCP-Weiterleitung gescheitert')),
  haproxy_stream_delete_failed: info('proxy', msgid('Entfernen der TCP-Weiterleitung gescheitert')),
  haproxy_scope_created: info('proxy', msgid('Gruppe angelegt')),
  haproxy_scope_deleted: info('proxy', msgid('Gruppe entfernt')),
  haproxy_scope_failed: info('proxy', msgid('Vorgang an der Gruppe gescheitert')),
  haproxy_failure_acknowledged: info('proxy', msgid('Fehlgeschlagene Vorgänge als geprüft markiert')),
  haproxy_import_started: info('proxy', msgid('Import gestartet')),
  haproxy_import_completed: info('proxy', msgid('Import abgeschlossen')),
  haproxy_import_failed: info('proxy', msgid('Import gescheitert')),
  haproxy_error_pages_updated: info('proxy', msgid('Fehlerseiten geändert')),
  haproxy_error_pages_failed: info('proxy', msgid('Fehlerseiten gescheitert')),
  haproxy_base_config_updated: info('proxy', msgid('Grundkonfiguration geändert')),
  haproxy_base_config_failed: info('proxy', msgid('Grundkonfiguration gescheitert')),
  geoip_table_updated: info('proxy', msgid('Länder-Tabelle erneuert')),
  geoip_table_reset: info('proxy', msgid('Länder-Tabelle zurückgesetzt')),
  saved_target_created: info('proxy', msgid('Backend-Server hinterlegt')),
  saved_target_changed: info('proxy', msgid('Backend-Server geändert')),
  saved_target_deleted: info('proxy', msgid('Backend-Server entfernt')),

  haproxy_certificate_issued: info('certificates', msgid('Zertifikat ausgestellt')),
  haproxy_certificate_failed: info('certificates', msgid('Zertifikat gescheitert')),
  haproxy_certificate_uploaded: info('certificates', msgid('Zertifikat hochgeladen')),
  haproxy_certificate_removed: info('certificates', msgid('Zertifikat entfernt')),
  haproxy_dns_credentials_updated: info('certificates', msgid('DNS-Zugangsdaten für Zertifikate geändert')),

  dns_zone_created: info('dns', msgid('DNS-Zone angebunden')),
  dns_zone_updated: info('dns', msgid('DNS-Zone geändert')),
  dns_zone_deleted: info('dns', msgid('Anbindung der DNS-Zone entfernt')),
  dns_record_created: info('dns', msgid('DNS-Eintrag angelegt')),
  dns_record_updated: info('dns', msgid('DNS-Eintrag geändert')),

  crowdsec_decision_added: info('crowdsec', msgid('Adresse gesperrt')),
  crowdsec_decision_removed: info('crowdsec', msgid('Sperre aufgehoben')),
  crowdsec_allowlist_added: info('crowdsec', msgid('Adresse freigegeben')),
  crowdsec_allowlist_removed: info('crowdsec', msgid('Freigabe entfernt')),
  crowdsec_rules_updated: info('crowdsec', msgid('Regeln von CrowdSec geändert')),
  crowdsec_switched: info('crowdsec', msgid('CrowdSec ein- oder ausgeschaltet')),
  crowdsec_cleared: info('crowdsec', msgid('Ereignisse von CrowdSec geleert')),

  backup_settings_updated: info('backup', msgid('Einstellungen der Sicherung geändert')),
  backup_started: info('backup', msgid('Sicherung gestartet')),
  backup_completed: info('backup', msgid('Sicherung abgeschlossen')),
  backup_failed: info('backup', msgid('Sicherung gescheitert')),
  backup_restore_checked: info('backup', msgid('Archiv zum Zurückspielen geprüft')),
  backup_restore_discarded: info('backup', msgid('Archiv zum Zurückspielen verworfen')),
  backup_restore_started: info('backup', msgid('Zurückspielen gestartet')),
  backup_restore_completed: info('backup', msgid('Zurückspielen abgeschlossen')),
  backup_restore_failed: info('backup', msgid('Zurückspielen gescheitert')),

  update_started: info('updates', msgid('Update gestartet')),
  update_completed: info('updates', msgid('Update abgeschlossen')),
  update_failed: info('updates', msgid('Update gescheitert')),

  setup_completed: info('settings', msgid('Einrichtung abgeschlossen')),
  setup_updated: info('settings', msgid('Einrichtung: Schritt gespeichert')),
  setup_started: info('settings', msgid('Einrichtung: Ausführen gestartet')),
  setup_finished: info('settings', msgid('Einrichtung: Ausführen beendet')),
  setup_failed: info('settings', msgid('Einrichtung: Ausführen gescheitert')),
  address_move_started: info('settings', msgid('Umzug der Adresse gestartet')),
  address_move_finished: info('settings', msgid('Umzug der Adresse abgeschlossen')),
  address_move_failed: info('settings', msgid('Umzug der Adresse gescheitert')),
  settings_updated: info('settings', msgid('Einstellungen geändert')),
  branding_updated: info('settings', msgid('Darstellung geändert')),
  mail_test_sent: info('settings', msgid('Testmail verschickt')),
  mail_test_failed: info('settings', msgid('Testmail gescheitert')),

  service_token_created: info('tokens', msgid('API-Key angelegt')),
  service_token_revoked: info('tokens', msgid('API-Key zurückgezogen')),
  service_token_changed: info('tokens', msgid('API-Key geändert')),
  service_token_ip_rejected: info('tokens', msgid('API-Key von fremder Adresse abgewiesen')),
  service_token_area_rejected: info('tokens', msgid('API-Key außerhalb seines Bereichs abgewiesen')),

  audit_exported: info('audit', msgid('Protokoll exportiert')),
  audit_settings_updated: info('audit', msgid('Einstellungen des Protokolls geändert')),
  audit_forward_test_sent: info('audit', msgid('Testnachricht der Weiterleitung gesendet')),
  audit_forward_test_failed: info('audit', msgid('Testnachricht der Weiterleitung gescheitert')),
};

/** Die Handlungen eines Bereichs, für den Filter. */
export function actionsOfArea(area: AuditArea): AuditAction[] {
  return (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter((action) => AUDIT_ACTIONS[action].area === area);
}

export function isAuditArea(value: unknown): value is AuditArea {
  return typeof value === 'string' && (AUDIT_AREAS as readonly string[]).includes(value);
}

/** Der Bereich einer Handlung. Eine Handlung, die es nicht mehr gibt (alte Zeile), hat keinen. */
export function areaOf(action: string): AuditArea | null {
  return (AUDIT_ACTIONS as Record<string, ActionInfo | undefined>)[action]?.area ?? null;
}

/** Der Text einer Handlung als Schlüssel für `t()`, oder `null` für eine unbekannte. */
export function labelOf(action: string): string | null {
  return (AUDIT_ACTIONS as Record<string, ActionInfo | undefined>)[action]?.label ?? null;
}

/**
 * Ob eine Handlung ein Fehlschlag oder eine Abweisung ist. Daran hängen die
 * Farbe in der Tabelle und die Dringlichkeit einer Syslog-Nachricht.
 */
export function isFailure(action: string): boolean {
  return /(_failed|_rejected)$/.test(action);
}
