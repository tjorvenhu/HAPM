'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Image as ImageIcon,
  Loader2,
  Palette,
  RotateCcw,
  Save,
  Tag,
  Trash2,
  Type,
  Upload,
  Undo2,
} from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import type { Brand } from '@/ui/primitives/brand';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { SkeletonDetail } from '@/components/Skeleton';
import ColorField from '@/components/reverse-proxy/ColorField';
import BrandingPreview from '@/components/system/BrandingPreview';
import {
  BRANDING_IMAGE_MAX_BYTES,
  BRANDING_IMAGE_SLOTS,
  BRANDING_IMAGE_TYPES,
  BRANDING_LIMITS,
  checkImageBytes,
  faviconSvg,
  parseAccent,
  parseName,
  parsePill,
  type BrandingImageSlot,
  type BrandingView,
} from '@/lib/branding/branding';
import { deriveAccent, HAPM_ACCENT, isHexColor, MIN_CONTRAST } from '@/lib/branding/color';
import { createTranslator, formatNumber, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/** Vorschläge für die Akzentfarbe. Jeder trägt weiße Schrift mit mindestens 4,5:1. */
const SUGGESTIONS: { color: string; label: string }[] = [
  { color: HAPM_ACCENT, label: msgid('Grün von HAPM') },
  { color: '#0e7490', label: msgid('Petrol') },
  { color: '#1d4ed8', label: msgid('Blau') },
  { color: '#4338ca', label: msgid('Indigo') },
  { color: '#7c3aed', label: msgid('Violett') },
  { color: '#be123c', label: msgid('Rot') },
  { color: '#c2410c', label: msgid('Orange') },
  { color: '#374151', label: msgid('Graphit') },
];

const SLOT_TEXT: Record<BrandingImageSlot, { title: string; hint: string; empty: string }> = {
  logo: {
    title: msgid('Logo'),
    hint: msgid('In der Seitenleiste, bei der Anmeldung, im Einrichtungsassistenten, in Mails und auf den Seiten von HAProxy. Am besten ein PNG mit durchsichtigem Grund, quer, etwa 4:1: Gmail und Outlook zeigen in Mails kein SVG. Auf den Seiten von HAProxy steht es nur, wenn die ganze Seite samt Logo unter 15.000 Bytes bleibt, sonst steht dort der Name.'),
    empty: msgid('Logo von HAPM'),
  },
  logoDark: {
    title: msgid('Helle Fassung'),
    hint: msgid('Für dunkle Flächen, etwa ein Logo in Weiß: Mails in dunklem Design und Fehlerseiten im dunklen Modus. Ohne eigene Fassung steht dort das Logo selbst.'),
    empty: msgid('Wie das Logo'),
  },
  icon: {
    title: msgid('Symbol im Tab'),
    hint: msgid('Quadratisch, etwa 64 × 64 Pixel oder ein SVG. Ohne Symbol zeigt der Tab mit Namen dessen Anfangsbuchstaben auf der Akzentfarbe, sonst das Zeichen von HAPM in der Akzentfarbe.'),
    empty: msgid('Erzeugt'),
  },
};

/** Was die Route nach dem Speichern über die Seiten von HAProxy sagt. */
interface PagesResult {
  written: number;
  skipped: number;
  error: { label: string; detail: string } | null;
}

type ImageState =
  | { kind: 'saved'; url: string; mime: string; bytes: number }
  | { kind: 'new'; mime: string; data: string; bytes: number }
  | null;

interface Draft {
  name: string;
  pillText: string;
  pillEnabled: boolean;
  /** Wie getippt. Gilt erst, wenn es eine Farbe ist. */
  accent: string | null;
  images: Record<BrandingImageSlot, ImageState>;
}

function fromView(view: BrandingView): Draft {
  return {
    name: view.name ?? '',
    pillText: view.pill.text,
    pillEnabled: view.pill.enabled,
    accent: view.accent,
    images: Object.fromEntries(
      BRANDING_IMAGE_SLOTS.map((slot) => {
        const image = view.images[slot];
        return [slot, image ? { kind: 'saved', ...image } : null];
      })
    ) as Draft['images'],
  };
}

function imageSrc(image: ImageState): string | null {
  if (!image) return null;
  return image.kind === 'saved' ? image.url : `data:${image.mime};base64,${image.data}`;
}

/** Die Farbe, die gerade gilt: eine gültige Eingabe, sonst das Grün von HAPM (`null`). */
function effectiveAccent(value: string | null): string | null {
  return value !== null && isHexColor(value) ? value.toLowerCase() : null;
}

function readAsBytes(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export default function AppearancePage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const { t, plural, locale } = useT();
  const number = (value: number, digits = 0) => formatNumber(locale, value, digits);

  const [saved, setSaved] = useState<BrandingView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInputs = useRef<Partial<Record<BrandingImageSlot, HTMLInputElement | null>>>({});

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/branding', { cache: 'no-store' });
      const body = await res.json();
      if (!body.success) throw new Error(body.error);
      setSaved(body.data as BrandingView);
      setDraft(fromView(body.data as BrandingView));
      setError('');
    } catch {
      setError(t('Die Darstellung konnte nicht geladen werden.'));
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const checks = useMemo(() => {
    if (!draft) return null;
    const { t: tr } = createTranslator(locale);
    const name = parseName(draft.name, tr);
    const pill = parsePill({ text: draft.pillText, enabled: draft.pillEnabled }, tr);
    // Eine halb getippte Farbe meldet `ColorField` selbst, sie sperrt nur das Speichern.
    const accent = draft.accent !== null && !isHexColor(draft.accent) ? { error: '-' } : parseAccent(draft.accent, tr);
    return {
      name: 'error' in name ? name.error : '',
      pill: 'error' in pill ? pill.error : '',
      accent: 'error' in accent ? accent.error : '',
    };
  }, [draft, locale]);

  const dirty = useMemo(() => (saved && draft ? JSON.stringify(fromView(saved)) !== JSON.stringify(draft) : false), [saved, draft]);
  const valid = checks !== null && !checks.name && !checks.pill && !checks.accent;

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">{t('Darstellung')}</h1>
        <p className="page-subtitle">
          {t('Logo, Name und Farbe der Oberfläche. So zeigt sich HAPM als eigenes Werkzeug, für Sie oder Ihre Kunden.')}
        </p>
      </div>
    </div>
  );

  if (!saved || !draft || !checks) {
    return (
      <>
        {header}
        {error ? <div className="alert alert-danger sys-block">{error}</div> : <SkeletonDetail />}
      </>
    );
  }

  const edit = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const setImage = (slot: BrandingImageSlot, image: ImageState) =>
    setDraft((prev) => (prev ? { ...prev, images: { ...prev.images, [slot]: image } } : prev));

  async function pickImage(slot: BrandingImageSlot, file: File) {
    if (file.size > BRANDING_IMAGE_MAX_BYTES) {
      notify({
        variant: 'error',
        title: t('Bild zu groß'),
        message: t('Die Datei hat {size} KB. Erlaubt sind bis {max} KB.', {
          size: number(Math.ceil(file.size / 1024)),
          max: number(BRANDING_IMAGE_MAX_BYTES / 1024),
        }),
      });
      return;
    }
    const bytes = await readAsBytes(file);
    const checked = checkImageBytes(bytes, locale);
    if ('error' in checked) {
      notify({ variant: 'error', title: t('Bild nicht übernommen'), message: checked.error });
      return;
    }
    setImage(slot, { kind: 'new', mime: checked.value.mime, data: checked.value.data, bytes: bytes.length });
  }

  const accent = effectiveAccent(draft.accent);
  const palette = deriveAccent(accent ?? HAPM_ACCENT);
  const name = draft.name.trim() || null;
  const brand: Brand = {
    name,
    pill: draft.pillEnabled && draft.pillText.trim() && !checks.pill ? draft.pillText.trim() : null,
    logo: imageSrc(draft.images.logo),
    logoDark: imageSrc(draft.images.logoDark),
  };
  const favicon =
    imageSrc(draft.images.icon) ??
    (name || accent
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(faviconSvg({ name, accent }))}`
      : '/favicon.svg');

  function payload(next: Draft) {
    const images: Partial<Record<BrandingImageSlot, { data: string } | null>> = {};
    for (const slot of BRANDING_IMAGE_SLOTS) {
      const image = next.images[slot];
      if (image?.kind === 'new') images[slot] = { data: image.data };
      else if (!image && saved?.images[slot]) images[slot] = null;
    }
    return {
      name: next.name.trim() || null,
      pill: { text: next.pillText.trim(), enabled: next.pillEnabled },
      accent: effectiveAccent(next.accent),
      images,
    };
  }

  async function save(next: Draft, message: string) {
    setSaving(true);
    try {
      const res = await apiFetch('/api/branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(next)),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.error || t('Die Darstellung ließ sich nicht speichern.'));
      setSaved(body.data as BrandingView);
      setDraft(fromView(body.data as BrandingView));
      // Farben, Logo, Symbol und Titel kommen aus dem Wurzel-Layout: neu vom Server holen.
      router.refresh();
      const pages = (body.data as { pages: PagesResult | null }).pages;
      if (pages?.error) {
        notify({
          variant: 'error',
          title: t('Gespeichert, aber die Fehlerseiten blieben, wie sie waren'),
          message: `${t(pages.error.label)}: ${pages.error.detail ? t(pages.error.detail) : t('fehlgeschlagen')}`,
        });
      } else if (pages && pages.written > 0) {
        notify({
          variant: 'success',
          message: `${message} ${plural(pages.written, {
            one: '{count} Fehlerseite von HAProxy neu geschrieben.',
            other: '{count} Fehlerseiten von HAProxy neu geschrieben.',
          })}`,
        });
      } else {
        notify({ variant: 'success', message });
      }
    } catch (err: unknown) {
      notify({
        variant: 'error',
        message: err instanceof Error ? err.message : t('Die Darstellung ließ sich nicht speichern.'),
      });
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    const confirmed = await confirm({
      title: t('Darstellung von HAPM wiederherstellen?'),
      message: t('Logo, helle Fassung, Symbol, Pille, Name und Farbe gehen auf die Vorgabe zurück. Hochgeladene Bilder werden gelöscht.'),
      confirmLabel: t('Wiederherstellen'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await save(
      {
        name: '',
        pillText: '',
        pillEnabled: false,
        accent: null,
        images: { logo: null, logoDark: null, icon: null },
      },
      t('Die Oberfläche zeigt wieder das Aussehen von HAPM.')
    );
  }

  const isDefault =
    !saved.name && !saved.accent && !saved.pill.enabled && !saved.pill.text && BRANDING_IMAGE_SLOTS.every((slot) => !saved.images[slot]);

  return (
    <>
      {header}

      <div className="hapm-design sys-block">
        <div className="form-columns">
          <section className="form-section">
            <div className="form-section-head">
              <span className="form-section-icon">
                <ImageIcon size={17} />
              </span>
              <div>
                <div className="form-section-title">
                  {t('Logo und Symbol')}
                  <InfoHint
                    text={t(
                      'Erlaubt sind SVG, PNG und WebP bis {max} KB, geprüft am Inhalt der Datei. Ein SVG mit Skripten oder eingebetteten Dokumenten wird abgelehnt. HAPM verkleinert keine Bilder.',
                      { max: number(BRANDING_IMAGE_MAX_BYTES / 1024) }
                    )}
                  />
                </div>
                <div className="form-section-sub">{t('Ohne eigenes Bild gilt das von HAPM.')}</div>
              </div>
            </div>

            <div className="brand-assets">
              {BRANDING_IMAGE_SLOTS.map((slot) => {
                const image = draft.images[slot];
                const src = imageSrc(image);
                const text = SLOT_TEXT[slot];
                const fallback =
                  slot === 'icon' ? favicon : slot === 'logoDark' ? (brand.logo ?? '/hapm-logo-white.svg') : '/hapm-logo.svg';
                const thumb = src ?? fallback;
                const thumbClass = `brand-asset__thumb${slot === 'logoDark' ? ' brand-asset__thumb--dark' : ''}${slot === 'icon' ? ' brand-asset__thumb--icon' : ''}`;
                return (
                  <div key={slot} className="brand-asset">
                    <div className={thumbClass}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- Daten-URL oder hochgeladenes Bild, `next/image` hätte daran nichts zu verkleinern. */}
                      <img src={thumb} alt="" />
                    </div>
                    <div className="brand-asset__body">
                      <div className="brand-asset__title">
                        {t(text.title)}
                        <InfoHint text={t(text.hint)} />
                      </div>
                      <div className="brand-asset__meta">
                        {image
                          ? t('{type}, {size} KB', {
                              type: BRANDING_IMAGE_TYPES[image.mime as keyof typeof BRANDING_IMAGE_TYPES] ?? image.mime,
                              size: number(Math.max(1, Math.round(image.bytes / 1024))),
                            })
                          : slot === 'icon' && !name && !accent
                            ? t('Symbol von HAPM')
                            : t(text.empty)}
                        {image?.kind === 'new' && <span className="badge-status badge-neutral">{t('Neu')}</span>}
                      </div>
                    </div>
                    <div className="brand-asset__actions">
                      <input
                        ref={(node) => {
                          fileInputs.current[slot] = node;
                        }}
                        type="file"
                        accept=".svg,.png,.webp,image/svg+xml,image/png,image/webp"
                        hidden
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (file) void pickImage(slot, file);
                        }}
                      />
                      {image ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          disabled={saving}
                          data-tooltip={t('Ersetzen')}
                          aria-label={t('{label} ersetzen', { label: t(text.title) })}
                          onClick={() => fileInputs.current[slot]?.click()}
                        >
                          <Upload size={16} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={saving}
                          onClick={() => fileInputs.current[slot]?.click()}
                        >
                          <Upload size={14} />
                          {t('Hochladen')}
                        </button>
                      )}
                      {image && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          disabled={saving}
                          data-tooltip={t('Entfernen')}
                          aria-label={t('{label} entfernen', { label: t(text.title) })}
                          onClick={() => setImage(slot, null)}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <span className="form-section-icon">
                <Tag size={17} />
              </span>
              <div>
                <div className="form-section-title">{t('Pille neben dem Logo')}</div>
                <div className="form-section-sub">{t('Ein kurzes Wort, etwa RevProxy oder Kunde A. Passt zu jedem Logo, auch zu dem von HAPM.')}</div>
              </div>
            </div>

            <label className="hapm-switch-row">
              <span className="hapm-switch-text">
                <span>{t('Pille zeigen')}</span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={draft.pillEnabled}
                  disabled={saving}
                  onChange={(event) => edit({ pillEnabled: event.target.checked })}
                />
                <span className="toggle-slider" />
              </span>
            </label>

            <div className="form-group">
              <div className="form-label-row">
                <label className="form-label" htmlFor="brand-pill">
                  {t('Text der Pille')}
                </label>
                <span className="brand-counter">
                  {draft.pillText.trim().length}/{BRANDING_LIMITS.pill}
                </span>
              </div>
              <input
                id="brand-pill"
                className="form-input"
                value={draft.pillText}
                maxLength={BRANDING_LIMITS.pill + 4}
                placeholder="RevProxy"
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
                aria-invalid={Boolean(checks.pill)}
                onChange={(event) => edit({ pillText: event.target.value })}
              />
              {checks.pill && <span className="form-hint brand-error">{checks.pill}</span>}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <span className="form-section-icon">
                <Type size={17} />
              </span>
              <div>
                <div className="form-section-title">{t('Name des Werkzeugs')}</div>
                <div className="form-section-sub">{t('Steht im Browser-Tab statt HAPM. Vorleser nennen ihn als Namen des Logos.')}</div>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="brand-name">
                {t('Name')}
                <InfoHint
                  text={t(
                    'Name, Logo und Farbe stehen auch in den Mails und auf den Seiten von HAProxy, soweit unter Reverse-Proxy, Fehlerseiten nichts anderes eingestellt ist. Authenticator-Apps und Passkeys zeigen weiter HAPM: ein neuer Name passte dort nicht mehr zu eingerichteten Geräten.'
                  )}
                />
              </label>
              <input
                id="brand-name"
                className="form-input"
                value={draft.name}
                maxLength={BRANDING_LIMITS.name + 4}
                placeholder="HAPM"
                autoComplete="off"
                disabled={saving}
                aria-invalid={Boolean(checks.name)}
                onChange={(event) => edit({ name: event.target.value })}
              />
              {checks.name && <span className="form-hint brand-error">{checks.name}</span>}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <span className="form-section-icon">
                <Palette size={17} />
              </span>
              <div>
                <div className="form-section-title">{t('Akzentfarbe')}</div>
                <div className="form-section-sub">{t('Knöpfe, Links, Schalter und der aktive Eintrag der Seitenleiste.')}</div>
              </div>
            </div>

            <div className="brand-swatches" role="group" aria-label={t('Vorschläge')}>
              {SUGGESTIONS.map((suggestion) => {
                const active = (accent ?? HAPM_ACCENT) === suggestion.color;
                return (
                  <button
                    key={suggestion.color}
                    type="button"
                    className={`brand-swatch${active ? ' is-active' : ''}`}
                    style={{ background: suggestion.color }}
                    data-tooltip={t(suggestion.label)}
                    aria-label={t(suggestion.label)}
                    aria-pressed={active}
                    disabled={saving}
                    onClick={() => edit({ accent: suggestion.color === HAPM_ACCENT ? null : suggestion.color })}
                  >
                    {active && <Check size={14} strokeWidth={2.25} />}
                  </button>
                );
              })}
            </div>

            <ColorField
              label={t('Eigene Farbe')}
              value={draft.accent}
              fallback={HAPM_ACCENT}
              onChange={(value) => edit({ accent: value })}
            />

            <div className="brand-contrast">
              <span className="brand-contrast__chip" style={{ background: palette.accent }}>
                Aa
              </span>
              <div>
                <div className="brand-contrast__ratio">
                  {t('Kontrast von Weiß auf dem Akzent: {ratio}:1', { ratio: number(palette.contrast, 1) })}
                  <span className="badge-status badge-success">
                    <span className="dot" />
                    {palette.contrast >= 7 ? 'AAA' : 'AA'}
                  </span>
                </div>
                <div className="form-hint">
                  {t('Geprüft nach WCAG. Mindestens {min}:1 für normale Schrift.', { min: number(MIN_CONTRAST, 1) })}
                </div>
              </div>
            </div>

            {palette.adjusted && (
              <div className="alert alert-info">
                <span className="brand-adjusted">
                  <span className="brand-adjusted__chips">
                    <span className="brand-adjusted__chip" style={{ background: palette.chosen }} />
                    <span className="brand-adjusted__chip" style={{ background: palette.accent }} />
                  </span>
                  <span>
                    {t(
                      'Weiße Schrift erreicht auf {chosen} nur {ratio}:1. Knöpfe und Links nehmen deshalb die dunklere Fassung {used}.',
                      { chosen: palette.chosen, ratio: number(palette.chosenContrast, 1), used: palette.accent }
                    )}
                  </span>
                </span>
              </div>
            )}
          </section>

          <div className="hapm-form-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || !dirty || !valid}
              onClick={() => void save(draft, t('Die Darstellung ist gespeichert.'))}
            >
              {saving ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
              {t('Speichern')}
            </button>
            {dirty && (
              <button className="btn btn-secondary" type="button" disabled={saving} onClick={() => setDraft(fromView(saved))}>
                <Undo2 size={16} strokeWidth={1.5} />
                {t('Verwerfen')}
              </button>
            )}
            <button
              className="btn btn-ghost brand-reset"
              type="button"
              disabled={saving || isDefault}
              onClick={() => void resetAll()}
            >
              <RotateCcw size={16} strokeWidth={1.5} />
              {t('Aussehen von HAPM')}
            </button>
          </div>
        </div>

        <div className="hapm-design-preview">
          <div className="hapm-design-bar">
            <div>
              <div className="form-section-title">{t('Vorschau')}</div>
              <div className="form-section-sub">
                {dirty ? t('Noch nicht gespeichert.') : t('So sieht es gerade aus.')}
              </div>
            </div>
          </div>
          <BrandingPreview brand={brand} accent={accent} favicon={favicon} />
        </div>
      </div>
    </>
  );
}
