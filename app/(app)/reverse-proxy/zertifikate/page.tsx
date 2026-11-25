'use client';

import { useEffect, useState, useCallback, type ReactNode } from 'react';
import Link from 'next/link';
import { ShieldCheck, Loader2, RefreshCw, RotateCw, Network, Info, Upload, Replace, Trash2 } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import CertificateUploadDialog, { type UploadBody } from '@/components/reverse-proxy/CertificateUploadDialog';
import CertificateIssueDialog from '@/components/reverse-proxy/CertificateIssueDialog';
import { InfoHint } from '@/ui/primitives/InfoHint';
import type { AcmeCertificate } from '@/lib/haproxy/certs';
import type { UploadedCertificate } from '@/lib/haproxy/cert-upload';
import type { CertificateSource } from '@/lib/types';
import { SkeletonRows } from '@/components/Skeleton';
import { formatDate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Was an Zertifikaten auf dem Server liegt.
 *
 * ── Warum es die Seite gibt ──
 *
 * Bis zu den Wildcards gehörte ein Zertifikat genau einem Dienst, und damit
 * stand alles Wissenswerte über es auf dessen Karte. Ein Wildcard-Zertifikat
 * bedient mehrere Dienste, und damit gibt es etwas, das keinem Eintrag gehört.
 * Wer `app.kunde.example` löscht, soll sehen können, dass `*.kunde.example`
 * weiter gebraucht wird. Dazu kommt, was von Hand ausgestellt wurde: hier
 * steht es, mit „von keinem Eintrag benutzt" daneben.
 *
 * ── Zwei Herkünfte, zwei Regeln ──
 *
 * Was acme.sh führt, entsteht und vergeht mit einem Dienst. Gelöscht wird es
 * hier nur, wenn niemand es hält (`keptBy` leer): kein Ziel bekommt es
 * ausgeliefert, und es deckt keine Domain eines Ziels ab. Sonst hieße es, dem
 * Reverse-Proxy das PEM unter einer laufenden Domain wegzuziehen. Die Route
 * prüft das im Lock noch einmal, die Seite zeigt nur den Knopf.
 *
 * Hochgeladene Zertifikate entstehen dagegen nur hier, also werden sie hier
 * ersetzt und entfernt. Entfernen geht nur, solange danach kein Ziel ohne
 * Zertifikat dastünde; das prüft die Route, die Seite zeigt den Grund.
 *
 * Tabellen und keine Karten: hier wird verglichen (welche Domains, wann
 * erneuert oder abgelaufen, wer benutzt es).
 */

interface CertificateUser {
  id: string;
  /** Der Adressteil seiner Gruppe. `null` heißt: der Eintrag liegt außerhalb
   *  aller Marker und hat keine Seite, dann steht sein Name ohne Link da. */
  slug: string | null;
}

interface CertificateRow extends AcmeCertificate {
  /** Wem HAProxy dieses Zertifikat ausliefert, nicht wen es abdecken könnte:
   *  ein genaueres Zertifikat für denselben Namen gewinnt vor der Wildcard. */
  usedBy: CertificateUser[];
  /** Ob die PEM-Datei im Zertifikatsverzeichnis liegt. `null`: unbekannt. */
  deployed: boolean | null;
  /** Wer es hält: `usedBy` und die Ziele, deren Domains es abdeckt. Leer heißt löschbar. */
  keptBy: string[];
}

interface UploadedRow extends UploadedCertificate {
  usedBy: CertificateUser[];
}

interface ProxyCertificates {
  $id: string;
  name: string;
  host: string;
  acmeReady: boolean;
  dnsHooks: string[];
  source: CertificateSource;
  certificates: CertificateRow[];
  uploaded: UploadedRow[];
  error: string | null;
}

/** Ab hier wird ein hochgeladenes Zertifikat als bald ablaufend markiert, wie in der Übersicht. */
const UPLOAD_WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export default function ReverseProxyCertificatesPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, rich, locale } = useT();
  // Stündlich genügt: daran hängt nur, ob „läuft bald ab" oder „abgelaufen" dasteht.
  const now = useNow(60 * 60 * 1000);

  const [rows, setRows] = useState<ProxyCertificates[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  /** Offen: `null` heißt neu hochladen, sonst die Zeile, die ersetzt wird. */
  const [uploading, setUploading] = useState<{ replace: UploadedRow | null } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  /** Der nie ausgestellte Antrag, der gerade noch einmal gestellt wird. */
  const [issuing, setIssuing] = useState<{ cert: CertificateRow; dnsHooks: string[] } | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/haproxy/certificates');
        const data = await res.json();
        if (data.success) setRows(data.data);
        setError('');
      } catch {
        setError(t('Die Zertifikate konnten nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /* Zwei Minuten und nicht zwanzig Sekunden wie die Gruppenseite: ein
   * Zertifikat ändert sich beim Ausstellen und beim Erneuern, sonst nie, und
   * jeder Takt ist ein `acme.sh --list` über jedes Domainverzeichnis. */
  usePolling(() => load(true), 120_000);

  /** Ein eigener Zustand für den Knopf, damit die Liste beim Aktualisieren
   *  stehen bleibt, mit Mindestdauer, sonst blitzt der Spinner nur auf. */
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([load(true), new Promise((resolve) => setTimeout(resolve, 400))]);
    } finally {
      setRefreshing(false);
    }
  }

  async function upload(body: UploadBody) {
    const res = await apiFetch('/api/haproxy/certificates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || t('Das Zertifikat ließ sich nicht hochladen.'));
    setUploading(null);
    notify({
      variant: 'success',
      message: body.replace
        ? t('Das Zertifikat für {domains} ist ersetzt. HAProxy ist neu geladen.', { domains: data.data.certificate.domains.join(', ') })
        : t('Das Zertifikat für {domains} ist hochgeladen. HAProxy ist neu geladen.', { domains: data.data.certificate.domains.join(', ') }),
    });
    await load(true);
  }

  async function remove(cert: UploadedRow) {
    const confirmed = await confirm({
      title: t('Zertifikat entfernen?'),
      message: t(
        'Die Datei {file} wird gelöscht und HAProxy neu geladen. Für {domains} liefert HAProxy danach ein anderes passendes Zertifikat oder den Platzhalter.',
        { file: cert.file, domains: cert.domains.join(', ') || cert.file }
      ),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setRemoving(cert.file);
    try {
      const res = await apiFetch(`/api/haproxy/certificates?file=${encodeURIComponent(cert.file)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      notify({ variant: 'success', message: t('Das Zertifikat {file} ist entfernt.', { file: cert.file }) });
      await load(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        message: err instanceof Error && err.message ? err.message : t('Das Zertifikat ließ sich nicht entfernen.'),
      });
    } finally {
      setRemoving(null);
    }
  }

  /** Was beim Löschen mit HAProxy geschieht, hängt daran, ob eine Datei geladen ist. */
  function acmeRemovalText(cert: CertificateRow): string {
    const domains = cert.domains.join(', ');
    if (cert.createdAt === null) {
      return t('acme.sh löscht den Antrag für {domains}. Ein Zertifikat gibt es dafür nicht, HAProxy bleibt unverändert.', { domains });
    }
    if (cert.deployed === false) {
      return t('acme.sh löscht das Zertifikat für {domains} samt Schlüssel. Ausgerollt ist es nicht, HAProxy bleibt unverändert.', { domains });
    }
    return t(
      'acme.sh löscht das Zertifikat für {domains} samt Schlüssel und erneuert es nicht mehr. Die Datei im Zertifikatsverzeichnis wird entfernt und HAProxy neu geladen.',
      { domains }
    );
  }

  /** Ein Zertifikat von acme.sh löschen. Wirft mit der Meldung der Route. */
  async function deleteAcme(cert: CertificateRow): Promise<{ reloaded: boolean }> {
    const res = await apiFetch(`/api/haproxy/certificates?domain=${encodeURIComponent(cert.mainDomain)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || t('Das Zertifikat ließ sich nicht löschen.'));
    return { reloaded: data.data.reloaded === true };
  }

  async function removeAcme(cert: CertificateRow) {
    const confirmed = await confirm({
      title: cert.createdAt === null ? t('Antrag löschen?') : t('Zertifikat löschen?'),
      message: acmeRemovalText(cert),
      confirmLabel: t('Löschen'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setRemoving(`acme:${cert.mainDomain}`);
    try {
      const { reloaded } = await deleteAcme(cert);
      notify({
        variant: 'success',
        message: reloaded
          ? t('Das Zertifikat für {domain} ist gelöscht. HAProxy ist neu geladen.', { domain: cert.mainDomain })
          : t('Das Zertifikat für {domain} ist gelöscht.', { domain: cert.mainDomain }),
      });
      await load(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        message: err instanceof Error && err.message ? err.message : t('Das Zertifikat ließ sich nicht löschen.'),
      });
    } finally {
      setRemoving(null);
    }
  }

  /** Alle, die niemand hält, nacheinander. Jedes prüft die Route einzeln im Lock. */
  async function removeUnused(certs: CertificateRow[]) {
    const confirmed = await confirm({
      title: t('Unbenutzte Zertifikate löschen?'),
      message: plural(
        certs.length,
        {
          one: 'acme.sh löscht {count} Zertifikat samt Schlüssel: {list}. Für jede geladene Datei wird HAProxy neu geladen.',
          other: 'acme.sh löscht {count} Zertifikate samt Schlüssel: {list}. Für jede geladene Datei wird HAProxy neu geladen.',
        },
        { list: certs.map((cert) => cert.mainDomain).join(', ') }
      ),
      confirmLabel: t('Alle löschen'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setRemoving('acme:*');
    const failed: string[] = [];
    let reason = '';
    try {
      for (const cert of certs) {
        try {
          await deleteAcme(cert);
        } catch (err: unknown) {
          failed.push(cert.mainDomain);
          if (err instanceof Error && err.message) reason = err.message;
        }
      }
      notify(
        failed.length === 0
          ? {
              variant: 'success',
              message: plural(certs.length, { one: '{count} Zertifikat ist gelöscht.', other: '{count} Zertifikate sind gelöscht.' }),
            }
          : { variant: 'error', message: t('Nicht gelöscht: {list}. {reason}', { list: failed.join(', '), reason }) }
      );
      await load(true);
    } finally {
      setRemoving(null);
    }
  }

  async function issue(cert: CertificateRow, dnsHook: string | null) {
    const res = await apiFetch('/api/haproxy/certificates/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mainDomain: cert.mainDomain, dnsHook }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || t('Der Antrag ließ sich nicht starten.'));
    setIssuing(null);
    notify({
      variant: 'success',
      message: t('Der Antrag für {domains} läuft. Den Fortschritt zeigt die Anzeige unten rechts.', {
        domains: cert.domains.join(', '),
      }),
    });
  }

  const usersCell = (usedBy: CertificateUser[]): ReactNode =>
    usedBy.length > 0 ? (
      /* Der Name ist der Weg dorthin: `?dienst=` öffnet den Bearbeiten-Dialog
         auf der Gruppenseite. Ohne das müsste man die Gruppe raten, die Seite
         suchen und dort die Karte finden. */
      usedBy.map((user, index) => (
        <span key={user.id}>
          {index > 0 && ', '}
          {user.slug ? (
            <Link href={`/reverse-proxy/${user.slug}?dienst=${encodeURIComponent(user.id)}`}>{user.id}</Link>
          ) : (
            user.id
          )}
        </span>
      ))
    ) : (
      /* Der Befund, für den es diese Spalte gibt: ein Zertifikat ohne Eintrag
         ist von Hand ausgestellt, im Voraus hochgeladen oder von einem
         gelöschten Dienst übrig. Beides gehört gesehen und nicht automatisch
         aufgeräumt. */
      <span style={{ color: 'var(--text-secondary)' }}>{t('Von keinem Eintrag benutzt')}</span>
    );

  /** Ein Antrag, der nie durchkam, hat keinen Termin: er hat kein Zertifikat. */
  function renewCell(cert: CertificateRow): ReactNode {
    if (cert.createdAt === null) {
      return (
        <span className="badge-status badge-warning" style={{ whiteSpace: 'nowrap' }}>
          <span className="dot" />
          {t('Nie ausgestellt')}
          <InfoHint
            text={t(
              'acme.sh führt den Antrag, aber er ist nie durchgekommen. Es gibt kein Zertifikat, HAProxy liefert keins dafür aus, und Ziele unter diesen Domains bekommen ein eigenes. Der Grund steht in der Historie beim gescheiterten Lauf.'
            )}
          />
        </span>
      );
    }
    return cert.renewAt ? formatDate(locale, cert.renewAt) : '—';
  }

  function acmeUsersCell(cert: CertificateRow): ReactNode {
    if (cert.createdAt === null) return '—';
    if (cert.deployed === false) {
      return (
        <span className="badge-status badge-warning" style={{ whiteSpace: 'nowrap' }}>
          <span className="dot" />
          {t('Nicht ausgerollt')}
          <InfoHint
            text={t(
              'acme.sh hat es ausgestellt, im Zertifikatsverzeichnis von HAProxy liegt es aber nicht. Das nächste Ziel, das es braucht, rollt es aus.'
            )}
          />
        </span>
      );
    }
    if (cert.usedBy.length === 0 && cert.keptBy.length > 0) {
      return (
        <span style={{ color: 'var(--text-secondary)' }}>
          {t('Von keinem Eintrag benutzt')}
          <InfoHint
            text={t(
              'Es deckt noch Domains dieser Ziele ab: {list}. Deshalb bleibt es stehen. Löschen lässt es sich, wenn kein Ziel mehr darunter liegt.',
              { list: cert.keptBy.join(', ') }
            )}
          />
        </span>
      );
    }
    return usersCell(cert.usedBy);
  }

  function expiryCell(cert: UploadedRow): ReactNode {
    if (!cert.notAfter) return <span style={{ color: 'var(--text-secondary)' }}>{t('Nicht lesbar')}</span>;
    const days = Math.floor((Date.parse(cert.notAfter) - now) / DAY_MS);
    const date = formatDate(locale, cert.notAfter);
    if (days < 0) return <span className="badge-status badge-danger"><span className="dot" />{t('Abgelaufen am {date}', { date })}</span>;
    if (days < UPLOAD_WARN_DAYS) {
      return <span className="badge-status badge-warning"><span className="dot" />{t('Läuft am {date} ab', { date })}</span>;
    }
    return date;
  }

  const source = rows[0]?.source ?? 'acme';

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('Zertifikate')}</h1>
          <p className="page-subtitle">
            {t('Was acme.sh führt und was hochgeladen ist. Gelesen bei jedem Aufruf, nicht aus einer Kopie.')}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
          <button className="btn btn-primary" onClick={() => setUploading({ replace: null })} disabled={loading || rows.length === 0}>
            <Upload size={16} />
            {t('Hochladen')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {loading ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <Network size={40} />
          <h3>{t('HAProxy antwortet nicht')}</h3>
          <p>
            {rich('Ohne HAProxy gibt es hier nichts zu zeigen. Sein Zustand steht in der {overview}.', {
              overview: <Link href="/dashboard">{t('Übersicht')}</Link>,
            })}
          </p>
        </div>
      ) : (
        <>
          <div className="form-note sys-block">
            <Info size={14} />
            <span>
              {source === 'upload'
                ? rich(
                    'Diese Installation stellt keine Zertifikate selbst aus. Ein neues Ziel braucht ein hochgeladenes Zertifikat, das seine Domains abdeckt. Umstellen lässt sich das unter {general}.',
                    { general: <Link href="/system">{t('Allgemein')}</Link> }
                  )
                : t(
                    'Zertifikate von acme.sh entstehen mit ihrem Ziel. Eins, das kein Ziel mehr braucht, löschen Sie in seiner Zeile. Hochgeladene ersetzen und entfernen Sie hier, acme.sh beantragt dann für ihre Domains keins.'
                  )}
            </span>
          </div>

          {rows.map((row) => {
            const unused = row.acmeReady ? row.certificates.filter((cert) => cert.keptBy.length === 0) : [];
            return (
            <div key={row.$id}>
              {row.error && <div className="alert alert-danger sys-block">{row.error}</div>}

              <div className="sys-block">
                <div className="section-header">
                  <h2 className="section-title">
                    {t('Hochgeladen')}
                    <span className="section-count">
                      {plural(row.uploaded.length, { one: '{count} Zertifikat', other: '{count} Zertifikate' })}
                    </span>
                  </h2>
                  <span className="section-hint">{t('Erneuert niemand von selbst. HAPM erinnert vor dem Ablauf.')}</span>
                </div>

                {row.uploaded.length === 0 ? (
                  <div className="empty-state">
                    <Upload size={32} />
                    <h3>{t('Kein hochgeladenes Zertifikat')}</h3>
                    <p>{t('Ein eigenes Zertifikat laden Sie mit dem Knopf oben hoch: PEM mit Kette und den privaten Schlüssel.')}</p>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('Datei')}</th>
                          <th>{t('Abgedeckte Domains')}</th>
                          <th>{t('Ausgestellt von')}</th>
                          <th>{t('Gültig bis')}</th>
                          <th>{t('Benutzt von')}</th>
                          <th aria-label={t('Aktionen')} />
                        </tr>
                      </thead>
                      <tbody>
                        {row.uploaded.map((cert) => (
                          <tr key={cert.file}>
                            <td>
                              <code>{cert.file}</code>
                            </td>
                            <td>{cert.domains.join(', ') || '—'}</td>
                            <td>{cert.issuer ?? '—'}</td>
                            <td>{expiryCell(cert)}</td>
                            <td>{usersCell(cert.usedBy)}</td>
                            <td>
                              <div className="hapm-form-actions">
                                <button
                                  className="btn btn-ghost btn-icon btn-sm"
                                  data-tooltip={t('Ersetzen')}
                                  aria-label={t('Ersetzen')}
                                  onClick={() => setUploading({ replace: cert })}
                                >
                                  <Replace size={16} />
                                </button>
                                <button
                                  className="btn btn-ghost btn-icon btn-sm"
                                  data-tooltip={t('Entfernen')}
                                  aria-label={t('Entfernen')}
                                  disabled={removing === cert.file}
                                  onClick={() => void remove(cert)}
                                >
                                  {removing === cert.file ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="sys-block">
                <div className="section-header">
                  <h2 className="section-title">
                    {t('Von acme.sh')}
                    <span className="section-count">
                      {plural(row.certificates.length, { one: '{count} Zertifikat', other: '{count} Zertifikate' })}
                    </span>
                  </h2>
                  <span className="section-hint">
                    {row.dnsHooks.length > 0
                      ? t('DNS-Hooks: {hooks}', { hooks: row.dnsHooks.join(', ') })
                      : t('Kein DNS-Hook eingerichtet, keine Wildcard ausstellbar')}
                  </span>
                  {unused.length > 1 && (
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ marginLeft: 'auto' }}
                      disabled={removing !== null}
                      onClick={() => void removeUnused(unused)}
                    >
                      {removing === 'acme:*' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                      {t('Unbenutzte löschen ({count})', { count: unused.length })}
                    </button>
                  )}
                </div>

                {row.error ? null : !row.acmeReady ? (
                  <div className="alert alert-warning">
                    <span>
                      {rich(
                        'acme.sh oder das Zertifikatsverzeichnis fehlt. HAPM richtet beides beim Start selbst ein, der Zustand steht in der {overview}. Solange das so ist, lässt sich kein Zertifikat ausstellen, und diese Liste ist leer, weil nicht gefragt werden konnte, nicht weil es keine gibt.',
                        { overview: <Link href="/dashboard">{t('Übersicht')}</Link> }
                      )}
                    </span>
                  </div>
                ) : row.certificates.length === 0 ? (
                  <div className="empty-state">
                    <ShieldCheck size={32} />
                    <h3>{t('Noch kein Zertifikat')}</h3>
                    <p>{t('acme.sh führt keins.')}</p>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('Hauptdomain')}</th>
                          <th>{t('Abgedeckte Domains')}</th>
                          <th>{t('Schlüssel')}</th>
                          <th>{t('Erneuerung')}</th>
                          <th>
                            {t('Benutzt von')}
                            <InfoHint
                              text={t(
                                'Die Ziele, denen HAProxy dieses Zertifikat ausliefert. Hat eine Domain ein eigenes Zertifikat, bekommt sie das, auch wenn eine Wildcard sie ebenfalls abdeckt.'
                              )}
                            />
                          </th>
                          <th aria-label={t('Aktionen')} />
                        </tr>
                      </thead>
                      <tbody>
                        {row.certificates.map((cert) => (
                          <tr key={cert.mainDomain}>
                            <td>
                              <code>{cert.mainDomain}</code>
                            </td>
                            <td>{cert.domains.join(', ')}</td>
                            <td>{cert.keyLength ?? '—'}</td>
                            <td>{renewCell(cert)}</td>
                            <td>{acmeUsersCell(cert)}</td>
                            <td>
                              {/* Ohne `nowrap` stehen die zwei Knöpfe eines nie ausgestellten Antrags untereinander. */}
                              <div className="hapm-form-actions" style={{ flexWrap: 'nowrap' }}>
                                {cert.createdAt === null && row.source === 'acme' && (
                                  <button
                                    className="btn btn-ghost btn-icon btn-sm"
                                    data-tooltip={t('Erneut beantragen')}
                                    aria-label={t('Erneut beantragen')}
                                    onClick={() => setIssuing({ cert, dnsHooks: row.dnsHooks })}
                                  >
                                    <RotateCw size={16} />
                                  </button>
                                )}
                                {unused.includes(cert) && (
                                  <button
                                    className="btn btn-ghost btn-icon btn-sm"
                                    data-tooltip={t('Löschen')}
                                    aria-label={t('Löschen')}
                                    disabled={removing !== null}
                                    onClick={() => void removeAcme(cert)}
                                  >
                                    {removing === `acme:${cert.mainDomain}` ? (
                                      <Loader2 size={16} className="spin" />
                                    ) : (
                                      <Trash2 size={16} />
                                    )}
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
            </div>
            );
          })}
        </>
      )}

      {issuing && (
        <CertificateIssueDialog
          mainDomain={issuing.cert.mainDomain}
          domains={issuing.cert.domains}
          dnsHooks={issuing.dnsHooks}
          onIssue={(dnsHook) => issue(issuing.cert, dnsHook)}
          onClose={() => setIssuing(null)}
        />
      )}

      {uploading && (
        <CertificateUploadDialog
          replace={uploading.replace ? { file: uploading.replace.file, domains: uploading.replace.domains } : null}
          onUpload={upload}
          onClose={() => setUploading(null)}
        />
      )}
    </>
  );
}
