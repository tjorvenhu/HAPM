'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  Plus, Trash2, Loader2, X, Settings2, Server, Waypoints, Info, Globe, Lock, LockOpen,
  ChevronDown, ChevronRight, CornerUpRight, Scale, RefreshCw,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { suggestPassword } from '@/components/suggestPassword';
import Select from '@/components/Select';
import { InfoHint } from '@/ui/primitives/InfoHint';
import {
  HAPROXY_PRESETS,
  PRESET_LABELS,
  PRESET_HINTS,
  HAPROXY_BALANCE,
  BALANCE_LABELS,
  BALANCE_HINTS,
  STICKY_BACKEND_LINE,
  WEIGHT_MAX,
  WEIGHT_MIN,
  KEEP_PASSWORD,
  LOCK_PASSWORD_MIN,
  readWeight,
  shortVersion,
  supportsPasswordLock,
  validateLockPassword,
  validateCreateInput,
  certificateChanged,
  isWildcardDomain,
  healthcheckPossible,
  serviceKind,
  type HaproxyScope,
  type HaproxyPreset,
  type HaproxyBalance,
  type ServiceKind,
  type HaproxyService,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import type { DomainMatch } from '@/lib/dns/zones';
import type { ProxyRow } from './types';

/**
 * Anlegen und Bearbeiten eines Reverse-Proxy-Ziels.
 *
 * Eine eigene Komponente, seit die Liste in drei Seiten zerfällt: der Dialog
 * gehört zu keiner davon, sondern zu allen. Je Seite nachgebaut, liefe ein
 * Formular mit dreißig Feldern und einer Vorschau auseinander.
 *
 * Der Zustand entsteht beim Einhängen aus `edit` und lebt nur, solange der
 * Dialog offen ist. Deshalb rendert die Seite ihn gar nicht erst, wenn er zu
 * ist: kein Zurücksetzen von Hand, kein halb gefülltes Formular beim nächsten
 * Öffnen.
 */

interface ServerRow {
  name: string;
  target: string;
  /** Als Text, weil ein Zahlenfeld beim Leeren `''` liefert und nicht `0`.
   *  Leer heißt „keine `weight`-Angabe" und nicht 1 — siehe `readWeight`. */
  weight: string;
}

const EMPTY_SERVER: ServerRow = { name: '', target: '', weight: '' };

/** Eine Zeile des Formulars als Eingabe. An einer Stelle, weil sie im
 *  Standard-Backend und in jeder Pfad-Regel gleich gelesen werden muss. */
function toServerInput(row: ServerRow) {
  return {
    name: row.name.trim(),
    target: row.target.trim(),
    weight: readWeight(row.weight),
  };
}

/** Eine Pfad-Regel im Formular. `paths` und `servers` sind Listen, weil beide
 *  es in der Konfiguration auch sind. */
interface RouteRow {
  name: string;
  paths: string[];
  servers: ServerRow[];
  check: boolean;
}

/** Die Wörter aus `TargetKindDialog`, damit die Überschrift dieselben trägt.
 *  Die TCP-Weiterleitung fehlt hier: sie ist kein Dienst und hat ein eigenes
 *  Formular. */
const KIND_TITLES: Record<ServiceKind, string> = {
  proxy: 'Reverse-Proxy',
  balance: 'Lastverteilung',
  redirect: 'HTTP-Weiterleitung',
};

const EMPTY_ROUTE: RouteRow = {
  name: '',
  paths: [''],
  servers: [{ ...EMPTY_SERVER }],
  check: true,
};

interface Props {
  /** Die Antwort von `/api/haproxy/services`: in HAPM genau ein Eintrag. */
  proxies: ProxyRow[];
  /** Gesetzt heißt bearbeiten. */
  edit: { proxy: ProxyRow; service: HaproxyService } | null;
  /**
   * Welches der drei Formulare gezeigt wird — die Wahl aus `TargetKindDialog`.
   *
   * Sie steht für die ganze Lebensdauer des Dialogs fest. Jede Sorte zeigt nur
   * ihre eigenen Felder: im Reverse-Proxy-Formular gibt es kein
   * Verteilverfahren, im Weiterleitungs-Formular keine Backend-Zeilen. Ein
   * Umschalter mittendrin hieße, dass jeder erst an den Feldern vorbeiscrollt,
   * die er gar nicht braucht.
   *
   * **Beim Bearbeiten sagt der Eintrag, was er ist** (`serviceKind`) und nicht
   * ein Klick von vorhin. Ein Eintrag mit Sitzungsbindung geht deshalb immer im
   * Lastverteilungs-Formular auf — im Reverse-Proxy-Formular verlöre er sie
   * beim Speichern. Die einzige Ausnahme steht bei `onSwitchKind`.
   */
  kind?: ServiceKind;
  /**
   * Aus einem Reverse-Proxy eine Lastverteilung machen, ohne den Eintrag zu
   * löschen.
   *
   * Ohne das wäre ein zweiter Webserver hinter einer laufenden Domain nur über
   * Löschen und Neuanlegen zu haben: die Domain wäre dazwischen offline, das
   * Zertifikat ginge weg und käme als neuer Antrag gegen das Kontingent zurück.
   * Genau die Lücke, wegen der `replaceService` überhaupt EIN Schreibvorgang
   * ist.
   *
   * Ein Knopf und kein Feld: im Reverse-Proxy-Formular gibt es weiterhin nichts
   * über Verteilung zu entscheiden. Er steht nur beim Bearbeiten da — beim
   * Anlegen ist die Auswahl davor der Weg.
   */
  onSwitchKind?: (kind: ServiceKind) => void;
  /** Der Bereich, mit dem ein neuer Eintrag startet — die Seite, von der aus
   *  der Dialog geöffnet wurde. */
  defaultScope: HaproxyScope;
  onClose: () => void;
  /**
   * Der Vorgang läuft ab hier abgekoppelt weiter (lib/haproxy/runner.ts).
   *
   * Mitgegeben wird, was die Liste braucht, um ihn zu zeigen: bei einem neuen
   * Eintrag als Platzhalter-Karte, bei einem bestehenden als gelb hinterlegte.
   * Aus der Antwort der Route ginge das nicht — sie trägt nur die Lauf-ID.
   */
  onStarted: (run: {
    id: string;
    label: string;
    serviceId: string;
    title: string;
    isNew: boolean;
  }) => void;
}

export default function ServiceFormModal({
  proxies,
  edit,
  kind: wantedKind = 'proxy',
  onSwitchKind,
  defaultScope,
  onClose,
  onStarted,
}: Props) {
  const { apiFetch } = useApp();

  /**
   * Welches Formular gilt.
   *
   * Beim Anlegen die Auswahl davor. Beim Bearbeiten der Eintrag selbst — mit
   * genau einer erlaubten Übersteuerung: **nach oben**. Das
   * Lastverteilungs-Formular zeigt alles, was das Reverse-Proxy-Formular zeigt,
   * plus die Verteilung; umgekehrt verlöre der Eintrag beim Speichern, was das
   * kleinere Formular nicht kennt. Deshalb steht die Regel hier und nicht beim
   * Aufrufer: eine falsch übergebene Art wäre sonst stiller Datenverlust.
   */
  const derived = edit ? serviceKind(edit.service) : null;
  const kind: ServiceKind =
    derived === null
      ? wantedKind
      : derived === 'proxy' && wantedKind === 'balance'
        ? 'balance'
        : derived;
  const redirecting = kind === 'redirect';
  const balancing = kind === 'balance';

  const usable = proxies.filter((p) => !p.error && p.acmeReady);
  /** Beim Bearbeiten der ALTE Dienstname. Er steht im Pfad des PATCH, während
   *  der Rumpf schon den neuen trägt — beim Umbenennen sind das zwei Werte. */
  const editingId = edit?.service.id ?? null;

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  /** Es gibt genau einen HAProxy. Die Kennung geht weiter im Rumpf mit, weil
   *  die Routen und die Historie sie tragen. */
  const serverId = edit?.proxy.$id ?? usable[0]?.$id ?? '';
  const [scope, setScope] = useState<HaproxyScope>(edit?.service.scope ?? defaultScope);

  /** Die Gruppen aus der Konfiguration. Unvollständige (nur einer der beiden
   *  Marker) stehen nicht zur Wahl: der Block landete sonst irgendwo. */
  const scopeOptions = (proxies.find((p) => p.$id === serverId)?.scopes ?? []).filter(
    (s) => s.complete
  );
  /**
   * Welcher acme.sh-DNS-Hook die Challenge setzt. Nur nötig, sobald eine
   * Wildcard unter den Domains ist: HTTP-01 stellt sie nicht aus.
   *
   * Er ist NICHT Teil von `CreateServiceInput` und wird deshalb auch beim
   * Bearbeiten nicht vorbelegt — er steht in keiner Zeile von `haproxy.cfg`,
   * und dorthin zurückgelesen werden kann nur, was dort steht. Für die
   * Erneuerung braucht ihn ohnehin niemand mehr: acme.sh merkt ihn sich beim
   * ersten Antrag.
   */
  const [dnsHook, setDnsHook] = useState('');
  const [serviceId, setServiceId] = useState(edit?.service.id ?? '');
  const [domains, setDomains] = useState<string[]>(
    edit && edit.service.domains.length > 0 ? [...edit.service.domains] : ['']
  );
  const [backends, setBackends] = useState<ServerRow[]>(
    edit && edit.service.servers.length > 0
      ? edit.service.servers.map((s) => ({ name: s.name, target: s.target, weight: s.weight === null ? '' : String(s.weight) }))
      : // Eine Lastverteilung startet mit zwei Zeilen. Sie ist die einzige der
        // Arten, bei der eine einzelne keinen Sinn ergibt, und eine Zeile plus
        // ein Knopf ist eine Aufforderung, die das Formular selbst erfüllen kann.
        kind === 'balance'
        ? [{ ...EMPTY_SERVER }, { ...EMPTY_SERVER }]
        : [{ ...EMPTY_SERVER }]
  );
  const [redirectTo, setRedirectTo] = useState(edit?.service.redirect?.to ?? '');
  const [redirectKeepPath, setRedirectKeepPath] = useState(
    edit?.service.redirect?.keepPath ?? false
  );
  const [redirectPermanent, setRedirectPermanent] = useState(
    edit?.service.redirect?.permanent ?? false
  );
  /** Die Pfad-Regeln: dieselbe Domain, ein anderer Port. Leer ist der Normalfall. */
  const [routes, setRoutes] = useState<RouteRow[]>(
    edit?.service.routes.map((route) => ({
      name: route.name,
      paths: route.paths.length > 0 ? [...route.paths] : [''],
      servers:
        route.servers.length > 0
          ? route.servers.map((s) => ({ name: s.name, target: s.target, weight: s.weight === null ? '' : String(s.weight) }))
          : [{ ...EMPTY_SERVER }],
      check: route.check,
    })) ?? []
  );
  /** Zugeklappt, auch wenn es Regeln gibt: der Abschnitt ist aufgeklappt so
   *  lang wie der Rest des Formulars, und die meisten Änderungen betreffen ihn
   *  nicht. Die Anzahl in der Überschrift sagt, dass es dort etwas gibt. */
  const [routesOpen, setRoutesOpen] = useState(false);
  /**
   * Das Verteilverfahren und die Sitzungsbindung.
   *
   * `null` heißt „keine `balance`-Zeile schreiben" und nicht „roundrobin": was
   * im `defaults`-Block der Maschine steht, gilt weiter, und eine hingesetzte
   * Vorgabe wäre eine Behauptung über eine Datei, in die dieses Formular nicht
   * sieht.
   */
  const [balance, setBalance] = useState<HaproxyBalance | null>(
    edit ? edit.service.balance : kind === 'balance' ? 'roundrobin' : null
  );
  /** Nur die Lastverteilung kennt sie. Die anderen beiden Formulare schicken
   *  hart `null` bzw. `false`, egal was hier steht. */
  const [sticky, setSticky] = useState(edit?.service.sticky ?? false);
  /** Ob die Erklärung hinter dem „i" aufgeklappt ist. Zugeklappt als Vorgabe:
   *  wer das Verfahren kennt, will den Absatz nicht bei jedem Öffnen sehen. */
  const [preset, setPreset] = useState<HaproxyPreset>(edit?.service.preset ?? 'default');
  const [healthcheck, setHealthcheck] = useState(edit?.service.healthcheck ?? true);
  /**
   * Welche Domains gesperrt sein sollen.
   *
   * Kein Schalter „gesperrt ja/nein": ein Eintrag kann `kunde.example` und
   * `intern.kunde.example` bedienen, und gesperrt gehört oft nur die zweite. Ohne
   * definierte Adressen bleibt die Auswahl bei der Sperre auf Admin-IPs
   * gesperrt — die ACL, auf die die Regel zeigt, gäbe es dann nicht.
   */
  const [lockedDomains, setLockedDomains] = useState<string[]>(
    edit?.service.lockedDomains ?? []
  );
  /**
   * WIE die gesperrten Domains gesperrt sind: auf die Admin-IPs oder mit
   * Passwort. Eine Art je Eintrag und nicht je Domain: es gibt in der Datei
   * eine ACL der gesperrten Domains, und an ihr hängt entweder die eine Regel
   * oder die Abfrage.
   */
  const [lockMode, setLockMode] = useState<'ip' | 'password'>(
    edit?.service.passwordLock ? 'password' : 'ip'
  );
  /**
   * Ein NEUES Passwort. Leer heißt beim Bearbeiten „das bisherige bleibt": es
   * lässt sich nicht vorbelegen, denn auf der Maschine liegt nur sein Hash,
   * und auch der kommt nicht bis hierher.
   */
  const [lockPassword, setLockPassword] = useState('');
  /** Ob der Eintrag schon ein Passwort hat, das stehen bleiben kann. */
  const hasStoredPassword = !!edit?.service.passwordLock;

  /** Die Adressliste steht je Frontend genau einmal. */
  const adminIps = proxies.find((p) => p.$id === serverId)?.adminIps ?? [];
  /** `null` (Version unbekannt) sperrt nichts: dann entscheidet der Vorgang. */
  const proxyVersion = proxies.find((p) => p.$id === serverId)?.version ?? null;
  const passwordPossible = supportsPasswordLock(proxyVersion) !== false;
  /** Warum sich gerade keine Domain sperren lässt. Leer heißt: es geht. */
  const lockBlocked =
    lockMode === 'ip'
      ? adminIps.length === 0
        ? 'Zum Sperren zuerst Admin-IPs setzen'
        : ''
      : passwordPossible
        ? ''
        : 'Die Passwortsperre braucht HAProxy 2.4 oder neuer';
  /**
   * Das Schloss je Zeile: EINE Domain sperren, nicht den ganzen Eintrag.
   *
   * Eine Funktion, weil Hauptdomain und Alias in getrennten Blöcken stehen und
   * denselben Knopf brauchen. Ohne Admin-IPs gibt es nichts zu sperren — dann
   * ist er aus und der Tooltip sagt, wo die Adressen herkommen.
   */
  function renderLockButton(domain: string) {
    const value = domain.trim().toLowerCase();
    const isLocked = value !== '' && lockedDomains.includes(value);
    return (
      <button
        type="button"
        className={`btn btn-ghost btn-icon${isLocked ? ' is-locked' : ''}`}
        /* Nach links: der Knopf sitzt am rechten Rand des Dialogs, und ein
           mittig gesetzter Tooltip liefe dort aus dem Fenster. */
        data-tooltip-pos="left"
        data-tooltip={
          lockBlocked && !isLocked
            ? lockBlocked
            : isLocked
              ? 'Sperre dieser Domain lösen'
              : lockMode === 'password'
                ? 'Mit Passwort sperren'
                : 'Nur für Admin-IPs erreichbar machen'
        }
        // Lösen geht immer: eine gesperrte Domain soll nicht gesperrt bleiben
        // müssen, weil der gewählten Art gerade etwas fehlt.
        disabled={value === '' || (lockBlocked !== '' && !isLocked)}
        onClick={() => toggleDomainLock(value)}
        aria-label={isLocked ? 'Sperre dieser Domain lösen' : 'Diese Domain sperren'}
      >
        {isLocked ? <Lock size={16} /> : <LockOpen size={16} />}
      </button>
    );
  }

  function toggleDomainLock(domain: string) {
    setLockedDomains((current) =>
      current.includes(domain) ? current.filter((d) => d !== domain) : [...current, domain]
    );
  }

  /* ── Was geschickt wird, folgt der Kategorie und nicht dem Zustand ──
   *
   * Jedes Feld, das dieses Formular nicht ZEIGT, wird hier hart auf seinen
   * neutralen Wert gesetzt. Das ist mehr als Kosmetik: `balance` und `sticky`
   * behalten beim Bearbeiten ihren gelesenen Wert im Zustand, und ein
   * Reverse-Proxy-Formular, das ihn mitschickte, schriebe eine Einstellung
   * zurück, die niemand sehen konnte.
   *
   * Zusammen mit `serviceKind` schließt sich der Kreis: ein Eintrag, der eines
   * dieser Felder trägt, geht gar nicht erst in diesem Formular auf. */
  // Nur, was auch als Domain dasteht: wer eine gesperrte Domain aus der Liste
  // entfernt, hat sie entfernt — nicht heimlich weiter gesperrt.
  const effectiveLocked = lockedDomains.filter((locked) =>
    domains.some((d) => d.trim().toLowerCase() === locked)
  );
  const lockingByPassword = lockMode === 'password' && effectiveLocked.length > 0;

  const input: CreateServiceInput = {
    scope,
    id: serviceId.trim().toLowerCase(),
    domains: domains.map((d) => d.trim().toLowerCase()).filter(Boolean),
    servers: redirecting
      ? []
      : backends
          // Die Gewichtung gibt es nur in der Lastverteilung; ohne sie steht in
          // der Zeile keine `weight`-Angabe.
          .map((row) => (balancing ? toServerInput(row) : { ...toServerInput(row), weight: null }))
          .filter((b) => b.target),
    redirect: redirecting
      ? { to: redirectTo.trim(), keepPath: redirectKeepPath, permanent: redirectPermanent }
      : null,
    routes: redirecting
      ? []
      : routes.map((route) => ({
          name: route.name.trim().toLowerCase(),
          paths: route.paths.map((p) => p.trim()).filter(Boolean),
          servers: route.servers
            .map((s) => ({ name: s.name.trim(), target: s.target.trim() }))
            .filter((s) => s.target),
          check: route.check,
        })),
    balance: balancing ? balance : null,
    sticky: balancing && sticky,
    lockedDomains: effectiveLocked,
    // Nie ein Hash: hier steht nur der Verweis, und ein neues Passwort geht als
    // `lockPassword` daneben mit. Hash und Cookie-Wert entstehen in der Route.
    passwordLock: lockingByPassword ? KEEP_PASSWORD : null,
    preset: redirecting ? 'default' : preset,
    // Eine Wildcard als Hauptdomain schließt ihn aus. Der Schalter behält
    // dabei seinen Wert im Zustand — wer die Domain wieder ändert, findet ihn
    // so vor, wie er ihn gesetzt hat, statt ihn erneut umlegen zu müssen.
    healthcheck:
      !redirecting &&
      healthcheck &&
      healthcheckPossible(domains.map((d) => d.trim().toLowerCase())),
  };
  // Dieselbe Funktion, die die Route aufruft. Zwei Regelwerke wären ein Dialog,
  // der etwas durchlässt, was der Server danach ablehnt.
  const inputError = validateCreateInput(input);

  /** Beim Bearbeiten: ob diese Änderung ein neues Zertifikat auslöst. Dieselbe
   *  Funktion, nach der die Route sich richtet — damit der Hinweis im Dialog
   *  nicht etwas anderes ankündigt, als danach passiert. */
  const certNeeded = edit ? certificateChanged(edit.service.domains, input.domains) : false;

  /* ── Wildcards ──
   *
   * Der Hook wird verlangt, sobald eine Wildcard dabei ist und ein Zertifikat
   * fällig wäre — beim Anlegen immer, beim Bearbeiten nur bei geänderten
   * Domains. Die Liste kommt aus der Probe: welche Hooks acme.sh kennt, steht
   * in dessen Konfiguration, und HAPM hält die Zugangsdaten nicht selbst. */
  const healthcheckAllowed = healthcheckPossible(input.domains);
  const selectedProxy = proxies.find((p) => p.$id === serverId) ?? null;
  const hasWildcard = input.domains.some(isWildcardDomain);
  const dnsHooks = selectedProxy?.dnsHooks ?? [];
  const dnsHookNeeded = hasWildcard && (!editingId || certNeeded);
  const dnsHookMissing = dnsHookNeeded && dnsHooks.length === 0;

  /**
   * Gibt es genau einen eingerichteten Hook, ist er gewählt.
   *
   * Abgeleitet und nicht in den Zustand geschrieben: die Liste kommt mit der
   * Antwort der Route, und ein Wert, den ein Effekt nachziehen müsste, wäre
   * genau einen Render lang veraltet. Wer aus mehreren wählt, überschreibt das
   * mit `dnsHook`.
   */
  const effectiveDnsHook = dnsHook || (dnsHooks.length === 1 ? dnsHooks[0] : '');

  /** „Bitte wählen" gibt es nur, wenn es etwas zu wählen gibt. Bei genau einem
   *  Hook wäre es ein zweiter Eintrag, dessen einzige Wirkung ein Fehler beim
   *  Speichern ist. */
  const hookOptions =
    dnsHooks.length === 1
      ? [{ value: dnsHooks[0], label: dnsHooks[0] }]
      : [
          { value: '', label: 'Bitte wählen' },
          ...dnsHooks.map((hook) => ({ value: hook, label: hook })),
        ];

  /** Der Satz zur Sperre unter der Domainliste. Leer heißt: es gibt dazu gerade
   *  nichts zu sagen, und dann steht dort auch nichts. */
  const domainLockNote =
    lockMode === 'password'
      ? passwordPossible
        ? effectiveLocked.length > 0
          ? `Passwortabfrage für: ${effectiveLocked.join(', ')}.`
          : ''
        : `Die Passwortsperre braucht HAProxy 2.4 oder neuer. Hier läuft ${shortVersion(proxyVersion ?? '')}.`
      : adminIps.length === 0
        ? 'Zum Sperren auf Admin-IPs braucht es Adressen. Sie stehen unter Reverse-Proxy, Einstellungen.'
        : effectiveLocked.length > 0
          ? `Gesperrt auf ${adminIps.join(', ')}: ${effectiveLocked.join(', ')}. Alle anderen bekommen dort 403.`
          : '';

  /** Was am Passwort der Sperre noch fehlt. Leer heißt: nichts. */
  const lockPasswordError = !lockingByPassword
    ? ''
    : lockPassword !== ''
      ? (validateLockPassword(lockPassword) ?? '')
      : hasStoredPassword
        ? ''
        : 'Für die Passwortsperre fehlt das Passwort.';


  /* ── DNS ──
   *
   * Ob eine Domain in einer Zone liegt, die hier verwaltet wird, und ob der
   * Eintrag schon steht, weiß nur der Server: der API-Token verlässt ihn nicht,
   * und der Bestand soll der ECHTE bei Cloudflare sein und nicht der, den wir
   * uns gemerkt haben.
   *
   * Gefragt wird entprellt, weil die Antwort an einem Feld hängt, in das gerade
   * jemand tippt: ohne die halbe Sekunde wäre jeder Buchstabe von `app.kunde.example`
   * eine Abfrage über zwölf Zonen. */
  const domainsKey = input.domains.join(',');
  const [dnsMatches, setDnsMatches] = useState<DomainMatch[]>([]);
  const [dnsChecking, setDnsChecking] = useState(false);
  /**
   * Für welche Domains ein Eintrag gesetzt werden soll.
   *
   * Je Domain und nicht ein Schalter für alle: ein Dienst bedient oft
   * `kunde.example` und `app.example.org`, und gemeint ist manchmal nur die zweite.
   *
   * **Ein fehlender Eintrag heißt AN.** Der Schalter erscheint nur für Domains
   * in einer Zone, die hier eingerichtet ist — und die richtet man ein, damit
   * genau das passiert. Deshalb steht hier nur, wer ihn AUSgeschaltet hat, und
   * nicht, wer ihn angelassen hat: mit `false` als Vorgabe müsste der Zustand
   * beim Eintreffen der Antwort nachgezogen werden, und das wäre einen Render
   * lang eine Zeile mit Haken, die beim Speichern nicht mitzählt.
   */
  const [dnsWanted, setDnsWanted] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    const list = domainsKey.split(',').filter(Boolean);
    // Auch der leere Fall läuft über den Timer und nicht im Rumpf des Effekts:
    // ein `setState` dort löst eine zweite Renderrunde aus, noch bevor die
    // erste gezeichnet ist (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => {
      if (list.length === 0) {
        setDnsMatches([]);
        return;
      }
      setDnsChecking(true);
      apiFetch(`/api/dns/match?domains=${encodeURIComponent(list.join(','))}`)
        .then((res) => res.json())
        .then((data) => {
          if (live && data.success) setDnsMatches(data.data as DomainMatch[]);
        })
        // Ohne Antwort bleibt der Abschnitt weg. Das Formular muss auch dann
        // bedienbar sein, wenn Cloudflare gerade nicht erreichbar ist — der
        // Reverse-Proxy hat damit nichts zu tun.
        .catch(() => {})
        .finally(() => {
          if (live) setDnsChecking(false);
        });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [domainsKey, apiFetch]);

  /** Die Domains, für die es hier überhaupt etwas zu entscheiden gibt. */
  const dnsRows = dnsMatches.filter((match) => match.zone !== null);
  /** Was mitgeschickt wird: möglich, noch nicht vorhanden und nicht abgewählt. */
  const dnsDomains = dnsRows
    .filter((m) => m.plan && !m.existing && !m.error && dnsWanted[m.domain] !== false)
    .map((m) => m.domain);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (inputError) {
      setFormError(inputError);
      return;
    }
    if (lockPasswordError) {
      setFormError(lockPasswordError);
      return;
    }
    // Dieselbe Bedingung, die `assertIssuable` auf dem Server prüft. Hier
    // vorweg, damit die Eingabe nicht für eine Meldung weggeworfen wird, die
    // ein Feld daneben beantwortet.
    if (dnsHookNeeded && !effectiveDnsHook) {
      setFormError(
        dnsHooks.length === 0
          ? 'Eine Wildcard-Domain lässt Let’s Encrypt nur über DNS-01 ausstellen, und es ist kein ' +
              'DNS-Hook von acme.sh eingerichtet. Die Zugangsdaten stehen unter Reverse-Proxy, Einstellungen.'
          : 'Für eine Wildcard-Domain muss der DNS-Hook gewählt werden, der die Challenge setzt.'
      );
      return;
    }
    setFormError('');
    setSaving(true);
    const verb = editingId ? 'Speichern' : 'Anlegen';
    try {
      const res = await apiFetch(
        editingId ? `/api/haproxy/services/${encodeURIComponent(editingId)}` : '/api/haproxy/services',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId,
            ...input,
            lockPassword: lockingByPassword ? lockPassword : '',
            dnsHook: dnsHookNeeded ? effectiveDnsHook : '',
            dnsDomains,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${verb} fehlgeschlagen`);
      // Ab hier ist der Vorgang gestartet, nicht fertig. Der Dialog geht zu,
      // damit niemand fünf Minuten vor einem Spinner sitzt; was die Route noch
      // synchron geprüft hat (belegte ID, fremde Domain), steht oben im
      // Formular und kam gar nicht bis hierher.
      onStarted({
        id: data.data.runId,
        label: `Ziel „${input.id}" ${editingId ? 'ändern' : 'anlegen'}`,
        // Beim Umbenennen heißt die Zeile in der Liste noch wie vorher: der
        // Vorgang läuft auf den ALTEN Namen, der neue steht erst danach da.
        serviceId: editingId ?? input.id,
        title: input.domains[0] ?? input.id,
        isNew: !editingId,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : `${verb} fehlgeschlagen`);
      setSaving(false);
    }
  }

  return (
  <div
    className="modal-overlay"
    onClick={(e) => e.target === e.currentTarget && !saving && onClose()}
  >
    {/* Über die volle Breite: der Dialog trägt zwei Spalten mit Listen darin,
        und bei 1040px stand in jeder Zeile ein Eingabefeld auf halber Breite
        neben viel Nichts. Die Grenze ist der Bildschirm, nicht eine Zahl. */}
    <div className="modal modal-form">
      <div className="modal-header">
        {/* Die Überschrift nennt die gewählte Art. Sie ist die Antwort auf die
            Frage, die eine Stufe vorher gestellt wurde — stünde hier für alle
            drei dasselbe, wäre die Auswahl davor folgenlos. Beim Bearbeiten
            steht die Art des Eintrags da und nicht die eines Klicks. */}
        <h2 className="modal-title">
          {`${KIND_TITLES[kind]} ${edit ? 'bearbeiten' : 'anlegen'}`}
          {editingId && <span className="modal-subject">{editingId}</span>}
        </h2>
        <button
          type="button"
          className="modal-close"
          onClick={() => onClose()}
          disabled={saving}
          aria-label="Dialog schließen"
        >
          <X size={18} />
        </button>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          {formError && <div className="alert alert-danger">{formError}</div>}

          {/* Dass der Eintrag in einem Zug ersetzt wird, stand hier als Satz —
              er beschrieb, wie das Werkzeug arbeitet, und nicht, was jemand
              entscheiden muss. Übrig bleibt der Hinweis, der eine Folge hat:
              geänderte Domains kosten ein neues Zertifikat. */}
          {editingId && certNeeded && (
            <div className="alert alert-info">
              Die Domains ändern sich. Dafür wird ein neues Zertifikat beantragt.
            </div>
          )}

          <div className="form-columns">
            <div className="form-col">
              {/* ── Allgemein ── */}
              <section className="form-section">
                <div className="form-section-head">
                  <span className="form-section-icon">
                    <Settings2 size={17} />
                  </span>
                  <div>
                    <div className="form-section-title">Allgemein</div>
                    <div className="form-section-sub">
                      In welcher Gruppe der Eintrag steht und wie er heißt.
                    </div>
                  </div>
                </div>

                <div className="form-pair">
                  <div className="form-group">
                    <label className="form-label">Gruppe</label>
                    <Select
                      value={scope}
                      onChange={setScope}
                      options={scopeOptions.map((s) => ({ value: s.name, label: s.label }))}
                      disabled={scopeOptions.length === 0}
                    />
                    {scopeOptions.length === 0 && (
                      <span className="form-hint">
                        In der Konfiguration steht kein vollständiger Marker-Block. Gruppen legt
                        man in der Übersicht an.
                      </span>
                    )}
                  </div>
                  <div className="form-group">
                    <label className="form-label">Dienst-ID</label>
                    <input
                      className="form-input"
                      value={serviceId}
                      onChange={(e) => setServiceId(e.target.value)}
                      placeholder="website_beispiel"
                      autoComplete="off"
                      required
                    />
                    <span className="form-hint">
                      Nur a-z, 0-9 und _. Sie benennt ACL und Backend.
                    </span>
                  </div>
                </div>

                {/* Kein Preset bei einer Weiterleitung: es schreibt Zeilen in
                    ein Backend mit Zielen, und die hat sie nicht. Das Feld
                    fehlt hier ganz, statt gesperrt dazustehen — gesperrt läse
                    es sich wie ein fehlendes Recht und nicht wie eine Frage,
                    die sich in diesem Formular gar nicht stellt. */}
                {!redirecting && (
                  <div className="form-group">
                    <label className="form-label">Preset</label>
                    <Select
                      value={preset}
                      onChange={(v) => setPreset(v as HaproxyPreset)}
                      options={HAPROXY_PRESETS.map((p) => ({
                        value: p,
                        label: PRESET_LABELS[p],
                      }))}
                    />
                    {/* Der Hinweistext steht bei den Presets selbst, damit
                        Formular und Konfiguration nicht auseinanderlaufen. */}
                    <span className="form-hint">{PRESET_HINTS[preset]}</span>
                  </div>
                )}
              </section>

              {/* ── Domains ── */}
              <section className="form-section">
                <div className="form-section-head">
                  <span className="form-section-icon">
                    <Globe size={17} />
                  </span>
                  <div>
                    <div className="form-section-title">Domains</div>
                    <div className="form-section-sub">
                      Das Schloss je Zeile sperrt EINE Domain, auf Admin-IPs oder mit Passwort.
                    </div>
                  </div>
                </div>

                {/* Die Hauptdomain steht in ihrem eigenen Feld und nicht als
                    erste Zeile einer Liste. Vorher trug jede Zeile eine Pille
                    („Hauptdomain" grün, „Alias" grau): eine Farbe für eine
                    Position, und die graue Pille wiederholte sich pro Zeile,
                    ohne etwas zu sagen. Was die erste Domain besonders macht,
                    ist ohnehin keine Marke, sondern dass sie nicht wegfallen
                    kann — genau das sagt ein eigenes Feld ohne X daneben. */}
                <div className="form-group">
                  <label className="form-label">
                    Hauptdomain
                    <InfoHint text="Nach ihr heißt das Zertifikat, und sie steht im Host-Header des Healthchecks." />
                  </label>
                  <div className="form-list-row">
                    <input
                      className="form-input"
                      value={domains[0] ?? ''}
                      onChange={(e) =>
                        setDomains(domains.map((d, i) => (i === 0 ? e.target.value : d)))
                      }
                      placeholder="kunde.example"
                      autoComplete="off"
                    />
                    {renderLockButton(domains[0] ?? '')}
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Weitere Domains</label>
                  {domains.length > 1 && (
                    <div className="form-list">
                      {domains.slice(1).map((domain, i) => {
                        const index = i + 1;
                        return (
                          <div className="form-list-row" key={index}>
                            <input
                              className="form-input"
                              value={domain}
                              onChange={(e) =>
                                setDomains(
                                  domains.map((d, j) => (j === index ? e.target.value : d))
                                )
                              }
                              placeholder="www.kunde.example"
                              autoComplete="off"
                            />
                            {renderLockButton(domain)}
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon"
                              data-tooltip="Zeile entfernen"
                              onClick={() => setDomains(domains.filter((_, j) => j !== index))}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setDomains([...domains, ''])}
                    >
                      <Plus size={14} />
                      Domain hinzufügen
                    </button>
                  </div>
                </div>

                {/* ── Sperrart ──
                    Immer da und nicht erst nach dem ersten Schloss: ohne
                    Admin-IPs lässt sich in der einen Art nichts sperren, und
                    der Weg zur anderen darf dann nicht hinter einem Knopf
                    liegen, der aus ist. */}
                <div className="form-group">
                  <label className="form-label">Sperrart</label>
                  <div>
                    <div className="segmented">
                      <button
                        type="button"
                        className={lockMode === 'ip' ? 'active' : ''}
                        onClick={() => setLockMode('ip')}
                      >
                        Admin-IPs
                      </button>
                      <button
                        type="button"
                        className={lockMode === 'password' ? 'active' : ''}
                        onClick={() => setLockMode('password')}
                      >
                        Passwort
                      </button>
                    </div>
                  </div>
                  {domainLockNote && <span className="form-hint">{domainLockNote}</span>}
                </div>

                {lockingByPassword && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="service-lock-password">
                      {hasStoredPassword ? 'Neues Passwort der Sperre' : 'Passwort der Sperre'}
                    </label>
                    <div className="form-list-row">
                      <input
                        id="service-lock-password"
                        className="form-input mono"
                        value={lockPassword}
                        onChange={(e) => setLockPassword(e.target.value)}
                        placeholder={hasStoredPassword ? 'Leer lassen: das bisherige bleibt' : ''}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        data-tooltip-pos="left"
                        data-tooltip="Vorschlag erzeugen"
                        onClick={() => setLockPassword(suggestPassword())}
                        aria-label="Vorschlag erzeugen"
                      >
                        <RefreshCw size={16} />
                      </button>
                    </div>
                    <span className="form-hint">
                      {hasStoredPassword
                        ? 'Ein neues Passwort meldet alle ab, die schon durchgelassen sind.'
                        : `Mindestens ${LOCK_PASSWORD_MIN} Zeichen. Jetzt notieren: gespeichert wird nur ein Hash.`}
                    </span>
                  </div>
                )}

                {/* ── DNS-Hook ──
                    Nur da, wenn eine Wildcard im Spiel ist. Ein Feld, das immer
                    dasteht und meistens nichts tut, ist keine Auskunft; dieses
                    sagt schon durch sein Erscheinen, dass die Challenge jetzt
                    über DNS läuft. */}
                {dnsHookNeeded && (
                  <div className="form-group">
                    <label className="form-label">DNS-Hook für die Wildcard</label>
                    {dnsHookMissing ? (
                      <div className="alert alert-warning">
                        Es ist kein DNS-Hook von acme.sh eingerichtet. Eine Wildcard lässt
                        Let’s Encrypt nur über DNS-01 ausstellen. Die Zugangsdaten der Zone werden
                        unter Reverse-Proxy, Einstellungen hinterlegt: einmal dort eingetragen,
                        merkt acme.sh sie sich für jede Erneuerung.
                      </div>
                    ) : (
                      <Select
                        value={effectiveDnsHook}
                        onChange={setDnsHook}
                        options={hookOptions}
                      />
                    )}
                  </div>
                )}

                {/* Der Hinweis zu Wildcards stand hier als Vorgabe und galt
                    damit für jeden Eintrag — die meisten haben gar keine. Eine
                    Erklärung, die immer dasteht, liest nach dem dritten Mal
                    niemand mehr, auch nicht das eine Mal, in dem sie gilt.
                    Deshalb erscheint sie erst, wenn wirklich eine Wildcard in
                    der Liste steht. Der Satz zur Sperre bleibt davon
                    unberührt. */}
                {/* ── DNS ──
                    Nur da, wenn mindestens eine Domain in einer Zone liegt, die
                    hier eingerichtet ist. Ein Abschnitt, der bei fremden Domains
                    leer dastünde, wäre eine Frage ohne Antwortmöglichkeit. */}
                {dnsRows.length > 0 && (
                  <div className="form-group">
                    {/* Flex und nicht einfach nebeneinander: das Icon säße
                        sonst auf der Textgrundlinie und hinge unter der
                        Beschriftung heraus. Dasselbe Muster wie in
                        BackupCheckSchedule. */}
                    <label
                      className="form-label"
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      DNS-Einträge
                      <InfoHint text="Der Eintrag zeigt auf die Domain der Zone selbst, deren A-Eintrag auf diesen Server zeigt. Beim Löschen des Ziels wird angeboten, ihn mitzunehmen." />
                      {dnsChecking && <Loader2 size={13} className="spin" />}
                    </label>
                    <div className="form-list">
                      {dnsRows.map((match) => {
                        const zoneName = match.zone?.name ?? '';
                        // Vier Zustände, und jeder sagt etwas anderes darüber,
                        // ob hier noch eine Entscheidung offen ist.
                        const settled = !!match.existing?.managed;
                        const foreign = !!match.existing && !match.existing.managed;
                        const unreadable = !!match.error;
                        const impossible = !match.plan;
                        const locked = settled || foreign || unreadable || impossible;

                        const tooltip = settled
                          ? `DNS-Zone ${zoneName}: ${match.plan?.fqdn} ist bereits als CNAME auf ${zoneName} eingerichtet.`
                          : foreign
                            ? `Dort steht ein ${match.existing?.type}-Eintrag auf ${match.existing?.content}. Er wird nicht angefasst.`
                            : unreadable
                              ? `Die Zone ${zoneName} ist gerade nicht lesbar: ${match.error}`
                              : impossible
                                ? (match.blocked ?? '')
                                : `Legt ${match.plan?.fqdn} als CNAME auf ${zoneName} an, ohne Cloudflare-Proxy.`;

                        return (
                          <label className="form-list-row" key={match.domain} data-tooltip={tooltip}>
                            <span className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={settled || (!locked && dnsWanted[match.domain] !== false)}
                                disabled={locked}
                                onChange={(e) =>
                                  setDnsWanted((current) => ({
                                    ...current,
                                    [match.domain]: e.target.checked,
                                  }))
                                }
                                aria-label={`DNS-Eintrag für ${match.domain}`}
                              />
                              <span className="toggle-slider" />
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              {settled
                                ? `${match.domain} steht bereits in ${zoneName}`
                                : foreign
                                  ? `${match.domain}: dort steht ein ${match.existing?.type}-Eintrag`
                                  : unreadable
                                    ? `${match.domain}: Zone ${zoneName} nicht lesbar`
                                    : impossible
                                      ? `${match.domain}: hier nicht möglich`
                                      : `${match.domain} als CNAME in Zone ${zoneName} setzen`}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Der Satz zur Sperre stand hier mit und steht jetzt bei der
                    Sperrart, zu der er gehört. */}
                {hasWildcard && (
                  <div className="form-note">
                    <Info size={14} />
                    <span>
                      Eine Wildcard deckt genau eine Ebene ab: <code>app.kunde.example</code> ja,{' '}
                      <code>a.b.kunde.example</code> nein, <code>kunde.example</code> selbst auch nicht:
                      die gehört als eigene Zeile dazu.
                    </span>
                  </div>
                )}
              </section>

              {/* ── Wohin ──
                  Der Abschnitt, in dem sich die drei Formulare unterscheiden.
                  Es gibt keinen Umschalter mehr: was für eine Sorte Eintrag das
                  ist, steht beim Anlegen in der Auswahl davor und beim
                  Bearbeiten im Eintrag selbst (`serviceKind`). Ein Dropdown
                  „Wohin die Domains gehen" mitten im Formular hieß, dass jeder
                  erst an den Feldern vorbeiscrollte, die er gar nicht braucht. */}
              <section className="form-section">
                <div className="form-section-head">
                  <span className="form-section-icon">
                    {redirecting ? (
                      <CornerUpRight size={17} />
                    ) : balancing ? (
                      <Scale size={17} />
                    ) : (
                      <Server size={17} />
                    )}
                  </span>
                  <div>
                    <div className="form-section-title">
                      {redirecting ? 'Weiterleitung' : balancing ? 'Ziele' : 'Ziel'}
                    </div>
                    <div className="form-section-sub">
                      {redirecting
                        ? 'Die Domains werden nicht bedient, sondern woanders hingeschickt.'
                        : balancing
                          ? 'Die Anfragen werden auf mehrere Ziele verteilt.'
                          : 'Wohin alles geht, was auf keine Pfad-Regel passt.'}
                    </div>
                  </div>
                </div>

                {redirecting ? (
                  <>
                    <div className="form-group">
                      <label className="form-label">
                        Zieladresse
                        <InfoHint text="Ein Zertifikat wird trotzdem ausgestellt: die Weiterleitung antwortet über HTTPS, und der Browser prüft das Zertifikat, bevor er die Antwort liest." />
                      </label>
                      <input
                        className="form-input"
                        value={redirectTo}
                        onChange={(e) => setRedirectTo(e.target.value)}
                        placeholder="https://example.org"
                        autoComplete="off"
                        spellCheck={false}
                        required
                      />
                      <span className="form-hint">Mit Schema.</span>
                    </div>

                    <div className="form-subsection">
                      <div className="form-subsection-head">
                        <div>
                          <div className="form-section-title">Pfad übernehmen</div>
                          <div className="form-section-sub">
                            Aus, und der Aufruf landet immer auf der Zieladresse selbst.
                          </div>
                        </div>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={redirectKeepPath}
                            onChange={(e) => setRedirectKeepPath(e.target.checked)}
                            aria-label="Pfad übernehmen"
                          />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                      <div className="form-note">
                        <Info size={14} />
                        <span>
                          {redirectKeepPath ? (
                            <>
                              <code>
                                {domains[0]?.trim() || 'domain.example'}/preise
                              </code>{' '}
                              geht auf <code>{(redirectTo.trim() || 'https://ziel.example')}/preise</code>.
                              Für eine Domain, die umgezogen ist.
                            </>
                          ) : (
                            <>
                              <code>
                                {domains[0]?.trim() || 'domain.example'}/preise
                              </code>{' '}
                              geht auf <code>{redirectTo.trim() || 'https://ziel.example'}</code>. Für
                              eine Domain, die nur auf eine andere zeigen soll.
                            </>
                          )}
                        </span>
                      </div>
                    </div>

                    <div className="form-subsection">
                      <div className="form-subsection-head">
                        <div>
                          <div className="form-section-title">Dauerhaft (301)</div>
                          <div className="form-section-sub">
                            Aus heißt 302: vorübergehend, und jederzeit zurücknehmbar.
                          </div>
                        </div>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={redirectPermanent}
                            onChange={(e) => setRedirectPermanent(e.target.checked)}
                            aria-label="Dauerhaft (301)"
                          />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                      {redirectPermanent && (
                        <div className="form-note">
                          <Info size={14} />
                          <span>
                            Ein Browser merkt sich eine 301 und ruft die alte Adresse nicht mehr
                            auf. Wer sie später ändert, erreicht damit niemanden mehr, der schon
                            einmal hier war, bis dessen Cache abläuft.
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                <>
                <div className="form-list">
                  <div className="form-list-head">
                    <span style={{ flex: '0 0 30%' }}>Name</span>
                    <span style={{ flex: 1 }}>Adresse</span>
                    {/* Die Spalte gibt es nur bei der Lastverteilung: ein
                        einzelnes Ziel bekommt ohnehin alles, und ein Feld ohne
                        Frage füllt irgendwann jemand aus. */}
                    {balancing && <span style={{ width: 76 }}>Gewicht</span>}
                    <span style={{ width: 34 }} />
                  </div>
                  {backends.map((backend, index) => (
                    <div className="form-list-row" key={index}>
                      <input
                        className="form-input"
                        style={{ flex: '0 0 30%', minWidth: 0 }}
                        value={backend.name}
                        onChange={(e) =>
                          setBackends(
                            backends.map((b, i) =>
                              i === index ? { ...b, name: e.target.value } : b
                            )
                          )
                        }
                        placeholder={`server${index + 1}`}
                        autoComplete="off"
                      />
                      <input
                        className="form-input"
                        value={backend.target}
                        onChange={(e) =>
                          setBackends(
                            backends.map((b, i) =>
                              i === index ? { ...b, target: e.target.value } : b
                            )
                          )
                        }
                        placeholder="10.10.0.20:80"
                        autoComplete="off"
                      />
                      {/* Leer und nicht 1 als Vorgabe: eine hingeschriebene 1
                          stünde danach in dreißig Zeilen, in denen sie vorher
                          nicht stand. Der Platzhalter sagt, was ohne Eintrag
                          gilt. */}
                      {balancing && (
                        <input
                          className="form-input"
                          style={{ width: 76, flex: '0 0 76px' }}
                          type="number"
                          min={WEIGHT_MIN}
                          max={WEIGHT_MAX}
                          value={backend.weight}
                          onChange={(e) =>
                            setBackends(
                              backends.map((b, i) =>
                                i === index ? { ...b, weight: e.target.value } : b
                              )
                            )
                          }
                          placeholder="1"
                          aria-label={`Gewicht von Ziel ${index + 1}`}
                        />
                      )}
                      {/* Beim Reverse-Proxy gibt es genau eine Zeile, also
                          nichts zu entfernen. Der Knopf fehlt dort ganz, statt
                          dauerhaft gesperrt dazustehen. */}
                      {balancing && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          data-tooltip="Zeile entfernen"
                          disabled={backends.length === 1}
                          onClick={() => setBackends(backends.filter((_, i) => i !== index))}
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {balancing && (
                  <div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setBackends([...backends, { ...EMPTY_SERVER }])}
                    >
                      <Plus size={14} />
                      Ziel hinzufügen
                    </button>
                  </div>
                )}
                <span className="form-hint">
                  Adresse und Port, wie HAProxy sie erreicht, üblicherweise die Adresse im
                  privaten Netz. Der Name ist frei; leer heißt server1, server2, …
                </span>
                {/* Der eine Weg von hier ins größere Formular. Ohne ihn wäre
                    ein zweites Ziel hinter einer laufenden Domain nur über
                    Löschen und Neuanlegen zu haben. */}
                {!balancing && editingId && onSwitchKind && (
                  <div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => onSwitchKind('balance')}
                    >
                      <Scale size={14} />
                      Zweites Ziel: auf Lastverteilung umstellen
                    </button>
                    <span className="form-hint">
                      Öffnet dasselbe Ziel im Lastverteilungs-Formular, mit Verfahren,
                      Gewichtung und Sitzungsbindung. Nicht gespeicherte Eingaben in diesem
                      Formular gehen dabei verloren.
                    </span>
                  </div>
                )}
                {balancing && (
                  <span className="form-hint">
                    Das Gewicht ist der Anteil eines Ziels im Verhältnis zu den anderen: 2 gegen 1
                    heißt doppelt so viele Anfragen. Leer heißt, dass keine <code>weight</code>
                    -Angabe geschrieben wird und HAProxys Vorgabe gilt (alle gleich).{' '}
                    <strong>0</strong> nimmt ein Ziel aus der Verteilung, ohne seine gebundenen
                    Sitzungen abzuwerfen: der Weg, einen Server in Ruhe herauszunehmen.
                  </span>
                )}

                {/* ── Verfahren und Bindung ──
                    Nur im Lastverteilungs-Formular. Bei einem Ziel gibt es
                    nichts zu verteilen und nichts zu binden; die Frage stünde
                    dort als Feld, das immer dieselbe Antwort hat. */}
                {balancing && (
                <div className="form-subsection">
                  <div className="form-group">
                    <div className="form-label-row">
                      <label className="form-label">Verteilverfahren</label>
                      <InfoHint
                        text={
                          balance
                            ? BALANCE_HINTS[balance]
                            : 'Es wird keine balance-Zeile geschrieben. Dann gilt, was im defaults-Block der Konfiguration steht, üblicherweise Round Robin. Was dort wirklich steht, weiß dieses Formular nicht, deshalb wird nichts hingeschrieben.'
                        }
                      />
                    </div>
                    <Select
                      value={balance ?? ''}
                      onChange={(v) => setBalance(v === '' ? null : (v as HaproxyBalance))}
                      options={[
                        { value: '', label: 'Vorgabe der Konfiguration' },
                        ...HAPROXY_BALANCE.map((b) => ({ value: b, label: BALANCE_LABELS[b] })),
                      ]}
                    />
                  </div>

                  <div className="form-subsection-head">
                    <div>
                      <div className="form-label-row">
                        <div className="form-section-title">Sitzungsbindung</div>
                        {/* Die Zeile aus der Konstante und nicht abgetippt: zwei Quellen
                            für dieselbe Zeile laufen auseinander. */}
                        <InfoHint
                          text={`HAProxy setzt einen eigenen Cookie und nimmt ihn aus der Anfrage, bevor sie beim Ziel ankommt. Nötig für Anwendungen, die Sitzungen im Arbeitsspeicher halten. Teilen die Ziele ihre Sitzungen (gemeinsame Datenbank, Redis), braucht es sie nicht. In der Konfiguration: „${STICKY_BACKEND_LINE}" im Backend und „cookie <Servername>" an jeder server-Zeile.`}
                        />
                      </div>
                      <div className="form-section-sub">
                        {sticky
                          ? 'Ein Besucher bleibt bei dem Ziel, auf dem er gelandet ist.'
                          : 'Jede Anfrage kann bei einem anderen Ziel landen.'}
                      </div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={sticky}
                        onChange={(e) => setSticky(e.target.checked)}
                        aria-label="Sitzungsbindung"
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                </div>
                )}

                <div className="form-subsection">
                  <div className="form-subsection-head">
                    <div>
                      <div className="form-section-title">Healthcheck</div>
                      <div className="form-section-sub">
                        HAProxy prüft die Ziele und nimmt ein totes aus dem Betrieb.
                      </div>
                    </div>
                    {/* `label` und nicht `span`: das eigentliche Kästchen ist
                        unsichtbar (opacity 0, 0×0), geklickt wird der Slider
                        darüber. Ohne ein Label, das den Klick weiterreicht, ist
                        der Schalter tot — genau das war er hier. Die anderen
                        Schalter der App stehen INNERHALB eines `label`, deshalb
                        fiel es nur an dieser Stelle auf. */}
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={input.healthcheck}
                        onChange={(e) => setHealthcheck(e.target.checked)}
                        disabled={!healthcheckAllowed}
                        aria-label="Healthcheck"
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  {/* Was der Check tut, steht fest — deshalb hier als Auskunft
                      und nicht als drei Felder, die man ohnehin nicht ändern
                      kann. */}
                  {!healthcheckAllowed ? (
                    <div className="form-note">
                      <Info size={14} />
                      <span>
                        Aus, weil die Hauptdomain eine Wildcard ist: der Check schickt sie als
                        Host-Header, und <code>{domains[0]?.trim()}</code> ist kein Hostname. Das
                        Ziel antwortete mit 404, und HAProxy nähme es aus dem Betrieb. Mit einer
                        echten Domain an erster Stelle geht der Schalter wieder.
                      </span>
                    </div>
                  ) : (
                    healthcheck && (
                      <div className="form-note">
                        <Info size={14} />
                        <span>
                          GET auf <code>/</code>, erwartet wird 200-399, Host-Header{' '}
                          <code>{domains[0]?.trim() || 'Hauptdomain'}</code>. Antwortet ein Ziel
                          anders, nimmt HAProxy es aus dem Betrieb.
                        </span>
                      </div>
                    )
                  )}
                </div>
                </>
                )}
              </section>
            </div>

            <div className="form-col">
              {/* Bei einer Weiterleitung gibt es kein Backend, auf das eine
                  Pfad-Regel zeigen könnte. Der Abschnitt fällt deshalb weg,
                  statt gesperrt dazustehen: gesperrt läse er sich wie ein
                  fehlendes Recht und nicht wie eine Frage, die sich hier gar
                  nicht stellt. */}
              {redirecting && (
                <div className="form-note">
                  <Info size={14} />
                  <span>
                    Eine Weiterleitung hat kein Backend. Pfad-Regeln, Preset, Healthcheck und
                    Verteilverfahren stehen deshalb nicht in diesem Formular: sie alle gehören zu
                    einem Eintrag mit Zielen. Wer die braucht, legt einen Reverse-Proxy oder eine
                    Lastverteilung an.
                  </span>
                </div>
              )}
              {/* ── Pfad-Regeln ──
                  Zugeklappt, bis jemand sie braucht: der Normalfall ist eine
                  Domain auf ein Ziel, und aufgeklappt ist dieser Abschnitt so
                  lang wie der ganze Rest des Formulars zusammen. */}
              {!redirecting && (
              <section className="form-section">
                <button
                  type="button"
                  className="form-section-head form-section-toggle"
                  onClick={() => setRoutesOpen((open) => !open)}
                  aria-expanded={routesOpen}
                >
                  <span className="form-section-icon">
                    <Waypoints size={17} />
                  </span>
                  <div>
                    <div className="form-section-title">Pfad-Regeln</div>
                    <div className="form-section-sub">
                      {routes.length === 0
                        ? 'Alles geht an das Standard-Backend. Das ist der Normalfall.'
                        : 'Einzelne Pfade auf einen anderen Port desselben Ziels.'}
                    </div>
                  </div>
                  <span className="form-section-count">{routes.length}</span>
                  {routesOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>

                {routesOpen && routes.length === 0 && (
                  <div className="rp-blank">
                    <span className="rp-blank-icon">
                      <Waypoints size={20} />
                    </span>
                    <strong>Keine Pfad-Regeln</strong>
                    <span>
                      Alles geht an das Standard-Backend. Der Fall dafür ist Coolify: Oberfläche
                      auf 8000, Terminal auf 6002, Live-Ansicht auf 6001.
                    </span>
                  </div>
                )}

                {routesOpen && routes.map((route, routeIndex) => {
                  const update = (patch: Partial<RouteRow>) =>
                    setRoutes(routes.map((r, i) => (i === routeIndex ? { ...r, ...patch } : r)));

                  return (
                    <div key={routeIndex} className="form-subsection">
                      <div className="form-subsection-head">
                        <div className="form-group" style={{ flex: 1, minWidth: 0 }}>
                          <label className="form-label">Name</label>
                          <input
                            className="form-input"
                            value={route.name}
                            onChange={(e) => update({ name: e.target.value })}
                            placeholder="terminal"
                            autoComplete="off"
                          />
                          <span className="form-hint">
                            Backend und ACL: {serviceId || 'dienst'}_{route.name || 'name'}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          data-tooltip="Regel entfernen"
                          onClick={() => setRoutes(routes.filter((_, i) => i !== routeIndex))}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Pfade</label>
                        <div className="form-list">
                          {route.paths.map((path, pathIndex) => (
                            <div className="form-list-row" key={pathIndex}>
                              <input
                                className="form-input"
                                value={path}
                                onChange={(e) =>
                                  update({
                                    paths: route.paths.map((p, i) =>
                                      i === pathIndex ? e.target.value : p
                                    ),
                                  })
                                }
                                placeholder="/terminal/ws"
                                autoComplete="off"
                              />
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon"
                                data-tooltip="Zeile entfernen"
                                disabled={route.paths.length === 1}
                                onClick={() =>
                                  update({
                                    paths: route.paths.filter((_, i) => i !== pathIndex),
                                  })
                                }
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
                            onClick={() => update({ paths: [...route.paths, ''] })}
                          >
                            <Plus size={14} />
                            Pfad hinzufügen
                          </button>
                        </div>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Ziele dieser Regel</label>
                        <div className="form-list">
                          {route.servers.map((server, serverIndex) => (
                            <div className="form-list-row" key={serverIndex}>
                              <input
                                className="form-input"
                                style={{ flex: '0 0 30%', minWidth: 0 }}
                                value={server.name}
                                onChange={(e) =>
                                  update({
                                    servers: route.servers.map((s, i) =>
                                      i === serverIndex ? { ...s, name: e.target.value } : s
                                    ),
                                  })
                                }
                                placeholder={`server${serverIndex + 1}`}
                                autoComplete="off"
                              />
                              <input
                                className="form-input"
                                value={server.target}
                                onChange={(e) =>
                                  update({
                                    servers: route.servers.map((s, i) =>
                                      i === serverIndex ? { ...s, target: e.target.value } : s
                                    ),
                                  })
                                }
                                placeholder="10.10.0.5:6002"
                                autoComplete="off"
                              />
                              {/* Auch hier, obwohl eine Regel meistens ein Ziel
                                  hat: sonst wäre die Gewichtung ein Feld, das
                                  zwar zurückgelesen und wieder geschrieben
                                  wird, sich aber nirgends ändern lässt. */}
                              <input
                                className="form-input"
                                style={{ width: 76, flex: '0 0 76px' }}
                                type="number"
                                min={WEIGHT_MIN}
                                max={WEIGHT_MAX}
                                value={server.weight}
                                onChange={(e) =>
                                  update({
                                    servers: route.servers.map((s, i) =>
                                      i === serverIndex ? { ...s, weight: e.target.value } : s
                                    ),
                                  })
                                }
                                placeholder="1"
                                aria-label={`Gewicht von Ziel ${serverIndex + 1}`}
                              />
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon"
                                data-tooltip="Zeile entfernen"
                                disabled={route.servers.length === 1}
                                onClick={() =>
                                  update({
                                    servers: route.servers.filter((_, i) => i !== serverIndex),
                                  })
                                }
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
                            onClick={() =>
                              update({ servers: [...route.servers, { ...EMPTY_SERVER }] })
                            }
                          >
                            <Plus size={14} />
                            Ziel hinzufügen
                          </button>
                        </div>
                      </div>

                      <div className="form-subsection-head">
                        <div>
                          <div className="form-section-title">Verbindungsprüfung</div>
                          <div className="form-section-sub">
                            Nur `check` auf der server-Zeile, kein HTTP-Check.
                          </div>
                        </div>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={route.check}
                            onChange={(e) => update({ check: e.target.checked })}
                            aria-label="Verbindungsprüfung"
                          />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                    </div>
                  );
                })}

                {routesOpen && (
                  <>
                    <div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          setRoutes([
                            ...routes,
                            { ...EMPTY_ROUTE, paths: [''], servers: [{ ...EMPTY_SERVER }] },
                          ])
                        }
                      >
                        <Plus size={14} />
                        Pfad-Regel hinzufügen
                      </button>
                    </div>

                    <div className="form-note">
                      <Info size={14} />
                      <span>
                        Verglichen wird der Anfang des Pfads: /app trifft auch /app/socket. Eine
                        WebSocket-Strecke antwortet auf ein GET auf / nicht mit 200. Deshalb hier
                        kein HTTP-Check, sonst nähme HAProxy sie dauerhaft aus dem Betrieb.
                      </span>
                    </div>
                  </>
                )}
              </section>
              )}

              {/* Die Meldung der Validierung steht am Fuß des Formulars, wo der
                  Blick beim Ausfüllen ohnehin endet. Hier standen einmal eine
                  Konfigurations-Übersicht und eine Checkliste — beide haben
                  wiederholt, was in den Feldern darüber schon steht. */}
              {inputError && serviceId && (
                <div className="alert alert-warning">{inputError}</div>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onClose()}
            disabled={saving}
          >
            Abbrechen
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !!inputError}>
            {saving && <Loader2 size={16} className="spin" />}
            {editingId ? 'Speichern' : 'Anlegen'}
          </button>
        </div>
      </form>
    </div>
  </div>
  );
}
