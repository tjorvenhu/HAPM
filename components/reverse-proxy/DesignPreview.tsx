'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Moon, Smartphone, Sun } from 'lucide-react';
import Select from '@/components/Select';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';
import { formatNumber } from '@/lib/i18n';
import { DESIGN_PAGES, designPageHtml, designPageLabel, designPageSizes } from '@/lib/haproxy/design-pages';
import { PAGE_MAX_BYTES, type PageDesign } from '@/lib/haproxy/page-design';

/**
 * Die Vorschau einer Fehlerseite oder der Passwortabfrage.
 *
 * ── Was hier zu sehen ist ──
 *
 * Das Dokument, das HAProxy ausliefern würde, Zeichen für Zeichen: dieselbe
 * Funktion, mit der die Route die Datei schreibt (`designPageHtml`), gerechnet
 * im Browser mit dem Entwurf aus dem Formular. Eine eigene Fassung für die
 * Vorschau gibt es nicht, also auch keine, die anders aussehen könnte als das
 * Ergebnis.
 *
 * ── Warum `iframe` mit `sandbox` ──
 *
 * Die Seite bringt ihr eigenes `<style>` mit und würde sonst die Oberfläche
 * umfärben. Das leere `sandbox` nimmt ihr außerdem alles, was sie hier nicht
 * braucht: Skripte (das `onclick` von „Zurück"), das Abschicken des Formulars,
 * den Zugriff auf die Sitzung. `srcDoc` und kein Verweis auf eine Route: der
 * Entwurf ist noch nirgends gespeichert, und die CSP der Oberfläche
 * (`next.config.ts`) erlaubt ein solches Dokument samt eingebettetem Logo
 * (`img-src data:`), ohne dass sie sich dafür ändern müsste.
 *
 * `inert`: ein Klick auf „Zur Startseite" lüde sonst HAPM in den Rahmen.
 *
 * Die Seite im Rahmen spricht die Sprache des Designs (`design.locale`), alles
 * drumherum die der Oberfläche.
 *
 * ── Hell und dunkel ──
 *
 * Die Seite von HAPM folgt `prefers-color-scheme` des Besuchers, eine eigene
 * Vorlage kann es auch. Im Rahmen gilt dafür das `color-scheme` des `iframe`
 * selbst, nicht das des Rechners, an dem jemand HAPM bedient: so zeigt der
 * Umschalter beide Fassungen, ohne das Dokument anzufassen.
 *
 * ── Warum verkleinert ──
 *
 * Die Fehlerseite hat unter 640 px eine eigene Anordnung. In einer Spalte von
 * 500 px sähe man immer nur die, also nie, was ein Besucher am Bildschirm
 * sieht. Der Rahmen bekommt deshalb die Maße eines Bildschirms und wird als
 * Ganzes auf die Breite der Spalte verkleinert.
 */

const VIEWPORTS = {
  wide: { width: 1280, height: 800 },
  narrow: { width: 390, height: 760 },
} as const;

type Viewport = keyof typeof VIEWPORTS;

type Scheme = 'light' | 'dark';

interface DesignPreviewProps {
  design: PageDesign;
  pageId: string;
  onPageChange: (id: string) => void;
}

export default function DesignPreview({ design, pageId, onPageChange }: DesignPreviewProps) {
  const { t, locale } = useT();
  const [viewport, setViewport] = useState<Viewport>('wide');
  const [scheme, setScheme] = useState<Scheme>('light');
  const [available, setAvailable] = useState(0);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const page = DESIGN_PAGES.find((entry) => entry.id === pageId) ?? DESIGN_PAGES[0];
  const html = useDeferredValue(useMemo(() => designPageHtml(page, design), [page, design]));
  const largest = useMemo(() => designPageSizes(design)[0], [design]);

  const { width, height } = VIEWPORTS[viewport];
  const scale = Math.min(1, available / width);
  const over = largest.bytes > PAGE_MAX_BYTES;

  return (
    <div className="card hapm-design-preview">
      <div className="hapm-design-bar">
        <Select
          value={page.id}
          onChange={onPageChange}
          options={DESIGN_PAGES.map((entry) => ({
            value: entry.id,
            label: designPageLabel(entry, t),
            hint: t(entry.hint),
          }))}
        />
        <div className="segmented" role="group" aria-label={t('Breite der Vorschau')}>
          <button
            type="button"
            className={viewport === 'wide' ? 'active' : ''}
            aria-pressed={viewport === 'wide'}
            onClick={() => setViewport('wide')}
          >
            <Monitor size={15} />
            {t('Bildschirm')}
          </button>
          <button
            type="button"
            className={viewport === 'narrow' ? 'active' : ''}
            aria-pressed={viewport === 'narrow'}
            onClick={() => setViewport('narrow')}
          >
            <Smartphone size={15} />
            {t('Handy')}
          </button>
        </div>
        <div className="segmented" role="group" aria-label={t('Farbschema des Besuchers')}>
          <button
            type="button"
            className={scheme === 'light' ? 'active' : ''}
            aria-pressed={scheme === 'light'}
            aria-label={t('Hell')}
            data-tooltip={t('Hell')}
            onClick={() => setScheme('light')}
          >
            <Sun size={15} />
          </button>
          <button
            type="button"
            className={scheme === 'dark' ? 'active' : ''}
            aria-pressed={scheme === 'dark'}
            aria-label={t('Dunkel')}
            data-tooltip={t('Dunkel')}
            onClick={() => setScheme('dark')}
          >
            <Moon size={15} />
          </button>
        </div>
      </div>

      <div className="hapm-design-stage" ref={stage} style={{ height: height * scale }}>
        <iframe
          className="hapm-design-frame"
          title={t('Vorschau: {page}', { page: designPageLabel(page, t) })}
          sandbox=""
          inert
          srcDoc={html}
          style={{
            width,
            height,
            colorScheme: scheme,
            transform: `scale(${scale})`,
            marginLeft: Math.max(0, (available - width * scale) / 2),
          }}
        />
      </div>

      <div className="form-group">
        <div className="form-label-row">
          <span className="form-label">
            {t('Größte Seite: {bytes} von {max} Bytes', {
              bytes: formatNumber(locale, largest.bytes),
              max: formatNumber(locale, PAGE_MAX_BYTES),
            })}
          </span>
          <InfoHint
            position="left"
            text={t(
              'HAProxy hält jede dieser Seiten samt Logo in einem Puffer von {buffer} Bytes. Eine größere Fehlerdatei lehnt es beim Laden ab, eine größere Passwortabfrage beantwortet es mit dem Fehler 500. HAPM speichert deshalb kein Design, bei dem eine Seite über {max} Bytes kommt.',
              { buffer: formatNumber(locale, 16_384), max: formatNumber(locale, PAGE_MAX_BYTES) }
            )}
          />
        </div>
        <div className={`hapm-meter${over ? ' is-over' : ''}`}>
          <i style={{ width: `${Math.min(100, (largest.bytes / PAGE_MAX_BYTES) * 100)}%` }} />
        </div>
        <span className="form-hint">{t('Am größten ist „{page}“.', { page: designPageLabel(largest.page, t) })}</span>
      </div>
    </div>
  );
}
