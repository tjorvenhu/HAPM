'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ShieldCheck, Loader2, RefreshCw, Network, Info } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import type { AcmeCertificate } from '@/lib/haproxy/certs';
import { SkeletonRows } from '@/components/Skeleton';

/**
 * Was an Zertifikaten auf dem Server liegt.
 *
 * ── Warum es die Seite gibt ──
 *
 * Bis zu den Wildcards gehörte ein Zertifikat genau einem Dienst, und damit
 * stand alles Wissenswerte über es auf dessen Karte. Ein Wildcard-Zertifikat
 * bedient mehrere Dienste — das ist sein Sinn —, und damit gibt es zum ersten
 * Mal etwas, das keinem Eintrag gehört. Wer `app.kunde.example` löscht, soll sehen
 * können, dass `*.kunde.example` weiter gebraucht wird.
 *
 * Der zweite Grund stand schon vorher da und war unsichtbar: ein von Hand auf
 * der Maschine ausgestelltes Zertifikat kannte dieses Werkzeug nicht. Hier
 * steht es, mit „von keinem Eintrag benutzt" daneben.
 *
 * ── Nur lesend ──
 *
 * Kein Löschen-Knopf. Ein Zertifikat entsteht und vergeht mit einem Dienst;
 * es hier einzeln zu entfernen hieße, dem Reverse-Proxy das PEM unter einer
 * laufenden Domain wegzuziehen — und das fiele nicht heute auf, sondern beim
 * nächsten Start von HAProxy. Was weg soll, geht über den Dienst weg.
 *
 * Eine Tabelle und keine Karten: hier wird verglichen (welche Domains, wann
 * erneuert, wer benutzt es), und das ist die Trennlinie aus CLAUDE.md.
 */

interface CertificateUser {
  id: string;
  /** Der Adressteil seiner Gruppe. `null` heißt: der Eintrag liegt außerhalb
   *  aller Marker und hat keine Seite — dann steht sein Name ohne Link da. */
  slug: string | null;
}

interface CertificateRow extends AcmeCertificate {
  usedBy: CertificateUser[];
}

interface ProxyCertificates {
  $id: string;
  name: string;
  host: string;
  acmeReady: boolean;
  dnsHooks: string[];
  certificates: CertificateRow[];
  error: string | null;
}

export default function ReverseProxyCertificatesPage() {
  const { apiFetch } = useApp();

  const [rows, setRows] = useState<ProxyCertificates[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/haproxy/certificates');
        const data = await res.json();
        if (data.success) setRows(data.data);
        setError('');
      } catch {
        setError('Die Zertifikate konnten nicht geladen werden.');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /* Zwei Minuten und nicht zwanzig Sekunden wie die Gruppenseite: ein
   * Zertifikat ändert sich beim Ausstellen und beim Erneuern, sonst nie, und
   * jeder Takt ist ein `acme.sh --list` über jedes Domainverzeichnis. */
  usePolling(() => load(true), 120_000);

  /** Ein eigener Zustand für den Knopf, damit die Liste beim Aktualisieren
   *  stehen bleibt statt hinter einem Overlay zu verschwinden — mit
   *  Mindestdauer, sonst blitzt der Spinner nur auf und das sieht aus wie ein
   *  Fehler. */
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([load(true), new Promise((resolve) => setTimeout(resolve, 400))]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Zertifikate</h1>
          <p className="page-subtitle">
            Was acme.sh an Zertifikaten führt. Gelesen bei jedem Aufruf, nicht aus einer Kopie.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            Aktualisieren
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {loading ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <Network size={40} />
          <h3>HAProxy antwortet nicht</h3>
          <p>
            Ohne HAProxy gibt es hier nichts zu zeigen. Sein Zustand steht in der{' '}
            <Link href="/dashboard">Übersicht</Link>.
          </p>
        </div>
      ) : (
        <>
          <div className="form-note sys-block">
            <Info size={14} />
            <span>
              Angelegt und entfernt werden Zertifikate über den zugehörigen Eintrag unter „Ziele“.
              Ein Zertifikat hier einzeln zu löschen nähme einer laufenden Domain ihr PEM.
            </span>
          </div>

          {rows.map((row) => (
            <div key={row.$id} className="sys-block">
              <div className="section-header">
                <h2 className="section-title">
                  Ausgestellt
                  <span className="section-count">
                    {row.certificates.length}{' '}
                    {row.certificates.length === 1 ? 'Zertifikat' : 'Zertifikate'}
                  </span>
                </h2>
                <span className="section-hint">
                  {row.dnsHooks.length > 0
                    ? `DNS-Hooks: ${row.dnsHooks.join(', ')}`
                    : 'Kein DNS-Hook eingerichtet, keine Wildcard ausstellbar'}
                </span>
              </div>

              {row.error ? (
                <div className="alert alert-danger">{row.error}</div>
              ) : !row.acmeReady ? (
                <div className="alert alert-warning">
                  <span>
                    acme.sh oder das Zertifikatsverzeichnis fehlt. HAPM richtet beides beim Start
                    selbst ein, der Zustand steht in der <Link href="/dashboard">Übersicht</Link>.
                    Solange das so ist, lässt sich kein Zertifikat ausstellen, und diese Liste ist
                    leer, weil nicht gefragt werden konnte, nicht weil es keine gibt.
                  </span>
                </div>
              ) : row.certificates.length === 0 ? (
                <div className="empty-state">
                  <ShieldCheck size={32} />
                  <h3>Noch kein Zertifikat</h3>
                  <p>acme.sh führt keins.</p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Hauptdomain</th>
                        <th>Abgedeckte Domains</th>
                        <th>Schlüssel</th>
                        <th>Erneuerung</th>
                        <th>Benutzt von</th>
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
                          <td>{formatRenew(cert.renewAt)}</td>
                          <td>
                            {cert.usedBy.length > 0 ? (
                              /* Der Name ist der Weg dorthin: `?dienst=` öffnet
                                 den Bearbeiten-Dialog auf der Gruppenseite. Ohne
                                 das müsste man die Gruppe raten, die Seite
                                 suchen und dort die Karte finden — bei dreißig
                                 Einträgen ist das der Umweg, den niemand geht. */
                              cert.usedBy.map((user, index) => (
                                <span key={user.id}>
                                  {index > 0 && ', '}
                                  {user.slug ? (
                                    <Link
                                      href={`/reverse-proxy/${user.slug}?dienst=${encodeURIComponent(user.id)}`}
                                    >
                                      {user.id}
                                    </Link>
                                  ) : (
                                    user.id
                                  )}
                                </span>
                              ))
                            ) : (
                              /* Der Befund, für den es diese Spalte gibt: ein
                                 Zertifikat ohne Eintrag ist entweder von Hand
                                 ausgestellt oder von einem gelöschten Dienst
                                 übrig. Beides gehört gesehen und nicht
                                 automatisch aufgeräumt. */
                              <span style={{ color: 'var(--text-secondary)' }}>
                                Von keinem Eintrag benutzt
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

/** acme.sh schreibt den Zeitpunkt als ISO-Text. Was sich nicht lesen lässt,
 *  steht so da, wie es kam — geraten wird nichts. */
function formatRenew(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('de-DE');
}
