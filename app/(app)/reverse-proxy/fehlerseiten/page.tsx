'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Code, FileWarning, ImageIcon, LayoutTemplate, Loader2, Palette, RefreshCw, RotateCcw, Save, Type,
  Upload, Undo2,
} from 'lucide-react';
import PageHeading from '@/components/PageHeading';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import ColorField from '@/components/reverse-proxy/ColorField';
import DesignPreview from '@/components/reverse-proxy/DesignPreview';
import ErrorPagesPanel, { type ErrorPagesRow } from '@/components/reverse-proxy/ErrorPagesPanel';
import { STATIC_THEME_DEFAULTS, isHexColor } from '@/ui/static/page';
import { useT } from '@/lib/i18n/react';
import { formatNumber, msgid, LOCALES, LOCALE_NAMES, type Locale } from '@/lib/i18n';
import {
  base64ToBytes,
  bytesToBase64,
  defaultPageDesign,
  builtInDesign,
  isDefaultDesign,
  parsePageDesign,
  sniffLogoType,
  DESIGN_TEXT_LIMITS,
  LOGO_TYPES,
  PAGE_MAX_BYTES,
  type DesignColors,
  type DesignLogo,
  type ErrorTextOverride,
  type LockTexts,
  type PageDesign,
  type PageMode,
} from '@/lib/haproxy/page-design';
import {
  cleanCustomSource,
  CUSTOM_PAGE_STARTER,
} from '@/lib/haproxy/custom-page';
import {
  DESIGN_PAGES,
  designPageLabel,
  designSizeError,
  logoByteBudget,
  type DesignPage,
} from '@/lib/haproxy/design-pages';
import { defaultErrorPageText } from '@/lib/haproxy/error-pages';
import { brandedTheme, usesBrandLogo, type PageBrand } from '@/lib/haproxy/page-brand';
import { brandLogoFit } from '@/lib/haproxy/page-theme';
import { lockPageDefaults } from '@/lib/haproxy/lock-page';
import type { ErrorPageEntry } from '@/lib/haproxy/error-pages';
import type { ProvisionStep } from '@/lib/haproxy/provision';

/**
 * Das Aussehen der Seiten, die HAProxy selbst ausliefert: Fehlerseiten und
 * Passwortabfrage. Links der Entwurf, rechts die Seite, wie HAProxy sie
 * ausliefern würde, darunter die Dateien auf dem Server.
 *
 * Der Entwurf liegt nur im Browser, bis er gespeichert wird. Speichern heißt
 * ausliefern (`/api/haproxy/error-pages/design`): die Route schreibt die Dateien
 * über den Weg, den es für sie schon gibt, und meldet, was dabei herauskam.
 *
 * Geprüft wird hier mit denselben Funktionen wie in der Route
 * (`parsePageDesign`, `designSizeError`). Was hier durchgeht, nimmt die Route
 * an, und umgekehrt.
 *
 * Zwei Sprachen, die nichts miteinander zu tun haben: die der Oberfläche
 * (`useT()`) für alles hier, und die der Seiten (`design.locale`) für deren
 * Vorgabetexte, auch in den Feldern und in der Vorschau.
 *
 * Oben steht die Art (`design.mode`): die Seite von HAPM, „Selbst gestalten“
 * oder eine eigene HTML-Datei. Gezeigt werden nur die Felder der gewählten Art,
 * die der anderen bleiben im Entwurf und werden mit gespeichert.
 */

interface DesignResult {
  design: PageDesign;
  steps: ProvisionStep[];
  entries: ErrorPageEntry[];
}

const COLOR_FIELDS: { key: keyof DesignColors; label: string; hint: string }[] = [
  {
    key: 'accent',
    label: msgid('Akzent'),
    hint: msgid('Knöpfe und Fokusrahmen. Die Schrift auf dem Knopf wird hell oder dunkel, je nachdem, was mehr Kontrast hat.'),
  },
  {
    key: 'background',
    label: msgid('Hintergrund'),
    hint: msgid('Die Fläche der Seite. Karte und Kopfleiste werden daraus abgeleitet: auf hellem Grund weiß, auf dunklem etwas heller als der Grund.'),
  },
  {
    key: 'text',
    label: msgid('Text'),
    hint: msgid('Überschrift und Fließtext. Gedämpfter Text und Rahmen entstehen als Mischung aus Text und Hintergrund.'),
  },
];

const MODES: { mode: PageMode; label: string; hint: string }[] = [
  {
    mode: 'standard',
    label: msgid('Standard'),
    hint: msgid('Die Fehlerseite von HAPM, hell oder dunkel nach dem Gerät des Besuchers.'),
  },
  {
    mode: 'designed',
    label: msgid('Selbst gestalten'),
    hint: msgid('Die Seite von HAPM mit eigenen Farben, Logo und Texten.'),
  },
  {
    mode: 'custom',
    label: msgid('Eigene HTML-Datei'),
    hint: msgid('Ihre Datei, unverändert für alle Fehlerseiten.'),
  },
];

function ModeIcon({ mode }: { mode: PageMode }) {
  if (mode === 'designed') return <Palette size={18} />;
  if (mode === 'custom') return <Code size={18} />;
  return <LayoutTemplate size={18} />;
}

function logoBytes(data: string): number {
  return base64ToBytes(data)?.length ?? 0;
}

/**
 * Was die Vorschau zeigt, solange ein Feld gerade nicht gültig ist: dort die
 * Vorgabe. Ein halb getippter Farbwert soll die Vorschau nicht leeren.
 */
function previewable(draft: PageDesign): PageDesign {
  if (draft.mode === 'custom') return previewableCustom(draft);
  const color = (value: string | null) => (value !== null && isHexColor(value) ? value : null);
  const text = (value: string | null | undefined) => (value && value.trim() ? value : null);
  const parsed = parsePageDesign({
    ...draft,
    colors: {
      accent: color(draft.colors.accent),
      background: color(draft.colors.background),
      text: color(draft.colors.text),
    },
    errors: Object.fromEntries(
      Object.entries(draft.errors).map(([status, entry]) => [
        status,
        { title: text(entry?.title), text: text(entry?.text) },
      ])
    ),
    lock: { title: text(draft.lock.title), subtitle: text(draft.lock.subtitle), submit: text(draft.lock.submit) },
  });
  return parsed.ok ? parsed.design : defaultPageDesign();
}

/**
 * Eigenes HTML, solange es noch nicht gültig ist (zu groß, leer): die Vorschau
 * zeigt trotzdem, was dasteht. Die Meldung dazu steht über der Seite.
 */
function previewableCustom(draft: PageDesign): PageDesign {
  const parsed = parsePageDesign(draft);
  if (parsed.ok) return parsed.design;
  return {
    ...defaultPageDesign(),
    mode: 'custom',
    locale: draft.locale,
    custom: { html: cleanCustomSource(draft.custom.html) },
  };
}

const same = (a: PageDesign | null, b: PageDesign | null) => JSON.stringify(a) === JSON.stringify(b);

interface OverrideFieldProps {
  label: string;
  value: string | null | undefined;
  fallback: string;
  max: number;
  multiline?: boolean;
  onChange: (value: string | null) => void;
}

/**
 * Ein Text mit Vorgabe. Das Feld zeigt den Text, der gerade gilt. Wer genau die
 * Vorgabe eintippt, hat keinen eigenen Text, sondern die Vorgabe.
 */
function OverrideField({ label, value, fallback, max, multiline, onChange }: OverrideFieldProps) {
  const { t } = useT();
  const custom = value !== null && value !== undefined;
  const shown = custom ? value : fallback;
  const change = (next: string) => onChange(next === fallback ? null : next);

  return (
    <div className="form-group">
      <div className="form-label-row">
        <span className="form-label">{label}</span>
        {custom && <span className="badge-status badge-neutral">{t('Eigener Text')}</span>}
      </div>
      <div className="hapm-design-field">
        {multiline ? (
          <textarea
            className="form-textarea"
            aria-label={label}
            rows={3}
            value={shown}
            maxLength={max}
            onChange={(event) => change(event.target.value)}
          />
        ) : (
          <input
            className="form-input"
            aria-label={label}
            value={shown}
            maxLength={max}
            onChange={(event) => change(event.target.value)}
          />
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          data-tooltip={t('Zurück auf den Text von HAPM')}
          aria-label={t('{label}: zurück auf den Text von HAPM', { label })}
          disabled={!custom}
          onClick={() => onChange(null)}
        >
          <RotateCcw size={16} />
        </button>
      </div>
    </div>
  );
}

export default function ErrorPagesDesignPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, locale } = useT();
  const number = (value: number) => formatNumber(locale, value);

  const [saved, setSaved] = useState<PageDesign | null>(null);
  /** Logo, Name und Farbe aus der Darstellung. Die Vorschau rechnet damit wie der Server. */
  const [brand, setBrand] = useState<PageBrand | null>(null);
  /** Erst beim Ändern belegt: ein Nachladen überschreibt sonst, was jemand tippt. */
  const [draft, setDraft] = useState<PageDesign | null>(null);
  const [row, setRow] = useState<ErrorPagesRow | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pageId, setPageId] = useState(DESIGN_PAGES[0].id);
  /** Das zuletzt gewählte eigene Logo, damit „Eigenes“ nach „Keines“ es wiederfindet. */
  const [lastCustom, setLastCustom] = useState<Extract<DesignLogo, { kind: 'custom' }> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadDesign = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/error-pages/design');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t('Das Design ließ sich nicht laden.'));
      setSaved(data.data.design as PageDesign);
      setBrand((data.data.brand ?? null) as PageBrand | null);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('Das Design ließ sich nicht laden.'));
    }
  }, [apiFetch, t]);

  const loadRow = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/error-pages');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t('Die Fehlerdateien ließen sich nicht lesen.'));
      const rows = data.data as ErrorPagesRow[];
      setRow(rows[0] ?? null);
    } catch (err) {
      setRow({
        $id: '',
        name: '',
        entries: [],
        error: err instanceof Error ? err.message : t('Die Fehlerdateien ließen sich nicht lesen.'),
      });
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void loadDesign();
    void loadRow();
  }, [loadDesign, loadRow]);

  usePolling(async () => {
    if (!draft) await loadDesign();
    await loadRow();
  }, 30_000);

  const current = draft ?? saved;
  const dirty = draft !== null && !same(draft, saved);

  const parsed = useMemo(() => (current ? parsePageDesign(current, locale) : null), [current, locale]);
  const preview = useMemo(() => (current ? previewable(current) : defaultPageDesign()), [current]);
  const problem =
    parsed && !parsed.ok ? parsed.error : parsed?.ok ? designSizeError(parsed.design, locale, brand) : null;

  const page = DESIGN_PAGES.find((entry) => entry.id === pageId) ?? DESIGN_PAGES[0];

  /**
   * Was die Seiten aus der Darstellung übernehmen, und was davon nicht passt.
   * Ein Logo, das nicht hineinpasst, wird nicht still weggelassen: hier steht,
   * was stattdessen kommt.
   */
  const brandNotes = useMemo(() => {
    const notes: { text: string; tone: 'info' | 'warning'; link?: boolean }[] = [];
    if (!brand) return notes;
    notes.push({
      tone: 'info',
      link: true,
      text:
        preview.mode === 'custom'
          ? t('Die eigene HTML-Datei bleibt, wie sie ist. Die Passwortabfrage zeigt Logo, Name und Akzentfarbe aus der Darstellung.')
          : preview.mode === 'designed'
            ? t('Was hier leer bleibt, kommt aus der Darstellung: Logo, Name und Akzentfarbe.')
            : t('Die Seiten zeigen Logo, Name und Akzentfarbe aus der Darstellung.'),
    });
    if (!usesBrandLogo(builtInDesign(preview), brand)) return notes;
    const fit = brandLogoFit(preview, brand);
    if (brand.logoTooLarge || fit === 'name') {
      const max = number(PAGE_MAX_BYTES);
      notes.push({
        tone: 'warning',
        text: brand.logoTooLarge
          ? brand.name
            ? t('Das Logo aus der Darstellung ist allein größer als eine ganze Seite ({max} Bytes). Statt seiner steht der Name.', { max })
            : t('Das Logo aus der Darstellung ist allein größer als eine ganze Seite ({max} Bytes). Die Seiten zeigen deshalb kein Logo, und einen Namen gibt es in der Darstellung nicht.', { max })
          : brand.name
            ? t('Das Logo aus der Darstellung passt mit den jetzigen Texten nicht in die Seiten, die höchstens {max} Bytes haben dürfen. Statt seiner steht der Name.', { max })
            : t('Das Logo aus der Darstellung passt mit den jetzigen Texten nicht in die Seiten, die höchstens {max} Bytes haben dürfen. Die Seiten zeigen deshalb kein Logo, und einen Namen gibt es in der Darstellung nicht.', { max }),
      });
    } else if (fit === 'light' && brand.logoDark && preview.mode !== 'custom') {
      // Die helle Fassung braucht nur eine Fehlerseite, die hell und dunkel kennt.
      const theme = brandedTheme(builtInDesign(preview), brand, 'both');
      if (!theme.accent && !theme.background && !theme.text) {
        notes.push({
          tone: 'warning',
          text: t('Die helle Fassung des Logos passt nicht zusätzlich in die Seiten. Im dunklen Modus steht deshalb das Logo selbst.'),
        });
      }
    }
    return notes;
    // `number` hängt nur an `locale`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, preview, t, locale]);

  function edit(patch: Partial<PageDesign>) {
    if (!current) return;
    setDraft({ ...current, ...patch });
  }

  function setColor(key: keyof DesignColors, value: string | null) {
    if (!current) return;
    edit({ colors: { ...current.colors, [key]: value } });
  }

  function setErrorText(status: number, field: keyof ErrorTextOverride, value: string | null) {
    if (!current) return;
    const entry = { ...current.errors[status], [field]: value ?? undefined };
    const next: ErrorTextOverride = {
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.text === undefined ? {} : { text: entry.text }),
    };
    const errors = { ...current.errors };
    if (Object.keys(next).length > 0) errors[status] = next;
    else delete errors[status];
    edit({ errors });
  }

  function chooseMode(mode: PageMode) {
    if (!current || current.mode === mode) return;
    // Beim ersten Wechsel auf eigenes HTML steht eine kleine, ganze Seite im Feld.
    const empty = !current.custom.html.trim();
    edit(mode === 'custom' && empty ? { mode, custom: CUSTOM_PAGE_STARTER } : { mode });
  }

  function setCustomHtml(html: string) {
    if (!current) return;
    edit({ custom: { html } });
  }

  async function insertStarter() {
    if (!current) return;
    const ok = await confirm({
      title: t('Vorlage einsetzen?'),
      message: t('Das HTML wird durch die Vorlage von HAPM ersetzt. Gespeichert ist damit noch nichts.'),
      confirmLabel: t('Einsetzen'),
      variant: 'warning',
    });
    if (ok) edit({ custom: CUSTOM_PAGE_STARTER });
  }

  function setLockText(field: keyof LockTexts, value: string | null) {
    if (!current) return;
    edit({ lock: { ...current.lock, [field]: value } });
  }

  function hasCustomText(entry: DesignPage): boolean {
    if (!current) return false;
    if (entry.kind === 'lock') return Object.values(current.lock).some((value) => value !== null);
    return current.errors[entry.status] !== undefined;
  }

  async function pickLogo(file: File) {
    if (!current) return;
    // Größer als eine ganze Seite passt nie. So wird eine solche Datei gar nicht
    // erst gelesen. Verkleinert wird nicht: das Ergebnis hätte niemand gesehen.
    if (file.size > PAGE_MAX_BYTES) {
      notify({
        variant: 'error',
        title: t('Logo zu groß'),
        message: t(
          'Die Datei hat {size} Bytes. Mit den jetzigen Texten passt ein Logo bis {budget} Bytes. Bitte wählen Sie eine kleinere Datei, etwa ein SVG.',
          { size: number(file.size), budget: number(logoByteBudget(preview, brand)) }
        ),
      });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffLogoType(bytes);
    if (!mime) {
      notify({
        variant: 'error',
        title: t('Kein Bild'),
        message: t('Die Datei ist kein SVG, PNG, JPEG oder WebP. Geprüft wird der Inhalt der Datei, nicht ihre Endung.'),
      });
      return;
    }
    const logo = { kind: 'custom' as const, mime, data: bytesToBase64(bytes) };
    const tooLarge = designSizeError({ ...preview, logo }, locale, brand);
    if (tooLarge) {
      notify({ variant: 'error', title: t('Logo zu groß'), message: tooLarge });
      return;
    }
    setLastCustom(logo);
    edit({ logo });
  }

  function chooseLogo(kind: DesignLogo['kind']) {
    if (kind === 'custom') {
      const known = lastCustom ?? (saved?.logo.kind === 'custom' ? saved.logo : null);
      if (known) edit({ logo: known });
      else fileInput.current?.click();
      return;
    }
    edit({ logo: { kind } });
  }

  function report(result: DesignResult, done: string) {
    setSaved(result.design);
    setDraft(null);
    if (result.entries.length > 0) setRow((prev) => (prev ? { ...prev, entries: result.entries } : prev));
    void loadRow();

    const failed = result.steps.find((step) => !step.ok);
    if (failed) {
      notify({
        variant: 'error',
        title: t('Gespeichert, aber nicht ausgeliefert'),
        message: `${t(failed.label)}: ${failed.detail ? t(failed.detail) : t('fehlgeschlagen')}`,
      });
      return;
    }
    // Die Schritte tragen ihre deutschen Schlüssel, übersetzt wird erst beim Zeigen.
    const reloaded = result.steps.some((step) => step.label.includes('neu geladen'));
    notify({
      variant: 'success',
      title: done,
      message: reloaded
        ? t('Geschrieben, geprüft und von HAProxy übernommen.')
        : t('Auf dem Server war keine Datei zu ändern.'),
    });
  }

  async function save() {
    if (!parsed?.ok || problem) return;

    // Gespeichert wird über denselben Weg wie der Knopf unten, und der ersetzt
    // jede Datei, die vom gespeicherten Stand abweicht. Auch eine von Hand.
    const others = row?.entries.filter((entry) => entry.state === 'other').length ?? 0;
    if (others > 0) {
      const ok = await confirm({
        title: t('Auch abweichende Dateien ersetzen?'),
        message: plural(others, {
          one: '{count} Fehlerdatei trägt gerade nicht das gespeicherte Design: eine eigene Seite oder ein älterer Stand. Sie wird mit ersetzt. Die bisherige Fassung bleibt als .hapm-original daneben liegen.',
          other: '{count} Fehlerdateien tragen gerade nicht das gespeicherte Design: eine eigene Seite oder ein älterer Stand. Sie werden mit ersetzt. Die bisherige Fassung bleibt als .hapm-original daneben liegen.',
        }),
        confirmLabel: t('Speichern und ausliefern'),
        variant: 'warning',
      });
      if (!ok) return;
    }

    setBusy('save');
    try {
      const res = await apiFetch('/api/haproxy/error-pages/design', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: parsed.design }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t('Speichern fehlgeschlagen.'));
      report(data.data as DesignResult, t('Design gespeichert'));
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: err instanceof Error ? err.message : t('Unbekannter Fehler.'),
      });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    const ok = await confirm({
      title: t('Zurück auf das Design von HAPM?'),
      message: t(
        'Art, Farben, Logo, Schriftzug, Fußzeile, Sprache, alle Texte und die eigene HTML-Datei gehen auf die Vorgabe zurück. Danach schreibt HAPM die Seiten neu und lädt HAProxy neu.'
      ),
      confirmLabel: t('Zurücksetzen'),
      variant: 'warning',
    });
    if (!ok) return;

    setBusy('reset');
    try {
      const res = await apiFetch('/api/haproxy/error-pages/design', { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t('Zurücksetzen fehlgeschlagen.'));
      report(data.data as DesignResult, t('Design von HAPM'));
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Zurücksetzen fehlgeschlagen'),
        message: err instanceof Error ? err.message : t('Unbekannter Fehler.'),
      });
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        draft ? null : loadDesign(),
        loadRow(),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  const pageLocale: Locale = current?.locale ?? 'de';
  const errorDefaults = page.kind === 'error' ? defaultErrorPageText(page.status, pageLocale) : null;
  const lockDefaults = lockPageDefaults(pageLocale);

  return (
    <>
      <div className="page-header">
        <PageHeading
          icon={<FileWarning size={20} />}
          title={t('Fehlerseiten')}
          back={{ label: t('Übersicht'), href: '/reverse-proxy' }}
          note={t('Was Besucher sehen, wenn HAProxy selbst antwortet')}
        />
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
          {saved && !isDefaultDesign(saved) && (
            <button className="btn btn-secondary" onClick={reset} disabled={busy !== null}>
              {busy === 'reset' ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}
              {t('Zurück auf das Design von HAPM')}
            </button>
          )}
          {dirty && (
            <button className="btn btn-secondary" onClick={() => setDraft(null)} disabled={busy !== null}>
              <Undo2 size={16} />
              {t('Verwerfen')}
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={!dirty || problem !== null || busy !== null}
          >
            {busy === 'save' ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {t('Speichern und ausliefern')}
          </button>
        </div>
      </div>

      {loadError && <div className="alert alert-danger sys-block">{loadError}</div>}
      {/* Bei eigenem HTML steht die Meldung unter den Feldern, an denen sie hängt. */}
      {problem && current?.mode !== 'custom' && <div className="alert alert-danger sys-block">{problem}</div>}

      {!current ? (
        <SkeletonRows />
      ) : (
        <div className="hapm-design sys-block">
          <div className="form-columns">
            <section className="form-section">
              <div className="form-section-head">
                <span className="form-section-icon">
                  <LayoutTemplate size={17} />
                </span>
                <div>
                  <div className="form-section-title">{t('Art der Seiten')}</div>
                  <div className="form-section-sub">{t('Gilt für alle Fehlerseiten.')}</div>
                </div>
              </div>

              <div className="kind-grid hapm-mode" role="radiogroup" aria-label={t('Art der Seiten')}>
                {MODES.map((entry) => (
                  <button
                    key={entry.mode}
                    type="button"
                    role="radio"
                    aria-checked={current.mode === entry.mode}
                    className={`kind-card${current.mode === entry.mode ? ' active' : ''}`}
                    onClick={() => chooseMode(entry.mode)}
                  >
                    <span className="kind-card-icon">
                      <ModeIcon mode={entry.mode} />
                    </span>
                    <span className="kind-card-text">
                      <span className="kind-card-title">{t(entry.label)}</span>
                      <span className="kind-card-sub">{t(entry.hint)}</span>
                    </span>
                  </button>
                ))}
              </div>

              {brandNotes.map((note) => (
                <div key={note.text} className={`alert ${note.tone === 'warning' ? 'alert-warning' : 'alert-info'}`}>
                  <span>
                    {note.text}{' '}
                    {note.link && <Link href="/system/darstellung">{t('Zur Darstellung')}</Link>}
                  </span>
                </div>
              ))}

              <div className="form-group">
                <div className="form-label-row">
                  <label className="form-label" htmlFor="design-locale">
                    {t('Sprache der Vorgabetexte')}
                  </label>
                  <InfoHint text={t('Gilt für alles, was HAPM auf den Seiten selbst schreibt: Vorgabetexte, Knöpfe, Hinweise. Eigene Texte bleiben, wie sie eingegeben sind.')} />
                </div>
                <Select
                  id="design-locale"
                  value={pageLocale}
                  onChange={(value) => edit({ locale: value })}
                  options={LOCALES.map((entry) => ({ value: entry, label: LOCALE_NAMES[entry] }))}
                />
              </div>
            </section>

            {current.mode === 'custom' && (
              <section className="form-section">
                <div className="form-section-head">
                  <span className="form-section-icon">
                    <Code size={17} />
                  </span>
                  <div>
                    <div className="form-section-title">
                      {t('Eigene HTML-Datei')}
                      <InfoHint text={t('Die Datei geht unverändert hinaus, für jeden Fehler dieselbe. HAPM setzt nichts ein und legt keinen Rahmen darum. CSS steht in einem <style> der Datei. Bilder und Schriften von anderen Adressen lädt der Browser des Besuchers nach.')} />
                    </div>
                    <div className="form-section-sub">{t('Eine Datei für jeden Status, so wie sie hier steht.')}</div>
                  </div>
                </div>

                <div className="form-group">
                  <div className="form-label-row">
                    <label className="form-label" htmlFor="design-custom-html">
                      HTML
                    </label>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={insertStarter}>
                      <RotateCcw size={14} />
                      {t('Vorlage einsetzen')}
                    </button>
                  </div>
                  <textarea
                    id="design-custom-html"
                    className="form-textarea mono"
                    rows={20}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    value={current.custom.html}
                    onChange={(event) => setCustomHtml(event.target.value)}
                  />
                </div>

                {problem && (
                  <div className="alert alert-danger" role="alert">
                    {problem}
                  </div>
                )}

                <span className="form-hint">
                  {t('Die Passwortabfrage behält das Design von HAPM.')}
                </span>
              </section>
            )}

            {current.mode === 'designed' && (
              <>
                <section className="form-section">
                  <div className="form-section-head">
                    <span className="form-section-icon">
                      <Palette size={17} />
                    </span>
                    <div>
                      <div className="form-section-title">{t('Farben')}</div>
                      <div className="form-section-sub">
                        {brand?.accent
                          ? t('Leer heißt: die Akzentfarbe aus der Darstellung, sonst die Farbe von HAPM.')
                          : t('Leer heißt: die Farbe von HAPM.')}
                      </div>
                    </div>
                  </div>
                  {COLOR_FIELDS.map((field) => (
                    <ColorField
                      key={field.key}
                      label={t(field.label)}
                      hint={t(field.hint)}
                      value={current.colors[field.key]}
                      fallback={(field.key === 'accent' ? brand?.accent : null) ?? STATIC_THEME_DEFAULTS[field.key]}
                      onChange={(value) => setColor(field.key, value)}
                    />
                  ))}
                </section>

                <section className="form-section">
                  <div className="form-section-head">
                    <span className="form-section-icon">
                      <ImageIcon size={17} />
                    </span>
                    <div>
                      <div className="form-section-title">
                        {t('Logo und Name')}
                        <InfoHint text={t('Das Logo steckt als Data-URI in jeder Seite: HAProxy liefert eine Fehlerseite als eine Datei aus und lädt nichts nach. Erlaubt sind SVG, PNG, JPEG und WebP, geprüft am Inhalt der Datei. Ein SVG wird als Bild eingebunden und führt kein Skript aus. HAPM verkleinert keine Bilder.')} />
                      </div>
                      <div className="form-section-sub">{t('Oben auf jeder Seite.')}</div>
                    </div>
                  </div>

                  <div className="choice-group" role="group" aria-label={t('Logo')}>
                    {(
                      [
                        ['hapm', brand ? msgid('Aus der Darstellung') : msgid('Logo von HAPM')],
                        ['custom', msgid('Eigenes')],
                        ['none', msgid('Keines')],
                      ] as const
                    ).map(([kind, label]) => (
                      <button
                        key={kind}
                        type="button"
                        className={`choice-btn${current.logo.kind === kind ? ' active' : ''}`}
                        aria-pressed={current.logo.kind === kind}
                        onClick={() => chooseLogo(kind)}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </div>

                  <input
                    ref={fileInput}
                    type="file"
                    accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void pickLogo(file);
                    }}
                  />

                  {current.logo.kind === 'custom' && (
                    <div className="hapm-design-field">
                      <span className="form-hint">
                        {t('{type}, {bytes} Bytes', {
                          type: LOGO_TYPES[current.logo.mime],
                          bytes: number(logoBytes(current.logo.data)),
                        })}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => fileInput.current?.click()}
                      >
                        <Upload size={14} />
                        {t('Andere Datei')}
                      </button>
                    </div>
                  )}
                  <span className="form-hint">
                    {t('Mit den jetzigen Texten passt eine Logo-Datei bis {bytes} Bytes.', {
                      bytes: number(logoByteBudget(preview, brand)),
                    })}
                  </span>

                  <div className="form-group">
                    <div className="form-label-row">
                      <label className="form-label" htmlFor="design-brand">
                        {t('Name neben dem Logo')}
                      </label>
                      <InfoHint text={t('Optional, etwa der Name der Firma. Steht neben dem Logo oder allein, wenn kein Logo gewählt ist.')} />
                    </div>
                    <input
                      id="design-brand"
                      className="form-input"
                      value={current.brand}
                      maxLength={DESIGN_TEXT_LIMITS.brand}
                      placeholder={t('Kein Name')}
                      onChange={(event) => edit({ brand: event.target.value })}
                    />
                  </div>
                </section>

                <section className="form-section">
                  <div className="form-section-head">
                    <span className="form-section-icon">
                      <Type size={17} />
                    </span>
                    <div>
                      <div className="form-section-title">
                        {t('Texte')}
                        <InfoHint text={t('Je Fall eine Überschrift und ein Text. Die Passwortabfrage hat drei Fassungen (Abfrage, falsches Passwort, zu viele Versuche), die sich Überschrift, Text und Knopf teilen. Die Hinweise darin und der Knopf der Fehlerseiten folgen der Sprache der Vorgabetexte.')} />
                      </div>
                      <div className="form-section-sub">{t('Ein Fall nach dem anderen, wie in der Vorschau.')}</div>
                    </div>
                  </div>

                  <Select
                    value={page.id}
                    onChange={setPageId}
                    options={DESIGN_PAGES.map((entry) => ({
                      value: entry.id,
                      label: designPageLabel(entry, t),
                      hint: hasCustomText(entry) ? t('Eigener Text') : t(entry.hint),
                    }))}
                  />

                  {page.kind === 'error' && errorDefaults ? (
                    <>
                      <OverrideField
                        label={t('Überschrift')}
                        value={current.errors[page.status]?.title}
                        fallback={errorDefaults.title}
                        max={DESIGN_TEXT_LIMITS.title}
                        onChange={(value) => setErrorText(page.status, 'title', value)}
                      />
                      <OverrideField
                        label={t('Text')}
                        value={current.errors[page.status]?.text}
                        fallback={errorDefaults.text}
                        max={DESIGN_TEXT_LIMITS.text}
                        multiline
                        onChange={(value) => setErrorText(page.status, 'text', value)}
                      />
                    </>
                  ) : (
                    <>
                      <OverrideField
                        label={t('Überschrift')}
                        value={current.lock.title}
                        fallback={lockDefaults.title}
                        max={DESIGN_TEXT_LIMITS.title}
                        onChange={(value) => setLockText('title', value)}
                      />
                      <OverrideField
                        label={t('Text')}
                        value={current.lock.subtitle}
                        fallback={lockDefaults.subtitle}
                        max={DESIGN_TEXT_LIMITS.text}
                        multiline
                        onChange={(value) => setLockText('subtitle', value)}
                      />
                      <OverrideField
                        label={t('Knopf')}
                        value={current.lock.submit}
                        fallback={lockDefaults.submit}
                        max={DESIGN_TEXT_LIMITS.submit}
                        onChange={(value) => setLockText('submit', value)}
                      />
              </>
            )}

              <div className="form-group">
                <div className="form-label-row">
                  <label className="form-label" htmlFor="design-footer">
                    {t('Fußzeile')}
                  </label>
                  <InfoHint text={t('Optional, auf jeder Seite unten, etwa ein Kontakt. Ein Link wird daraus nicht: die Seite zeigt den Text, wie er hier steht.')} />
                </div>
                <input
                  id="design-footer"
                  className="form-input"
                  value={current.footer}
                  maxLength={DESIGN_TEXT_LIMITS.footer}
                  placeholder={t('Keine Fußzeile')}
                  onChange={(event) => edit({ footer: event.target.value })}
                />
              </div>
            </section>
            </>
            )}
          </div>

          <DesignPreview design={preview} brand={brand} pageId={page.id} onPageChange={setPageId} />
        </div>
      )}

      <ErrorPagesPanel
        row={row}
        onWritten={(entries) => setRow((prev) => (prev ? { ...prev, entries } : prev))}
      />
    </>
  );
}
