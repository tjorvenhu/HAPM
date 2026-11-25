'use client';

import { useEffect, useRef, useState, useCallback, use, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Globe, Plus, Loader2, RefreshCw, X, Search, ArrowLeft, FolderMinus, ShieldCheck,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { usePolling } from '@/components/usePolling';
import { useConfirm } from '@/components/ConfirmDialog';
import UpdateRunOverlay from '@/components/UpdateRunOverlay';
import { HAPROXY_PHASES, HAPROXY_PHASE_LABELS } from '@/components/runPhases';
import Select from '@/components/Select';
import { SkeletonTitle, SkeletonCards } from '@/components/Skeleton';
import { EntityGrid } from '@/components/EntityCard';
import ServiceCard, { PendingCard } from '@/components/reverse-proxy/ServiceCard';
import { useSavedTargets } from '@/components/reverse-proxy/SavedTargetPick';
import ServiceFormModal from '@/components/reverse-proxy/ServiceFormModal';
import StreamCard from '@/components/reverse-proxy/StreamCard';
import StreamFormModal from '@/components/reverse-proxy/StreamFormModal';
import LockDialog, { type LockChoice } from '@/components/reverse-proxy/LockDialog';
import TargetKindDialog, {
  TARGET_KINDS,
  TARGET_KIND_LABELS,
  type TargetKind,
} from '@/components/reverse-proxy/TargetKindDialog';
import {
  scopePageFor,
  servicesInScope,
  streamsInScope,
  type ProxyRow,
} from '@/components/reverse-proxy/types';
import { handOverScopeRun } from '@/components/reverse-proxy/scopeHandover';
import {
  addPendingRun,
  applyRunSnapshot,
  isQueued,
  placeholderRuns,
  removePendingRuns,
  runForEntry,
  type PendingRun,
  type RunSnapshot,
} from '@/components/reverse-proxy/pendingRuns';
import {
  KEEP_PASSWORD,
  matchesSearch,
  serviceKind,
  toCreateInput,
  type HaproxyService,
  type ServiceKind,
} from '@/lib/haproxy/config';
import { matchesStreamSearch, type HaproxyStream } from '@/lib/haproxy/streams';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Eine Gruppe der Reverse-Proxy-Ziele.
 *
 * Eine Seite je Gruppe statt aller Abschnitte auf einer. Der Grund ist die
 * Länge: die Liste wächst mit jedem Eintrag, und wer einen Dienst sucht,
 * scrollte sonst an allen anderen Gruppen vorbei. Die Aufteilung ist dabei
 * keine Erfindung der Oberfläche — es sind die Marker-Blöcke der
 * Konfiguration.
 *
 * WELCHE Gruppen es gibt, steht deshalb auch nicht im Code: die Seite kennt
 * ihren Adressteil und findet die Gruppe erst, wenn die Konfiguration gelesen
 * ist. Vor dem Laden ist „gibt es nicht" nicht dasselbe wie „noch nicht
 * gelesen" — ein 404 aus dem ersten Render wäre eine Behauptung über eine
 * Datei, die noch niemand aufgemacht hat.
 *
 * Gelesen wird weiterhin bei jedem Aufruf direkt aus `/etc/haproxy/haproxy.cfg`;
 * es gibt keine Collection dahinter, siehe docs/reverse-proxy.md.
 */

export default function ReverseProxyScopePage({
  params,
}: {
  params: Promise<{ scope: string }>;
}) {
  const { scope: slug } = use(params);
  // `ScopeView` liest `useSearchParams` (siehe `?dienst=`), und Next verlangt
  // dafür eine Suspense-Grenze — ohne sie scheitert der Build an dieser Seite.
  return (
    <Suspense fallback={null}>
      <ScopeView slug={slug} />
    </Suspense>
  );
}

function ScopeView({ slug }: { slug: string }) {
  const { apiFetch } = useApp();
  // Einmal für alle Karten der Seite, nicht je Karte.
  const savedTargets = useSavedTargets();
  const { notify } = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, plural, rich } = useT();
  /** Von woanders verlinkt: `?dienst=<id>` öffnet den Bearbeiten-Dialog dieses
   *  Eintrags, sobald die Konfiguration gelesen ist. Kommt von der
   *  Zertifikatsseite, wo „Benutzt von" auf den Dienst zeigt. */
  const requestedService = searchParams.get('dienst');

  const [proxies, setProxies] = useState<ProxyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  /**
   * Nach welcher der vier Sorten gefiltert wird. Leer heißt: alle.
   *
   * Dieselben vier wie in der Auswahl beim Anlegen und dieselben Wörter — eine
   * Liste, in der man einen Eintrag anlegt, und eine, in der man ihn wiederfindet,
   * dürfen nicht verschieden heißen. `stream` ist dabei die einzige, die nicht
   * aus `serviceKind` kommt: eine TCP-Weiterleitung ist kein Dienst.
   */
  const [kindFilter, setKindFilter] = useState<TargetKind | ''>('');

  /**
   * Welcher Dialog offen ist.
   *
   * Drei Zustände statt eines Schalters, weil es drei Stufen sind: erst die
   * Frage, was für ein Ziel es werden soll (`kind`), dann das Formular dazu.
   * Beim Bearbeiten entfällt die erste — was der Eintrag ist, sagt der Eintrag.
   *
   * `service` und `stream` sind getrennt und nicht ein Feld mit einem
   * Unterscheider: es sind zwei Formulare, und ein gemeinsamer Typ hieße, in
   * jedem Zweig zu prüfen, welche Hälfte gerade gefüllt ist.
   */
  const [kindDialog, setKindDialog] = useState(false);
  const [dialog, setDialog] = useState<
    | {
        /** Nur beim Anlegen: welches der drei Formulare aufgeht. Beim
         *  Bearbeiten `null`, denn dann sagt der Eintrag, was er ist. */
        kind: ServiceKind | null;
        edit: { proxy: ProxyRow; service: HaproxyService } | null;
      }
    | null
  >(null);
  const [streamDialog, setStreamDialog] = useState<
    { edit: { proxy: ProxyRow; stream: HaproxyStream } | null } | null
  >(null);

  /**
   * Die eigenen Vorgänge, solange sie laufen. Eine Liste, kein einzelner Lauf:
   * wer mehrere Ziele kurz nacheinander anlegt, hat mehrere unterwegs, und jeder
   * braucht seine Karte und seine Meldung (siehe `pendingRuns.ts`).
   *
   * Anlegen, Ändern und Löschen laufen abgekoppelt (lib/haproxy/runner.ts): der
   * Dialog schließt sich sofort, und was passiert, steht in der Pille unten
   * rechts. Diese Seite behält trotzdem einen Faden zu jedem eigenen Vorgang,
   * um die Liste in dem Moment nachzuladen, in dem er fertig ist. Ohne das
   * stünde die neue Domain bis zum nächsten Takt nicht da, und das sähe aus,
   * als wäre nichts passiert.
   */
  const [pendingRuns, setPendingRuns] = useState<PendingRun[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  /** Der Vorgang läuft ab jetzt abgekoppelt: eine Meldung, dass er gestartet
   *  ist, und danach zeigt ihn die Pille unten rechts. Keine Memoisierung — die
   *  Funktion wird nur aus Klick-Handlern gerufen, nie aus einem Effekt. */
  function startRun(run: PendingRun) {
    setPendingRuns((current) => addPendingRun(current, run));
    notify({
      variant: 'info',
      title: t('{label} läuft', { label: run.label }),
      message: t('Zertifikat, Prüfung und Reload dauern ein paar Minuten. Der Fortschritt steht unten rechts.'),
      action: { label: t('Schritte ansehen'), onClick: () => setOpenRunId(run.id) },
    });
  }
  /** Welches Schloss gerade umgelegt wird — `<proxyId>:<serviceId>`. */
  const [lockingId, setLockingId] = useState<string | null>(null);
  /** Der Eintrag, für den gerade gefragt wird, WIE er gesperrt werden soll. */
  const [lockDialog, setLockDialog] = useState<{ proxy: ProxyRow; service: HaproxyService } | null>(
    null
  );
  const [removing, setRemoving] = useState(false);

  // Stille Variante, sonst blitzt bei jedem Poll-Takt der Ladebildschirm auf.
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/haproxy/services');
        const data = await res.json();
        if (data.success) setProxies(data.data);
        setError('');
      } catch {
        setError(t('Die Reverse-Proxy-Ziele konnten nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    load();
  }, [load]);

  /*
   * 20 Sekunden und nicht 60 wie auf der Übersicht.
   *
   * Für die Konfiguration wären 60 richtig — eine `haproxy.cfg` ändert sich
   * nicht im Minutentakt. Auf DIESER Seite steht aber die Healthcheck-Marke je
   * Karte, und die kommt aus `show stat`: ob ein Ziel antwortet, ändert sich
   * genau im Sekundentakt. Eine Farbe, die eine Minute alt sein darf, sagt über
   * ein totes Backend nichts mehr aus, und der Ausweg war bisher F5.
   *
   * Der Preis ist derselbe Aufruf dreimal so oft, also drei Runden Kommandos je
   * Minute, solange jemand die Seite offen hat — `usePolling` hält auf einem
   * versteckten Tab ohnehin an.
   */
  usePolling(() => load(true), 20_000);

  /**
   * Der Deep-Link von der Zertifikatsseite: `?dienst=<id>` öffnet den
   * Bearbeiten-Dialog.
   *
   * Erst, wenn die Konfiguration gelesen ist — vor dem Laden ist „gibt es
   * nicht" nicht dasselbe wie „noch nicht gelesen", und eine Meldung aus dem
   * ersten Render wäre eine Behauptung über eine Datei, die niemand aufgemacht
   * hat. Genau einmal, deshalb das Flag: sonst ginge der Dialog nach jedem
   * Poll-Takt wieder auf.
   */
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);
  useEffect(() => {
    if (deepLinkHandled || !requestedService || loading) return;
    setDeepLinkHandled(true);

    const target = scopePageFor(proxies, slug);
    const hit = target
      ? servicesInScope(proxies, target.scope).find(
          (entry) => entry.service.id === requestedService
        )
      : undefined;

    // Die Adresse wieder aufräumen, bevor der Dialog aufgeht: sonst öffnet ein
    // Reload nach dem Schließen denselben Dialog erneut.
    router.replace(`/reverse-proxy/${slug}`);

    if (hit) {
      setDialog({ kind: null, edit: hit });
      return;
    }
    notify({
      variant: 'error',
      title: t('Eintrag nicht gefunden'),
      message: t('„{id}" steht nicht (mehr) in dieser Gruppe.', { id: requestedService }),
    });
  }, [deepLinkHandled, requestedService, loading, proxies, slug, router, notify, t]);

  /*
   * Die eigenen Vorgänge verfolgen, bis sie fertig sind, und dann nachladen.
   *
   * EIN Intervall für alle, solange überhaupt einer läuft, und nicht eines je
   * Lauf: es fragt jeden ab, zieht Phase und Schritte nach und behandelt die
   * fertigen gemeinsam. Die Liste liest es aus einer Ref, sonst begänne das
   * Intervall bei jeder neuen Phase von vorn.
   */
  const pendingRunsRef = useRef(pendingRuns);
  useEffect(() => {
    pendingRunsRef.current = pendingRuns;
  }, [pendingRuns]);
  const tracking = pendingRuns.length > 0;

  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;
    // Ein Takt mit Nachladen dauert länger als zwei Sekunden. Der nächste
    // wartet, sonst meldete er denselben fertigen Lauf ein zweites Mal.
    let busy = false;

    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const runs = pendingRunsRef.current;
        const snapshots = await Promise.all(
          runs.map((run) =>
            apiFetch(`/api/haproxy/runs/${run.id}`)
              .then((r) => r.json())
              .then((data) => (data?.success ? (data.data as RunSnapshot) : null))
              .catch(() => null)
          )
        );
        if (cancelled) return;

        const running: [string, RunSnapshot][] = [];
        const finished: { run: PendingRun; ok: boolean }[] = [];
        runs.forEach((run, index) => {
          const snapshot = snapshots[index];
          if (!snapshot) return;
          if (snapshot.status === 'running') running.push([run.id, snapshot]);
          else finished.push({ run, ok: snapshot.status === 'success' });
        });
        // Die Phase auf der Karte mitziehen: „Zertifikat" dauert am längsten,
        // und ein Spinner ohne Wort sagt nicht, worauf man wartet. Als
        // Funktion von `current`: ein Lauf, der während der Abfrage gestartet
        // wurde, steht noch nicht in `runs` und darf nicht verloren gehen.
        setPendingRuns((current) =>
          running.reduce((acc, [id, snapshot]) => applyRunSnapshot(acc, id, snapshot), current)
        );
        if (finished.length === 0) return;

        /* ERST nachladen, dann Platzhalter abräumen und melden.
         *
         * Andersherum stand die Erfolgsmeldung da, während die Karte noch den
         * alten Zustand zeigte, und ein neuer Eintrag war ein bis drei Sekunden
         * lang weder Platzhalter noch Karte: zwischen „Lauf fertig" und „Liste
         * aktuell" liegt eine Runde Kommandos. Die Meldung meint jetzt beides:
         * der Vorgang ist durch UND die Liste zeigt es. */
        await load(true);
        if (cancelled) return;
        const done = new Set(finished.map(({ run }) => run.id));
        setPendingRuns((current) => removePendingRuns(current, done));
        for (const { run, ok } of finished) {
          notify({
            variant: ok ? 'success' : 'error',
            title: run.label,
            message: ok
              ? t('Durchgelaufen, HAProxy hat die neue Konfiguration übernommen.')
              : t('Nicht durchgelaufen. Der erste fehlgeschlagene Schritt steht im Protokoll.'),
            action: { label: t('Protokoll'), onClick: () => setOpenRunId(run.id) },
          });
        }
      } finally {
        busy = false;
      }
    };

    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tracking, apiFetch, load, notify, t]);

  /** Eigener Zustand statt `loading`: die Liste soll stehen bleiben, der Knopf
   *  trotzdem antworten. Die Mindestdauer verhindert ein Spinner-Flackern. */
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([load(true), new Promise((resolve) => setTimeout(resolve, 400))]);
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Die Sperre umlegen, ohne den Dialog zu öffnen.
   *
   * Geschickt wird der VOLLSTÄNDIGE Eintrag, wie ihn das Formular auch schicken
   * würde (`toCreateInput`) — die Route ersetzt ihn in einem Zug. Ein Sonderweg,
   * der nur die eine Zeile ändert, wäre ein zweiter Schreibpfad in dieselbe
   * Datei, und der müsste alles noch einmal können: Lock, Prüfsumme, Rollback.
   */
  function toggleLock(proxy: ProxyRow, service: HaproxyService) {
    if (!service.editable) return;
    // Der Knopf kennt zwei Handlungen: alles sperren oder alles öffnen. Wer
    // einzelne Domains meint, macht das im Dialog — dort stehen sie.
    //
    // Öffnen geht sofort. Sperren fragt vorher, auf welche Art: es gibt zwei,
    // und was der einen fehlt (Admin-IPs, eine neue genug HAProxy-Version),
    // steht dort auf ihrer Karte statt hier in einer Meldung.
    if (service.lockedDomains.length > 0) {
      void writeLock(proxy, service, null);
      return;
    }
    setLockDialog({ proxy, service });
  }

  /** `choice: null` löst die Sperre. */
  async function writeLock(proxy: ProxyRow, service: HaproxyService, choice: LockChoice | null) {
    const nextLocked = choice ? service.domains : [];
    const key = `${proxy.$id}:${service.id}`;
    setLockingId(key);
    try {
      const res = await apiFetch(`/api/haproxy/services/${encodeURIComponent(service.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: proxy.$id,
          ...toCreateInput(service),
          lockedDomains: nextLocked,
          // Der Verweis plus das neue Passwort: die Route macht daraus Hash und
          // Cookie-Wert. Hier entsteht keins von beiden.
          passwordLock: choice?.mode === 'password' ? KEEP_PASSWORD : null,
          lockPassword: choice?.mode === 'password' ? choice.password : '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Ändern fehlgeschlagen'));
      startRun({
        id: data.data.runId,
        label:
          choice === null
            ? t('Sperre von „{id}" lösen', { id: service.id })
            : choice.mode === 'password'
              ? t('„{id}" mit Passwort sperren', { id: service.id })
              : t('„{id}" auf Admin-IPs sperren', { id: service.id }),
        serviceId: service.id,
        title: service.domains[0] ?? service.id,
        isNew: false,
        kind: 'write',
        phase: null,
        steps: [],
      });
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Ändern fehlgeschlagen'),
        message: err instanceof Error ? err.message : t('Unbekannter Fehler.'),
      });
    } finally {
      setLockingId(null);
    }
  }

  async function handleDelete(proxy: ProxyRow, service: HaproxyService) {
    /* ── Gibt es überhaupt einen eigenen DNS-Eintrag? ──
     *
     * Gefragt wird vor dem Dialog und nicht darin: der Schalter soll nur da
     * sein, wenn es etwas zu entscheiden gibt. Ein Häkchen „DNS-Eintrag
     * mitlöschen" an einer Domain, für die keine Zone eingerichtet ist, wäre
     * eine Frage ohne Wirkung — und beim nächsten Mal glaubt man ihr nicht mehr.
     *
     * Ein Fehlschlag hier lässt den Löschvorgang unangetastet: dann steht der
     * Schalter eben nicht da, und der Lauf fasst DNS nicht an.
     */
    const managed = await apiFetch(
      `/api/dns/match?domains=${encodeURIComponent(service.domains.join(','))}`
    )
      .then((res) => res.json())
      .then((data) =>
        data.success
          ? (data.data as { domain: string; existing: { managed: boolean } | null }[])
              .filter((m) => m.existing?.managed)
              .map((m) => m.domain)
          : []
      )
      .catch(() => [] as string[]);

    await confirm({
      title: t('Reverse-Proxy-Ziel löschen'),
      message: [
        t(
          'Das entfernt die Weiche für {domains} aus der HAProxy-Konfiguration, samt Backend, Zertifikat und dessen automatischer Erneuerung.',
          { domains: service.domains.join(', ') }
        ),
        service.routes.length > 0
          ? plural(
              service.routes.length,
              { one: 'Die Pfad-Regel ({paths}) geht mit.', other: 'Die {count} Pfad-Regeln ({paths}) gehen mit.' },
              { paths: service.routes.map((r) => r.paths.join(' ')).join(', ') }
            )
          : null,
        t('Die Domains sind danach nicht mehr erreichbar.'),
      ]
        .filter(Boolean)
        .join(' '),
      // Nur, wenn es einen gibt — und dann standardmäßig an: ein CNAME, der auf
      // einen gelöschten Dienst zeigt, ist eine Karteileiche. Angeboten wird
      // ausschließlich, was dieses Werkzeug selbst gesetzt hat; ein A-Eintrag
      // von Hand bleibt ohnehin stehen (lib/dns/sync.ts).
      checkboxLabel: managed.length > 0 ? t('DNS-Einträge ebenfalls entfernen') : undefined,
      checkboxHint: managed.join(', '),
      checkboxDefault: true,
      requireText: service.id,
      requireTextLabel: t('Zum Bestätigen die Dienst-ID abtippen:'),
      confirmLabel: t('Endgültig löschen'),
      variant: 'danger',
      onConfirm: async (removeDns) => {
        const res = await apiFetch(`/api/haproxy/services/${encodeURIComponent(service.id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          // Ohne Eintrag gibt es keinen Schalter und nichts zu entfernen — dann
          // steht hier `false` und nicht der Zustand eines Häkchens, das der
          // Dialog gar nicht gezeigt hat.
          body: JSON.stringify({
            serverId: proxy.$id,
            removeDns: managed.length > 0 && removeDns,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          // Der Dialog zeigt den Text selbst an, solange er offen bleibt —
          // deshalb hier kein Toast, sondern das Werfen, auf das er wartet.
          throw new Error(data.error || t('Löschen fehlgeschlagen'));
        }
        startRun({
          id: data.data.runId,
          label: t('Ziel „{id}" löschen', { id: service.id }),
          serviceId: service.id,
          title: service.domains[0] ?? service.id,
          isNew: false,
          kind: 'delete',
          phase: null,
          steps: [],
        });
      },
    });
  }

  /**
   * Eine TCP-Weiterleitung entfernen.
   *
   * Kein DNS-Schalter und keine Frage nach dem Zertifikat: es gibt weder das
   * eine noch das andere. Was der Dialog dafür sagt, ist die Folge, die es hier
   * gibt und beim Dienst nicht — der Port nimmt danach keine Verbindungen mehr
   * an, und was gerade darüber läuft, bricht ab.
   */
  async function handleDeleteStream(proxy: ProxyRow, stream: HaproxyStream) {
    await confirm({
      title: t('TCP-Weiterleitung löschen'),
      message: t(
        'Das nimmt den listen-Abschnitt „{id}" aus der HAProxy-Konfiguration. Port {port} nimmt danach keine Verbindungen mehr an, und was gerade darüber läuft, bricht ab.',
        { id: stream.id, port: stream.port ?? '?' }
      ),
      requireText: stream.id,
      requireTextLabel: t('Zum Bestätigen die Kennung abtippen:'),
      confirmLabel: t('Endgültig löschen'),
      variant: 'danger',
      onConfirm: async () => {
        const res = await apiFetch(`/api/haproxy/streams/${encodeURIComponent(stream.id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: proxy.$id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('Löschen fehlgeschlagen'));
        startRun({
          id: data.data.runId,
          label: t('TCP-Weiterleitung „{id}" löschen', { id: stream.id }),
          serviceId: stream.id,
          title: `Port ${stream.port ?? '?'}`,
          isNew: false,
          kind: 'delete',
          phase: null,
          steps: [],
        });
      },
    });
  }

  const page = scopePageFor(proxies, slug);
  const entries = page ? servicesInScope(proxies, page.scope) : [];
  const streamEntries = page ? streamsInScope(proxies, page.scope) : [];
  const placeholders = placeholderRuns(
    pendingRuns,
    new Set([
      ...entries.map(({ service }) => service.id),
      ...streamEntries.map(({ stream }) => stream.id),
    ])
  );

  /**
   * Die Gruppe entfernen: ihre Marker-Paare.
   *
   * Nur, solange nichts drinsteht — sonst nähme das Entfernen Einträge mit, die
   * niemand gemeint hat. Geprüft wird das trotzdem auch im Lauf
   * (`removeScope` in config.ts): zwischen Anzeige und Vorgang kann jemand
   * einen Dienst angelegt haben.
   */
  async function removeScope() {
    if (!page) return;
    const okToGo = await confirm({
      title: t('Gruppe „{name}" entfernen?', { name: page.title }),
      message: t(
        'Die Marker-Paare werden aus der Konfiguration genommen. Es steht kein Eintrag darin, es geht also nichts offline. Danach lässt sich in dieser Gruppe nichts mehr anlegen.'
      ),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
    });
    if (!okToGo) return;

    setRemoving(true);
    try {
      const res = await apiFetch('/api/haproxy/scopes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: page.scope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Die Gruppe konnte nicht entfernt werden.'));
      // Diese Seite gibt es gleich nicht mehr. Der Vorgang wird deshalb an die
      // Übersicht übergeben, die ihn zu Ende verfolgt und die Karte so lange
      // rot stehen lässt — sonst stünde die Gruppe dort unverändert in der
      // Liste, bis der nächste Takt sie abholt.
      handOverScopeRun({
        name: page.scope,
        runIds: data.data.runs.map((r: { runId: string }) => r.runId),
        action: 'remove',
      });
      router.push('/reverse-proxy');
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Entfernen fehlgeschlagen'),
        message: err instanceof Error ? err.message : t('Unbekannter Fehler.'),
      });
    } finally {
      setRemoving(false);
    }
  }
  const matches = entries.filter(
    ({ service }) =>
      // `matchesSearch` ist rein und getestet, damit Suchfeld und spätere
      // Aufrufer dieselbe Vorstellung von „passt" haben.
      matchesSearch(service, search) &&
      // Die Sorte wird abgeleitet und nicht gespeichert — dieselbe Funktion,
      // die auch entscheidet, welches Formular beim Bearbeiten aufgeht.
      (!kindFilter || serviceKind(service) === kindFilter)
  );
  /* `serviceKind` gilt für Dienste. Ist nach einer ihrer Sorten gefiltert,
   * fallen die TCP-Weiterleitungen deshalb ganz WEG statt ungefiltert stehen zu
   * bleiben — eine gefilterte Liste, in der ein Abschnitt ungefiltert bleibt,
   * behauptet, es gebe dort nichts weiter zu sehen. */
  const streamMatches =
    kindFilter && kindFilter !== 'stream'
      ? []
      : streamEntries.filter(({ stream }) => matchesStreamSearch(stream, search));
  const SECTIONS = [
    {
      key: 'offen',
      title: t('Öffentlich erreichbar'),
      hint: t('Jede Adresse kommt durch'),
      items: matches.filter(({ service }) => service.lockedDomains.length === 0),
    },
    {
      key: 'gesperrt',
      title: t('Gesperrt'),
      // Teilweise gesperrte stehen hier mit: die Frage, die diese Überschrift
      // beantwortet, ist „wo greift die Sperre" — und da greift sie. Beide
      // Arten stehen zusammen: wie gesperrt ist, sagt die Marke auf der Karte.
      hint: t('Auf Admin-IPs oder mit Passwort, ganz oder für einzelne Domains'),
      items: matches.filter(({ service }) => service.lockedDomains.length > 0),
    },
  ];

  /* Für einen Dienst braucht es acme.sh (ohne Zertifikat scheitert `haproxy -c`),
   * für eine TCP-Weiterleitung nicht. Deshalb zwei Zahlen und nicht eine: ohne
   * acme.sh lässt sich ein Port trotzdem durchreichen, und die Auswahl soll das
   * sagen, statt den ganzen Knopf wegzunehmen. */
  const usable = proxies.filter((p) => !p.error && p.acmeReady);
  const reachable = proxies.filter((p) => !p.error);
  // In der Gruppe der Oberfläche legt niemand von Hand an (`refuseSurfaceScopeEntry`).
  const canCreate = !!page && reachable.length > 0 && !page.surface;
  /** Entfernen geht nur, solange nichts drinsteht — und nur bei einer Gruppe,
   *  die dieses Werkzeug angelegt hat (BEGIN- und END-Marker, siehe config.ts).
   *  Eine TCP-Weiterleitung zählt dabei mit: sie liegt im selben Marker-Block. */
  const canRemove =
    !!page && page.removable && entries.length === 0 && streamEntries.length === 0;

  // Erst wenn die Konfiguration gelesen ist, ist „gibt es nicht" eine Aussage.
  if (!loading && !page) {
    return (
      <>
        <div className="page-header">
          <div className="page-heading">
            <span className="page-heading-icon">
              <Globe size={20} />
            </span>
            <div>
              <h1 className="page-title">{t('Gruppe nicht gefunden')}</h1>
              <div className="page-crumbs">
                <Link className="page-back" href="/reverse-proxy">
                  <ArrowLeft size={14} />
                  {t('Übersicht')}
                </Link>
              </div>
            </div>
          </div>
        </div>
        {error ? (
          <div className="alert alert-danger sys-block">{error}</div>
        ) : (
          <div className="empty-state">
            <Globe size={40} />
            <h3>{t('Diese Gruppe gibt es nicht')}</h3>
            <p>
              {rich(
                'In der Konfiguration steht kein Marker-Block {slug}. Entweder wurde die Gruppe entfernt, oder die Konfiguration ließ sich nicht lesen. Der Zustand von HAProxy steht in der {overview}.',
                { slug: <code>{slug}</code>, overview: <Link href="/dashboard">{t('Übersicht')}</Link> }
              )}
            </p>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div className="page-heading">
          <span className="page-heading-icon">
            <Globe size={20} />
          </span>
          <div>
            {/* Solange die Konfiguration nicht gelesen ist, steht hier ein
                Balken und nicht der Adressteil. Der wäre zwar da, aber falsch:
                `scopeSlug` schreibt klein, `scopeLabel` schreibt groß — die
                Überschrift sprang sichtbar von „kunden" auf „Kunden", sobald
                die Antwort da war. Ein Platzhalter behauptet nichts. */}
            {page ? (
              <h1 className="page-title">
                {page.title}
                <span className="section-count">
                  {plural(entries.length, { one: '{count} Dienst', other: '{count} Dienste' })}
                </span>
              </h1>
            ) : (
              <h1 className="page-title">
                <SkeletonTitle />
              </h1>
            )}
            {/* Ein Zurück-Knopf statt einer Brotkrume: die Hierarchie ist eine
                Stufe tief, und ein Häuschen mit einem Schrägstrich daneben ist
                dafür eine Bauform ohne Inhalt. Was hier steht, sagt dasselbe
                und lässt sich anklicken, ohne auf ein 14 Pixel großes Symbol zu
                zielen. */}
            <div className="page-crumbs">
              <Link className="page-back" href="/reverse-proxy">
                <ArrowLeft size={14} />
                {t('Übersicht')}
              </Link>
              <span>{t('Gruppe')}</span>
              {page?.surface && (
                <span
                  className="badge-status badge-neutral"
                  data-tooltip={t('HAPM ist über ein Ziel dieser Gruppe erreichbar ({url})', { url: page.surface.url })}
                >
                  <ShieldCheck size={13} />
                  {t('Oberfläche von HAPM')}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="page-actions">
          <div className="page-search">
            <Search size={15} />
            <input
              className="form-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('Ziele suchen…')}
              aria-label={t('Ziele suchen')}
              autoComplete="off"
            />
            {search && (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                data-tooltip={t('Suche leeren')}
                onClick={() => setSearch('')}
              >
                <X size={15} />
              </button>
            )}
          </div>
          {/* Die Wörter kommen aus derselben Karte wie die Auswahl beim
              Anlegen — eine Liste, in der man einen Eintrag anlegt, und eine,
              in der man ihn wiederfindet, dürfen nicht verschieden heißen. */}
          <Select
            value={kindFilter}
            onChange={(v) => setKindFilter(v as TargetKind | '')}
            options={[
              { value: '', label: t('Alle Typen') },
              ...TARGET_KINDS.map((k) => ({ value: k, label: t(TARGET_KIND_LABELS[k]) })),
            ]}
          />
          <button className="btn btn-secondary btn-icon" onClick={refresh} disabled={refreshing} data-tooltip={t('Aktualisieren')}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          </button>
          {canRemove && (
            <button
              className="btn btn-danger btn-icon"
              onClick={() => removeScope()}
              disabled={removing}
              data-tooltip={t('Gruppe entfernen')}
            >
              {removing ? <Loader2 size={16} className="spin" /> : <FolderMinus size={16} />}
            </button>
          )}
          {/* Sonst fehlt der Knopf einfach, solange etwas in der Gruppe steht.
              Hier steht er gesperrt da: diese Gruppe wird auch durch Aufräumen
              nicht entfernbar, und das soll man sehen, bevor man es versucht. */}
          {page?.surface && (
            <button
              className="btn btn-danger btn-icon"
              disabled
              aria-label={t('Gruppe entfernen')}
              data-tooltip={t('Nicht entfernbar: hier liegt das Ziel der Oberfläche von HAPM')}
            >
              <FolderMinus size={16} />
            </button>
          )}
          {canCreate && (
            <button className="btn btn-primary" onClick={() => setKindDialog(true)}>
              <Plus size={16} />
              {t('Ziel anlegen')}
            </button>
          )}
        </div>
      </div>

      {/* Bleibt als Fläche: „konnte nicht geladen werden" ist kein Ereignis,
          sondern ein Zustand — er hört nicht von selbst auf, also darf die
          Meldung auch nicht von selbst verschwinden. Alles, was ein Ereignis
          ist (gespeichert, gesperrt, fehlgeschlagen), geht als Toast raus. */}
      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {/* Ein neuer Eintrag steht schon in der Liste, während er entsteht: das
          Anlegen dauert Minuten (Zertifikat), und eine Liste, die sich nach dem
          Klick auf „Anlegen" nicht rührt, sieht aus, als wäre der Klick
          verlorengegangen. Der Fortschritt selbst steht in der Pille unten
          rechts. Je Anlegen eine Karte, auch wenn mehrere hintereinander am
          Lock warten. */}
      {placeholders.length > 0 && (
        <div className="sys-block">
          <EntityGrid size="compact">
            {placeholders.map((run) => (
              <PendingCard
                key={run.id}
                title={run.title}
                phase={run.phase}
                steps={run.steps}
                queued={isQueued(run)}
              />
            ))}
          </EntityGrid>
        </div>
      )}

      {loading ? (
        <SkeletonCards />
      ) : entries.length + streamEntries.length === 0 ? (
        <div className="empty-state">
          <Globe size={40} />
          <h3>{t('Noch kein Eintrag')}</h3>
          <p>{t('Hier stehen die Dienste dieser Gruppe, sobald der erste angelegt ist.')}</p>
        </div>
      ) : matches.length + streamMatches.length === 0 ? (
        <div className="empty-state">
          <Search size={40} />
          <h3>{t('Nichts gefunden')}</h3>
          {/* Die gesetzten Filter stehen im Satz: „nichts gefunden" ohne den
              Grund schickt einen suchen, wo nichts zu suchen ist. */}
          <p>
            {kindFilter
              ? t('Kein Eintrag dieser Gruppe passt zur Suche und zum Typ „{kind}".', {
                  kind: t(TARGET_KIND_LABELS[kindFilter]),
                })
              : t('Kein Eintrag dieser Gruppe passt zur Suche.')}
          </p>
        </div>
      ) : (
        /* Gesperrte Einträge stehen unter ihrer eigenen Überschrift. Sie sind
           die Ausnahme und die Frage, die man an eine solche Liste stellt
           („was ist eigentlich nicht öffentlich?") — zwischen dreißig offenen
           verteilt beantwortet sie niemand. */
        SECTIONS.map(({ key, title, hint, items }) =>
          items.length === 0 ? null : (
            <div className="sys-block" key={key}>
              {SECTIONS.filter((s) => s.items.length > 0).length > 1 && (
                <div className="section-header">
                  <h2 className="section-title">
                    {title}
                    <span className="section-count">{items.length}</span>
                  </h2>
                  <span className="section-hint">{hint}</span>
                </div>
              )}
              <EntityGrid size="compact">
                {items.map(({ proxy, service }) => {
                  const run = runForEntry(pendingRuns, service.id);
                  return (
                    <ServiceCard
                      key={`${proxy.$id}:${service.id}`}
                      proxy={proxy}
                      service={service}
                      savedTargets={savedTargets}
                      busy={lockingId === `${proxy.$id}:${service.id}`}
                      health={proxy.health[service.id] ?? 'unknown'}
                      pendingPhase={run ? (run.phase ?? msgid('Wird geschrieben')) : null}
                      // Nur für die Karte, um die es geht: `busy` (das Schloss)
                      // macht jede Karte kurz „pending", und die dürfte dabei
                      // nicht rot werden, weil daneben etwas gelöscht wird.
                      pendingKind={run?.kind ?? 'write'}
                      onToggleLock={() => toggleLock(proxy, service)}
                      onEdit={() => setDialog({ kind: null, edit: { proxy, service } })}
                      onDelete={() => handleDelete(proxy, service)}
                    />
                  );
                })}
              </EntityGrid>
            </div>
          )
        )
      )}

      {/* ── TCP-Weiterleitungen ──
          Unter eigener Überschrift und nicht zwischen den Diensten: sie
          beantworten eine andere Frage („welche Ports sind auf diesem Server
          offen"), und sie tragen statt einer Domain einen Port. Zwischen dreißig
          Dienstkarten verteilt ginge genau die Frage unter. */}
      {!loading && streamMatches.length > 0 && (
        <div className="sys-block">
          <div className="section-header">
            <h2 className="section-title">
              {t('TCP-Weiterleitungen')}
              <span className="section-count">{streamMatches.length}</span>
            </h2>
            <span className="section-hint">
              {t('Ports dieses Servers, durchgereicht ohne HTTP und ohne Zertifikat')}
            </span>
          </div>
          <EntityGrid size="compact">
            {streamMatches.map(({ proxy, stream }) => {
              const run = runForEntry(pendingRuns, stream.id);
              return (
                <StreamCard
                  key={`${proxy.$id}:${stream.id}`}
                  stream={stream}
                  savedTargets={savedTargets}
                  health={proxy.health[stream.id] ?? 'unknown'}
                  pendingPhase={run ? (run.phase ?? msgid('Wird geschrieben')) : null}
                  pendingKind={run?.kind ?? 'write'}
                  onEdit={() => setStreamDialog({ edit: { proxy, stream } })}
                  onDelete={() => handleDeleteStream(proxy, stream)}
                />
              );
            })}
          </EntityGrid>
        </div>
      )}

      {lockDialog && (
        <LockDialog
          proxy={lockDialog.proxy}
          service={lockDialog.service}
          onClose={() => setLockDialog(null)}
          onPick={(choice) => {
            const { proxy, service } = lockDialog;
            setLockDialog(null);
            void writeLock(proxy, service, choice);
          }}
        />
      )}

      {kindDialog && (
        <TargetKindDialog
          onClose={() => setKindDialog(false)}
          onPick={(pick: TargetKind) => {
            setKindDialog(false);
            /* Ein Dienst braucht acme.sh, eine TCP-Weiterleitung nicht. Die
               Auswahl bleibt deshalb vollständig, und die Meldung kommt erst
               hier: eine ausgegraute Karte sagte nicht, woran es liegt. */
            if (pick !== 'stream' && usable.length === 0) {
              notify({
                variant: 'warning',
                title: t('acme.sh ist nicht eingerichtet'),
                message: t(
                  'Für einen Eintrag mit Domain braucht es ein Zertifikat. HAPM richtet acme.sh beim Start selbst ein, der Zustand steht in der Übersicht. Eine TCP-Weiterleitung geht trotzdem.'
                ),
                action: { label: t('Übersicht'), onClick: () => router.push('/dashboard') },
              });
              return;
            }
            if (pick === 'stream') setStreamDialog({ edit: null });
            else setDialog({ kind: pick, edit: null });
          }}
        />
      )}

      {dialog && page && (
        <ServiceFormModal
          /* Der `key` erzwingt beim Umstellen einen Neuaufbau: der Zustand des
             Formulars entsteht beim Einhängen aus `edit`, und ohne ihn stünden
             im Lastverteilungs-Formular die Felder des vorigen. */
          key={dialog.kind ?? 'auto'}
          proxies={proxies}
          edit={dialog.edit}
          kind={dialog.kind ?? undefined}
          onSwitchKind={(next) => setDialog((current) => current && { ...current, kind: next })}
          defaultScope={page.scope}
          onClose={() => setDialog(null)}
          onStarted={(run) => {
            setDialog(null);
            startRun({ ...run, kind: 'write', phase: null, steps: [] });
          }}
        />
      )}

      {streamDialog && page && (
        <StreamFormModal
          proxies={proxies}
          edit={streamDialog.edit}
          defaultScope={page.scope}
          onClose={() => setStreamDialog(null)}
          onStarted={(run) => {
            setStreamDialog(null);
            startRun({ ...run, kind: 'write', phase: null, steps: [] });
          }}
        />
      )}

      {/* Dasselbe Overlay wie in der Pille und auf der Logs-Seite: es holt sich
          den Lauf selbst, statt eine Kopie der Zeile zu zeigen, die bei einem
          laufenden Vorgang eingefroren wäre. */}
      {openRunId && (
        <UpdateRunOverlay
          runId={openRunId}
          endpoint="/api/haproxy/runs"
          phases={HAPROXY_PHASES}
          phaseLabels={HAPROXY_PHASE_LABELS}
          noun="Reverse-Proxy"
          onClose={() => setOpenRunId(null)}
          onFinished={() => load(true)}
        />
      )}
    </>
  );
}
