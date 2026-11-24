'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  ExternalLink,
  Globe,
  Home,
  Loader2,
  Play,
  RefreshCw,
  Search,
  UserPlus,
  X,
} from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { LONG_TEXT } from '@/ui/primitives/hint-text';
import { usePolling } from '@/components/usePolling';
import { useT } from '@/lib/i18n/react';
import { msgid, type Translatable } from '@/lib/i18n/translate';
import { DNS_PROVIDERS, findDnsProvider, validateDnsCredentials } from '@/lib/haproxy/dns-credentials';
import { needsDnsChallenge } from '@/lib/haproxy/challenge';
import {
  SETUP_SCOPE,
  SETUP_STEPS,
  STAGE_LABELS,
  certificateDomains,
  executionOutcome,
  normalizeSetupDomain,
  stepReached,
  validateSetupDomain,
  validateWildcardBase,
  wildcardBaseOf,
  type SetupStep,
} from '@/lib/setup/rules';
// Nur die Typen: die Dateien dahinter erreichen `lib/db`.
import type { SetupView } from '@/lib/setup';
import type { AddressCheck } from '@/lib/setup/address';
import type { Exposure } from '@/lib/types';

/**
 * Die Einrichtung: Konto, Erreichbarkeit, DNS-Anbieter, Adresse der Oberfläche,
 * Ausführen. Eine Seite, damit ein Neuladen an derselben Stelle weitergeht:
 * welcher Schritt dran ist, sagt `GET /api/setup` (`resumeStep`), nicht ein
 * Zustand im Browser.
 *
 * Das Konto besteht nach Schritt 1. Alles danach lässt sich abbrechen und
 * später fortsetzen, die Übersicht erinnert daran.
 */

type Shown = Exclude<SetupStep, 'done'>;

const POLL_MS = 3000;

const TITLES: Record<Shown, string> = {
  account: msgid('HAPM einrichten'),
  exposure: msgid('Erreichbarkeit'),
  dns: msgid('DNS-Anbieter'),
  address: msgid('Adresse der Oberfläche'),
  run: msgid('Einrichten'),
};

/**
 * `fetch` mit CSRF-Token. Die Seite steht außerhalb des Rahmens, `useApp()` gibt es hier nicht.
 * Die Meldung der Route kommt schon in der Sprache der Anfrage, der Rückfall bleibt ein Schlüssel.
 */
async function call<T>(csrf: string, url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (init?.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { ...init, headers, cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(body?.error || msgid('Die Anfrage ist fehlgeschlagen.'));
  return body.data as T;
}

/** Die Meldung eines Fehlers, übersetzt nachgeschlagen: eine Meldung der Route ist es schon. */
function message(err: unknown, fallback: string, t: (text: Translatable) => string): string {
  return t(err instanceof Error ? err.message : fallback);
}

export default function SetupPage() {
  const router = useRouter();
  const { t } = useT();
  const [shown, setShown] = useState<Shown | null>(null);
  const [setup, setSetup] = useState<SetupView | null>(null);
  const [csrf, setCsrf] = useState('');

  /** Den Stand übernehmen und beim nächsten offenen Schritt weitermachen. */
  const advance = useCallback(
    (next: SetupView) => {
      setSetup(next);
      if (next.step === 'done') router.replace('/dashboard');
      else setShown(next.step);
    },
    [router]
  );

  useEffect(() => {
    let live = true;
    (async () => {
      const status = await fetch('/api/setup', { cache: 'no-store' }).then((r) => r.json());
      if (!live) return;
      if (status.data?.needsSetup) {
        setShown('account');
        return;
      }
      const view = status.data?.setup as SetupView | undefined;
      // Es gibt ein Konto, aber keine Anmeldung: mehr verrät die Route nicht.
      if (!view) {
        router.replace('/login');
        return;
      }
      if (view.status !== 'open' || view.step === 'done' || view.step === 'account') {
        router.replace('/dashboard');
        return;
      }
      const me = await fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json());
      if (!live) return;
      setCsrf(me.data?.csrfToken ?? '');
      setSetup(view);
      // Zurück auf einen schon erreichten Schritt, etwa aus dem Hinweis der Übersicht.
      const wanted = new URLSearchParams(window.location.search).get('schritt') as Shown | null;
      setShown(wanted && SETUP_STEPS.includes(wanted) && wanted !== 'account' && stepReached(wanted, view.step) ? wanted : view.step);
    })().catch(() => {
      if (live) setShown('account');
    });
    return () => {
      live = false;
    };
  }, [router]);

  const running = executionOutcome(setup?.execution ?? null) === 'running';
  usePolling(async () => {
    const status = await fetch('/api/setup', { cache: 'no-store' }).then((r) => r.json());
    if (status.data?.setup) setSetup(status.data.setup as SetupView);
  }, running ? POLL_MS : 0);

  if (shown === null) {
    return (
      <AuthCard standalone className="hapm-setup" title={t('HAPM einrichten')}>
        <div className="skeleton shell-skeleton--row" />
        <div className="skeleton shell-skeleton--row" />
      </AuthCard>
    );
  }

  const index = SETUP_STEPS.indexOf(shown);
  const progress = (
    <div className="hapm-setup-progress">
      <span>{t('Schritt {step} von {total}', { step: index + 1, total: SETUP_STEPS.length })}</span>
      <div className="hapm-setup-bar">
        <i style={{ width: `${((index + 1) / SETUP_STEPS.length) * 100}%` }} />
      </div>
    </div>
  );

  const back = (to: Shown) => (
    <button className="btn btn-ghost" type="button" onClick={() => setShown(to)}>
      <ArrowLeft size={15} />
      {t('Zurück')}
    </button>
  );

  const later = (
    <p className="auth-footer">
      <Link href="/dashboard">{t('Später fertig machen')}</Link>
    </p>
  );

  const acmeWarning = setup?.acmeReady === false && (
    <div className="alert alert-warning">
      {t('acme.sh ist nicht eingerichtet. Solange das so ist, lassen sich keine Zertifikate ausstellen. Der Grund steht in der Übersicht.')}
    </div>
  );

  if (shown === 'account') {
    return (
      <Frame step={shown} progress={progress} subtitle={t('Legen Sie zuerst das Konto an, mit dem Sie HAPM verwalten.')}>
        <AccountStep
          onCreated={(token) => {
            setCsrf(token);
            call<{ setup?: SetupView }>(token, '/api/setup')
              .then((data) => (data.setup ? advance(data.setup) : router.replace('/login')))
              .catch(() => router.replace('/login'));
          }}
          onNoSession={() => router.replace('/login')}
        />
      </Frame>
    );
  }

  if (!setup) return null;

  if (shown === 'exposure') {
    return (
      <Frame step={shown} progress={progress} subtitle={t('Davon hängt ab, wie HAPM Zertifikate ausstellt.')}>
        {acmeWarning}
        <ExposureStep setup={setup} csrf={csrf} onSaved={advance} />
        {later}
      </Frame>
    );
  }

  if (shown === 'dns') {
    return (
      <Frame
        step={shown}
        progress={progress}
        subtitle={
          setup.exposure === 'internal'
            ? t('Über ihn stellt HAPM jedes Zertifikat aus.')
            : t('Nur nötig für Wildcard-Zertifikate.')
        }
      >
        {acmeWarning}
        <DnsStep setup={setup} csrf={csrf} onSaved={advance} back={back('exposure')} />
        {later}
      </Frame>
    );
  }

  if (shown === 'address') {
    return (
      <Frame step={shown} progress={progress} subtitle={t('Unter dieser Domain ist HAPM danach per HTTPS erreichbar.')}>
        <AddressStep setup={setup} csrf={csrf} onSaved={advance} back={back('dns')} />
        {later}
      </Frame>
    );
  }

  return (
    <RunStep
      setup={setup}
      csrf={csrf}
      progress={progress}
      onChanged={setSetup}
      back={back('address')}
      later={later}
      acmeWarning={acmeWarning}
    />
  );
}

function Frame({
  step,
  title,
  subtitle,
  progress,
  children,
}: {
  step: Shown;
  title?: string;
  subtitle: string;
  progress: ReactNode;
  children: ReactNode;
}) {
  const { t } = useT();
  return (
    <AuthCard standalone className="hapm-setup" title={title ?? t(TITLES[step])} subtitle={subtitle}>
      {progress}
      <div className="auth-form">{children}</div>
    </AuthCard>
  );
}

/* ── Schritt 1: Konto ── */

function AccountStep({
  onCreated,
  onNoSession,
}: {
  onCreated: (csrfToken: string) => void;
  onNoSession: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Folgt der Konto-Adresse, bis jemand das Feld selbst anfasst.
  const [acmeEmail, setAcmeEmail] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError(t('Die Passwörter stimmen nicht überein.'));
      return;
    }
    setLoading(true);
    try {
      const data = await call<{ csrfToken: string | null }>('', '/api/setup', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, acmeEmail: acmeEmail ?? email }),
      });
      // Das Konto steht. Ohne Sitzung geht es über die Anmeldung weiter.
      if (data.csrfToken) onCreated(data.csrfToken);
      else onNoSession();
    } catch (err: unknown) {
      setError(message(err, msgid('Die Einrichtung ist fehlgeschlagen.'), t));
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="auth-field">
        <label htmlFor="name">{t('Name')}</label>
        <input
          id="name"
          type="text"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('Max Mustermann')}
          autoComplete="name"
          autoFocus
        />
      </div>
      <div className="auth-field">
        <label htmlFor="email">{t('E-Mail-Adresse')}</label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.org"
          autoComplete="email"
        />
      </div>
      <div className="auth-field">
        <label htmlFor="password">{t('Passwort')}</label>
        <input
          id="password"
          type="password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
          autoComplete="new-password"
        />
      </div>
      <div className="auth-field">
        <label htmlFor="confirmPassword">{t('Passwort wiederholen')}</label>
        <input
          id="confirmPassword"
          type="password"
          required
          minLength={10}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="••••••••••"
          autoComplete="new-password"
        />
      </div>
      <p className="auth-hint">{t('Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.')}</p>
      <div className="auth-field">
        <label htmlFor="acmeEmail">
          {t("E-Mail für Let's Encrypt")}
          <InfoHint
            text={t(
              "Mit dieser Adresse meldet acme.sh das Konto bei Let's Encrypt an, über das die Zertifikate ausgestellt werden. Vorgabe ist die Adresse Ihres Kontos."
            )}
          />
        </label>
        <input
          id="acmeEmail"
          type="email"
          required
          value={acmeEmail ?? email}
          onChange={(e) => setAcmeEmail(e.target.value)}
          placeholder="admin@example.org"
          autoComplete="email"
        />
      </div>
      {error && <div className="auth-error">{error}</div>}
      <button className="auth-submit" type="submit" disabled={loading}>
        {loading ? <span className="btn-spinner" aria-hidden="true" /> : <UserPlus size={15} />}
        {loading ? t('Konto wird angelegt…') : t('Konto anlegen')}
      </button>
    </form>
  );
}

/* ── Schritt 2: Erreichbarkeit ── */

const EXPOSURE_CHOICES: { value: Exposure; title: string; text: string; icon: ReactNode }[] = [
  {
    value: 'internal',
    title: msgid('Nur im eigenen Netz'),
    text: msgid("Let's Encrypt erreicht den Server nicht. Zertifikate kommen deshalb über Ihren DNS-Anbieter."),
    icon: <Home size={18} strokeWidth={1.5} />,
  },
  {
    value: 'public',
    title: msgid('Aus dem Internet erreichbar'),
    text: msgid(
      "Der Server muss auf Port 80 und 443 von außen erreichbar sein. Let's Encrypt prüft jede Domain über Port 80."
    ),
    icon: <Globe size={18} strokeWidth={1.5} />,
  },
];

function ExposureStep({
  setup,
  csrf,
  onSaved,
}: {
  setup: SetupView;
  csrf: string;
  onSaved: (next: SetupView) => void;
}) {
  const { t } = useT();
  const [choice, setChoice] = useState<Exposure | null>(setup.exposure);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!choice) {
      setError(t('Bitte wählen Sie eine der beiden Möglichkeiten.'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/exposure', {
        method: 'PUT',
        body: JSON.stringify({ exposure: choice }),
      });
      onSaved(data.setup);
    } catch (err: unknown) {
      setError(message(err, msgid('Die Auswahl ließ sich nicht speichern.'), t));
      setSaving(false);
    }
  }

  return (
    <>
      <div className="hapm-choices">
        {EXPOSURE_CHOICES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`hapm-choice${choice === option.value ? ' is-selected' : ''}`}
            aria-pressed={choice === option.value}
            disabled={saving}
            onClick={() => setChoice(option.value)}
          >
            {option.icon}
            <span className="hapm-choice-text">
              <strong>{t(option.title)}</strong>
              <span>{t(option.text)}</span>
            </span>
          </button>
        ))}
      </div>
      {error && <div className="auth-error">{error}</div>}
      <button className="auth-submit" type="button" disabled={saving || !choice} onClick={save}>
        {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
        {t('Weiter')}
      </button>
    </>
  );
}

/* ── Schritt 3: DNS-Anbieter ── */

function DnsStep({
  setup,
  csrf,
  onSaved,
  back,
}: {
  setup: SetupView;
  csrf: string;
  onSaved: (next: SetupView) => void;
  back: ReactNode;
}) {
  const { t } = useT();
  const configured = setup.dnsHooks ?? [];
  const [hook, setHook] = useState<string>(
    setup.dnsHook && findDnsProvider(setup.dnsHook) ? setup.dnsHook : ''
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const provider = hook ? findDnsProvider(hook) : null;

  async function send(body: Record<string, unknown>, fallback: string) {
    setError('');
    setSaving(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/dns', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      onSaved(data.setup);
    } catch (err: unknown) {
      setError(message(err, fallback, t));
      setSaving(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!provider) {
      setError(t('Bitte wählen Sie einen DNS-Anbieter.'));
      return;
    }
    const trimmed = Object.fromEntries(
      provider.fields.map((field) => [field.name, (values[field.name] ?? '').trim()])
    );
    // Dieselbe Prüfung wie in der Route.
    const invalid = validateDnsCredentials({ hook: provider.hook, values: trimmed, remove: false });
    if (invalid) {
      setError(t(invalid));
      return;
    }
    void send({ hook: provider.hook, values: trimmed }, msgid('Die Zugangsdaten ließen sich nicht speichern.'));
  }

  return (
    <form className="auth-form" onSubmit={save}>
      {configured.length > 0 && (
        <div className="hapm-setup-note">
          <span>
            {t('Schon eingerichtet: {providers}.', {
              providers: configured.map((name) => findDnsProvider(name)?.label ?? name).join(', '),
            })}
          </span>
          <div className="hapm-form-actions">
            {configured.map((name) => (
              <button
                key={name}
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={saving}
                onClick={() => void send({ keep: name }, msgid('Der Anbieter ließ sich nicht übernehmen.'))}
              >
                {t('Mit {provider} weiter', { provider: findDnsProvider(name)?.label ?? name })}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="hapm-choices">
        {DNS_PROVIDERS.map((option) => (
          <button
            key={option.hook}
            type="button"
            className={`hapm-choice${hook === option.hook ? ' is-selected' : ''}`}
            aria-pressed={hook === option.hook}
            disabled={saving}
            onClick={() => {
              setHook(option.hook);
              setValues({});
              setError('');
            }}
          >
            <ProviderLogo hook={option.hook} size={32} />
            <span className="hapm-choice-text">
              <strong>{option.label}</strong>
              {option.note && <span>{t(option.note)}</span>}
            </span>
          </button>
        ))}
      </div>

      {provider && (
        <>
          {provider.fields.map((field) => (
            <div className="auth-field" key={field.name}>
              <label htmlFor={`dns-${field.name}`}>
                {t(field.label)}
                {!field.required && ` ${t('(freiwillig)')}`}
                {field.hint && field.hint.length > LONG_TEXT && <InfoHint text={t(field.hint)} />}
              </label>
              <input
                id={`dns-${field.name}`}
                type={field.required ? 'password' : 'text'}
                value={values[field.name] ?? ''}
                onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
              />
              {field.hint && field.hint.length <= LONG_TEXT && <p className="auth-hint">{t(field.hint)}</p>}
            </div>
          ))}
          <p className="auth-hint">
            {provider.apiTokenField
              ? t('Mit dem Token stellt acme.sh Zertifikate aus. HAPM richtet damit auch die Zone unter „DNS" ein und speichert es dafür verschlüsselt.')
              : t('Der Token geht an acme.sh und wird in HAPM nicht gespeichert.')}{' '}
            <a href={provider.consoleUrl} target="_blank" rel="noreferrer">
              {t('Token bei {provider} anlegen', { provider: provider.label })}
            </a>
          </p>
        </>
      )}

      {error && <div className="auth-error">{error}</div>}

      <button className="auth-submit" type="submit" disabled={saving || !provider}>
        {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
        {saving ? t('Wird geprüft…') : t('Speichern und weiter')}
      </button>
      <div className="hapm-setup-actions">
        {back}
        {setup.exposure === 'public' && (
          <button
            className="btn btn-ghost"
            type="button"
            disabled={saving}
            onClick={() => void send({ skip: true }, msgid('Der Schritt ließ sich nicht überspringen.'))}
          >
            {t('Überspringen')}
          </button>
        )}
      </div>
    </form>
  );
}

/** Das Zeichen des Anbieters. Ein Hook ohne Datei (von Hand eingerichtet) bekommt keines. */
function ProviderLogo({ hook, size }: { hook: string; size: number }) {
  const logo = findDnsProvider(hook)?.logo;
  if (!logo) return null;
  return <Image src={logo} alt="" width={size} height={size} className="hapm-provider-logo" unoptimized />;
}

/* ── Schritt 4: Adresse der Oberfläche ── */

function verdictText(
  check: AddressCheck,
  exposure: Exposure | null,
  t: (text: Translatable, params?: Record<string, string | number>) => string
): { tone: 'alert-success' | 'alert-warning' | 'alert-info'; text: string } {
  const where = check.resolved?.join(', ') ?? '';
  const domain = check.domain;
  switch (check.verdict) {
    case 'matches':
      return { tone: 'alert-success', text: t('{domain} zeigt auf diesen Server ({where}).', { domain, where }) };
    case 'elsewhere':
      return {
        tone: 'alert-warning',
        text: t(
          '{domain} zeigt auf {where}. Das ist keine Adresse, die dieser Server selbst trägt. Hinter einer Adressumsetzung (NAT) kann das trotzdem stimmen.',
          { domain, where }
        ),
      };
    case 'unresolved':
      return {
        tone: 'alert-warning',
        text:
          exposure === 'internal'
            ? t(
                'Für {domain} sieht dieser Server keinen DNS-Eintrag. Das Zertifikat entsteht trotzdem, es wird über den DNS-Anbieter ausgestellt. Erreichbar ist die Oberfläche erst mit dem Eintrag.',
                { domain }
              )
            : t(
                "Für {domain} sieht dieser Server keinen DNS-Eintrag. Ohne den Eintrag scheitert das Zertifikat: Let's Encrypt ruft die Domain auf.",
                { domain }
              ),
      };
    default:
      return { tone: 'alert-info', text: t('Die DNS-Abfrage ist gescheitert. Ob der Eintrag stimmt, ließ sich nicht prüfen.') };
  }
}

function AddressStep({
  setup,
  csrf,
  onSaved,
  back,
}: {
  setup: SetupView;
  csrf: string;
  onSaved: (next: SetupView) => void;
  back: ReactNode;
}) {
  const { t } = useT();
  const internal = setup.exposure === 'internal';
  const dnsReady = setup.dns === 'configured';

  const [domainDraft, setDomainDraft] = useState(setup.domain ?? '');
  // Bei „intern" vorbelegt an: weitere Ziele unter der Basis brauchen dann kein neues Zertifikat.
  const [wildcard, setWildcard] = useState(setup.domain ? setup.wildcard : internal && dnsReady);
  /** Nur was getippt wurde. Sonst folgt die Basis der Domain. */
  const [baseDraft, setBaseDraft] = useState<string | null>(setup.wildcardBase);
  const [check, setCheck] = useState<AddressCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  /** Nur was getippt wurde. Sonst gilt die erste Adresse des Servers. */
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [settingRecord, setSettingRecord] = useState(false);
  const [recordNote, setRecordNote] = useState('');
  /** Gesetzt, wenn die Zone beim Anbieter liegt, die Domain aber woanders verwaltet wird. */
  const [recordUnused, setRecordUnused] = useState('');

  const domain = normalizeSetupDomain(domainDraft);
  const suggestedBase = wildcardBaseOf(domain);
  const base = normalizeSetupDomain(baseDraft ?? suggestedBase ?? '');
  const wildcardOn = dnsReady && wildcard;
  const addresses = setup.serverAddresses;
  const recordAddress = (addressDraft ?? addresses[0] ?? '').trim();
  const dnsProvider = setup.dnsHook ? findDnsProvider(setup.dnsHook) : null;
  /** Der Anbieter, bei dem die Einrichtung den Eintrag selbst setzen kann. */
  const recordProvider = setup.dnsApi ? dnsProvider : null;

  async function setRecord() {
    const invalid = validateSetupDomain(domain);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    setError('');
    setRecordNote('');
    setRecordUnused('');
    setSettingRecord(true);
    try {
      const data = await call<{
        outcome: 'created' | 'updated' | 'unchanged';
        type: string;
        zone: string;
        delegated: boolean | null;
      }>(
        csrf,
        '/api/setup/dns-record',
        { method: 'PUT', body: JSON.stringify({ domain, address: recordAddress }) }
      );
      const record = { type: data.type, domain, address: recordAddress, zone: data.zone };
      setRecordNote(
        data.outcome === 'created'
          ? t('Der Eintrag {type} {domain} → {address} ist angelegt. Die Zone {zone} steht jetzt auch unter DNS.', record)
          : data.outcome === 'updated'
            ? t('Der Eintrag {type} {domain} → {address} ist geändert. Die Zone {zone} steht jetzt auch unter DNS.', record)
            : t('Der Eintrag {type} {domain} → {address} stand schon so da. Die Zone {zone} steht jetzt auch unter DNS.', record)
      );
      setRecordUnused(
        data.delegated === false
          ? t(
              'Die Nameserver von {zone} zeigen nicht auf {provider}. Solange das so ist, wirkt der Eintrag nicht, und ein Zertifikat über DNS scheitert.',
              { zone: data.zone, provider: recordProvider?.label ?? t('diesen Anbieter') }
            )
          : ''
      );
      setCheck(null);
    } catch (err: unknown) {
      setError(message(err, msgid('Der Eintrag ließ sich nicht anlegen.'), t));
    } finally {
      setSettingRecord(false);
    }
  }

  async function runCheck() {
    const invalid = validateSetupDomain(domain);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    setError('');
    setChecking(true);
    try {
      setCheck(await call<AddressCheck>(csrf, `/api/setup/address?domain=${encodeURIComponent(domain)}`));
    } catch (err: unknown) {
      setError(message(err, msgid('Die Prüfung ist fehlgeschlagen.'), t));
    } finally {
      setChecking(false);
    }
  }

  async function send(body: Record<string, unknown>) {
    setError('');
    setSaving(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/address', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      onSaved(data.setup);
    } catch (err: unknown) {
      setError(message(err, msgid('Die Adresse ließ sich nicht speichern.'), t));
      setSaving(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const invalid = validateSetupDomain(domain) ?? (wildcardOn ? validateWildcardBase(domain, base) : null);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    void send({ domain, wildcard: wildcardOn, wildcardBase: wildcardOn ? base : null });
  }

  const verdict = check && check.domain === domain ? verdictText(check, setup.exposure, t) : null;
  const shownDomain = domain || 'hapm.example.org';

  return (
    <form className="auth-form" onSubmit={save}>
      <div className="auth-field">
        <label htmlFor="setup-domain">{t('Domain')}</label>
        <input
          id="setup-domain"
          type="text"
          inputMode="url"
          value={domainDraft}
          onChange={(e) => setDomainDraft(e.target.value)}
          placeholder="hapm.example.org"
          disabled={saving}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </div>

      {setup.publicUrl && domain && setup.publicUrl !== `https://${domain}` && (
        <div className="alert alert-warning">
          {t('Bisher gilt {url}. Eine andere Domain entwertet alle hinterlegten Passkeys.', { url: setup.publicUrl })}
        </div>
      )}

      {dnsReady && (
        <label className="hapm-switch-row">
          <span className="hapm-switch-text">
            <span>
              {t('Wildcard-Zertifikat für *.{base} ausstellen', { base: base || 'example.org' })}
              <InfoHint
                text={t(
                  'Weitere Ziele unter dieser Basis finden das Zertifikat dann vor und brauchen kein eigenes. Ausgestellt wird es über Ihren DNS-Anbieter.'
                )}
              />
            </span>
          </span>
          <span className="toggle-switch">
            <input
              type="checkbox"
              checked={wildcard}
              disabled={saving}
              onChange={(e) => setWildcard(e.target.checked)}
            />
            <span className="toggle-slider" />
          </span>
        </label>
      )}

      {wildcardOn && (
        <div className="auth-field">
          <label htmlFor="setup-base">{t('Basis der Wildcard')}</label>
          <input
            id="setup-base"
            type="text"
            value={baseDraft ?? suggestedBase ?? ''}
            onChange={(e) => setBaseDraft(e.target.value)}
            placeholder="example.org"
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      <div className="hapm-setup-note">
        <div className="hapm-setup-note-head">
          <strong>{recordProvider ? t('Der DNS-Eintrag der Oberfläche') : t('Diesen DNS-Eintrag legen Sie selbst an')}</strong>
        </div>
        <dl className="detail-grid">
          <dt>{t('Name')}</dt>
          <dd>{shownDomain}</dd>
          <dt>{t('Typ')}</dt>
          <dd>{recordAddress.includes(':') ? 'AAAA' : 'A'}</dd>
          <dt>{t('Wert')}</dt>
          <dd>
            {recordProvider ? (
              <div className="auth-field">
                <input
                  type="text"
                  value={addressDraft ?? addresses[0] ?? ''}
                  onChange={(e) => setAddressDraft(e.target.value)}
                  placeholder="192.0.2.10"
                  aria-label={t('Adresse, auf die der Eintrag zeigt')}
                  disabled={saving || settingRecord}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : (
              (addresses[0] ?? t('Die Adresse dieses Servers'))
            )}
            {addresses.length === 0 && <InfoHint text={t('Sie ließ sich nicht ermitteln.')} />}
            {addresses.length > 1 && (
              <InfoHint
                text={t('Weitere Adressen dieses Servers: {addresses}', { addresses: addresses.slice(1).join(', ') })}
              />
            )}
          </dd>
          <dt>{t('Wo')}</dt>
          {internal ? (
            <dd>
              {t('Im DNS-Server Ihres Netzes')}
              <InfoHint
                text={[
                  t('Etwa im Router, in Pi-hole oder AdGuard Home. Nur dann erreichen Geräte in Ihrem Netz die Oberfläche unter dieser Adresse.'),
                  recordProvider
                    ? t(
                        'Oder bei {provider}: die Domain zeigt dann überall auf diese interne Adresse. Manche Router verwerfen solche Antworten (Rebind-Schutz).',
                        { provider: recordProvider.label }
                      )
                    : '',
                  wildcardOn && base
                    ? t(
                        'Mit dem Wildcard-Zertifikat lohnt sich auch ein Eintrag für *.{base}: weitere Ziele sind dann ohne neuen Eintrag erreichbar.',
                        { base }
                      )
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            </dd>
          ) : (
            <dd>
              {recordProvider ? t('Bei {provider}', { provider: recordProvider.label }) : t('Bei Ihrem DNS-Anbieter')}
              <InfoHint
                text={
                  recordProvider
                    ? t('Über den Knopf unten oder von Hand. Es muss die öffentliche Adresse dieses Servers sein.')
                    : t('Es muss die öffentliche Adresse dieses Servers sein.')
                }
              />
            </dd>
          )}
        </dl>
        <div className="hapm-form-actions">
          {recordProvider && (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={saving || settingRecord || !domain || !recordAddress}
              onClick={setRecord}
            >
              {settingRecord ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <ProviderLogo hook={recordProvider.hook} size={16} />
              )}
              {t('Bei {provider} anlegen', { provider: recordProvider.label })}
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={checking || saving || !domain}
            onClick={runCheck}
          >
            {checking ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
            {t('Eintrag prüfen')}
          </button>
        </div>
      </div>

      {recordNote && <div className="alert alert-success">{recordNote}</div>}
      {recordUnused && <div className="alert alert-warning">{recordUnused}</div>}
      {verdict && <div className={`alert ${verdict.tone}`}>{verdict.text}</div>}
      {error && <div className="auth-error">{error}</div>}

      <button className="auth-submit" type="submit" disabled={saving}>
        {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
        {t('Weiter')}
      </button>
      {!internal && (
        <p className="auth-hint">
          {t('Ohne Adresse bleibt die Oberfläche unverschlüsselt auf Port {port}.', { port: setup.listenPort })}
        </p>
      )}
      <div className="hapm-setup-actions">
        {back}
        {!internal && (
          <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => void send({ skip: true })}>
            {t('Später')}
          </button>
        )}
      </div>
    </form>
  );
}

/* ── Schritt 5: Ausführen ── */

function RunStep({
  setup,
  csrf,
  progress,
  onChanged,
  back,
  later,
  acmeWarning,
}: {
  setup: SetupView;
  csrf: string;
  progress: ReactNode;
  onChanged: (next: SetupView) => void;
  back: ReactNode;
  later: ReactNode;
  acmeWarning: ReactNode;
}) {
  const { t } = useT();
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [check, setCheck] = useState<AddressCheck | null>(null);

  const outcome = executionOutcome(setup.execution);
  const domain = setup.domain ?? '';
  const exposure = setup.exposure ?? 'public';
  const domains = certificateDomains(setup);
  const overDns = needsDnsChallenge(domains, exposure);
  const providerLabel =
    (setup.dnsHook && findDnsProvider(setup.dnsHook)?.label) || setup.dnsHook || t('Ihrem DNS-Anbieter');

  // Vor dem Ausführen noch einmal sagen, worauf die Domain zeigt.
  useEffect(() => {
    if (outcome !== 'idle' || !domain) return;
    let live = true;
    call<AddressCheck>(csrf, `/api/setup/address?domain=${encodeURIComponent(domain)}`)
      .then((result) => {
        if (live) setCheck(result);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [csrf, domain, outcome]);

  async function start() {
    setError('');
    setStarting(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/run', { method: 'POST' });
      onChanged(data.setup);
    } catch (err: unknown) {
      setError(message(err, msgid('Die Einrichtung ließ sich nicht starten.'), t));
    } finally {
      setStarting(false);
    }
  }

  if (outcome === 'succeeded') {
    return (
      <Frame
        step="run"
        title={t('HAPM ist eingerichtet')}
        subtitle={t('Unter der neuen Adresse melden Sie sich einmal neu an.')}
        progress={progress}
      >
        <Stages setup={setup} />
        <a className="auth-submit" href={`https://${domain}`}>
          <ExternalLink size={15} />
          {t('HAPM unter {url} öffnen', { url: `https://${domain}` })}
        </a>
        {exposure === 'internal' && (
          <p className="auth-hint">
            {t('Öffnet sich die Adresse nicht, fehlt der Eintrag für {domain} im DNS-Server Ihres Netzes.', { domain })}
          </p>
        )}
        <p className="auth-footer">
          <Link href="/dashboard">{t('Weiter mit der bisherigen Adresse')}</Link>
        </p>
      </Frame>
    );
  }

  const verdict = check && check.domain === domain ? verdictText(check, setup.exposure, t) : null;

  return (
    <Frame
      step="run"
      subtitle={
        outcome === 'running'
          ? t('Das dauert einige Minuten. Die Seite dürfen Sie neu laden.')
          : t('HAPM legt jetzt an, was Sie gewählt haben.')
      }
      progress={progress}
    >
      {outcome === 'idle' && (
        <>
          {acmeWarning}
          <div className="hapm-setup-note">
            <dl className="detail-grid">
              <dt>{t('Zertifikat')}</dt>
              <dd>
                {domains.map((name) => (
                  <div key={name}>{name}</div>
                ))}
              </dd>
              <dt>{t('Ausstellung')}</dt>
              <dd>
                {overDns ? (
                  <span className="hapm-provider">
                    {setup.dnsHook && <ProviderLogo hook={setup.dnsHook} size={18} />}
                    {t('über DNS bei {provider}', { provider: providerLabel })}
                  </span>
                ) : (
                  t("über HTTP auf Port 80, Let's Encrypt ruft die Domain auf")
                )}
              </dd>
              {setup.dnsZone && (
                <>
                  <dt>{t('DNS-Zone')}</dt>
                  <dd>
                    {setup.dnsZone}
                    <div className="detail-sub">{t('steht unter „DNS“ und lässt sich dort verwalten')}</div>
                  </dd>
                </>
              )}
              <dt>{t('Gruppe')}</dt>
              <dd>{SETUP_SCOPE}</dd>
              <dt>{t('Ziel')}</dt>
              <dd>
                {domain}
                <div className="detail-sub">
                  {t('leitet an {target}, die Oberfläche von HAPM', { target: `127.0.0.1:${setup.listenPort}` })}
                </div>
              </dd>
            </dl>
          </div>
          {verdict && verdict.tone !== 'alert-success' && (
            <div className={`alert ${verdict.tone}`}>{verdict.text}</div>
          )}
        </>
      )}

      {outcome !== 'idle' && <Stages setup={setup} />}

      {outcome === 'failed' && (
        <div className="auth-error">
          {t(
            'Die Einrichtung ist nicht durchgelaufen. Ihr Konto und alles, was oben einen Haken trägt, bleiben bestehen. Sie können die Eingaben ändern und es erneut versuchen.'
          )}
        </div>
      )}
      {error && <div className="auth-error">{error}</div>}

      {outcome !== 'running' && (
        <>
          <button className="auth-submit" type="button" disabled={starting} onClick={start}>
            {starting ? (
              <span className="btn-spinner" aria-hidden="true" />
            ) : outcome === 'failed' ? (
              <RefreshCw size={15} />
            ) : (
              <Play size={15} />
            )}
            {outcome === 'failed' ? t('Erneut versuchen') : t('Jetzt einrichten')}
          </button>
          <div className="hapm-setup-actions">{back}</div>
        </>
      )}
      {later}
    </Frame>
  );
}

function Stages({ setup }: { setup: SetupView }) {
  const { t } = useT();
  const stages = setup.execution?.stages ?? [];
  return (
    <ul className="hapm-steps">
      {stages.map((stage) => {
        const state =
          stage.status === 'ok'
            ? 'is-ok'
            : stage.status === 'error'
              ? 'is-failed'
              : stage.status === 'running'
                ? 'is-running'
                : 'is-pending';
        return (
          <li key={stage.key} className={`hapm-step ${state}`}>
            {stage.status === 'ok' ? (
              <Check size={14} strokeWidth={1.5} />
            ) : stage.status === 'error' ? (
              <X size={14} strokeWidth={1.5} />
            ) : stage.status === 'running' ? (
              <Loader2 size={14} strokeWidth={1.5} className="spin" />
            ) : (
              <Circle size={14} strokeWidth={1.5} />
            )}
            <span className="hapm-step-text">
              <span className="hapm-step-label">{t(STAGE_LABELS[stage.key], { scope: SETUP_SCOPE })}</span>
              {/* Gespeichert auf Deutsch: ein Satz ohne eingesetzte Werte wird hier nachgeschlagen. */}
              {stage.detail && <span className="hapm-step-detail">{t(stage.detail)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
