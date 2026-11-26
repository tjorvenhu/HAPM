import { createDocument } from './db';
import { COLLECTIONS } from './types';

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'setup_completed'
  | 'setup_updated'
  | 'setup_started'
  | 'setup_finished'
  | 'setup_failed'
  | 'address_move_started'
  | 'address_move_finished'
  | 'address_move_failed'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'passkey_added'
  | 'passkey_renamed'
  | 'passkey_removed'
  | '2fa_setup'
  | '2fa_verified'
  | '2fa_failed'
  | '2fa_disabled'
  | '2fa_recovery_codes_created'
  | '2fa_recovery_code_used'
  | 'user_created'
  | 'user_deleted'
  | 'haproxy_service_created'
  | 'haproxy_service_updated'
  | 'haproxy_service_failed'
  | 'haproxy_service_deleted'
  | 'haproxy_service_delete_failed'
  | 'haproxy_settings_updated'
  | 'haproxy_settings_failed'
  | 'haproxy_stream_created'
  | 'haproxy_stream_updated'
  | 'haproxy_stream_deleted'
  | 'haproxy_stream_failed'
  | 'haproxy_stream_delete_failed'
  | 'haproxy_scope_created'
  | 'haproxy_scope_deleted'
  | 'haproxy_scope_failed'
  | 'haproxy_failure_acknowledged'
  | 'haproxy_dns_credentials_updated'
  | 'haproxy_certificate_issued'
  | 'haproxy_certificate_failed'
  | 'haproxy_certificate_uploaded'
  | 'haproxy_certificate_removed'
  | 'haproxy_import_started'
  | 'haproxy_import_completed'
  | 'haproxy_import_failed'
  | 'haproxy_error_pages_updated'
  | 'haproxy_error_pages_failed'
  | 'haproxy_base_config_updated'
  | 'haproxy_base_config_failed'
  | 'geoip_table_updated'
  | 'geoip_table_reset'
  | 'dns_zone_created'
  | 'dns_zone_updated'
  | 'dns_zone_deleted'
  | 'dns_record_created'
  | 'dns_record_updated'
  | 'service_token_created'
  | 'service_token_revoked'
  | 'saved_target_created'
  | 'saved_target_changed'
  | 'saved_target_deleted'
  | 'service_token_changed'
  | 'service_token_ip_rejected'
  | 'service_token_area_rejected'
  | 'update_started'
  | 'update_completed'
  | 'update_failed'
  | 'backup_settings_updated'
  | 'backup_started'
  | 'backup_completed'
  | 'backup_failed'
  | 'backup_restore_checked'
  | 'backup_restore_discarded'
  | 'backup_restore_started'
  | 'backup_restore_completed'
  | 'backup_restore_failed'
  | 'settings_updated'
  | 'branding_updated'
  | 'mail_test_sent'
  | 'mail_test_failed'
  | 'crowdsec_decision_added'
  | 'crowdsec_decision_removed'
  | 'crowdsec_allowlist_added'
  | 'crowdsec_allowlist_removed'
  | 'crowdsec_rules_updated'
  | 'crowdsec_switched'
  | 'crowdsec_cleared';

interface AuditParams {
  userId: string;
  userEmail: string;
  action: AuditAction;
  resource?: string;
  resourceId?: string;
  details?: string;
  ip?: string;
}

/** Schreibt eine Zeile ins Protokoll. Scheitert nie nach außen. */
export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await createDocument(COLLECTIONS.AUDIT_LOGS, {
      userId: params.userId,
      userEmail: params.userEmail,
      action: params.action,
      resource: params.resource || null,
      resourceId: params.resourceId || null,
      details: params.details?.substring(0, 2000) || null,
      ip: params.ip || null,
      timestamp: new Date().toISOString(),
    });
  } catch {
    console.error(`[audit] Eintrag nicht geschrieben: ${params.action} von ${params.userEmail}`);
  }
}

export function systemActor() {
  return { userId: 'system', userEmail: 'scheduler' };
}

export function serviceActor(service: { id: string; name: string }) {
  return { userId: `service:${service.id}`, userEmail: service.name };
}

/** Gesetzt von `bin/remote-addr.mjs`: die Gegenstelle des Sockets, nicht fälschbar. */
const REMOTE_ADDR_HEADER = 'x-hapm-remote-addr';

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

/**
 * Die Adresse des Aufrufers.
 *
 * Zwei Wege führen zu HAPM. Direkt über seinen Port: dann ist die Gegenstelle
 * des Sockets der Aufrufer, und `X-Forwarded-For` ist eine Behauptung von ihm,
 * die nicht zählt. Oder über das eigene HAProxy: dann kommt die Anfrage von
 * 127.0.0.1, und der letzte Eintrag in `X-Forwarded-For` ist der, den HAProxy
 * selbst gesehen hat (`option forwardfor` hängt ihn hinten an).
 *
 * `X-Real-IP` wird nicht gelesen: niemand auf dem Weg setzt es, also käme es
 * immer vom Aufrufer.
 *
 * Ohne den Vorlader (`pnpm dev`) fehlt die Gegenstelle. Dann bleibt nur die
 * Kopfzeile, und ohne sie `unknown`.
 */
export function getClientIP(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const parts = forwarded ? forwarded.split(',').map((p) => p.trim()).filter(Boolean) : [];
  const viaProxy = parts.length > 0 ? parts[parts.length - 1] : null;

  const socket = request.headers.get(REMOTE_ADDR_HEADER)?.trim().replace(/^::ffff:/, '') ?? '';
  if (socket) return isLoopback(socket) ? (viaProxy ?? socket) : socket;

  return viaProxy ?? 'unknown';
}
