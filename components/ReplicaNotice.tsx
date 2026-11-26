'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useT } from '@/lib/i18n/react';

/** Die Seiten, deren Inhalt auf einem Folgeknoten vom Hauptknoten kommt. */
const SYNCED_PAGES = ['/dashboard', '/reverse-proxy'];
/** Darunter wird nur gelesen, was dieser Knoten selbst mitschreibt. */
const OWN_PAGES = ['/reverse-proxy/statistiken', '/reverse-proxy/logs', '/reverse-proxy/api'];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Der Hinweis auf einem Folgeknoten, über jeder Seite, auf der sich sonst etwas
 * am Proxy ändern ließe.
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
  if (!SYNCED_PAGES.some((page) => under(pathname, page)) || OWN_PAGES.some((page) => under(pathname, page))) return null;

  return (
    <div className="alert alert-info sys-block hapm-flag">
      <ArrowLeftRight size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>{t('Dieser Knoten ist ein Folgeknoten')}</strong>
        <span>{t('Ziele, Zertifikate und Einstellungen des Proxys kommen vom Hauptknoten und werden dort geändert.')}</span>
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
