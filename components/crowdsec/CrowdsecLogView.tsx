'use client';

import { useState } from 'react';
import { FileText, Loader2, RefreshCw } from 'lucide-react';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useCrowdsecData } from './useCrowdsecData';

type Which = 'crowdsec' | 'bouncer';
const LINES = ['300', '1000', '2000'] as const;
type Lines = (typeof LINES)[number];

const SOURCES: { value: Which; label: string }[] = [
  { value: 'crowdsec', label: 'CrowdSec' },
  { value: 'bouncer', label: msgid('Bouncer für HAProxy') },
];

function lineClass(line: string): string | undefined {
  if (/level=(error|fatal)|\bERROR\b|\bFATAL\b/.test(line)) return 'cs-log-error';
  if (/level=warn|\bWARN/.test(line)) return 'cs-log-warn';
  return undefined;
}

/**
 * Reverse-Proxy → Logs → CrowdSec: die Ausgabe eines der beiden Container,
 * neueste Zeile oben. Was CrowdSec erkannt hat, steht unter „Ereignisse“ der
 * Seite CrowdSec; hier steht, was der Prozess selbst meldet (Start, Regeln,
 * Fehler, Anfragen des Bouncers).
 */
export default function CrowdsecLogView() {
  const { t } = useT();
  const [which, setWhich] = useState<Which>('crowdsec');
  const [lines, setLines] = useState<Lines>('300');
  const { data, error, loading, reload } = useCrowdsecData<{ container: string; exists: boolean; lines: string[] }>(
    `/api/crowdsec/log?container=${which}&tail=${lines}`,
    15_000
  );

  return (
    <>
      <div className="logs-toolbar">
        <div className="form-group">
          <label className="form-label" htmlFor="csLogSource">{t('Container')}</label>
          <Select<Which>
            id="csLogSource"
            value={which}
            onChange={setWhich}
            options={SOURCES.map((s) => ({ value: s.value, label: t(s.label) }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="csLogLines">{t('Zeilen')}</label>
          <Select<Lines> id="csLogLines" value={lines} onChange={setLines} options={LINES.map((n) => ({ value: n, label: n }))} />
        </div>
        <div className="logs-toolbar-end">
          <button className="btn btn-secondary" onClick={() => void reload()} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {!data ? (
        loading ? <SkeletonRows /> : null
      ) : !data.exists ? (
        <div className="empty-state">
          <FileText size={40} />
          <h3>{t('Den Container gibt es nicht')}</h3>
          <p>{t('{name} läuft auf diesem Server nicht. Ist CrowdSec bei der Installation abgewählt worden?', { name: data.container })}</p>
        </div>
      ) : data.lines.length === 0 ? (
        <div className="empty-state">
          <FileText size={40} />
          <h3>{t('Noch keine Ausgabe')}</h3>
        </div>
      ) : (
        <div className="card">
          <pre className="cs-log">
            {data.lines.map((line, index) => (
              <div key={index} className={lineClass(line)}>
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}
    </>
  );
}
