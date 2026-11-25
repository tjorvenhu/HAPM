'use client';

import { Ban, Gauge, Globe2, Info, Plus, ShieldAlert, X } from 'lucide-react';
import Select from '@/components/Select';
import CountryFlag from '@/components/CountryFlag';
import { countryName } from '@/lib/country-flags';
import {
  PROTECTION_MARKER,
  RATE_LIMIT_DEFAULT,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MIN,
  RATE_PERIODS,
  type AccessProtection,
  type RatePeriod,
} from '@/lib/haproxy/config';
import { formatCount, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Der Zugriffsschutz auf „Reverse-Proxy → Einstellungen": gesperrte Adressen,
 * gesperrte Länder und die Ratenbegrenzung. Was in der Datei daraus wird,
 * steht bei `protectionLines` in `lib/haproxy/config.ts`.
 *
 * Geprüft wird hier nichts, wie bei den Admin-IPs: die Route lehnt ab und sagt
 * warum, auch wenn eine Sperre die eigene Adresse träfe.
 */

/** Was das Formular hält. Die Zahl als Text, damit man sie leeren und neu
 *  tippen kann, ohne dass sofort eine 0 dasteht. */
export interface ProtectionDraft {
  blockedIps: string[];
  blockedCountries: string[];
  rateLimit: { requests: string; period: RatePeriod } | null;
}

export interface ProtectionContext {
  /** Die Länder, die die GeoIP-Tabelle kennt. Leer heißt: keine Tabelle. */
  countries: string[];
  client: { ip: string; country: string | null };
}

export function protectionDraft(protection: AccessProtection): ProtectionDraft {
  return {
    // Eine leere Zeile am Ende, damit man tippen kann, wie bei den Admin-IPs.
    blockedIps: protection.blockedIps.length > 0 ? [...protection.blockedIps] : [''],
    blockedCountries: [...protection.blockedCountries],
    rateLimit: protection.rateLimit
      ? { requests: String(protection.rateLimit.requests), period: protection.rateLimit.period }
      : null,
  };
}

/** Für die Route. Leere Zeilen fallen dort weg. */
export function protectionPayload(draft: ProtectionDraft) {
  return {
    blockedIps: draft.blockedIps,
    blockedCountries: draft.blockedCountries,
    rateLimit: draft.rateLimit
      ? { requests: Number(draft.rateLimit.requests.trim()), period: draft.rateLimit.period }
      : null,
  };
}

const PERIOD_LABELS: Record<RatePeriod, string> = {
  '10s': msgid('10 Sekunden'),
  '1m': msgid('1 Minute'),
  '10m': msgid('10 Minuten'),
};

export default function ProtectionSection({
  value,
  onChange,
  context,
  hasAdminIps,
}: {
  /** `null`: der Block steht von Hand geändert in der Datei. */
  value: ProtectionDraft | null;
  onChange: (next: ProtectionDraft) => void;
  context: ProtectionContext | null;
  hasAdminIps: boolean;
}) {
  const { t, rich, locale } = useT();

  if (!value) {
    return (
      <div className="alert alert-warning">
        <span>
          {rich(
            'Der Block {marker} steht nicht so in der Konfiguration, wie HAPM ihn schreibt. Er wirkt weiter, wird hier aber nicht bearbeitet, damit keine Änderung von Hand verloren geht.',
            { marker: <code>{PROTECTION_MARKER}</code> }
          )}
        </span>
      </div>
    );
  }

  const countries = context?.countries ?? [];
  const available = countries.filter((code) => !value.blockedCountries.includes(code));
  const client = context?.client ?? null;
  const clientKnown = client && client.ip !== 'unknown';

  return (
    <div className="form-columns">
      <section className="form-section">
        <div className="form-section-head">
          <span className="form-section-icon">
            <Ban size={17} />
          </span>
          <div>
            <div className="form-section-title">{t('Gesperrte Adressen')}</div>
            <div className="form-section-sub">
              {t('Einzelne IPs oder Netze, die keinen Dienst erreichen. Gilt auch für Admin-IPs.')}
            </div>
          </div>
        </div>

        <div className="form-list">
          {value.blockedIps.map((ip, index) => (
            <div className="form-list-row" key={index}>
              <input
                className="form-input"
                value={ip}
                onChange={(e) =>
                  onChange({
                    ...value,
                    blockedIps: value.blockedIps.map((a, i) => (i === index ? e.target.value : a)),
                  })
                }
                placeholder={t('203.0.113.7 oder 10.0.0.0/8')}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                data-tooltip={t('Zeile entfernen')}
                disabled={value.blockedIps.length === 1 && ip === ''}
                onClick={() => {
                  const rest = value.blockedIps.filter((_, i) => i !== index);
                  onChange({ ...value, blockedIps: rest.length > 0 ? rest : [''] });
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
        <div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onChange({ ...value, blockedIps: [...value.blockedIps, ''] })}
          >
            <Plus size={14} />
            {t('Adresse hinzufügen')}
          </button>
        </div>

        <div className="form-section-head" style={{ marginTop: 8 }}>
          <span className="form-section-icon">
            <Globe2 size={17} />
          </span>
          <div>
            <div className="form-section-title">
              {value.blockedCountries.length > 0
                ? t('Gesperrte Länder ({count})', { count: value.blockedCountries.length })
                : t('Gesperrte Länder')}
            </div>
            <div className="form-section-sub">
              {hasAdminIps
                ? t('Besucher aus diesen Ländern bekommen 403. Admin-IPs sind ausgenommen.')
                : t('Besucher aus diesen Ländern bekommen 403. Mit Admin-IPs wären diese ausgenommen.')}
            </div>
          </div>
        </div>

        {/* Chips, die umbrechen, statt einer Zeile je Land: mit zwanzig
            Ländern wäre die Liste sonst länger als der Rest der Seite. */}
        {value.blockedCountries.length === 0 ? (
          <div className="form-list-empty">{t('Kein Land gesperrt.')}</div>
        ) : (
          <div className="entity-card-tags">
            {[...value.blockedCountries]
              .sort((a, b) => countryName(a, locale).localeCompare(countryName(b, locale), locale))
              .map((code) => (
              <span className="entity-card-tag hapm-country-chip" key={code} data-tooltip={code}>
                <CountryFlag code={code} />
                <span>{countryName(code, locale)}</span>
                <button
                  type="button"
                  className="hapm-chip-remove"
                  aria-label={t('{country} entfernen', { country: countryName(code, locale) })}
                  onClick={() =>
                    onChange({ ...value, blockedCountries: value.blockedCountries.filter((c) => c !== code) })
                  }
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}

        {countries.length === 0 ? (
          <div className="form-note">
            <Info size={14} />
            <span>{t('Ohne GeoIP-Tabelle lässt sich kein Land sperren. Sie lässt sich oben auf dieser Seite holen.')}</span>
          </div>
        ) : (
          <Select<string>
            value={null}
            onChange={(code) =>
              onChange({ ...value, blockedCountries: [...value.blockedCountries, code].sort() })
            }
            options={available
              .map((code) => ({
                value: code,
                label: countryName(code, locale),
                hint: code,
                icon: <CountryFlag code={code} />,
              }))
              .sort((a, b) => a.label.localeCompare(b.label, locale))}
            placeholder={t('Land hinzufügen')}
            searchable
            searchPlaceholder={t('Land suchen')}
          />
        )}
      </section>

      <section className="form-section">
        <div className="form-subsection-head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span className="form-section-icon">
              <Gauge size={17} />
            </span>
            <div>
              <div className="form-section-title">{t('Ratenbegrenzung')}</div>
              <div className="form-section-sub">
                {t('Zu viele Anfragen von einer Adresse bekommen 429, bis sie wieder unter der Grenze liegt.')}
              </div>
            </div>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={value.rateLimit !== null}
              onChange={(e) => {
                const on = e.target.checked;
                onChange({
                  ...value,
                  rateLimit: on
                    ? { requests: String(RATE_LIMIT_DEFAULT.requests), period: RATE_LIMIT_DEFAULT.period }
                    : null,
                });
              }}
              aria-label={t('Ratenbegrenzung')}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {value.rateLimit && (
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{t('Anfragen je Adresse')}</label>
              <input
                className="form-input"
                inputMode="numeric"
                value={value.rateLimit.requests}
                onChange={(e) =>
                  onChange({ ...value, rateLimit: { ...value.rateLimit!, requests: e.target.value } })
                }
                autoComplete="off"
              />
              <span className="form-hint">
                {t('{min} bis {max}', {
                  min: formatCount(locale, RATE_LIMIT_MIN),
                  max: formatCount(locale, RATE_LIMIT_MAX),
                })}
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">{t('Zeitraum')}</label>
              <Select<RatePeriod>
                value={value.rateLimit.period}
                onChange={(period) => onChange({ ...value, rateLimit: { ...value.rateLimit!, period } })}
                options={RATE_PERIODS.map((period) => ({ value: period, label: t(PERIOD_LABELS[period]) }))}
              />
            </div>
          </div>
        )}

        {value.rateLimit && (
          <div className="form-note">
            <Info size={14} />
            <span>
              {hasAdminIps
                ? t('Admin-IPs zählen nicht mit. Eine Seite lädt beim ersten Aufruf oft hundert Dateien und mehr, und mehrere Menschen hinter einem Anschluss teilen sich eine Adresse.')
                : t('Eine Seite lädt beim ersten Aufruf oft hundert Dateien und mehr, und mehrere Menschen hinter einem Anschluss teilen sich eine Adresse. Das gilt auch für diese Oberfläche.')}
            </span>
          </div>
        )}

        <div className="form-note">
          <ShieldAlert size={14} />
          <span>
            {clientKnown
              ? client.country
                ? t('Gilt im HTTPS-Frontend für jeden Dienst. Ihre Adresse ist {ip} ({country}). Eine Sperre, die Sie selbst träfe, wird abgelehnt.', {
                    ip: client.ip,
                    country: countryName(client.country, locale),
                  })
                : t('Gilt im HTTPS-Frontend für jeden Dienst. Ihre Adresse ist {ip}. Eine Sperre, die Sie selbst träfe, wird abgelehnt.', {
                    ip: client.ip,
                  })
              : t('Gilt im HTTPS-Frontend für jeden Dienst. Eine Sperre, die Sie selbst träfe, wird abgelehnt.')}
          </span>
        </div>
      </section>
    </div>
  );
}
