'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { FileCog, Loader2, Check } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { useConfirm } from '@/components/ConfirmDialog';
import { useMountedLoad } from '@/components/useMountedLoad';
import { usePolling } from '@/components/usePolling';
import { SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';
import type { BaseConfigDiff, BaseConfigDrift } from '@/lib/haproxy/base-config-diff';

/**
 * Der Abgleich von `haproxy.cfg` mit der Grundkonfiguration, die HAPM heute
 * schreiben würde.
 *
 * Die Grundkonfiguration entsteht nur, wenn die Datei fehlt. Neue Vorgaben
 * (etwa `limited-quic`) kommen bei einer älteren Installation deshalb nie an.
 * Hier stehen sie, je Abschnitt, mit der jetzigen und der vorgeschlagenen
 * Fassung, und lassen sich einzeln übernehmen. Zeilen, die es nur in der Datei
 * gibt, sind meist bewusst gesetzt: sie stehen als Hinweis da und lassen sich
 * nicht auswählen. Was verglichen wird und was nie, steht in
 * `lib/haproxy/base-config-diff.ts`.
 *
 * Lädt sich selbst und erneuert sich im Minutentakt, solange nichts ausgewählt
 * ist: ein Takt, der die Liste unter einer Auswahl austauscht, nähme Haken weg.
 */

export interface BaseConfigRow {
  $id: string;
  name: string;
  diff: BaseConfigDiff | null;
  error: string | null;
}

/** Die Abweichungen eines Abschnitts, in der Reihenfolge der Grundkonfiguration. */
function bySection(drifts: BaseConfigDrift[]): [string, BaseConfigDrift[]][] {
  const groups = new Map<string, BaseConfigDrift[]>();
  for (const drift of drifts) {
    const list = groups.get(drift.section) ?? [];
    list.push(drift);
    groups.set(drift.section, list);
  }
  return [...groups.entries()];
}

export default function BaseConfigPanel() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, rich } = useT();

  const [row, setRow] = useState<BaseConfigRow | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/base-config');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const next = (data.data as BaseConfigRow[])[0] ?? null;
      setRow(next);
      // Eine Auswahl, deren Zeile es nicht mehr gibt, fällt weg.
      const ids = new Set(next?.diff?.drifts.map((drift) => drift.id) ?? []);
      setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [apiFetch]);

  useMountedLoad(load);

  /* Der Link auf der Übersicht zielt auf `#grundkonfiguration`. Die Karten
     darüber laden später und schieben diese nach unten, der Sprung des Browsers
     landete dann daneben. Deshalb einmal nachgezogen, sobald der Abgleich da ist. */
  const card = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (!row || scrolled.current || window.location.hash !== '#grundkonfiguration') return;
    const timer = setTimeout(() => {
      scrolled.current = true;
      card.current?.scrollIntoView({ block: 'start' });
    }, 300);
    return () => clearTimeout(timer);
  }, [row]);
  usePolling(() => {
    if (selected.size === 0 && !busy) void load();
  }, 60_000);

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function apply(target: BaseConfigRow) {
    const count = selected.size;
    const ok = await confirm({
      title: t('Ausgewählte Zeilen übernehmen?'),
      message: plural(count, {
        one: '{count} Zeile wird in haproxy.cfg geschrieben. HAProxy prüft die Datei vorher und lädt danach neu. Scheitert das, bleibt die bisherige Fassung stehen.',
        other: '{count} Zeilen werden in haproxy.cfg geschrieben. HAProxy prüft die Datei vorher und lädt danach neu. Scheitert das, bleibt die bisherige Fassung stehen.',
      }),
      confirmLabel: t('Übernehmen'),
      variant: 'warning',
    });
    if (!ok) return;

    setBusy(true);
    try {
      const res = await apiFetch('/api/haproxy/base-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: target.$id, ids: [...selected] }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t('Der Vorgang ist fehlgeschlagen.'));

      const steps = data.data.steps as { label: string; ok: boolean; detail?: string }[];
      const failed = steps.find((step) => !step.ok);
      setRow({ ...target, diff: data.data.diff as BaseConfigDiff, error: null });
      if (!failed) setSelected(new Set());
      notify(
        failed
          ? {
              variant: 'error',
              title: t('Grundkonfiguration'),
              message: `${t(failed.label)}: ${failed.detail ? t(failed.detail) : t('fehlgeschlagen')}`,
            }
          : {
              variant: 'success',
              title: t('Grundkonfiguration'),
              message: t('Übernommen, geprüft und HAProxy neu geladen.'),
            }
      );
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Übernehmen fehlgeschlagen'),
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setBusy(false);
    }
  }

  const diff = row?.diff ?? null;
  const applicable = diff?.drifts.filter((drift) => drift.kind !== 'extra') ?? [];

  return (
    <div className="card sys-block" id="grundkonfiguration" ref={card}>
      <div className="card-header">
        <div>
          <h2 className="card-title">
            <FileCog size={16} />
            {t('Grundkonfiguration')}
            <InfoHint
              text={t(
                'HAPM schreibt die Grundkonfiguration nur, wenn haproxy.cfg fehlt. Neue Vorgaben kommen bei einer bestehenden Installation deshalb nicht von selbst an. Verglichen werden global, defaults und die beiden Frontends, ohne die Bereiche der Gruppen und ohne die Einstellungen auf dieser Seite.'
              )}
            />
          </h2>
          <p className="card-subtitle">{t('Wo haproxy.cfg von den Vorgaben von HAPM abweicht.')}</p>
        </div>
        {row && applicable.length > 0 && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => apply(row)}
            disabled={busy || selected.size === 0}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            {t('Ausgewählte übernehmen')}
          </button>
        )}
      </div>

      {!row ? (
        loadFailed ? (
          <div className="alert alert-danger">{t('Der Abgleich konnte nicht geladen werden.')}</div>
        ) : (
          <SkeletonRows count={3} />
        )
      ) : row.error || !diff ? (
        <div className="alert alert-danger">{row.error ?? t('HAProxy ist nicht erreichbar.')}</div>
      ) : (
        <>
          {diff.missingSections.length > 0 && (
            <div className="alert alert-warning">
              <span>
                {rich(
                  'Nicht gefunden: {sections}. Diese Abschnitte werden nicht abgeglichen und nicht angelegt.',
                  { sections: <code>{diff.missingSections.join(', ')}</code> }
                )}
              </span>
            </div>
          )}

          {diff.drifts.length === 0 ? (
            <span className="form-hint">{t('Die Datei entspricht der Grundkonfiguration von HAPM.')}</span>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }} />
                    <th>{t('In der Datei')}</th>
                    <th>{t('Vorschlag')}</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {bySection(diff.drifts).map(([section, drifts]) => (
                    <Fragment key={section}>
                      <tr>
                        <td colSpan={4}>
                          <code>{section}</code>
                        </td>
                      </tr>
                      {drifts.map((drift) => (
                        <tr key={drift.id}>
                          <td>
                            {drift.kind === 'extra' ? null : (
                              <label className="toggle-switch">
                                <input
                                  type="checkbox"
                                  checked={selected.has(drift.id)}
                                  disabled={busy}
                                  onChange={(e) => toggle(drift.id, e.target.checked)}
                                  aria-label={t('Auswählen')}
                                />
                                <span className="toggle-slider" />
                              </label>
                            )}
                          </td>
                          {drift.current === null ? (
                            <td>
                              <span className="form-hint">{t('fehlt')}</span>
                            </td>
                          ) : (
                            <td className="mono">{drift.current}</td>
                          )}
                          {drift.proposed === null ? (
                            <td>
                              <span className="badge-status badge-neutral">
                                <span className="dot" />
                                {t('Nur hier, bleibt stehen')}
                              </span>
                            </td>
                          ) : (
                            <td className="mono">{drift.proposed}</td>
                          )}
                          <td>{drift.hint && <InfoHint text={t(drift.hint)} position="left" />}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
