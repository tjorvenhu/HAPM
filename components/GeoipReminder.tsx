'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Globe } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import type { GeoipOverview } from '@/lib/geoip/fetch';

/**
 * Der Hinweis über dem Dashboard, dass die Länder-Tabelle alt ist und sich
 * nicht von selbst erneuert.
 *
 * ── Warum das überhaupt jemand sehen muss ──
 *
 * Die Tabelle, aus der die Reverse-Proxy-Statistik ihre Länder macht, altert,
 * ohne dass irgendetwas kaputt geht: Adressbereiche werden neu vergeben, und
 * die Zuordnung wird still falsch. Ein falsches Land ist die unangenehme Sorte
 * Fehler — es sieht aus wie eine Auskunft und ist keine.
 *
 * ── Warum „alt" allein nicht mehr reicht ──
 *
 * HAPM holt sich die Tabelle jeden Monat selbst (`lib/geoip/fetch.ts`). Eine
 * alte Tabelle ist damit kein Normalzustand mehr, an den erinnert werden muss,
 * sondern die Folge von etwas: das Holen ist abgeschaltet, oder es scheitert.
 * Nur dann steht der Hinweis, und er nennt den Grund. Eine alte Tabelle kurz
 * nach dem Start, bevor der erste Abruf lief, ist kein Anlass.
 *
 * ── Warum er auf dem Dashboard steht und nicht auf der Statistik-Seite ──
 *
 * Weil man ihn dort erst sähe, wenn man die Zahlen schon liest — also zu spät,
 * um ihnen nicht zu glauben. Das Dashboard ist die Seite, die täglich offen
 * ist.
 *
 * ── Warum er verschwindet und nicht wegklickbar ist ──
 *
 * Er hört auf, wenn die Tabelle wieder frisch ist, und nur dann. Wegklickbar
 * wäre er ein Hinweis, den man einmal wegdrückt und danach nie wieder sieht.
 */

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { dateStyle: 'medium' });
}

export default function GeoipReminder() {
  const { apiFetch } = useApp();
  const [status, setStatus] = useState<GeoipOverview | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch('/api/geoip')
      .then((res) => res.json())
      .then((data) => {
        if (live && data.success) setStatus(data.data as GeoipOverview);
      })
      // Still: dieser Hinweis ist eine Beigabe. Ein Fehler beim Laden darf
      // nicht als Fläche über dem Dashboard stehen.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [apiFetch]);

  if (!status?.stale) return null;
  if (status.autoRefresh && !status.lastAttemptError) return null;

  return (
    <div className="alert alert-warning sys-block">
      <Globe size={16} style={{ flexShrink: 0 }} />
      <span>
        {status.origin === 'none' ? (
          <>
            <strong>Keine Länder-Tabelle vorhanden.</strong> Die Statistik zeigt deshalb keine
            Länder.
          </>
        ) : (
          <>
            <strong>Die Länder-Tabelle ist veraltet.</strong>{' '}
            {status.version ? `Stand ${status.version}, ` : ''}
            {status.ageDays === null ? 'ihr Alter ist unbekannt' : `${status.ageDays} Tage alt`}.
          </>
        )}{' '}
        {status.lastAttemptError && (
          <>
            Der letzte Abruf von db-ip.com
            {status.lastAttemptAt ? ` am ${formatDay(status.lastAttemptAt)}` : ''} ist gescheitert:{' '}
            {status.lastAttemptError}{' '}
          </>
        )}
        {!status.autoRefresh && <>Das selbsttätige Erneuern ist abgeschaltet. </>}
        Unter <Link href="/reverse-proxy/einstellungen">Einstellungen</Link> lässt sich die Tabelle
        holen oder hochladen.
      </span>
    </div>
  );
}
