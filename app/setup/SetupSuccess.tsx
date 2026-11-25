'use client';

import type { CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, ExternalLink } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import { useT } from '@/lib/i18n/react';
import { SETUP_SCOPE, STAGE_LABELS } from '@/lib/setup/rules';
import type { SetupView } from '@/lib/setup';

/**
 * Das Ende der Einrichtung: eine Kachel mit Haken, die erledigten Schritte in
 * einer Liste, der Weg zur neuen Adresse.
 *
 * Eigene Überschrift statt der von `AuthCard`: die Kachel steht über ihr, und
 * `AuthCard` setzt den Titel vor alles, was hineinkommt.
 */

/** Die Striche um die Kachel: Winkel und Abstand je Strich, links drei, rechts drei. */
const RAYS = [
  { angle: -60, delay: 0 },
  { angle: -34, delay: 50 },
  { angle: -10, delay: 100 },
  { angle: 150, delay: 30 },
  { angle: 170, delay: 80 },
  { angle: 192, delay: 130 },
];

export function SetupSuccess({ setup }: { setup: SetupView }) {
  const { t } = useT();
  const domain = setup.domain ?? '';
  const url = `https://${domain}`;
  const stages = setup.execution?.stages ?? [];

  return (
    <AuthCard standalone className="hapm-setup is-done" title="">
      <div className="hapm-done-head">
        <div className="hapm-done-mark" aria-hidden="true">
          {RAYS.map((ray, index) => (
            <i
              key={index}
              style={{ '--ray-angle': `${ray.angle}deg`, '--ray-delay': `${ray.delay}ms` } as CSSProperties}
            />
          ))}
          <span className="hapm-done-tile">
            <svg viewBox="0 0 48 48">
              <path d="M13 25.5 L21 33 L36 16" pathLength={1} />
            </svg>
          </span>
        </div>
        <h1 className="auth-title">{t('HAPM ist eingerichtet')}</h1>
        <p className="auth-subtitle">{t('Unter der neuen Adresse melden Sie sich einmal neu an.')}</p>
      </div>

      <ul className="hapm-done-steps">
        {stages.map((stage, index) => (
          <li key={stage.key} style={{ '--i': index } as CSSProperties}>
            <span className="hapm-done-check">
              <Check size={13} strokeWidth={3} />
            </span>
            {t(STAGE_LABELS[stage.key], { scope: SETUP_SCOPE })}
          </li>
        ))}
      </ul>

      <div className="hapm-done-actions">
        <a className="auth-submit hapm-done-open" href={url}>
          <ExternalLink size={16} />
          <span>{t('HAPM unter {url} öffnen', { url })}</span>
          <ArrowRight size={16} className="hapm-done-arrow" />
        </a>
        {setup.exposure === 'internal' && (
          <p className="auth-hint">
            {t('Öffnet sich die Adresse nicht, fehlt der Eintrag für {domain} im DNS-Server Ihres Netzes.', { domain })}
          </p>
        )}
        <p className="auth-footer">
          <Link href="/dashboard">{t('Weiter mit der bisherigen Adresse')}</Link>
        </p>
      </div>
    </AuthCard>
  );
}
