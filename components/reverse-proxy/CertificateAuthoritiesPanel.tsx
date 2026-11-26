'use client';

import { useCallback, useEffect, useImperativeHandle, useState, type ReactNode, type Ref } from 'react';
import Link from 'next/link';
import { BadgeCheck, Loader2, Plus, Replace, Trash2 } from 'lucide-react';
import ErrorNote from '@/components/ErrorNote';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useMountedLoad } from '@/components/useMountedLoad';
import { useNow } from '@/components/useNow';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { errorText } from '@/components/errorText';
import { SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { subscribeRunFinished } from '@/components/runs/runs';
import { MISSING, formatDate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import CertificateAuthorityDialog, { type AuthorityBody } from './CertificateAuthorityDialog';
// Nur Typen: die Datei dahinter erreicht `lib/ssh`.
import type { CaList, CaRow, CaSaved } from '@/lib/haproxy/ca-actions';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Die hinterlegten Zertifizierungsstellen: womit HAProxy das Zertifikat eines
 * Ziels prüft, das aus einer eigenen CA kommt (Reiter der Zertifikatsseite).
 *
 * Eine Tabelle wie bei den Zertifikaten daneben: verglichen wird, wer
 * ausgestellt hat, bis wann es gilt und wer es benutzt. Der Fingerabdruck steht
 * ganz da, weil er die Frage beantwortet, um die es bei einer Root geht: ist es
 * die richtige.
 *
 * Der Knopf „Aktualisieren" gehört der Seite. Sie ruft `reload` über `ref`.
 */
export interface AuthoritiesHandle {
  reload: () => Promise<void>;
}

export default function CertificateAuthoritiesPanel({ ref }: { ref?: Ref<AuthoritiesHandle> }) {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, locale } = useT();
  // Stündlich genügt: daran hängt nur, ob „läuft bald ab" oder „abgelaufen" dasteht.
  const now = useNow(60 * 60 * 1000);

  const [list, setList] = useState<CaList | null>(null);
  const [error, setError] = useState('');
  /** Offen: `null` heißt neu hinterlegen, sonst die Zeile, die ersetzt wird. */
  const [editing, setEditing] = useState<{ replace: CaRow | null } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/certificate-authorities');
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error);
      setList(data.data);
      setError('');
    } catch (err: unknown) {
      setError(errorText(err, t('Die Zertifizierungsstellen konnten nicht geladen werden.')));
    }
  }, [apiFetch, t]);

  useMountedLoad(load);
  useImperativeHandle(ref, () => ({ reload: load }), [load]);

  // Wie die Zertifikate daneben: es ändert sich nur, wenn jemand etwas hinterlegt oder ein Ziel umstellt.
  usePolling(load, 120_000);

  // Ein Lauf am Reverse-Proxy kann ändern, wer eine Stelle benutzt.
  useEffect(
    () =>
      subscribeRunFinished((run) => {
        if (run.kind === 'haproxy') void load();
      }),
    [load]
  );

  async function save(body: AuthorityBody) {
    const res = await apiFetch('/api/haproxy/certificate-authorities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || t('Die Zertifizierungsstelle ließ sich nicht hinterlegen.'));
    const saved = data.data as CaSaved;
    setEditing(null);
    notify({
      variant: 'success',
      message: !body.replace
        ? t('Die Zertifizierungsstelle {name} ist hinterlegt. Sie lässt sich jetzt an einem Ziel auswählen.', { name: saved.name })
        : saved.reloaded
          ? t('Die Zertifizierungsstelle {name} ist ersetzt. HAProxy ist neu geladen.', { name: saved.name })
          : t('Die Zertifizierungsstelle {name} ist ersetzt.', { name: saved.name }),
    });
    // Ein Hinweis verhindert nichts, soll aber gelesen werden: ein eigener Toast je Hinweis.
    for (const warning of saved.warnings) notify({ variant: 'warning', message: warning });
    await load();
  }

  async function remove(ca: CaRow) {
    const confirmed = await confirm({
      title: t('Zertifizierungsstelle entfernen?'),
      message: t('Die Datei von {name} wird entfernt. Danach lässt sie sich an keinem Ziel mehr auswählen.', { name: ca.name }),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setRemoving(ca.name);
    try {
      const res = await apiFetch(`/api/haproxy/certificate-authorities?name=${encodeURIComponent(ca.name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      notify({ variant: 'success', message: t('Die Zertifizierungsstelle {name} ist entfernt.', { name: ca.name }) });
      await load();
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Entfernen fehlgeschlagen'),
        message: errorText(err, t('Die Zertifizierungsstelle ließ sich nicht entfernen.')),
      });
    } finally {
      setRemoving(null);
    }
  }

  function expiryCell(ca: CaRow, warnDays: number): ReactNode {
    if (!ca.notAfter) return <span style={{ color: 'var(--text-secondary)' }}>{t('Nicht lesbar')}</span>;
    const days = Math.floor((Date.parse(ca.notAfter) - now) / DAY_MS);
    const date = formatDate(locale, ca.notAfter);
    if (days < 0) {
      return (
        <span className="badge-status badge-danger">
          <span className="dot" />
          {t('Abgelaufen am {date}', { date })}
        </span>
      );
    }
    if (days < warnDays) {
      return (
        <span className="badge-status badge-warning">
          <span className="dot" />
          {t('Läuft am {date} ab', { date })}
        </span>
      );
    }
    return date;
  }

  const usersCell = (ca: CaRow): ReactNode =>
    ca.usedBy.length > 0 ? (
      ca.usedBy.map((user, index) => (
        <span key={user.id}>
          {index > 0 && ', '}
          {user.slug ? <Link href={`/reverse-proxy/${user.slug}?dienst=${encodeURIComponent(user.id)}`}>{user.id}</Link> : user.id}
        </span>
      ))
    ) : (
      <span style={{ color: 'var(--text-secondary)' }}>{t('Von keinem Eintrag benutzt')}</span>
    );

  if (list === null && !error) return <SkeletonRows />;

  const authorities = list?.authorities ?? [];
  const warnDays = list?.warnDays ?? 30;

  return (
    <>
      {error && (
        <div className="alert alert-danger sys-block">
          <ErrorNote text={error} />
        </div>
      )}
      {list?.error && (
        <div className="alert alert-danger sys-block">
          <ErrorNote text={list.error} />
        </div>
      )}

      <div className="sys-block">
        <div className="section-header">
          <h2 className="section-title">
            {t('Zertifizierungsstellen')}
            <InfoHint
              text={t(
                'Für Ziele, die HTTPS sprechen und deren Zertifikat aus einer eigenen CA kommt. Hinterlegen Sie hier das Zertifikat der CA und wählen Sie sie am Ziel unter „HTTPS, Zertifikat prüfen“ aus. HAProxy nimmt das Zertifikat des Ziels dann nur an, wenn diese Stelle es ausgestellt hat und es für die aufgerufene Domain gilt.'
              )}
            />
            <span className="section-count">
              {plural(authorities.length, { one: '{count} Stelle', other: '{count} Stellen' })}
            </span>
          </h2>
          <span className="section-hint">{t('Erneuert niemand von selbst. HAPM erinnert vor dem Ablauf.')}</span>
          <button
            className="btn btn-primary btn-sm"
            style={{ marginLeft: 'auto' }}
            disabled={list === null || list.error !== null || removing !== null}
            onClick={() => setEditing({ replace: null })}
          >
            <Plus size={14} />
            {t('Hinterlegen')}
          </button>
        </div>

        {list?.error ? null : authorities.length === 0 ? (
          <div className="empty-state">
            <BadgeCheck size={32} />
            <h3>{t('Keine Zertifizierungsstelle hinterlegt')}</h3>
            <p>{t('Gebraucht wird sie für Ziele, deren Zertifikat aus einer eigenen CA kommt.')}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Zertifikate der Stelle')}</th>
                  <th>{t('Gültig bis')}</th>
                  <th>{t('Benutzt von')}</th>
                  <th aria-label={t('Aktionen')} />
                </tr>
              </thead>
              <tbody>
                {authorities.map((ca) => (
                  <tr key={ca.name}>
                    <td data-label="primary">
                      <code>{ca.name}</code>
                    </td>
                    <td data-label={t('Zertifikate der Stelle')}>
                      {ca.certificates.length === 0
                        ? MISSING
                        : ca.certificates.map((cert) => (
                            <div key={cert.fingerprint} className="ca-cert">
                              <span>
                                {cert.subject}
                                {!cert.selfSigned && (
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {' '}
                                    {t('(ausgestellt von {issuer})', { issuer: cert.issuer })}
                                  </span>
                                )}
                              </span>
                              <code className="ca-fingerprint" data-tooltip={t('Fingerabdruck SHA-256')}>
                                {cert.fingerprint}
                              </code>
                            </div>
                          ))}
                    </td>
                    <td data-label={t('Gültig bis')}>{expiryCell(ca, warnDays)}</td>
                    <td data-label={t('Benutzt von')}>{usersCell(ca)}</td>
                    <td data-label="actions">
                      <div className="hapm-form-actions" style={{ flexWrap: 'nowrap' }}>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip={t('Ersetzen')}
                          aria-label={t('Ersetzen')}
                          disabled={removing !== null}
                          onClick={() => setEditing({ replace: ca })}
                        >
                          <Replace size={16} />
                        </button>
                        {/* Solange ein Ziel sie benutzt, gibt es nichts zu entfernen: die Route lehnte es ab. */}
                        {ca.usedBy.length === 0 && (
                          <button
                            className="btn btn-ghost btn-icon btn-sm"
                            data-tooltip={t('Entfernen')}
                            aria-label={t('Entfernen')}
                            disabled={removing !== null}
                            onClick={() => void remove(ca)}
                          >
                            {removing === ca.name ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <CertificateAuthorityDialog
          replace={editing.replace ? { name: editing.replace.name, usedBy: editing.replace.usedBy.map((user) => user.id) } : null}
          onSave={save}
          onError={(message) =>
            notify({
              variant: 'error',
              title: editing.replace ? t('Ersetzen fehlgeschlagen') : t('Hinterlegen fehlgeschlagen'),
              message,
            })
          }
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
