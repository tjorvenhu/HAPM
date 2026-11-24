'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
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
import { DNS_PROVIDERS, findDnsProvider, validateDnsCredentials } from '@/lib/haproxy/dns-credentials';
import { needsDnsChallenge } from '@/lib/haproxy/challenge';
import {
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
  account: 'HAPM einrichten',
  exposure: 'Erreichbarkeit',
  dns: 'DNS-Anbieter',
  address: 'Adresse der Oberfläche',
  run: 'Einrichten',
};

/** `fetch` mit CSRF-Token. Die Seite steht außerhalb des Rahmens, `useApp()` gibt es hier nicht. */
async function call<T>(csrf: string, url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (init?.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { ...init, headers, cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(body?.error || 'Die Anfrage ist fehlgeschlagen.');
  return body.data as T;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export default function SetupPage() {
  const router = useRouter();
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
      // „Einrichtung erneut öffnen" beginnt vorn, nicht beim letzten Schritt.
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
      <AuthCard standalone className="hapm-setup" title="HAPM einrichten">
        <div className="skeleton shell-skeleton--row" />
        <div className="skeleton shell-skeleton--row" />
      </AuthCard>
    );
  }

  const index = SETUP_STEPS.indexOf(shown);
  const progress = (
    <div className="hapm-setup-progress">
      <span>
        Schritt {index + 1} von {SETUP_STEPS.length}
      </span>
      <div className="hapm-setup-bar">
        <i style={{ width: `${((index + 1) / SETUP_STEPS.length) * 100}%` }} />
      </div>
    </div>
  );

  const back = (to: Shown) => (
    <button className="btn btn-ghost" type="button" onClick={() => setShown(to)}>
      <ArrowLeft size={15} />
      Zurück
    </button>
  );

  const later = (
    <p className="auth-footer">
      <Link href="/dashboard">Später fertig machen</Link>
    </p>
  );

  const acmeWarning = setup?.acmeReady === false && (
    <div className="alert alert-warning">
      acme.sh ist nicht eingerichtet. Solange das so ist, lassen sich keine Zertifikate ausstellen.
      Der Grund steht in der Übersicht.
    </div>
  );

  if (shown === 'account') {
    return (
      <Frame step={shown} progress={progress} subtitle="Legen Sie zuerst das Konto an, mit dem Sie HAPM verwalten.">
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
      <Frame step={shown} progress={progress} subtitle="Davon hängt ab, wie HAPM Zertifikate ausstellt.">
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
            ? 'Über ihn stellt HAPM jedes Zertifikat aus.'
            : 'Nur nötig für Wildcard-Zertifikate.'
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
      <Frame step={shown} progress={progress} subtitle="Unter dieser Domain ist HAPM danach per HTTPS erreichbar.">
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
  return (
    <AuthCard standalone className="hapm-setup" title={title ?? TITLES[step]} subtitle={subtitle}>
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
      setError('Die Passwörter stimmen nicht überein.');
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
      setError(message(err, 'Die Einrichtung ist fehlgeschlagen.'));
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="auth-field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Max Mustermann"
          autoComplete="name"
          autoFocus
        />
      </div>
      <div className="auth-field">
        <label htmlFor="email">E-Mail-Adresse</label>
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
        <label htmlFor="password">Passwort</label>
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
        <label htmlFor="confirmPassword">Passwort wiederholen</label>
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
      <p className="auth-hint">Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.</p>
      <div className="auth-field">
        <label htmlFor="acmeEmail">
          E-Mail für Let&apos;s Encrypt
          <InfoHint text="Mit dieser Adresse meldet acme.sh das Konto bei Let's Encrypt an, über das die Zertifikate ausgestellt werden. Vorgabe ist die Adresse Ihres Kontos." />
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
        {loading ? 'Konto wird angelegt…' : 'Konto anlegen'}
      </button>
    </form>
  );
}

/* ── Schritt 2: Erreichbarkeit ── */

const EXPOSURE_CHOICES: { value: Exposure; title: string; text: string; icon: ReactNode }[] = [
  {
    value: 'internal',
    title: 'Nur im eigenen Netz',
    text: "Let's Encrypt erreicht den Server nicht. Zertifikate kommen deshalb über Ihren DNS-Anbieter.",
    icon: <Home size={18} strokeWidth={1.5} />,
  },
  {
    value: 'public',
    title: 'Aus dem Internet erreichbar',
    text: "Der Server muss auf Port 80 und 443 von außen erreichbar sein. Let's Encrypt prüft jede Domain über Port 80.",
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
  const [choice, setChoice] = useState<Exposure | null>(setup.exposure);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!choice) {
      setError('Bitte wählen Sie eine der beiden Möglichkeiten.');
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
      setError(message(err, 'Die Auswahl ließ sich nicht speichern.'));
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
              <strong>{option.title}</strong>
              <span>{option.text}</span>
            </span>
          </button>
        ))}
      </div>
      {error && <div className="auth-error">{error}</div>}
      <button className="auth-submit" type="button" disabled={saving || !choice} onClick={save}>
        {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
        Weiter
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
      setError(message(err, fallback));
      setSaving(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!provider) {
      setError('Bitte wählen Sie einen DNS-Anbieter.');
      return;
    }
    const trimmed = Object.fromEntries(
      provider.fields.map((field) => [field.name, (values[field.name] ?? '').trim()])
    );
    // Dieselbe Prüfung wie in der Route.
    const invalid = validateDnsCredentials({ hook: provider.hook, values: trimmed, remove: false });
    if (invalid) {
      setError(invalid);
      return;
    }
    void send({ hook: provider.hook, values: trimmed }, 'Die Zugangsdaten ließen sich nicht speichern.');
  }

  return (
    <form className="auth-form" onSubmit={save}>
      {configured.length > 0 && (
        <div className="hapm-setup-note">
          <span>Schon eingerichtet: {configured.map((name) => findDnsProvider(name)?.label ?? name).join(', ')}.</span>
          <div className="hapm-form-actions">
            {configured.map((name) => (
              <button
                key={name}
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={saving}
                onClick={() => void send({ keep: name }, 'Der Anbieter ließ sich nicht übernehmen.')}
              >
                Mit {findDnsProvider(name)?.label ?? name} weiter
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
            <span className="hapm-choice-text">
              <strong>{option.label}</strong>
              {option.note && <span>{option.note}</span>}
            </span>
          </button>
        ))}
      </div>

      {provider && (
        <>
          {provider.fields.map((field) => (
            <div className="auth-field" key={field.name}>
              <label htmlFor={`dns-${field.name}`}>
                {field.label}
                {!field.required && ' (freiwillig)'}
                {field.hint && field.hint.length > LONG_TEXT && <InfoHint text={field.hint} />}
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
              {field.hint && field.hint.length <= LONG_TEXT && <p className="auth-hint">{field.hint}</p>}
            </div>
          ))}
          <p className="auth-hint">
            Der Token geht an acme.sh und wird in HAPM nicht gespeichert.{' '}
            <a href={provider.consoleUrl} target="_blank" rel="noreferrer">
              Token bei {provider.label} anlegen
            </a>
          </p>
        </>
      )}

      {error && <div className="auth-error">{error}</div>}

      <button className="auth-submit" type="submit" disabled={saving || !provider}>
        {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
        {saving ? 'Wird geprüft…' : 'Speichern und weiter'}
      </button>
      <div className="hapm-setup-actions">
        {back}
        {setup.exposure === 'public' && (
          <button
            className="btn btn-ghost"
            type="button"
            disabled={saving}
            onClick={() => void send({ skip: true }, 'Der Schritt ließ sich nicht überspringen.')}
          >
            Überspringen
          </button>
        )}
      </div>
    </form>
  );
}

/* ── Schritt 4: Adresse der Oberfläche ── */

function verdictText(
  check: AddressCheck,
  exposure: Exposure | null
): { tone: 'alert-success' | 'alert-warning' | 'alert-info'; text: string } {
  const where = check.resolved?.join(', ') ?? '';
  switch (check.verdict) {
    case 'matches':
      return { tone: 'alert-success', text: `${check.domain} zeigt auf diesen Server (${where}).` };
    case 'elsewhere':
      return {
        tone: 'alert-warning',
        text:
          `${check.domain} zeigt auf ${where}. Das ist keine Adresse, die dieser Server selbst trägt. ` +
          'Hinter einer Adressumsetzung (NAT) kann das trotzdem stimmen.',
      };
    case 'unresolved':
      return {
        tone: 'alert-warning',
        text:
          `Für ${check.domain} sieht dieser Server keinen DNS-Eintrag. ` +
          (exposure === 'internal'
            ? 'Das Zertifikat entsteht trotzdem, es wird über den DNS-Anbieter ausgestellt. Erreichbar ist die Oberfläche erst mit dem Eintrag.'
            : "Ohne den Eintrag scheitert das Zertifikat: Let's Encrypt ruft die Domain auf."),
      };
    default:
      return { tone: 'alert-info', text: 'Die DNS-Abfrage ist gescheitert. Ob der Eintrag stimmt, ließ sich nicht prüfen.' };
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

  const domain = normalizeSetupDomain(domainDraft);
  const suggestedBase = wildcardBaseOf(domain);
  const base = normalizeSetupDomain(baseDraft ?? suggestedBase ?? '');
  const wildcardOn = dnsReady && wildcard;
  const addresses = setup.serverAddresses;

  async function runCheck() {
    const invalid = validateSetupDomain(domain);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError('');
    setChecking(true);
    try {
      setCheck(await call<AddressCheck>(csrf, `/api/setup/address?domain=${encodeURIComponent(domain)}`));
    } catch (err: unknown) {
      setError(message(err, 'Die Prüfung ist fehlgeschlagen.'));
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
      setError(message(err, 'Die Adresse ließ sich nicht speichern.'));
      setSaving(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const invalid = validateSetupDomain(domain) ?? (wildcardOn ? validateWildcardBase(domain, base) : null);
    if (invalid) {
      setError(invalid);
      return;
    }
    void send({ domain, wildcard: wildcardOn, wildcardBase: wildcardOn ? base : null });
  }

  const verdict = check && check.domain === domain ? verdictText(check, setup.exposure) : null;
  const shownDomain = domain || 'hapm.example.org';

  return (
    <form className="auth-form" onSubmit={save}>
      <div className="auth-field">
        <label htmlFor="setup-domain">Domain</label>
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
          Bisher gilt {setup.publicUrl}. Eine andere Domain entwertet alle hinterlegten Passkeys.
        </div>
      )}

      {dnsReady && (
        <label className="hapm-switch-row">
          <span className="hapm-switch-text">
            <span>
              Wildcard-Zertifikat für *.{base || 'example.org'} ausstellen
              <InfoHint text="Weitere Ziele unter dieser Basis finden das Zertifikat dann vor und brauchen kein eigenes. Ausgestellt wird es über Ihren DNS-Anbieter." />
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
          <label htmlFor="setup-base">Basis der Wildcard</label>
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
        <strong>Diesen DNS-Eintrag legen Sie selbst an:</strong>
        {addresses.length > 0 ? (
          <code>
            {shownDomain} → {addresses[0]}
          </code>
        ) : (
          <span>Die Adresse dieses Servers ließ sich nicht ermitteln. Der Eintrag zeigt auf sie.</span>
        )}
        {addresses.length > 1 && (
          <span>Weitere Adressen dieses Servers: {addresses.slice(1).join(', ')}.</span>
        )}
        {!internal && <span>Es muss die öffentliche Adresse dieses Servers sein.</span>}
        <div className="hapm-form-actions">
          <button className="btn btn-secondary btn-sm" type="button" disabled={checking || saving || !domain} onClick={runCheck}>
            {checking ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
            Eintrag prüfen
          </button>
        </div>
      </div>

      {verdict && <div className={`alert ${verdict.tone}`}>{verdict.text}</div>}
      {error && <div className="auth-error">{error}</div>}

      <button className="auth-submit" type="submit" disabled={saving}>
        {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
        Weiter
      </button>
      {!internal && (
        <p className="auth-hint">
          Ohne Adresse bleibt die Oberfläche unverschlüsselt auf Port {setup.listenPort}.
        </p>
      )}
      <div className="hapm-setup-actions">
        {back}
        {!internal && (
          <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => void send({ skip: true })}>
            Später
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
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [check, setCheck] = useState<AddressCheck | null>(null);

  const outcome = executionOutcome(setup.execution);
  const domain = setup.domain ?? '';
  const exposure = setup.exposure ?? 'public';
  const domains = certificateDomains(setup);
  const overDns = needsDnsChallenge(domains, exposure);

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
      setError(message(err, 'Die Einrichtung ließ sich nicht starten.'));
    } finally {
      setStarting(false);
    }
  }

  if (outcome === 'succeeded') {
    return (
      <Frame
        step="run"
        title="HAPM ist eingerichtet"
        subtitle="Unter der neuen Adresse melden Sie sich einmal neu an."
        progress={progress}
      >
        <Stages setup={setup} />
        <a className="auth-submit" href={`https://${domain}`}>
          <ExternalLink size={15} />
          HAPM unter https://{domain} öffnen
        </a>
        <p className="auth-footer">
          <Link href="/dashboard">Weiter mit der bisherigen Adresse</Link>
        </p>
      </Frame>
    );
  }

  const verdict = check && check.domain === domain ? verdictText(check, setup.exposure) : null;

  return (
    <Frame
      step="run"
      subtitle={
        outcome === 'running'
          ? 'Das dauert einige Minuten. Die Seite dürfen Sie neu laden.'
          : 'HAPM legt jetzt an, was Sie gewählt haben.'
      }
      progress={progress}
    >
      {outcome === 'idle' && (
        <>
          {acmeWarning}
          <div className="hapm-setup-note">
            <span>
              Zertifikat für <code>{domains.join(', ')}</code>,{' '}
              {overDns ? `über DNS (${setup.dnsHook ?? 'DNS-Anbieter'})` : 'über HTTP auf Port 80'}.
            </span>
            <span>
              Ziel in der Gruppe HAPM: <code>{domain} → 127.0.0.1:{setup.listenPort}</code>
            </span>
          </div>
          {verdict && verdict.tone !== 'alert-success' && (
            <div className={`alert ${verdict.tone}`}>{verdict.text}</div>
          )}
        </>
      )}

      {outcome !== 'idle' && <Stages setup={setup} />}

      {outcome === 'failed' && (
        <div className="auth-error">
          Die Einrichtung ist nicht durchgelaufen. Ihr Konto und alles, was oben einen Haken trägt,
          bleiben bestehen. Sie können die Eingaben ändern und es erneut versuchen.
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
            {outcome === 'failed' ? 'Erneut versuchen' : 'Jetzt einrichten'}
          </button>
          <div className="hapm-setup-actions">{back}</div>
        </>
      )}
      {later}
    </Frame>
  );
}

function Stages({ setup }: { setup: SetupView }) {
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
              <span className="hapm-step-label">{STAGE_LABELS[stage.key]}</span>
              {stage.detail && <span className="hapm-step-detail">{stage.detail}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
