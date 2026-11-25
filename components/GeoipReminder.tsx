'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Globe } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useT } from '@/lib/i18n/react';
import { formatDate } from '@/lib/i18n/format';
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

export default function GeoipReminder() {
  const { t, plural, rich, locale } = useT();
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

  const failedAt = status.lastAttemptAt ? formatDate(locale, status.lastAttemptAt) : null;

  return (
    <div className="alert alert-warning sys-block">
      <Globe size={16} style={{ flexShrink: 0 }} />
      <span>
        {status.origin === 'none' ? (
          <>
            <strong>{t('Keine Länder-Tabelle vorhanden.')}</strong> {t('Die Statistik zeigt deshalb keine Länder.')}
          </>
        ) : (
          <>
            <strong>{t('Die Länder-Tabelle ist veraltet.')}</strong>{' '}
            {status.ageDays === null
              ? status.version
                ? t('Stand {version}, ihr Alter ist unbekannt.', { version: status.version })
                : t('Ihr Alter ist unbekannt.')
              : status.version
                ? t('Stand {version}, {age}.', {
                    version: status.version,
                    age: plural(status.ageDays, { one: '{count} Tag alt', other: '{count} Tage alt' }),
                  })
                : plural(status.ageDays, { one: '{count} Tag alt.', other: '{count} Tage alt.' })}
          </>
        )}{' '}
        {status.lastAttemptError && (
          <>
            {failedAt
              ? t('Der letzte Abruf von db-ip.com am {date} ist gescheitert:', { date: failedAt })
              : t('Der letzte Abruf von db-ip.com ist gescheitert:')}{' '}
            {t(status.lastAttemptError)}{' '}
          </>
        )}
        {!status.autoRefresh && <>{t('Das selbsttätige Erneuern ist abgeschaltet.')} </>}
        {rich('Unter {link} lässt sich die Tabelle holen oder hochladen.', {
          link: <Link href="/reverse-proxy/einstellungen?bereich=laender">{t('Einstellungen')}</Link>,
        })}
      </span>
    </div>
  );
}
