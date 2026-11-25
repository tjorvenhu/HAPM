'use client';

import type { CSSProperties } from 'react';
import { BarChart3, LayoutDashboard, Network, Plus, Search, ShieldCheck, X } from 'lucide-react';
import { Logo } from '@/ui/primitives/Logo';
import type { Brand } from '@/ui/primitives/brand';
import { accentVariables, deriveAccent, HAPM_ACCENT } from '@/lib/branding/color';
import { useT } from '@/lib/i18n/react';

interface Props {
  brand: Brand;
  /** `null`: das Grün von HAPM. */
  accent: string | null;
  /** Das Symbol im Tab, als Adresse. */
  favicon: string;
}

/**
 * Eine verkleinerte Oberfläche in den gewählten Farben: Tab, Seitenleiste mit
 * Logo und Pille, ein Inhalt mit Knöpfen, darunter das Logo auf dunkler
 * Fläche (die helle Fassung, wenn es eine gibt).
 *
 * Die Farben stehen als Variablen an der Bühne. `--primary` steht an der
 * Wurzel als `var(--accent)` und ist dort schon ausgerechnet: es muss hier
 * neu gesetzt werden, sonst blieben die Knöpfe in der Farbe der Seite.
 */
export default function BrandingPreview({ brand, accent, favicon }: Props) {
  const { t } = useT();
  const chosen = accent ?? HAPM_ACCENT;
  const palette = deriveAccent(chosen);
  const style = {
    ...accentVariables(chosen),
    '--primary': palette.accent,
    '--primary-hover': palette.hover,
  } as CSSProperties;
  const name = brand.name ?? 'HAPM';

  return (
    <div className="brand-stage" style={style} aria-hidden="true">
      <div className="brand-browser">
        <div className="brand-tab">
          {/* eslint-disable-next-line @next/next/no-img-element -- Daten-URL, `next/image` hätte daran nichts zu verkleinern. */}
          <img src={favicon} alt="" className="brand-tab__icon" />
          <span className="brand-tab__title">
            {t('Übersicht')} · {name}
          </span>
          <X size={12} strokeWidth={1.75} />
        </div>
        <div className="brand-browser__plus">
          <Plus size={12} strokeWidth={1.75} />
        </div>
      </div>

      <div className="brand-app">
        <div className="brand-app__sidebar">
          <div className="brand-app__logo">
            <Logo width={112} brand={brand} priority={false} />
          </div>
          <div className="brand-app__search">
            <Search size={12} strokeWidth={1.75} />
            {t('Suchen')}
          </div>
          <div className="brand-app__nav is-active">
            <LayoutDashboard size={13} strokeWidth={1.75} />
            {t('Übersicht')}
          </div>
          <div className="brand-app__nav">
            <Network size={13} strokeWidth={1.75} />
            {t('Ziele')}
          </div>
          <div className="brand-app__nav">
            <ShieldCheck size={13} strokeWidth={1.75} />
            {t('Zertifikate')}
          </div>
          <div className="brand-app__nav">
            <BarChart3 size={13} strokeWidth={1.75} />
            {t('Statistik')}
          </div>
        </div>

        <div className="brand-app__main">
          <div className="brand-app__title">{t('Übersicht')}</div>
          <div className="brand-app__card">
            <div className="brand-app__line" />
            <div className="brand-app__line brand-app__line--short" />
            <div className="brand-app__row">
              <span className="brand-app__btn">{t('Ziel anlegen')}</span>
              <span className="brand-app__btn brand-app__btn--secondary">{t('Abbrechen')}</span>
              <span className="brand-app__toggle" />
            </div>
            <span className="brand-app__link">{t('Zu den Zertifikaten')}</span>
          </div>
        </div>
      </div>

      <div className="brand-dark">
        <Logo width={112} background="dark" brand={brand} priority={false} />
        <span className="brand-dark__label">{t('Auf dunkler Fläche')}</span>
      </div>
    </div>
  );
}
