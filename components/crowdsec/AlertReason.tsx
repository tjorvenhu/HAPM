'use client';

import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT, type ClientTranslator } from '@/lib/i18n/react';
import { describeReason } from '@/lib/crowdsec/describe';

/** Die Beschriftung eines Grundes, wie die Seite sie zeigt: in Worten, sonst der Name. */
export function reasonLabel(name: string, t: ClientTranslator['t']): string {
  const description = describeReason(name);
  return description ? description.labels.map((label) => t(label)).join(', ') : name;
}

/**
 * Der Grund eines Ereignisses oder einer Sperre in Worten, die Erklärung und
 * der Name bei CrowdSec hinter dem „i". Einen unbekannten Namen zeigt sie, wie
 * er ist.
 */
export default function AlertReason({ name, strong = false }: { name: string; strong?: boolean }) {
  const { t } = useT();
  const description = describeReason(name);
  if (!description) {
    return strong ? <strong className="mono">{name}</strong> : <span className="mono">{name}</span>;
  }
  const label = reasonLabel(name, t);
  const hint = [...description.hints.map((text) => t(text)), t('Bei CrowdSec: {name}', { name: name.trim().replace(/,$/, '') })].join(' ');
  return (
    <span className="form-label-row">
      {strong ? <strong>{label}</strong> : <span>{label}</span>}
      <InfoHint text={hint} />
    </span>
  );
}
