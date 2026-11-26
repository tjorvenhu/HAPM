'use client';

import { useCallback, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { useMountedLoad } from '@/components/useMountedLoad';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';
import { DEFAULT_DNS_WAIT, MAX_DNS_WAIT, MIN_DNS_WAIT } from '@/lib/haproxy/challenge';

/**
 * Wie lange acme.sh nach dem TXT-Eintrag wartet, bevor es die
 * Zertifizierungsstelle fragt (`Settings.dnsWait`, `--dnssleep`).
 *
 * Steht bei den DNS-Zugangsdaten und nur, wenn ein Anbieter eingerichtet ist,
 * für den der Wert gilt: ein eigener Nameserver (RFC 2136) oder Infoblox. Bei
 * Hetzner und Cloudflare sieht acme.sh selbst nach, ob der Eintrag sichtbar
 * ist, dort wäre das Feld eine Einstellung ohne Wirkung.
 *
 * Ein eigener Knopf: die Einstellung liegt in der Datenbank und nicht in
 * `haproxy.cfg`, sie geht also nicht mit dem Speichern der Seite.
 */
export default function DnsWaitSetting() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t } = useT();

  /** `null`, bis der gespeicherte Wert gelesen ist. */
  const [saved, setSaved] = useState<number | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error);
      const wait = typeof data.data.dnsWait === 'number' ? data.data.dnsWait : DEFAULT_DNS_WAIT;
      setSaved(wait);
      setValue(String(wait));
    } catch {
      // Ohne den gespeicherten Wert bleibt das Feld gesperrt: eine geratene
      // Vorgabe sähe aus wie die Einstellung.
      setSaved(null);
    }
  }, [apiFetch]);

  useMountedLoad(load);

  const seconds = /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  const valid = seconds >= MIN_DNS_WAIT && seconds <= MAX_DNS_WAIT;

  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dnsWait: seconds }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || t('Speichern fehlgeschlagen'));
      setSaved(seconds);
      notify({
        variant: 'success',
        message: t('Gespeichert. Die Wartezeit gilt für Zertifikate, die ab jetzt ausgestellt werden.'),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-group">
      <label className="form-label" htmlFor="dnsWait">
        {t('Wartezeit nach dem DNS-Eintrag')}
        <InfoHint
          text={t(
            'So lange wartet acme.sh nach dem Setzen des TXT-Eintrags, bevor die Zertifizierungsstelle ihn prüft. Gilt für RFC 2136 und Infoblox: eine Zone im eigenen Netz kann acme.sh nicht von außen nachsehen. Erhöhen Sie den Wert, wenn weitere Nameserver die Zone erst nachladen.'
          )}
        />
      </label>
      <div className="form-list-row">
        <input
          id="dnsWait"
          className="form-input"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
          disabled={saved === null || saving}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={saved === null || saving || !valid || seconds === saved}
          onClick={() => void save()}
        >
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          {t('Speichern')}
        </button>
      </div>
      <span className="form-hint">
        {t('{min} bis {max} Sekunden', { min: MIN_DNS_WAIT, max: MAX_DNS_WAIT })}
      </span>
    </div>
  );
}
