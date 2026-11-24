'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, FileWarning, ImageIcon, Loader2, Palette, RefreshCw, RotateCcw, Save, Type, Upload, Undo2,
} from 'lucide-react';
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
import {
  base64ToBytes,
  bytesToBase64,
  defaultPageDesign,
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
} from '@/lib/haproxy/page-design';
import { DESIGN_PAGES, designSizeError, logoByteBudget, type DesignPage } from '@/lib/haproxy/design-pages';
import { defaultErrorPageText } from '@/lib/haproxy/error-pages';
import { LOCK_PAGE_DEFAULTS } from '@/lib/haproxy/lock-page';
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
 */

interface DesignResult {
  design: PageDesign;
  steps: ProvisionStep[];
  entries: ErrorPageEntry[];
}

const COLOR_FIELDS: { key: keyof DesignColors; label: string; hint: string }[] = [
  {
    key: 'accent',
    label: 'Akzent',
    hint: 'Knöpfe und Fokusrahmen. Die Schrift auf dem Knopf wird hell oder dunkel, je nachdem, was mehr Kontrast hat.',
  },
  {
    key: 'background',
    label: 'Hintergrund',
    hint: 'Die Fläche der Seite. Karte und Kopfleiste werden daraus abgeleitet: auf hellem Grund weiß, auf dunklem etwas heller als der Grund.',
  },
  {
    key: 'text',
    label: 'Text',
    hint: 'Überschrift und Fließtext. Gedämpfter Text und Rahmen entstehen als Mischung aus Text und Hintergrund.',
  },
];

const number = (value: number) => value.toLocaleString('de-DE');

function logoBytes(data: string): number {
  return base64ToBytes(data)?.length ?? 0;
}

/**
 * Was die Vorschau zeigt, solange ein Feld gerade nicht gültig ist: dort die
 * Vorgabe. Ein halb getippter Farbwert soll die Vorschau nicht leeren.
 */
function previewable(draft: PageDesign): PageDesign {
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
  const custom = value !== null && value !== undefined;
  const shown = custom ? value : fallback;
  const change = (next: string) => onChange(next === fallback ? null : next);

  return (
    <div className="form-group">
      <div className="form-label-row">
        <span className="form-label">{label}</span>
        {custom && <span className="badge-status badge-neutral">Eigener Text</span>}
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
          data-tooltip="Zurück auf den Text von HAPM"
          aria-label={`${label}: zurück auf den Text von HAPM`}
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

  const [saved, setSaved] = useState<PageDesign | null>(null);
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
      if (!data.success) throw new Error(data.error || 'Das Design ließ sich nicht laden.');
      setSaved(data.data.design as PageDesign);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Das Design ließ sich nicht laden.');
    }
  }, [apiFetch]);

  const loadRow = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/error-pages');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Die Fehlerdateien ließen sich nicht lesen.');
      const rows = data.data as ErrorPagesRow[];
      setRow(rows[0] ?? null);
    } catch (err) {
      setRow({
        $id: '',
        name: '',
        entries: [],
        error: err instanceof Error ? err.message : 'Die Fehlerdateien ließen sich nicht lesen.',
      });
    }
  }, [apiFetch]);

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

  const parsed = useMemo(() => (current ? parsePageDesign(current) : null), [current]);
  const preview = useMemo(() => (current ? previewable(current) : defaultPageDesign()), [current]);
  const problem = parsed && !parsed.ok ? parsed.error : parsed?.ok ? designSizeError(parsed.design) : null;

  const page = DESIGN_PAGES.find((entry) => entry.id === pageId) ?? DESIGN_PAGES[0];

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
        title: 'Logo zu groß',
        message:
          `Die Datei hat ${number(file.size)} Bytes. Mit den jetzigen Texten passt ein Logo bis ` +
          `${number(logoByteBudget(preview))} Bytes. Bitte wählen Sie eine kleinere Datei, etwa ein SVG.`,
      });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffLogoType(bytes);
    if (!mime) {
      notify({
        variant: 'error',
        title: 'Kein Bild',
        message: 'Die Datei ist kein SVG, PNG, JPEG oder WebP. Geprüft wird der Inhalt der Datei, nicht ihre Endung.',
      });
      return;
    }
    const logo = { kind: 'custom' as const, mime, data: bytesToBase64(bytes) };
    const tooLarge = designSizeError({ ...preview, logo });
    if (tooLarge) {
      notify({ variant: 'error', title: 'Logo zu groß', message: tooLarge });
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
        title: 'Gespeichert, aber nicht ausgeliefert',
        message: `${failed.label}: ${failed.detail ?? 'fehlgeschlagen'}`,
      });
      return;
    }
    const reloaded = result.steps.some((step) => step.label.includes('neu geladen'));
    notify({
      variant: 'success',
      title: done,
      message: reloaded
        ? 'Geschrieben, geprüft und von HAProxy übernommen.'
        : 'Auf dem Server war keine Datei zu ändern.',
    });
  }

  async function save() {
    if (!parsed?.ok || problem) return;

    // Gespeichert wird über denselben Weg wie der Knopf unten, und der ersetzt
    // jede Datei, die vom gespeicherten Stand abweicht. Auch eine von Hand.
    const others = row?.entries.filter((entry) => entry.state === 'other').length ?? 0;
    if (others > 0) {
      const ok = await confirm({
        title: 'Auch abweichende Dateien ersetzen?',
        message:
          `${others} Fehlerdatei(en) tragen gerade nicht das gespeicherte Design: eine eigene Seite ` +
          'oder ein älterer Stand. Sie werden mit ersetzt. Die bisherige Fassung bleibt als ' +
          '.hapm-original daneben liegen.',
        confirmLabel: 'Speichern und ausliefern',
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
      if (!data.success) throw new Error(data.error || 'Speichern fehlgeschlagen.');
      report(data.data as DesignResult, 'Design gespeichert');
    } catch (err) {
      notify({
        variant: 'error',
        title: 'Speichern fehlgeschlagen',
        message: err instanceof Error ? err.message : 'Unbekannter Fehler.',
      });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    const ok = await confirm({
      title: 'Zurück auf das Design von HAPM?',
      message:
        'Farben, Logo, Schriftzug, Fußzeile und alle Texte gehen auf die Vorgabe zurück. ' +
        'Danach schreibt HAPM die Seiten neu und lädt HAProxy neu.',
      confirmLabel: 'Zurücksetzen',
      variant: 'warning',
    });
    if (!ok) return;

    setBusy('reset');
    try {
      const res = await apiFetch('/api/haproxy/error-pages/design', { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Zurücksetzen fehlgeschlagen.');
      report(data.data as DesignResult, 'Design von HAPM');
    } catch (err) {
      notify({
        variant: 'error',
        title: 'Zurücksetzen fehlgeschlagen',
        message: err instanceof Error ? err.message : 'Unbekannter Fehler.',
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

  const errorDefaults = page.kind === 'error' ? defaultErrorPageText(page.status) : null;

  return (
    <>
      <div className="page-header">
        <div className="page-heading">
          <span className="page-heading-icon">
            <FileWarning size={20} />
          </span>
          <div>
            <h1 className="page-title">Fehlerseiten</h1>
            <div className="page-crumbs">
              <Link className="page-back" href="/reverse-proxy">
                <ArrowLeft size={14} />
                Übersicht
              </Link>
              <span>Was Besucher sehen, wenn HAProxy selbst antwortet</span>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            Aktualisieren
          </button>
          {saved && !isDefaultDesign(saved) && (
            <button className="btn btn-secondary" onClick={reset} disabled={busy !== null}>
              {busy === 'reset' ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}
              Zurück auf das Design von HAPM
            </button>
          )}
          {dirty && (
            <button className="btn btn-secondary" onClick={() => setDraft(null)} disabled={busy !== null}>
              <Undo2 size={16} />
              Verwerfen
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={!dirty || problem !== null || busy !== null}
          >
            {busy === 'save' ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            Speichern und ausliefern
          </button>
        </div>
      </div>

      {loadError && <div className="alert alert-danger sys-block">{loadError}</div>}
      {problem && <div className="alert alert-danger sys-block">{problem}</div>}

      {!current ? (
        <SkeletonRows />
      ) : (
        <div className="hapm-design sys-block">
          <div className="form-columns">
            <section className="form-section">
              <div className="form-section-head">
                <span className="form-section-icon">
                  <Palette size={17} />
                </span>
                <div>
                  <div className="form-section-title">Farben</div>
                  <div className="form-section-sub">Leer heißt: die Farbe von HAPM.</div>
                </div>
              </div>
              {COLOR_FIELDS.map((field) => (
                <ColorField
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  value={current.colors[field.key]}
                  fallback={STATIC_THEME_DEFAULTS[field.key]}
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
                    Logo und Name
                    <InfoHint text="Das Logo steckt als Data-URI in jeder Seite: HAProxy liefert eine Fehlerseite als eine Datei aus und lädt nichts nach. Erlaubt sind SVG, PNG, JPEG und WebP, geprüft am Inhalt der Datei. Ein SVG wird als Bild eingebunden und führt kein Skript aus. HAPM verkleinert keine Bilder." />
                  </div>
                  <div className="form-section-sub">Oben auf jeder Seite.</div>
                </div>
              </div>

              <div className="choice-group" role="group" aria-label="Logo">
                {(
                  [
                    ['hapm', 'Logo von HAPM'],
                    ['custom', 'Eigenes'],
                    ['none', 'Keines'],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    className={`choice-btn${current.logo.kind === kind ? ' active' : ''}`}
                    aria-pressed={current.logo.kind === kind}
                    onClick={() => chooseLogo(kind)}
                  >
                    {label}
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
                    {LOGO_TYPES[current.logo.mime]}, {number(logoBytes(current.logo.data))} Bytes
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload size={14} />
                    Andere Datei
                  </button>
                </div>
              )}
              <span className="form-hint">
                Mit den jetzigen Texten passt eine Logo-Datei bis {number(logoByteBudget(preview))} Bytes.
              </span>

              <div className="form-group">
                <div className="form-label-row">
                  <label className="form-label" htmlFor="design-brand">
                    Name neben dem Logo
                  </label>
                  <InfoHint text="Optional, etwa der Name der Firma. Steht neben dem Logo oder allein, wenn kein Logo gewählt ist." />
                </div>
                <input
                  id="design-brand"
                  className="form-input"
                  value={current.brand}
                  maxLength={DESIGN_TEXT_LIMITS.brand}
                  placeholder="Kein Name"
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
                    Texte
                    <InfoHint text="Je Fall eine Überschrift und ein Text. Die Passwortabfrage hat drei Fassungen (Abfrage, falsches Passwort, zu viele Versuche), die sich Überschrift, Text und Knopf teilen. Die Hinweise darin und der Knopf der Fehlerseiten bleiben, wie sie sind." />
                  </div>
                  <div className="form-section-sub">Ein Fall nach dem anderen, wie in der Vorschau.</div>
                </div>
              </div>

              <Select
                value={page.id}
                onChange={setPageId}
                options={DESIGN_PAGES.map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                  hint: hasCustomText(entry) ? 'Eigener Text' : entry.hint,
                }))}
              />

              {page.kind === 'error' && errorDefaults ? (
                <>
                  <OverrideField
                    label="Überschrift"
                    value={current.errors[page.status]?.title}
                    fallback={errorDefaults.title}
                    max={DESIGN_TEXT_LIMITS.title}
                    onChange={(value) => setErrorText(page.status, 'title', value)}
                  />
                  <OverrideField
                    label="Text"
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
                    label="Überschrift"
                    value={current.lock.title}
                    fallback={LOCK_PAGE_DEFAULTS.title}
                    max={DESIGN_TEXT_LIMITS.title}
                    onChange={(value) => setLockText('title', value)}
                  />
                  <OverrideField
                    label="Text"
                    value={current.lock.subtitle}
                    fallback={LOCK_PAGE_DEFAULTS.subtitle}
                    max={DESIGN_TEXT_LIMITS.text}
                    multiline
                    onChange={(value) => setLockText('subtitle', value)}
                  />
                  <OverrideField
                    label="Knopf"
                    value={current.lock.submit}
                    fallback={LOCK_PAGE_DEFAULTS.submit}
                    max={DESIGN_TEXT_LIMITS.submit}
                    onChange={(value) => setLockText('submit', value)}
                  />
                </>
              )}

              <div className="form-group">
                <div className="form-label-row">
                  <label className="form-label" htmlFor="design-footer">
                    Fußzeile
                  </label>
                  <InfoHint text="Optional, auf jeder Seite unten, etwa ein Kontakt. Ein Link wird daraus nicht: die Seite zeigt den Text, wie er hier steht." />
                </div>
                <input
                  id="design-footer"
                  className="form-input"
                  value={current.footer}
                  maxLength={DESIGN_TEXT_LIMITS.footer}
                  placeholder="Keine Fußzeile"
                  onChange={(event) => edit({ footer: event.target.value })}
                />
              </div>
            </section>
          </div>

          <DesignPreview design={preview} pageId={page.id} onPageChange={setPageId} />
        </div>
      )}

      <ErrorPagesPanel
        row={row}
        onWritten={(entries) => setRow((prev) => (prev ? { ...prev, entries } : prev))}
      />
    </>
  );
}
