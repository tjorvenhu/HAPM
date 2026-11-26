'use client';

import Select from '@/components/Select';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { splitHint } from '@/ui/primitives/hint-text';
import { useT } from '@/lib/i18n/react';
import type { DnsCredentialField } from '@/lib/haproxy/dns-credentials';

/**
 * Die Felder eines DNS-Anbieters, wie `DNS_PROVIDERS` sie beschreibt: ein
 * Geheimnis, ein Text, eine Auswahl oder ein Zertifikat als PEM.
 *
 * Eine Stelle für die drei Formulare, die sie zeigen (Assistent, Zugangsdaten
 * für acme.sh, Zone anbinden): ein Anbieter mit fünf Feldern sähe sonst an
 * drei Stellen dreimal anders aus. `skin` wählt nur das Vokabular: `form` für
 * die Seiten hinter der Anmeldung, `auth` für den Assistenten.
 *
 * Ein langer Hinweis steht hinter dem „i", ein kurzer unter dem Feld
 * (`splitHint`, docs/oberflaeche.md).
 */
export default function CredentialFields({
  fields,
  values,
  onChange,
  skin,
  idPrefix,
  disabled = false,
}: {
  fields: readonly DnsCredentialField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  skin: 'form' | 'auth';
  /** Hält die Kennungen der Felder eindeutig, wenn zwei Formulare auf einer Seite stehen. */
  idPrefix: string;
  disabled?: boolean;
}) {
  const { t } = useT();
  const form = skin === 'form';

  return (
    <>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const value = values[field.name] ?? '';
        const hint = splitHint(field.hint ? t(field.hint) : undefined);
        const kind = field.kind ?? 'secret';
        const input = form ? 'form-input' : undefined;

        return (
          <div className={form ? 'form-group' : 'auth-field'} key={field.name}>
            <label className={form ? 'form-label' : undefined} htmlFor={id}>
              {t(field.label)}
              {!field.required && ` ${t('(optional)')}`}
              {hint.hint && <InfoHint text={hint.hint} />}
            </label>

            {kind === 'select' && field.options ? (
              <Select
                id={id}
                value={value || field.options[0]}
                options={field.options.map((option) => ({ value: option, label: option.toUpperCase() }))}
                disabled={disabled}
                onChange={(next) => onChange(field.name, next)}
              />
            ) : kind === 'pem' ? (
              <textarea
                id={id}
                className="form-textarea mono"
                rows={4}
                value={value}
                onChange={(e) => onChange(field.name, e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----"
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
              />
            ) : (
              <input
                id={id}
                className={input}
                // Ein Geheimnis als Passwortfeld, weil daneben jemand steht.
                type={kind === 'secret' ? 'password' : 'text'}
                value={value}
                onChange={(e) => onChange(field.name, e.target.value)}
                placeholder={field.placeholder}
                disabled={disabled}
                autoComplete={kind === 'secret' ? 'new-password' : 'off'}
                spellCheck={false}
              />
            )}

            {hint.visible &&
              (form ? <span className="form-hint">{hint.visible}</span> : <p className="auth-hint">{hint.visible}</p>)}
          </div>
        );
      })}
    </>
  );
}
