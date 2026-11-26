'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  Globe,
  Home,
  Loader2,
  Play,
  RefreshCw,
  Plus,
  Search,
  Send,
  Server,
  ShieldCheck,
  Upload,
  UserPlus,
  Waypoints,
  X,
} from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import AuthFormSkeleton from '@/ui/auth/AuthFormSkeleton';
import { SetupStepper } from './SetupStepper';
import { SetupSuccess } from './SetupSuccess';
import { InfoHint } from '@/ui/primitives/InfoHint';
import BrandLogo from '@/components/BrandLogo';
import Select from '@/components/Select';
import IpAllowList from '@/components/IpAllowList';
import FormHint from '@/components/FormHint';
import CredentialFields from '@/components/dns/CredentialFields';
import { ProviderLogo as DnsProviderLogo } from '@/components/dns/ProviderName';
import { usePolling } from '@/components/usePolling';
import CertificateUploadDialog, { type UploadBody } from '@/components/reverse-proxy/CertificateUploadDialog';
import { useToast } from '@/components/Toast';
import { useT } from '@/lib/i18n/react';
import { msgid, type Translatable } from '@/lib/i18n/translate';
import { formatDate } from '@/lib/i18n/format';
import {
  DNS_PROVIDERS,
  findDnsProvider,
  hasCredentialForm,
  validateDnsCredentials,
} from '@/lib/haproxy/dns-credentials';
import { dnsProviderForHook } from '@/lib/dns/zones';
import { needsDnsChallenge } from '@/lib/haproxy/challenge';
import { normalizeAcmeDirectory, validateAcmeDirectory, validateEab } from '@/lib/acme-server';
import { SMTP_DEFAULT_PORTS, SMTP_SECURITY_CHOICES } from '@/lib/mail/config';
import {
  SETUP_SCOPE,
  SETUP_STEPS,
  STAGE_LABELS,
  certificateDomains,
  certificateFactsOf,
  certificatePathOpen,
  executionOutcome,
  isPublicAddress,
  normalizeSetupDomain,
  normalizeSurfaceIps,
  stepReached,
  validateSetupDomain,
  validateSurfaceIps,
  validateWildcardBase,
  wildcardBaseOf,
  wildcardPossible,
  type SetupStep,
} from '@/lib/setup/rules';
// Nur die Typen: die Dateien dahinter erreichen `lib/db`.
import type { SetupView } from '@/lib/setup';
import type { AddressCheck } from '@/lib/setup/address';
import type { TestMailResult } from '@/lib/notifications';
import type { Exposure, SmtpSecurity } from '@/lib/types';

/**
 * Die Einrichtung: Konto, Erreichbarkeit, DNS-Anbieter, Zertifikate,
 * SMTP-Konto, Adresse der Oberfläche, Ausführen. Eine Seite, damit ein Neuladen an derselben Stelle weitergeht:
 * welcher Schritt dran ist, sagt `GET /api/setup` (`resumeStep`), nicht ein
 * Zustand im Browser.
 *
 * Das Konto besteht nach Schritt 1. Alles danach lässt sich abbrechen und
 * später fortsetzen, die Übersicht erinnert daran.
 */

type Shown = Exclude<SetupStep, 'done'>;

const POLL_MS = 3000;

/** Die kurzen Namen der Schritte in der Schrittanzeige. */
const STEP_LABELS: Record<Shown, string> = {
  account: msgid('Konto'),
  exposure: msgid('Erreichbarkeit'),
  dns: msgid('DNS'),
  certificates: msgid('Zertifikate'),
  mail: msgid('E-Mail'),
  address: msgid('Adresse'),
  run: msgid('Einrichten'),
};

const TITLES: Record<Shown, string> = {
  account: msgid('HAPM einrichten'),
  exposure: msgid('Erreichbarkeit'),
  dns: msgid('DNS-Anbieter'),
  certificates: msgid('Zertifikate'),
  mail: msgid('SMTP-Konto'),
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
  /** In welche Richtung der nächste Schritt hereingleitet. */
  const [motion, setMotion] = useState<'forward' | 'back'>('forward');

  /** Den Stand übernehmen und beim nächsten offenen Schritt weitermachen. */
  const advance = useCallback(
    (next: SetupView) => {
      setSetup(next);
      setMotion('forward');
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
        <AuthFormSkeleton />
      </AuthCard>
    );
  }

  const index = SETUP_STEPS.indexOf(shown);
  const progress = (
    <SetupStepper labels={SETUP_STEPS.map((step) => t(STEP_LABELS[step]))} current={index} />
  );

  // „Später“ führt zur Übersicht, die Einrichtung bleibt offen und die
  // Übersicht erinnert daran. Er steht als Knopf neben „Zurück“, unter dem
  // Hauptknopf; ein Textlink darunter kostete eine Zeile mehr.
  const later = (
    <Link className="btn btn-secondary hapm-setup-later" href="/dashboard">
      {t('Später')}
    </Link>
  );

  const back = (to: Shown) => (
    <>
      <button
        className="btn btn-secondary hapm-setup-back"
        type="button"
        onClick={() => {
          setMotion('back');
          setShown(to);
        }}
      >
        <ArrowLeft size={15} />
        {t('Zurück')}
      </button>
      {later}
    </>
  );

  // Bei „nur hochladen" stellt acme.sh ohnehin nichts aus.
  const acmeWarning = setup?.acmeReady === false && setup.certificateSource !== 'upload' && (
    <div className="alert alert-warning">
      {t('acme.sh ist nicht eingerichtet. Solange das so ist, lassen sich keine Zertifikate ausstellen. Der Grund steht in der Übersicht.')}
    </div>
  );

  if (shown === 'account') {
    return (
      <Frame step={shown} motion={motion} progress={progress} subtitle={t('Legen Sie zuerst das Konto an, mit dem Sie HAPM verwalten.')}>
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
      <Frame
        step={shown}
        motion={motion}
        progress={progress}
        subtitle={
          <>
            {t('Davon hängt ab, wie HAPM Zertifikate ausstellt.')}
            <InfoHint
              text={t(
                "Im eigenen Netz erreicht Let's Encrypt den Server nicht, Zertifikate kommen deshalb über Ihren DNS-Anbieter. Im Internet prüft Let's Encrypt jede Domain über Port 80."
              )}
            />
          </>
        }
      >
        {acmeWarning}
        <ExposureStep setup={setup} csrf={csrf} onSaved={advance} later={later} />
      </Frame>
    );
  }

  if (shown === 'dns') {
    return (
      <Frame
        step={shown}
        motion={motion}
        progress={progress}
        subtitle={t('Wo die DNS-Einträge Ihrer Domains stehen.')}
      >
        {acmeWarning}
        <DnsStep setup={setup} csrf={csrf} onSaved={advance} back={back('exposure')} />
      </Frame>
    );
  }

  if (shown === 'certificates') {
    return (
      <Frame step={shown} motion={motion} progress={progress} subtitle={t('Woher HAPM die Zertifikate für Ihre Domains bekommt.')}>
        <CertificatesStep setup={setup} csrf={csrf} onSaved={advance} back={back('dns')} />
      </Frame>
    );
  }

  if (shown === 'mail') {
    return (
      <Frame
        step={shown}
        motion={motion}
        progress={progress}
        subtitle={
          <>
            {t('Für Passkeys, „Passwort vergessen“ und Benachrichtigungen.')}
            <InfoHint
              text={t(
                'Über dieses Konto verschickt HAPM alle Mails. Passkeys gibt es nur mit SMTP-Konto: wird einer hinterlegt oder entfernt, erfährt es der Inhaber per Mail, und wer sein Gerät verliert, setzt sein Passwort per Mail zurück. Ohne Server geht es mit „Überspringen“ weiter. Einrichten lässt sich das Konto jederzeit unter „Benachrichtigungen“.'
              )}
            />
          </>
        }
      >
        <MailStep setup={setup} csrf={csrf} onSaved={advance} onChanged={setSetup} back={back('certificates')} />
      </Frame>
    );
  }

  if (shown === 'address') {
    return (
      <Frame step={shown} motion={motion} progress={progress} subtitle={t('Unter dieser Domain ist HAPM danach per HTTPS erreichbar.')}>
        <AddressStep setup={setup} csrf={csrf} onSaved={advance} back={back('mail')} />
      </Frame>
    );
  }

  return (
    <RunStep
      setup={setup}
      csrf={csrf}
      motion={motion}
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
  motion = 'forward',
  children,
}: {
  step: Shown;
  title?: string;
  subtitle: ReactNode;
  progress: ReactNode;
  motion?: 'forward' | 'back';
  children: ReactNode;
}) {
  const { t } = useT();
  return (
    <AuthCard standalone className="hapm-setup" title={title ?? t(TITLES[step])} subtitle={subtitle}>
      {progress}
      {/* Der Schlüssel macht aus jedem Schritt ein neues Element, und nur ein neues gleitet herein. */}
      <div key={step} className={motion === 'back' ? 'auth-form hapm-step-enter is-back' : 'auth-form hapm-step-enter'}>
        {children}
      </div>
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
  const { notify } = useToast();
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
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Die Einrichtung ist fehlgeschlagen.'), t) });
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="hapm-setup-pair">
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
      </div>
      <div className="hapm-setup-pair">
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
      {error && <FormHint>{error}</FormHint>}
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
    text: msgid("Let's Encrypt erreicht den Server nicht. Zertifikate kommen über DNS."),
    icon: <Home size={18} strokeWidth={1.5} />,
  },
  {
    value: 'public',
    title: msgid('Aus dem Internet erreichbar'),
    text: msgid('Port 80 und 443 müssen von außen erreichbar sein.'),
    icon: <Globe size={18} strokeWidth={1.5} />,
  },
];

function ExposureStep({
  setup,
  csrf,
  onSaved,
  later,
}: {
  setup: SetupView;
  csrf: string;
  onSaved: (next: SetupView) => void;
  later: ReactNode;
}) {
  const { t } = useT();
  const [choice, setChoice] = useState<Exposure | null>(setup.exposure);
  /** Aus dem Internet schlägt der Assistent CrowdSec für alle Ziele vor. */
  const [crowdsec, setCrowdsec] = useState(setup.crowdsec ?? true);
  const [error, setError] = useState('');
  const { notify } = useToast();
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
        body: JSON.stringify({ exposure: choice, crowdsec }),
      });
      onSaved(data.setup);
    } catch (err: unknown) {
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Die Auswahl ließ sich nicht speichern.'), t) });
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
            {choice === option.value && (
              <span className="hapm-choice-check">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
          </button>
        ))}
      </div>
      {choice === 'public' && setup.crowdsecInStack && (
        <label className="hapm-switch-row">
          <span className="hapm-switch-text">
            <span>
              <BrandLogo brand="crowdsec" size={16} />
              {t('CrowdSec (WAF) für alle Ziele einschalten')}
              <InfoHint
                text={t(
                  'Empfohlen für einen Server im Internet. CrowdSec prüft jede Anfrage auf bekannte Angriffe und sperrt Adressen, die scannen oder Passwörter raten. Abgelehnt wird mit 403. Später unter Reverse-Proxy, CrowdSec zu ändern, auch je Ziel.'
                )}
              />
            </span>
          </span>
          <span className="toggle-switch">
            <input
              type="checkbox"
              checked={crowdsec}
              disabled={saving}
              onChange={(e) => setCrowdsec(e.target.checked)}
            />
            <span className="toggle-slider" />
          </span>
        </label>
      )}
      {error && <FormHint>{error}</FormHint>}
      <div className="hapm-setup-nav">
        {later}
        <button className="auth-submit" type="button" disabled={saving || !choice} onClick={save}>
          {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
          {t('Weiter')}
        </button>
      </div>
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
  /** Ein Hook aus `DNS_PROVIDERS` oder `MANUAL_DNS` für den eigenen DNS-Server. */
  const [hook, setHook] = useState<string>(
    setup.dns === 'manual' ? MANUAL_DNS : setup.dnsHook && findDnsProvider(setup.dnsHook) ? setup.dnsHook : ''
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const { notify } = useToast();
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
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, fallback, t) });
      setSaving(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (hook === MANUAL_DNS) {
      void send({ manual: true }, msgid('Die Auswahl ließ sich nicht speichern.'));
      return;
    }
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

      <div className="hapm-choices hapm-choices-three">
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
            {hook === option.hook && (
              <span className="hapm-choice-check">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className={`hapm-choice${hook === MANUAL_DNS ? ' is-selected' : ''}`}
          aria-pressed={hook === MANUAL_DNS}
          disabled={saving}
          onClick={() => {
            setHook(MANUAL_DNS);
            setValues({});
            setError('');
          }}
        >
          <Server size={18} strokeWidth={1.5} />
          <span className="hapm-choice-text">
            <strong>{t('Eigener DNS-Server')}</strong>
            <span>{t('HAPM legt keine Einträge an und nennt Ihnen, was Sie eintragen.')}</span>
          </span>
          {hook === MANUAL_DNS && (
            <span className="hapm-choice-check">
              <Check size={12} strokeWidth={3} />
            </span>
          )}
        </button>
      </div>

      {hook === MANUAL_DNS && (
        <div className="alert alert-info">
          {setup.exposure === 'internal'
            ? t("Ohne Anbieter mit API erreicht Let's Encrypt diesen Server nicht. Im nächsten Schritt wählen Sie einen eigenen ACME-Server oder hochgeladene Zertifikate.")
            : t("Zertifikate kommen weiter von Let's Encrypt über Port 80. Eine Wildcard geht ohne Anbieter mit API nur als hochgeladenes Zertifikat.")}
        </div>
      )}

      {provider && (
        <>
          <div className="hapm-setup-pair">
            <CredentialFields
              fields={provider.fields}
              values={values}
              onChange={(field, value) => setValues((before) => ({ ...before, [field]: value }))}
              skin="auth"
              idPrefix="dns"
              disabled={saving}
            />
          </div>
          <p className="auth-hint">
            {hasCredentialForm(provider) ? (
              <>
                {t('HAPM speichert die Zugangsdaten verschlüsselt.')}
                <InfoHint
                  text={t(
                    'Mit den Zugangsdaten stellt acme.sh Zertifikate aus. HAPM richtet damit auch die Zone unter „DNS“ ein und speichert sie dafür verschlüsselt.'
                  )}
                />
              </>
            ) : provider.apiTokenField ? (
              <>
                {t('HAPM speichert den Token verschlüsselt.')}
                <InfoHint
                  text={t(
                    'Mit dem Token stellt acme.sh Zertifikate aus. HAPM richtet damit auch die Zone unter „DNS“ ein und speichert ihn dafür verschlüsselt.'
                  )}
                />
              </>
            ) : (
              t('Der Token geht an acme.sh und wird in HAPM nicht gespeichert.')
            )}
            {provider.consoleUrl && (
              <>
                {' '}
                <a href={provider.consoleUrl} target="_blank" rel="noreferrer">
                  {t('Token bei {provider} anlegen', { provider: provider.label })}
                </a>
              </>
            )}
          </p>
        </>
      )}

      {error && <FormHint>{error}</FormHint>}

      <div className="hapm-setup-nav">
        {back}
        <button className="auth-submit" type="submit" disabled={saving || !hook}>
          {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
          {saving && provider ? t('Wird geprüft…') : hook === MANUAL_DNS ? t('Weiter') : t('Speichern und weiter')}
        </button>
      </div>
    </form>
  );
}

/**
 * Der eigene DNS-Server als dritte Karte. Kein Hook: HAPM richtet dann bei
 * keinem Anbieter etwas ein und nennt die Einträge (`dns: 'manual'`). Er
 * ersetzt „Überspringen", das dasselbe hieß, nur ohne es zu sagen.
 */
const MANUAL_DNS = 'manual';

/**
 * Das Zeichen des Anbieters, oder sein Symbol, wenn er kein eigenes hat
 * (`components/dns/ProviderName.tsx`). Ein Hook, den HAPM nicht kennt (von Hand
 * eingerichtet), bekommt keines.
 */
function ProviderLogo({ hook, size }: { hook: string; size: number }) {
  const provider = dnsProviderForHook(hook);
  return provider ? <DnsProviderLogo provider={provider} size={size} /> : null;
}

/* ── Schritt 4: Zertifikate ── */

type CertificateChoice = 'letsencrypt' | 'custom' | 'upload';

function CertificatesStep({
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
  // Let's Encrypt erreicht eine interne Installation nur über DNS-01.
  const letsEncryptPossible = !internal || dnsReady;
  const providerLabel = (setup.dnsHook && findDnsProvider(setup.dnsHook)?.label) || setup.dnsHook || '';
  /** Ein Nameserver oder eine Appliance, die man selbst betreibt (`fixedWait`). */
  const ownDns = Boolean(setup.dnsHook && findDnsProvider(setup.dnsHook)?.fixedWait);

  const [choice, setChoice] = useState<CertificateChoice | null>(
    setup.certificateSource === 'upload'
      ? 'upload'
      : setup.acmeDirectory
        ? 'custom'
        : letsEncryptPossible
          ? 'letsencrypt'
          : null
  );
  const [directory, setDirectory] = useState(setup.acmeDirectory ?? '');
  const [eabKeyId, setEabKeyId] = useState('');
  const [eabHmacKey, setEabHmacKey] = useState('');
  // Intern ohne DNS-Anbieter ist HTTP der einzige Weg zum eigenen Server: dann vorbelegt an.
  const [httpReachable, setHttpReachable] = useState(
    setup.acmeDirectory ? setup.acmeHttpReachable : internal && !dnsReady
  );
  const [error, setError] = useState('');
  const { notify } = useToast();
  const [saving, setSaving] = useState(false);

  const custom = choice === 'custom';
  const facts = certificateFactsOf({
    certificateSource: choice === 'upload' ? 'upload' : 'acme',
    acmeDirectory: custom ? normalizeAcmeDirectory(directory) || 'pending' : null,
    acmeHttpReachable: httpReachable,
  });
  const pathOpen = choice !== null && certificatePathOpen(setup, facts);

  const options: { value: CertificateChoice; title: string; text: string; icon: ReactNode; disabled?: boolean }[] = [
    {
      value: 'letsencrypt',
      title: "Let's Encrypt",
      text: internal
        ? dnsReady
          ? t('Über DNS bei {provider}. Erneuert sich von selbst.', { provider: providerLabel })
          : t('Erreicht diesen Server nur über DNS mit API.')
        : dnsReady
          ? t('Über Port 80, Wildcards über DNS bei {provider}.', { provider: providerLabel })
          : t('Über Port 80. Eine Wildcard geht ohne DNS-Anbieter mit API nicht.'),
      icon: <ShieldCheck size={18} strokeWidth={1.5} />,
      disabled: !letsEncryptPossible,
    },
    {
      value: 'custom',
      title: t('Eigener ACME-Server'),
      text: t('Eine CA mit ACME im eigenen Netz, etwa step-ca.'),
      icon: <Waypoints size={18} strokeWidth={1.5} />,
    },
    {
      value: 'upload',
      title: t('Zertifikate hochladen'),
      text: t('HAPM beantragt nichts, Sie laden Zertifikat und Schlüssel hoch.'),
      icon: <Upload size={18} strokeWidth={1.5} />,
    },
  ];

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!choice) {
      setError(t('Bitte wählen Sie, woher die Zertifikate kommen.'));
      return;
    }
    const url = normalizeAcmeDirectory(directory);
    const invalid = custom ? (validateAcmeDirectory(url) ?? validateEab({ keyId: eabKeyId, hmacKey: eabHmacKey })) : null;
    if (invalid) {
      setError(t(invalid));
      return;
    }
    setError('');
    setSaving(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/certificates', {
        method: 'PUT',
        body: JSON.stringify({
          source: choice === 'upload' ? 'upload' : 'acme',
          acmeDirectory: custom ? url : null,
          httpReachable: custom && internal && httpReachable,
          eabKeyId: custom ? eabKeyId : '',
          eabHmacKey: custom ? eabHmacKey : '',
        }),
      });
      onSaved(data.setup);
    } catch (err: unknown) {
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Die Auswahl ließ sich nicht speichern.'), t) });
      setSaving(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={save}>
      <div className="hapm-choices hapm-choices-three">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`hapm-choice${choice === option.value ? ' is-selected' : ''}`}
            aria-pressed={choice === option.value}
            disabled={saving || option.disabled}
            onClick={() => {
              setChoice(option.value);
              setError('');
            }}
          >
            {option.icon}
            <span className="hapm-choice-text">
              <strong>{option.title}</strong>
              <span>{option.text}</span>
            </span>
            {choice === option.value && (
              <span className="hapm-choice-check">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Eine Folge, die man vor der Wahl kennen muss: Let's Encrypt fragt den
          TXT-Eintrag aus dem Internet ab. Einen Nameserver im eigenen Netz
          erreicht es nicht, und der Antrag scheiterte erst beim Ausführen. */}
      {choice === 'letsencrypt' && dnsReady && ownDns && (
        <div className="alert alert-warning">
          {t(
            "Let's Encrypt prüft den DNS-Eintrag aus dem Internet. Das gelingt nur, wenn Ihre Zone bei {provider} auch dort ausgeliefert wird. Für eine Zone nur im eigenen Netz wählen Sie einen eigenen ACME-Server.",
            { provider: providerLabel }
          )}
        </div>
      )}

      {custom && (
        <>
          <div className="auth-field">
            <label htmlFor="acme-directory">
              {t('Directory-URL')}
              <InfoHint
                text={t(
                  'Die Adresse, unter der der ACME-Server sein Verzeichnis anbietet. Bei step-ca etwa https://ca.example.org/acme/acme/directory. acme.sh muss sie über HTTPS mit einem Zertifikat erreichen, dem es vertraut.'
                )}
              />
            </label>
            <input
              id="acme-directory"
              type="text"
              inputMode="url"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="https://ca.example.org/acme/acme/directory"
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="hapm-setup-pair">
            <div className="auth-field">
              <label htmlFor="eab-kid">
                {t('EAB Key-ID')} {t('(optional)')}
                <InfoHint
                  text={t(
                    'External Account Binding: nur nötig, wenn die CA es verlangt. Sie zeigt Key-ID und HMAC-Schlüssel beim Anlegen des Zugangs an.'
                  )}
                />
              </label>
              <input
                id="eab-kid"
                type="text"
                value={eabKeyId}
                onChange={(e) => setEabKeyId(e.target.value)}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="auth-field">
              <label htmlFor="eab-hmac">
                {t('EAB HMAC-Schlüssel')} {t('(optional)')}
                <InfoHint text={t('Geht an acme.sh und wird in HAPM nicht gespeichert.')} />
              </label>
              <input
                id="eab-hmac"
                type="password"
                value={eabHmacKey}
                onChange={(e) => setEabHmacKey(e.target.value)}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          {internal && (
            <label className="hapm-switch-row">
              <span className="hapm-switch-text">
                <span>
                  {t('Dieser ACME-Server erreicht HAPM über HTTP (Port 80)')}
                  <InfoHint
                    text={t(
                      "Dann prüft er jede Domain über Port 80, wie Let's Encrypt es im Internet tut. Typisch für eine CA im selben Netz. Wildcards gehen weiter nur über DNS."
                    )}
                  />
                </span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={httpReachable}
                  disabled={saving}
                  onChange={(e) => setHttpReachable(e.target.checked)}
                />
                <span className="toggle-slider" />
              </span>
            </label>
          )}
        </>
      )}

      {choice !== null && !pathOpen && (
        <div className="alert alert-warning">
          {t('Ohne HTTP über Port 80 und ohne DNS-Anbieter mit API kann der ACME-Server keine Domain prüfen. Schalten Sie HTTP ein oder laden Sie Zertifikate hoch.')}
        </div>
      )}
      {choice === 'upload' && (
        <p className="auth-hint">{t('Das Zertifikat der Oberfläche laden Sie im letzten Schritt hoch.')}</p>
      )}

      {error && <FormHint>{error}</FormHint>}

      <div className="hapm-setup-nav">
        {back}
        <button className="auth-submit" type="submit" disabled={saving || !choice || !pathOpen}>
          {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
          {saving && custom ? t('Konto wird angemeldet…') : t('Weiter')}
        </button>
      </div>
    </form>
  );
}

/* ── Schritt 5: SMTP-Konto ── */

function MailStep({
  setup,
  csrf,
  onSaved,
  onChanged,
  back,
}: {
  setup: SetupView;
  csrf: string;
  onSaved: (next: SetupView) => void;
  /** Den Stand übernehmen, ohne weiterzugehen: nach dem Speichern für die Testmail. */
  onChanged: (next: SetupView) => void;
  back: ReactNode;
}) {
  const { t } = useT();
  const account = setup.mailAccount;
  const [host, setHost] = useState(account.smtpHost ?? '');
  const [port, setPort] = useState(String(account.smtpPort));
  const [security, setSecurity] = useState<SmtpSecurity>(account.smtpSecurity);
  const [user, setUser] = useState(account.smtpUser ?? '');
  const [pass, setPass] = useState('');
  const [from, setFrom] = useState(account.mailFrom ?? '');
  const [error, setError] = useState('');
  const { notify } = useToast();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestMailResult | null>(null);

  /** Ohne Server ist „Weiter“ das Überspringen: ein leeres Formular ist keine Eingabe. */
  const skipping = host.trim() === '';
  const busy = saving || testing;

  /** Was gespeichert wird, oder `null` mit der Meldung im Schritt. */
  function fields(): Record<string, unknown> | null {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError(t('Der Port ist eine Zahl zwischen 1 und 65535.'));
      return null;
    }
    if (!from.trim()) {
      setError(t('Bitte geben Sie den Absender ein.'));
      return null;
    }
    return {
      smtpHost: host.trim(),
      smtpPort: portNumber,
      smtpSecurity: security,
      smtpUser: user.trim() || null,
      // Leer heißt: das gespeicherte Passwort bleibt.
      ...(pass ? { smtpPass: pass } : {}),
      mailFrom: from.trim(),
    };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    const body = skipping ? { skip: true } : fields();
    if (!body) return;
    setSaving(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/mail', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      onSaved(data.setup);
    } catch (err: unknown) {
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Das SMTP-Konto ließ sich nicht speichern.'), t) });
      setSaving(false);
    }
  }

  /** Erst speichern: die Testmail geht über das gespeicherte Konto (`/api/mail/test`). */
  async function sendTest() {
    setError('');
    setTestResult(null);
    const body = fields();
    if (!body) return;
    setTesting(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/mail', {
        method: 'PUT',
        body: JSON.stringify({ ...body, advance: false }),
      });
      onChanged(data.setup);
      // Ohne Adresse an das eigene Konto.
      setTestResult(
        await call<TestMailResult>(csrf, '/api/mail/test', { method: 'POST', body: JSON.stringify({ to: null }) })
      );
    } catch (err: unknown) {
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Die Testmail ließ sich nicht verschicken.'), t) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={save}>
      <div className="hapm-setup-trio">
        <div className="auth-field">
          <label htmlFor="smtp-host">{t('Server')}</label>
          <input
            id="smtp-host"
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.org"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="auth-field">
          <label htmlFor="smtp-port">{t('Port')}</label>
          <input
            id="smtp-port"
            type="text"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            disabled={busy}
            autoComplete="off"
          />
        </div>
        <div className="auth-field">
          <label htmlFor="smtp-security">{t('Verschlüsselung')}</label>
          <Select
            id="smtp-security"
            value={security}
            options={SMTP_SECURITY_CHOICES.map((option) => ({ ...option, label: t(option.label), hint: t(option.hint) }))}
            disabled={busy}
            onChange={(value) => {
              setSecurity(value);
              if (port === String(SMTP_DEFAULT_PORTS[security])) setPort(String(SMTP_DEFAULT_PORTS[value]));
            }}
          />
        </div>
      </div>
      <div className="hapm-setup-trio">
        <div className="auth-field">
          <label htmlFor="mail-from">
            {t('Absender')}
            <InfoHint text={t('Eine Adresse, die das SMTP-Konto verschicken darf. Wahlweise mit Namen davor: HAPM <hapm@example.org>. Ohne Namen steht im Postfach „HAPM“.')} />
          </label>
          <input
            id="mail-from"
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="hapm@example.org"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="auth-field">
          <label htmlFor="smtp-user">
            {t('Benutzername')} {t('(optional)')}
          </label>
          <input
            id="smtp-user"
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="auth-field">
          <label htmlFor="smtp-pass">
            {t('Passwort')} {t('(optional)')}
            <InfoHint text={t('Das Passwort liegt verschlüsselt in der Datenbank und wird nach dem Speichern nicht mehr angezeigt.')} />
          </label>
          <input
            id="smtp-pass"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            // Gesetzt, aber nie angezeigt. Leer gelassen bleibt es (siehe `fields`).
            placeholder={account.smtpPassSet ? '••••••••' : ''}
            disabled={busy}
            autoComplete="new-password"
          />
        </div>
      </div>

      <div className="hapm-setup-test">
        <span className="auth-hint">{t('Die Testmail geht an die Adresse Ihres Kontos.')}</span>
        <button className="btn btn-secondary btn-sm" type="button" disabled={busy || skipping} onClick={() => void sendTest()}>
          {testing ? <Loader2 size={14} strokeWidth={1.5} className="spin" /> : <Send size={14} strokeWidth={1.5} />}
          {t('Testmail senden')}
        </button>
      </div>

      {testResult &&
        (testResult.sent ? (
          <div className="alert alert-success">
            {t('Der Mailserver hat die Testmail an {to} angenommen.', { to: testResult.to })}
          </div>
        ) : (
          <div className="alert alert-danger">{testResult.error ?? t('Die Testmail wurde nicht verschickt.')}</div>
        ))}
      {error && <FormHint>{error}</FormHint>}

      <div className="hapm-setup-nav">
        {back}
        <button className="auth-submit" type="submit" disabled={busy}>
          {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
          {skipping ? t('Überspringen') : t('Speichern und weiter')}
        </button>
      </div>
    </form>
  );
}

/* ── Schritt 6: Adresse der Oberfläche ── */

/** Wie das Zertifikat der Oberfläche entsteht: über DNS, über HTTP auf Port 80, oder hochgeladen. */
type Issuance = 'dns' | 'http' | 'upload';

function issuanceOf(setup: SetupView, domains: string[]): Issuance {
  if (setup.certificateSource === 'upload') return 'upload';
  const facts = certificateFactsOf(setup);
  return needsDnsChallenge(domains, setup.exposure ?? 'public', facts.httpReachable) ? 'dns' : 'http';
}

function verdictText(
  check: AddressCheck,
  issuance: Issuance,
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
          issuance === 'dns'
            ? t(
                'Für {domain} sieht dieser Server keinen DNS-Eintrag. Das Zertifikat entsteht trotzdem, es wird über den DNS-Anbieter ausgestellt. Erreichbar ist die Oberfläche erst mit dem Eintrag.',
                { domain }
              )
            : issuance === 'upload'
              ? t('Für {domain} sieht dieser Server keinen DNS-Eintrag. Erreichbar ist die Oberfläche erst mit dem Eintrag.', {
                  domain,
                })
              : t(
                  'Für {domain} sieht dieser Server keinen DNS-Eintrag. Ohne den Eintrag scheitert das Zertifikat: der ACME-Server ruft die Domain auf.',
                  { domain }
                ),
      };
    default:
      return { tone: 'alert-info', text: t('Die DNS-Abfrage ist gescheitert. Ob der Eintrag stimmt, ließ sich nicht prüfen.') };
  }
}

/** Wie oft gefragt wird, solange der Eintrag noch fehlt. */
const DNS_WATCH_MS = 5000;
/** Nach so langer Wartezeit darf man auch ohne sichtbaren Eintrag weiter. */
const DNS_PATIENCE_MS = 45_000;

/** Ob die Frage beantwortet ist: die Domain zeigt irgendwohin. Wohin, sagt die Meldung. */
function recordVisible(check: AddressCheck | null, domain: string): boolean {
  return Boolean(check && check.domain === domain && (check.verdict === 'matches' || check.verdict === 'elsewhere'));
}

/**
 * Fragt, worauf die Domain zeigt, und fragt weiter, solange sie nicht auflöst.
 *
 * Ein DNS-Eintrag ist nach dem Anlegen nicht im selben Augenblick sichtbar.
 * Eine einzelne Abfrage direkt danach sagt „kein Eintrag" und stimmt eine
 * halbe Minute später nicht mehr. Die nächste Abfrage beginnt erst, wenn die
 * vorige beantwortet ist: sie fragt mehrere Server und kann Sekunden dauern.
 */
function useAddressWatch(csrf: string, domain: string, active: boolean): AddressCheck | null {
  const [check, setCheck] = useState<AddressCheck | null>(null);
  const visible = recordVisible(check, domain);

  useEffect(() => {
    if (!active || !domain || visible) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      const result = await call<AddressCheck>(csrf, `/api/setup/address?domain=${encodeURIComponent(domain)}`).catch(
        () => null
      );
      if (!live) return;
      if (result) setCheck(result);
      timer = setTimeout(() => void ask(), DNS_WATCH_MS);
    };
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, csrf, domain, visible]);

  return check && check.domain === domain ? check : null;
}

/** Die Zeile, solange auf den Eintrag gewartet wird. */
function DnsWaiting({ domain, firstAnswer }: { domain: string; firstAnswer: boolean }) {
  const { t } = useT();
  return (
    <div className="alert alert-info hapm-flag" role="status">
      <Loader2 size={16} className="spin" />
      <div className="hapm-flag-body">
        <strong>
          {firstAnswer
            ? t('Warte auf den DNS-Eintrag für {domain}', { domain })
            : t('Der DNS-Eintrag für {domain} wird geprüft', { domain })}
        </strong>
        {firstAnswer && (
          <span>
            {t('Noch ist er nicht zu sehen. Nach dem Anlegen dauert das meist unter einer Minute. Die Prüfung läuft von selbst weiter.')}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Die Vorschläge für den Wert des DNS-Eintrags, der beste zuerst. Öffentlich
 * steht die Adresse aus der Adresszeile des Browsers vorn, wenn es eine
 * öffentliche IP ist: unter ihr hat der Aufrufer den Server gerade erreicht.
 */
function suggestedAddresses(fromServer: string[], internal: boolean): string[] {
  if (internal || typeof window === 'undefined') return fromServer;
  const host = window.location.hostname.replace(/^\[|\]$/g, '');
  if (!isPublicAddress(host)) return fromServer;
  return [host, ...fromServer.filter((entry) => entry !== host)];
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
  /** Eine Wildcard stellt nur acme.sh über einen DNS-Anbieter aus. */
  const dnsReady = wildcardPossible(setup, certificateFactsOf(setup));

  const [domainDraft, setDomainDraft] = useState(setup.domain ?? '');
  // Bei „intern" vorbelegt an: weitere Ziele unter der Basis brauchen dann kein neues Zertifikat.
  const [wildcard, setWildcard] = useState(setup.domain ? setup.wildcard : internal && dnsReady);
  /** Nur was getippt wurde. Sonst folgt die Basis der Domain. */
  /** Für welche Domain die Prüfung läuft: gesetzt von „Eintrag prüfen" und nach „anlegen". */
  const [watched, setWatched] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { notify } = useToast();
  const [saving, setSaving] = useState(false);
  /** Nur was getippt wurde. Sonst gilt die erste Adresse des Servers. */
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [settingRecord, setSettingRecord] = useState(false);
  // Von welchen Adressen die Oberfläche aufrufbar sein soll. Nur aus dem
  // Internet gefragt. Vorbelegt mit der eigenen Adresse: wer sie vergisst,
  // sperrt sich mit dem letzten Schritt aus.
  const [restricted, setRestricted] = useState(setup.surfaceIps.length > 0);
  const [surfaceIps, setSurfaceIps] = useState<string[]>(
    setup.surfaceIps.length > 0 ? setup.surfaceIps : setup.clientIp ? [setup.clientIp] : []
  );
  const [recordNote, setRecordNote] = useState('');
  /** Gesetzt, wenn die Zone beim Anbieter liegt, die Domain aber woanders verwaltet wird. */
  const [recordUnused, setRecordUnused] = useState('');

  const domain = normalizeSetupDomain(domainDraft);
  const suggestedBase = wildcardBaseOf(domain);
  // Die Basis ist immer die Domain eine Ebene darüber: `*.example.org` für
  // `hapm.example.org`. Sie war einmal ein Feld, das fast nie jemand änderte,
  // und jede andere Basis deckte die Oberfläche nicht ab (`validateWildcardBase`).
  const base = suggestedBase ?? '';
  const wildcardOn = dnsReady && wildcard && base !== '';
  // Wer die Einrichtung unter einer öffentlichen Adresse aufruft, hat die
  // Adresse schon in der Hand, unter der der Server von außen erreichbar ist.
  // Sie geht vor dem, was der Server über sich selbst weiß: hinter einer
  // Adressumsetzung trägt er nur seine interne.
  const addresses = suggestedAddresses(setup.serverAddresses, internal);
  const recordAddress = (addressDraft ?? addresses[0] ?? '').trim();
  const allowedIps = restricted ? normalizeSurfaceIps(surfaceIps) : [];
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
      // Ab jetzt nachsehen, bis der Eintrag zu sehen ist.
      setWatched(domain);
    } catch (err: unknown) {
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Der Eintrag ließ sich nicht anlegen.'), t) });
    } finally {
      setSettingRecord(false);
    }
  }

  function runCheck() {
    const invalid = validateSetupDomain(domain);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    setError('');
    setWatched(domain);
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
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Die Adresse ließ sich nicht speichern.'), t) });
      setSaving(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const invalid =
      validateSetupDomain(domain) ??
      (wildcardOn ? validateWildcardBase(domain, base) : null) ??
      validateSurfaceIps(allowedIps);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    if (restricted && allowedIps.length === 0) {
      setError(t('Bitte tragen Sie mindestens eine Adresse ein, oder schalten Sie die Beschränkung aus.'));
      return;
    }
    void send({ domain, wildcard: wildcardOn, wildcardBase: wildcardOn ? base : null, surfaceIps: allowedIps });
  }

  // Die Prüfung gilt der Domain, für die sie begonnen wurde. Wer weitertippt, beendet sie.
  const watching = watched !== null && watched === domain;
  const check = useAddressWatch(csrf, domain, watching);
  const checking = watching && !recordVisible(check, domain);
  const issuance = issuanceOf(setup, certificateDomains({ domain, wildcard: wildcardOn, wildcardBase: base }));
  // Die Zeile mit dem Spinner nur, wo auf den Eintrag gewartet werden muss
  // (das Zertifikat über HTTP braucht ihn). Sonst sagt die Meldung, was sein
  // Fehlen heißt, und die Prüfung läuft still weiter.
  const waitingRow = checking && (check === null || (check.verdict === 'unresolved' && issuance === 'http'));
  const verdict = watching && check && !waitingRow ? verdictText(check, issuance, t) : null;
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

      {dnsReady && base && (
        <label className="hapm-switch-row">
          <span className="hapm-switch-text">
            <span>
              {t('Wildcard-Zertifikat für *.{base} ausstellen', { base })}
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

      <div className="hapm-setup-note">
        <div className="hapm-setup-note-head">
          <strong>{recordProvider ? t('Der DNS-Eintrag der Oberfläche') : t('Diesen DNS-Eintrag legen Sie selbst an')}</strong>
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
        <dl className="detail-grid hapm-setup-record">
          <dt>{t('Name')}</dt>
          <dd>{shownDomain}</dd>
          <dt>{t('Typ')}</dt>
          <dd>{recordAddress.includes(':') ? 'AAAA' : 'A'}</dd>
          <dt>{t('Wert')}</dt>
          {/* Feld und „i“ in einer Zeile: das Feld stand als Block da, und das
              „i“ rutschte darunter. */}
          <dd className="hapm-record-value">
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
              {recordProvider
                ? t('Bei {provider}', { provider: recordProvider.label })
                : setup.dns === 'manual'
                  ? t('In Ihrem DNS-Server')
                  : t('Bei Ihrem DNS-Anbieter')}
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
      </div>

      {!internal && (
        <label className="hapm-switch-row">
          <span className="hapm-switch-text">
            <span>
              {t('Oberfläche nur von bestimmten Adressen aufrufbar')}
              <InfoHint
                text={t(
                  'Unter ihrer Domain antwortet die Oberfläche dann nur diesen Adressen und Netzen, alle anderen bekommen 403. Das gilt auch für API und MCP. Die Liste steht danach unter Reverse-Proxy, Einstellungen, Zugriff und lässt sich dort ändern.'
                )}
              />
            </span>
          </span>
          <span className="toggle-switch">
            <input
              type="checkbox"
              checked={restricted}
              disabled={saving}
              onChange={(e) => setRestricted(e.target.checked)}
            />
            <span className="toggle-slider" />
          </span>
        </label>
      )}
      {!internal && restricted && (
        <div className="hapm-setup-note">
          <IpAllowList
            value={surfaceIps}
            onChange={setSurfaceIps}
            disabled={saving}
            heading={false}
            emptyHint={t('Noch keine Adresse eingetragen.')}
          />
          {setup.clientIp && !allowedIps.includes(setup.clientIp) && (
            <div className="hapm-form-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={saving}
                onClick={() => setSurfaceIps([...normalizeSurfaceIps(surfaceIps), setup.clientIp!])}
              >
                <Plus size={14} />
                {t('Eigene Adresse eintragen ({ip})', { ip: setup.clientIp })}
              </button>
            </div>
          )}
          <div className="alert alert-info">
            {t('Das gilt für den Aufruf über die Domain. Über Port {port} bleibt die Oberfläche erreichbar, bis er geschlossen ist.', {
              port: setup.listenPort,
            })}
          </div>
        </div>
      )}

      {recordNote && <div className="alert alert-success">{recordNote}</div>}
      {recordUnused && <div className="alert alert-warning">{recordUnused}</div>}
      {waitingRow && <DnsWaiting domain={domain} firstAnswer={check !== null} />}
      {verdict && <div className={`alert ${verdict.tone}`}>{verdict.text}</div>}
      {error && <FormHint>{error}</FormHint>}

      <div className="hapm-setup-nav">
        {back}
        <button className="auth-submit" type="submit" disabled={saving}>
          {saving ? <span className="btn-spinner" aria-hidden="true" /> : <ArrowRight size={15} />}
          {t('Weiter')}
        </button>
      </div>
    </form>
  );
}

/* ── Schritt 7: Ausführen ── */

function RunStep({
  setup,
  csrf,
  motion,
  progress,
  onChanged,
  back,
  later,
  acmeWarning,
}: {
  setup: SetupView;
  csrf: string;
  motion: 'forward' | 'back';
  progress: ReactNode;
  onChanged: (next: SetupView) => void;
  back: ReactNode;
  later: ReactNode;
  acmeWarning: ReactNode;
}) {
  const { t, locale } = useT();
  const [error, setError] = useState('');
  const { notify } = useToast();
  const [starting, setStarting] = useState(false);
  /** Nach längerem Warten: weiter auch ohne sichtbaren Eintrag. */
  const [patient, setPatient] = useState(false);

  const [uploading, setUploading] = useState(false);

  const outcome = executionOutcome(setup.execution);
  const domain = setup.domain ?? '';
  const domains = certificateDomains(setup);
  const issuance = issuanceOf(setup, domains);
  const providerLabel =
    (setup.dnsHook && findDnsProvider(setup.dnsHook)?.label) || setup.dnsHook || t('Ihrem DNS-Anbieter');
  /** Bei „nur hochladen" geht es erst los, wenn ein Zertifikat die Domain abdeckt. */
  const uploadMissing = issuance === 'upload' && !setup.presentCertificate;

  async function upload(body: UploadBody) {
    await call(csrf, '/api/haproxy/certificates', { method: 'POST', body: JSON.stringify(body) });
    setUploading(false);
    const status = await call<{ setup?: SetupView }>(csrf, '/api/setup');
    if (status.setup) onChanged(status.setup);
  }

  // Vor dem Ausführen sagen, worauf die Domain zeigt, und weiterfragen, bis
  // sie auflöst: der Eintrag ist oft erst im Schritt davor entstanden.
  const check = useAddressWatch(csrf, domain, outcome === 'idle');
  const visible = recordVisible(check, domain);
  /**
   * Über HTTP ruft der ACME-Server die Domain auf: ohne Eintrag scheitert das
   * Zertifikat sicher, und jeder Fehlversuch zählt bei Let's Encrypt gegen ein
   * Kontingent. Deshalb geht es hier erst weiter, wenn der Eintrag zu sehen
   * ist. Eine gescheiterte Abfrage (`unknown`) hält nicht auf: dann weiß
   * dieser Server es nur nicht.
   */
  const recordMissing = issuance === 'http' && outcome === 'idle' && !visible && check?.verdict !== 'unknown';

  // Wer lange wartet, bekommt den Weg ohne Prüfung: der Server sieht manche Einträge nie (eigener DNS im Netz).
  useEffect(() => {
    if (!recordMissing) return;
    const timer = setTimeout(() => setPatient(true), DNS_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [recordMissing]);

  async function start() {
    setError('');
    setStarting(true);
    try {
      const data = await call<{ setup: SetupView }>(csrf, '/api/setup/run', { method: 'POST' });
      onChanged(data.setup);
    } catch (err: unknown) {
      notify({ variant: 'error', title: t('Fehlgeschlagen'), message: message(err, msgid('Die Einrichtung ließ sich nicht starten.'), t) });
    } finally {
      setStarting(false);
    }
  }

  if (outcome === 'succeeded') return <SetupSuccess setup={setup} />;

  // Solange gewartet wird, steht die Zeile mit dem Spinner da, nicht die Warnung.
  const verdict = check && !recordMissing && check.verdict !== 'unresolved' ? verdictText(check, issuance, t) : null;
  const unresolvedNote = check && !recordMissing && check.verdict === 'unresolved' ? verdictText(check, issuance, t) : null;

  return (
    <Frame
      step="run"
      motion={motion}
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
                {issuance === 'upload' ? (
                  setup.presentCertificate ? (
                    setup.presentCertificate.notAfter ? (
                      t('hochgeladen, gültig bis {date}', { date: formatDate(locale, setup.presentCertificate.notAfter) })
                    ) : (
                      t('liegt schon vor: {domains}', { domains: setup.presentCertificate.domains.join(', ') })
                    )
                  ) : (
                    t('noch nicht hochgeladen')
                  )
                ) : issuance === 'dns' ? (
                  <span className="hapm-provider">
                    {setup.dnsHook && <ProviderLogo hook={setup.dnsHook} size={18} />}
                    {t('über DNS bei {provider}', { provider: providerLabel })}
                  </span>
                ) : setup.acmeDirectory ? (
                  t('über HTTP auf Port 80, der ACME-Server ruft die Domain auf')
                ) : (
                  t("über HTTP auf Port 80, Let's Encrypt ruft die Domain auf")
                )}
              </dd>
              {setup.acmeDirectory && issuance !== 'upload' && (
                <>
                  <dt>{t('ACME-Server')}</dt>
                  <dd>{setup.acmeDirectory}</dd>
                </>
              )}
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
              {setup.exposure === 'public' && setup.surfaceIps.length > 0 && (
                <>
                  <dt>{t('Aufrufbar von')}</dt>
                  <dd>
                    {setup.surfaceIps.join(', ')}
                    <div className="detail-sub">{t('Alle anderen Adressen bekommen unter der Domain 403.')}</div>
                  </dd>
                </>
              )}
            </dl>
          </div>
          {recordMissing && <DnsWaiting domain={domain} firstAnswer={check !== null} />}
          {verdict && <div className={`alert ${verdict.tone}`}>{verdict.text}</div>}
          {unresolvedNote && <div className={`alert ${unresolvedNote.tone}`}>{unresolvedNote.text}</div>}
          {uploadMissing && (
            <div className="hapm-setup-note">
              <div className="hapm-setup-note-head">
                <span>{t('HAPM stellt in dieser Installation keine Zertifikate aus. Laden Sie das für {domain} hoch.', { domain })}</span>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setUploading(true)}>
                  <Upload size={14} />
                  {t('Zertifikat hochladen')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {outcome !== 'idle' && <Stages setup={setup} />}

      {outcome === 'failed' && (
        <div className="auth-error" role="alert">
          {t(
            'Die Einrichtung ist nicht durchgelaufen. Ihr Konto und alles, was oben einen Haken trägt, bleiben bestehen. Sie können die Eingaben ändern und es erneut versuchen.'
          )}
        </div>
      )}
      {error && <FormHint>{error}</FormHint>}

      {outcome !== 'running' && (
        <>
          <div className="hapm-setup-nav">
            {back}
            <button
              className="auth-submit"
              type="button"
              disabled={starting || (outcome === 'idle' && (uploadMissing || recordMissing))}
              onClick={start}
            >
              {starting ? (
                <span className="btn-spinner" aria-hidden="true" />
              ) : outcome === 'failed' ? (
                <RefreshCw size={15} />
              ) : (
                <Play size={15} />
              )}
              {outcome === 'failed' ? t('Erneut versuchen') : t('Jetzt einrichten')}
            </button>
          </div>
          {recordMissing && patient && (
            <div className="hapm-setup-nav">
              <button className="btn btn-ghost btn-sm" type="button" disabled={starting} onClick={start}>
                {t('Ohne sichtbaren Eintrag einrichten')}
              </button>
              <InfoHint
                text={t(
                  'Nur sinnvoll, wenn der Eintrag sicher steht und dieser Server ihn bloß nicht sehen kann. Fehlt er wirklich, scheitert das Zertifikat.'
                )}
              />
            </div>
          )}
        </>
      )}
      {/* Während des Laufs gibt es nichts zu wählen, aber gehen darf man. */}
      {outcome === 'running' && <div className="hapm-setup-nav">{later}</div>}
      {uploading && (
        <CertificateUploadDialog
          replace={null}
          expected={domains}
          onUpload={upload}
          onClose={() => setUploading(false)}
        />
      )}
    </Frame>
  );
}

function Stages({ setup }: { setup: SetupView }) {
  const { t } = useT();
  const stages = setup.execution?.stages ?? [];
  return (
    <ul className="hapm-steps">
      {stages.map((stage, index) => {
        const state =
          stage.status === 'ok'
            ? 'is-ok'
            : stage.status === 'error'
              ? 'is-failed'
              : stage.status === 'running'
                ? 'is-running'
                : 'is-pending';
        return (
          <li key={stage.key} className={`hapm-step ${state}`} style={{ '--i': index } as CSSProperties}>
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
