/**
 * Das SMTP-Konto aus den Einstellungen, als das, was der Versand braucht.
 *
 * Rein: keine Datenbank, kein Netz, kein nodemailer. Das Entschlüsseln des
 * Passworts kommt als Funktion herein, damit sich alles hier ohne Schlüssel
 * prüfen lässt (`tests/mail/config.test.ts`).
 */

import { validateEmail } from '../validation';
import type { Settings, SmtpSecurity } from '../types';

export const SMTP_SECURITIES: SmtpSecurity[] = ['starttls', 'tls', 'none'];
export const DEFAULT_SMTP_PORT = 587;

/** Der Name, unter dem die Mails im Postfach stehen, wenn der Absender keinen eigenen trägt. */
export const MAIL_SENDER_NAME = 'HAPM';

export type MailSettings = Pick<
  Settings,
  'smtpHost' | 'smtpPort' | 'smtpSecurity' | 'smtpUser' | 'smtpPass' | 'mailFrom'
>;

/** Ein Fehler, dessen Text für den Menschen an der Oberfläche geschrieben ist. */
export class MailError extends Error {
  /**
   * `rejected`: der Server hat diese eine Mail abgelehnt, die nächste kann
   * durchgehen. `unavailable`: es liegt am Konto oder an der Verbindung, ein
   * zweiter Versuch gleich danach scheitert genauso.
   */
  constructor(message: string, readonly reason: 'rejected' | 'unavailable' = 'unavailable') {
    super(message);
    this.name = 'MailError';
  }
}

export interface Sender {
  name: string | null;
  address: string;
}

/** `hapm@example.org` oder `Name <hapm@example.org>`. Alles andere ist `null`. */
export function parseSender(value: string): Sender | null {
  const raw = value.trim();
  // Ein Zeilenumbruch im Absender wäre eine zweite Kopfzeile.
  if (!raw || /[\r\n]/.test(raw)) return null;

  const named = /^(.*?)\s*<([^<>\s]+)>$/.exec(raw);
  if (named) {
    const name = named[1].replace(/^"|"$/g, '').replace(/["\\]/g, '').trim();
    return validateEmail(named[2]) ? { name: name || null, address: named[2] } : null;
  }
  return validateEmail(raw) ? { name: null, address: raw } : null;
}

/** `fallback` gilt, wenn der Absender keinen Namen nennt: der Name aus der Darstellung oder HAPM. */
export function formatSender(sender: Sender, fallback: string = MAIL_SENDER_NAME): string {
  return `"${(sender.name ?? fallback).replace(/["\\\r\n]/g, '')}" <${sender.address}>`;
}

/** Eingerichtet heißt: es gibt einen Server und einen Absender. */
export function isMailConfigured(settings: Pick<Settings, 'smtpHost' | 'mailFrom'>): boolean {
  return Boolean(settings.smtpHost?.trim() && settings.mailFrom && parseSender(settings.mailFrom));
}

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  pass: string | null;
  from: string;
}

/** Wirft `MailError`, wenn mit den Einstellungen nichts zu verschicken ist. */
export function smtpConfig(
  settings: MailSettings,
  decryptPass: (ciphertext: string) => string,
  senderName?: string | null
): SmtpConfig {
  const host = settings.smtpHost?.trim();
  const sender = settings.mailFrom ? parseSender(settings.mailFrom) : null;
  if (!host || !sender) {
    throw new MailError(
      'Es ist kein SMTP-Konto eingerichtet. Server und Absender stehen unter „Benachrichtigungen“.'
    );
  }

  let pass: string | null = null;
  if (settings.smtpPass) {
    try {
      pass = decryptPass(settings.smtpPass);
    } catch {
      throw new MailError(
        'Das gespeicherte SMTP-Passwort lässt sich nicht entschlüsseln. Bitte unter „Benachrichtigungen“ neu eintragen.'
      );
    }
  }

  return {
    host,
    port: settings.smtpPort || DEFAULT_SMTP_PORT,
    security: SMTP_SECURITIES.includes(settings.smtpSecurity) ? settings.smtpSecurity : 'starttls',
    user: settings.smtpUser?.trim() || null,
    pass,
    from: formatSender(sender, senderName || MAIL_SENDER_NAME),
  };
}

/** Wie lange der Versand auf den Server wartet. Ohne Grenzen hinge ein Lauf an einem stummen Server. */
export const SMTP_TIMEOUTS = {
  dnsTimeout: 10_000,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
} as const;

export function transportOptions(config: SmtpConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
    ...SMTP_TIMEOUTS,
  };
}

interface SmtpFailure {
  code?: string;
  response?: string;
  message?: string;
}

/**
 * Was nodemailer wirft, als Satz für die Oberfläche. Die Antwort des Servers
 * steht wörtlich dahinter: an ihr erkennt man, was er verlangt.
 */
export function smtpError(err: unknown, config: Pick<SmtpConfig, 'host' | 'port' | 'pass'>): MailError {
  const code = typeof err === 'object' && err !== null ? ((err as SmtpFailure).code ?? '') : '';
  // Ohne Kennung kam die Ablehnung aus dem Gespräch mit dem Server (eine Antwort mit 4xx oder 5xx).
  const perMessage = code === 'EENVELOPE' || code === 'EMESSAGE' || code === '';
  return new MailError(describeSmtpError(err, config), perMessage ? 'rejected' : 'unavailable');
}

export function describeSmtpError(err: unknown, config: Pick<SmtpConfig, 'host' | 'port' | 'pass'>): string {
  const failure = (typeof err === 'object' && err !== null ? err : { message: String(err) }) as SmtpFailure;
  const where = `${config.host}:${config.port}`;
  const code = failure.code ?? '';

  let summary: string;
  if (code === 'EAUTH') summary = 'Der Mailserver hat die Anmeldung abgelehnt.';
  else if (code === 'EDNS' || code === 'ENOTFOUND') summary = `Der Name ${config.host} lässt sich nicht auflösen.`;
  else if (code === 'ETIMEDOUT' || code === 'ETIMEOUT') {
    summary = `Der Mailserver ${where} hat nicht rechtzeitig geantwortet.`;
  } else if (code === 'ECONNECTION' || code === 'ECONNREFUSED' || code === 'ESOCKET') {
    summary = `Keine Verbindung zu ${where}. Port und Verschlüsselung müssen zusammenpassen.`;
  } else if (code === 'ETLS') summary = `Die verschlüsselte Verbindung zu ${where} kam nicht zustande.`;
  else if (code === 'EENVELOPE') summary = 'Der Mailserver hat Absender oder Empfänger abgelehnt.';
  else summary = 'Der Mailserver hat die Mail nicht angenommen.';

  let detail = (failure.response || failure.message || '').trim();
  if (config.pass) detail = detail.split(config.pass).join('***');
  return detail ? `${summary} Meldung: ${detail.slice(0, 500)}` : summary;
}
