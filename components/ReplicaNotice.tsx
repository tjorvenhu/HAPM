'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { msgid } from '@/lib/i18n/translate';
import { useT } from '@/lib/i18n/react';

/**
 * Die Seiten, deren Inhalt auf einem Folgeknoten vom Hauptknoten kommt, mit
 * dem Satz, der dort steht. Es gilt der längste passende Eintrag. `null`:
 * darunter liest man nur, was dieser Knoten selbst mitschreibt.
 */
const SYNCED_PAGES: { prefix: string; text: string | null }[] = [
  { prefix: '/dashboard', text: msgid('Ziele, Zertifikate und Einstellungen des Proxys kommen vom Hauptknoten und werden dort geändert.') },
  { prefix: '/reverse-proxy', text: msgid('Ziele, Zertifikate und Einstellungen des Proxys kommen vom Hauptknoten und werden dort geändert.') },
  { prefix: '/reverse-proxy/statistiken', text: null },
  { prefix: '/reverse-proxy/logs', text: null },
  {
    prefix: '/reverse-proxy/crowdsec',
    text: msgid('Sperren von Hand, Freigaben und Regeln kommen vom Hauptknoten. Was CrowdSec hier selbst sperrt, lässt sich hier aufheben.'),
  },
  { prefix: '/reverse-proxy/api', text: msgid('API-Keys kommen vom Hauptknoten und werden dort angelegt und zurückgezogen.') },
  { prefix: '/dns', text: msgid('DNS-Zonen und ihre Zugänge kommen vom Hauptknoten und werden dort geändert.') },
  { prefix: '/users', text: msgid('Konten kommen vom Hauptknoten und werden dort angelegt und entfernt.') },
  { prefix: '/konto', text: msgid('Passwort, zweiter Faktor und Passkeys kommen vom Hauptknoten und werden dort geändert.') },
  { prefix: '/system', text: msgid('Diese Einstellungen kommen vom Hauptknoten und werden dort geändert.') },
  { prefix: '/system/darstellung', text: null },
  {
    prefix: '/notifications',
    text: msgid('SMTP-Konto, Empfänger und Ereignisse kommen vom Hauptknoten und werden dort geändert.'),
  },
];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function replicaNoticeFor(pathname: string): string | null {
  let best: (typeof SYNCED_PAGES)[number] | null = null;
  for (const page of SYNCED_PAGES) {
    if (under(pathname, page.prefix) && (!best || page.prefix.length > best.prefix.length)) best = page;
  }
  return best?.text ?? null;
}

/**
 * Der Hinweis auf einem Folgeknoten, über jeder Seite, auf der sich sonst etwas
 * ändern ließe, das der Abgleich überträgt.
 *
 * Er steht im Rahmen und nicht in jeder Seite einzeln: die Knöpfe bleiben, wo
 * sie sind, und die Absage kommt vom Server (`lib/sync/role.ts`). Ohne den
 * Hinweis davor sähe das aus wie ein Fehler. Nicht wegklickbar: er gilt, solange
 * die Rolle gilt.
 */
export default function ReplicaNotice() {
  const { session } = useApp();
  const pathname = usePathname();
  const { t } = useT();

  if (session.features?.replica !== true) return null;
  const text = replicaNoticeFor(pathname);
  if (!text) return null;

  return (
    <div className="alert alert-info sys-block hapm-flag">
      <ArrowLeftRight size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>{t('Dieser Knoten ist ein Folgeknoten')}</strong>
        <span>{t(text)}</span>
      </div>
      <div className="hapm-flag-actions">
        <Link className="btn btn-secondary btn-sm" href="/abgleich">
          {t('Abgleich')}
          <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
    </div>
  );
}
