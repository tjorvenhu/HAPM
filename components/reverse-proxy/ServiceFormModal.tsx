'use client';

import { Fragment, useEffect, useState, type FormEvent } from 'react';
import ErrorNote from '@/components/ErrorNote';
import Link from 'next/link';
import {
  Plus, Trash2, Loader2, X, Server, Waypoints, Info, Globe, Lock,
  ChevronDown, ChevronRight, CornerUpRight, Scale, RefreshCw, ShieldCheck, SlidersHorizontal, Shield,
  CircleCheck, CircleDashed, CircleAlert,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useTabMotion } from '@/components/AreaTabs';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { suggestPassword } from '@/components/suggestPassword';
import Select from '@/components/Select';
import { InfoHint } from '@/ui/primitives/InfoHint';
import BrandLogo from '@/components/BrandLogo';
import {
  HAPROXY_BALANCE,
  BALANCE_LABELS,
  BALANCE_HINTS,
  STICKY_BACKEND_LINE,
  WEIGHT_MAX,
  WEIGHT_MIN,
  KEEP_PASSWORD,
  LOCK_PASSWORD_MIN,
  HEADER_DIRECTION_LABELS,
  HEADER_SUGGESTIONS,
  HEADERS_MAX,
  TUNNEL_LINE,
  locksEveryDomain,
  ownsDomain,
  readWeight,
  shortVersion,
  supportsPasswordLock,
  supportsSystemCa,
  validateLockPassword,
  validateCreateInput,
  validateNewService,
  certificateChanged,
  isWildcardDomain,
  healthcheckPossible,
  serviceKind,
  type HaproxyScope,
  type HaproxyBalance,
  type BackendTls,
  type HeaderDirection,
  type HeaderRule,
  type ServiceKind,
  type HaproxyService,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { needsDnsChallenge } from '@/lib/haproxy/challenge';
import { certCovers } from '@/lib/haproxy/certs';
import { refuseSurfaceUpdate } from '@/lib/haproxy/protected';
import { normalizeDomain, type DomainMatch } from '@/lib/dns/zones';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import type { ProxyRow } from './types';
import SavedTargetPick, { useSavedTargets } from './SavedTargetPick';
import BackendTlsPick from './BackendTlsPick';

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

/** Eine Zeile des Standard-Backends als Eingabe. */
function toServerInput(row: ServerRow) {
  return {
    name: row.name.trim(),
    target: row.target.trim(),
    weight: readWeight(row.weight),
  };
}

/** Ein Ziel einer Pfad-Regel. Ohne Gewicht: `RouteServerInput` kennt keines,
 *  und geschrieben würde es nicht. */
type RouteServerRow = Omit<ServerRow, 'weight'>;

const EMPTY_ROUTE_SERVER: RouteServerRow = { name: '', target: '' };

/** Eine Pfad-Regel im Formular. `paths` und `servers` sind Listen, weil beide
 *  es in der Konfiguration auch sind. */
interface RouteRow {
  name: string;
  paths: string[];
  servers: RouteServerRow[];
  check: boolean;
  backendTls: BackendTls;
}

/** Die Wörter aus `TargetKindDialog`, damit die Überschrift dieselben trägt.
 *  Die TCP-Weiterleitung fehlt hier: sie ist kein Dienst und hat ein eigenes
 *  Formular. */
const KIND_TITLES: Record<ServiceKind, { create: string; edit: string }> = {
  proxy: { create: msgid('Reverse-Proxy anlegen'), edit: msgid('Reverse-Proxy bearbeiten') },
  balance: { create: msgid('Lastverteilung anlegen'), edit: msgid('Lastverteilung bearbeiten') },
  redirect: { create: msgid('HTTP-Weiterleitung anlegen'), edit: msgid('HTTP-Weiterleitung bearbeiten') },
};

/**
 * Wer die Domains aufrufen darf. Drei Zustände und eine Frage, statt eines
 * Schlosses je Domainzeile, eines Umschalters für die Art und eines Satzes
 * darunter: so stand die Art der Sperre auch dann im Formular, wenn gar nichts
 * gesperrt war.
 */
type Access = 'open' | 'ip' | 'password';

type FormTab = 'domains' | 'ziel' | 'schutz' | 'erweitert';

const FORM_TABS: { key: FormTab; label: string; icon: typeof Globe }[] = [
  { key: 'domains', label: msgid('Domains'), icon: Globe },
  { key: 'ziel', label: msgid('Ziel'), icon: Server },
  { key: 'schutz', label: msgid('Zugriff und Schutz'), icon: Shield },
  { key: 'erweitert', label: msgid('Erweitert'), icon: SlidersHorizontal },
];

const ACCESS_LABELS: Record<Access, string> = {
  open: msgid('Offen'),
  ip: msgid('Nur Admin-IPs'),
  password: msgid('Passwort'),
};

/** Ab so vielen Adressen steht im Formular nur noch ihre Anzahl. */
const ADMIN_IPS_SHOWN = 4;

const EMPTY_ROUTE: RouteRow = {
  name: '',
  paths: [''],
  servers: [{ ...EMPTY_ROUTE_SERVER }],
  check: true,
  // HTTP und nicht die Wahl des Backends: eine Regel zeigt auf einen anderen
  // Port, und dort spricht oft ein anderes Programm.
  backendTls: 'off',
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

/** Ausgeschrieben, damit `tests/ui/css-classes.test.ts` jede Klasse findet. */
const DNS_STATE_CLASS = {
  matches: 'hapm-dns-state is-matches',
  elsewhere: 'hapm-dns-state is-elsewhere',
  unresolved: 'hapm-dns-state is-unresolved',
  unknown: 'hapm-dns-state is-unknown',
} as const;

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
  const { notify } = useToast();
  const { t, plural, rich } = useT();

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
  /**
   * Die Dienst-ID, beim Bearbeiten. Ein neuer Eintrag hat noch keine: sie
   * ergibt sich aus der Hauptdomain und wird beim Anlegen auf dem Server
   * vergeben, wo die Konfiguration vorliegt. Danach bleibt sie, auch wenn sich
   * die Domain ändert: sie benennt ACL und Backend in der Datei.
   */
  const editingId = edit?.service.id ?? null;

  const [saving, setSaving] = useState(false);
  /** Nur die Prüfung vor dem Absenden. Was die Route antwortet, ist eine Meldung. */
  const [formError, setFormError] = useState('');
  /** Es gibt genau einen HAProxy. Die Kennung geht weiter im Rumpf mit, weil
   *  die Routen und die Historie sie tragen. */
  const serverId = edit?.proxy.$id ?? usable[0]?.$id ?? '';

  /** Die Gruppen aus der Konfiguration. Unvollständige (nur einer der beiden
   *  Marker) stehen nicht zur Wahl: der Block landete sonst irgendwo. */
  /** Die Gruppe der Oberfläche steht nicht zur Wahl, außer der Eintrag liegt
   *  schon darin (`refuseSurfaceScopeEntry`, dieselbe Regel wie die Route). */
  const surfaceScope = proxies.find((p) => p.$id === serverId)?.surface?.scope?.toUpperCase() ?? null;
  const scopeOptions = (proxies.find((p) => p.$id === serverId)?.scopes ?? []).filter(
    (s) =>
      s.complete &&
      (surfaceScope === null || s.name.toUpperCase() !== surfaceScope || edit?.service.scope?.toUpperCase() === surfaceScope)
  );
  const [scope, setScope] = useState<HaproxyScope>(
    edit?.service.scope ??
      (scopeOptions.some((s) => s.name === defaultScope) ? defaultScope : (scopeOptions[0]?.name ?? defaultScope))
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
  const [domains, setDomains] = useState<string[]>(
    edit && edit.service.domains.length > 0 ? [...edit.service.domains] : ['']
  );
  const savedTargets = useSavedTargets();
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
          ? route.servers.map((s) => ({ name: s.name, target: s.target }))
          : [{ ...EMPTY_ROUTE_SERVER }],
      check: route.check,
      backendTls: route.backendTls,
    })) ?? []
  );
  /** Zugeklappt, auch wenn es Regeln gibt: der Abschnitt ist aufgeklappt so
   *  lang wie der Rest des Formulars, und die meisten Änderungen betreffen ihn
   *  nicht. Die Anzahl in der Überschrift sagt, dass es dort etwas gibt. */
  const [routesOpen, setRoutesOpen] = useState(true);
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
  /**
   * Die Zusätze: feste Header und das lange Timeout. Sie stehen in jedem
   * Backend des Eintrags, auch in denen der Pfad-Regeln. Im Normalfall leer.
   */
  const [headers, setHeaders] = useState<Record<HeaderDirection, HeaderRule[]>>({
    response: edit?.service.responseHeaders.map((rule) => ({ ...rule })) ?? [],
    request: edit?.service.requestHeaders.map((rule) => ({ ...rule })) ?? [],
  });
  /** Der Reiter des Dialogs. Beginnt bei den Domains, beim Bearbeiten auch. */
  const [tab, setTab] = useState<FormTab>('domains');
  const motion = useTabMotion(tab);
  const [tunnel, setTunnel] = useState(edit?.service.tunnel ?? false);
  /** CrowdSec für dieses Ziel. Gilt es global, ist der Schalter an und gesperrt. */
  const [crowdsec, setCrowdsec] = useState(edit?.service.crowdsec ?? false);
  /** Zugeklappt wie die Pfad-Regeln, aus demselben Grund. */
  const [addonsOpen, setAddonsOpen] = useState(true);
  const [healthcheck, setHealthcheck] = useState(edit?.service.healthcheck ?? true);
  /** Wie HAProxy mit den Zielen spricht. Beim Bearbeiten aus der Datei gelesen
   *  (`readServerParams`), sonst HTTP. */
  const [backendTls, setBackendTls] = useState<BackendTls>(edit?.service.backendTls ?? 'off');
  /**
   * Der Zugriff: offen, nur für die Admin-IPs oder mit Passwort.
   *
   * Eine Art je Eintrag und nicht je Domain: es gibt in der Datei eine ACL der
   * gesperrten Domains, und an ihr hängt entweder die eine Regel oder die
   * Abfrage. Das Modell dahinter ist dasselbe geblieben (`lockedDomains`,
   * `passwordLock`), nur die Frage steht jetzt an einer Stelle.
   */
  const [access, setAccess] = useState<Access>(
    !edit || edit.service.lockedDomains.length === 0
      ? 'open'
      : edit.service.passwordLock
        ? 'password'
        : 'ip'
  );
  /**
   * Für welche Domains. Vorgabe: alle. Wer nur einzelne meint (`kunde.example`
   * offen, `intern.kunde.example` gesperrt), wählt sie aus der Liste.
   */
  const [lockAll, setLockAll] = useState(
    !edit ||
      edit.service.lockedDomains.length === 0 ||
      locksEveryDomain(edit.service.domains, edit.service.lockedDomains)
  );
  const [lockedDomains, setLockedDomains] = useState<string[]>(
    edit?.service.lockedDomains ?? []
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
  /** Die Version, wenn sie `@system-ca` nicht kennt. Unbekannt sperrt nichts. */
  const verifyUnsupported =
    supportsSystemCa(proxyVersion) === false ? shortVersion(proxyVersion ?? '') : null;
  /* Eine Art, der gerade etwas fehlt, lässt sich nicht wählen. Wer sie schon
   * hat, behält sie: der Eintrag soll sich öffnen lassen, auch wenn inzwischen
   * die Voraussetzung fehlt. */
  const accessBlocked: Record<Access, boolean> = {
    open: false,
    ip: adminIps.length === 0 && access !== 'ip',
    password: !passwordPossible && access !== 'password',
  };

  /** Die Domains des Formulars, so wie sie geschickt werden. */
  const domainList = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  /**
   * Woraus sich einzelne Domains wählen lassen: die des Eintrags, und dazu,
   * was schon gesperrt ist und unter einer seiner Wildcards liegt
   * (`intern.kunde.example` unter `*.kunde.example`). Ohne die zweite Hälfte
   * verlöre ein solcher Eintrag seine Sperre beim Speichern.
   */
  const lockChoices = [
    ...new Set([...domainList, ...lockedDomains.filter((d) => ownsDomain(domainList, d))]),
  ];

  function toggleDomainLock(domain: string) {
    setLockedDomains((current) =>
      current.includes(domain) ? current.filter((d) => d !== domain) : [...current, domain]
    );
  }

  /** Das Kennzeichen an einer gesperrten Domain. Nur lesend: gewählt wird in
   *  der Karte „Zugriff", nicht an der Zeile. */
  function renderLockMark(domain: string) {
    const value = domain.trim().toLowerCase();
    if (value === '' || !effectiveLocked.includes(value)) return null;
    return (
      <span
        className="hapm-row-mark"
        data-tooltip-pos="left"
        data-tooltip={
          t(access === 'password' ? 'Mit Passwort gesperrt, siehe Zugriff' : 'Nur für Admin-IPs, siehe Zugriff')
        }
      >
        <Lock size={15} />
      </span>
    );
  }

  function updateHeader(direction: HeaderDirection, index: number, patch: Partial<HeaderRule>) {
    setHeaders((current) => ({
      ...current,
      [direction]: current[direction].map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  }

  /** Ein Vorschlag fügt gewöhnliche Zeilen ein. Steht der Name schon da, wird
   *  sein Wert ersetzt: zwei Zeilen desselben Namens nimmt die Prüfung nicht an. */
  function insertHeaders(direction: HeaderDirection, rules: HeaderRule[]) {
    setHeaders((current) => {
      const next = current[direction].filter((row) => row.name.trim() !== '' || row.value !== '');
      for (const rule of rules) {
        const at = next.findIndex((row) => row.name.trim().toLowerCase() === rule.name.toLowerCase());
        if (at === -1) next.push({ ...rule });
        else next[at] = { ...rule };
      }
      return { ...current, [direction]: next };
    });
  }

  /** Name und Wert, wie sie geschickt werden. Eine leere Zeile ist keine. */
  const sentHeaders = (direction: HeaderDirection) =>
    headers[direction]
      .map((rule) => ({ name: rule.name.trim(), value: rule.value.trim() }))
      .filter((rule) => rule.name !== '' || rule.value !== '');

  /** Die Header, die das Frontend schon für alle Ziele setzt. */
  const globalHeaders = proxies.find((p) => p.$id === serverId)?.globalHeaders ?? {
    request: [],
    response: [],
  };

  /**
   * Was es heißt, wenn ein Header hier denselben Namen trägt wie einer der
   * globalen Einstellungen. Die beiden Richtungen verhalten sich gegenteilig
   * (`parseGlobalHeaders`), deshalb steht es an der Zeile und nicht hinter
   * einem „i": bei der Antwort hat der Eintrag keine Wirkung.
   */
  function globalHeaderNote(direction: HeaderDirection, name: string): string {
    const wanted = name.trim().toLowerCase();
    const known = globalHeaders[direction].find((entry) => entry.toLowerCase() === wanted);
    if (!wanted || !known) return '';
    return direction === 'request'
      ? t('Die globalen Einstellungen setzen {header} schon. Für dieses Ziel gilt der Wert hier.', { header: known })
      : t(
          'Die globalen Einstellungen setzen {header} für alle Ziele und überschreiben den Wert hier. Er kommt beim Besucher nicht an.',
          { header: known }
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
  // Nur, was dem Eintrag gehört: wer eine gesperrte Domain aus der Liste
  // entfernt, hat sie entfernt, nicht heimlich weiter gesperrt. „Offen" schickt
  // keine, was auch immer in der Auswahl noch steht.
  const effectiveLocked =
    access === 'open'
      ? []
      : lockAll
        ? domainList
        : lockedDomains.filter((locked) => lockChoices.includes(locked));
  const lockingByPassword = access === 'password' && effectiveLocked.length > 0;

  const input: CreateServiceInput = {
    scope,
    // Leer heißt beim Anlegen: der Server vergibt sie.
    id: editingId ?? '',
    domains: domainList,
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
          backendTls: route.backendTls,
        })),
    balance: balancing ? balance : null,
    sticky: balancing && sticky,
    lockedDomains: effectiveLocked,
    // Nie ein Hash: hier steht nur der Verweis, und ein neues Passwort geht als
    // `lockPassword` daneben mit. Hash und Cookie-Wert entstehen in der Route.
    passwordLock: lockingByPassword ? KEEP_PASSWORD : null,
    // Eine Weiterleitung hat kein Backend, in dem die Zeilen stünden, und ihr
    // Formular zeigt sie nicht.
    responseHeaders: redirecting ? [] : sentHeaders('response'),
    requestHeaders: redirecting ? [] : sentHeaders('request'),
    tunnel: !redirecting && tunnel,
    crowdsec: !redirecting && crowdsec,
    // Eine Wildcard als Hauptdomain schließt ihn aus. Der Schalter behält
    // dabei seinen Wert im Zustand — wer die Domain wieder ändert, findet ihn
    // so vor, wie er ihn gesetzt hat, statt ihn erneut umlegen zu müssen.
    healthcheck:
      !redirecting &&
      healthcheck &&
      healthcheckPossible(domainList),
    // Das Weiterleitungs-Formular zeigt die Frage nicht, also schickt es HTTP.
    backendTls: redirecting ? 'off' : backendTls,
  };
  // Dieselbe Funktion, die die Route aufruft. Zwei Regelwerke wären ein Dialog,
  // der etwas durchlässt, was der Server danach ablehnt.
  const inputError = editingId ? validateCreateInput(input) : validateNewService(input);
  const addonCount = input.responseHeaders.length + input.requestHeaders.length + (input.tunnel ? 1 : 0);
  /** Was in einem Reiter eingestellt ist, als Zahl an seinem Namen: so sieht
   *  man von außen, dass dort etwas steht. */
  const tabCounts: Record<FormTab, number> = {
    domains: 0,
    ziel: 0,
    schutz: (input.lockedDomains.length > 0 ? 1 : 0) + (input.crowdsec ? 1 : 0),
    erweitert: input.routes.length + addonCount,
  };

  /* Das Ziel, über das die Adresse von HAPM läuft, behält deren Domain
   * (`lib/haproxy/protected.ts`). Dieselbe Funktion wie in der Route, hier
   * vorweg: sonst ginge der Dialog erst nach dem Speichern mit der Absage
   * wieder auf. */
  const surface =
    edit && edit.proxy.surface?.serviceId === edit.service.id ? edit.proxy.surface : null;
  const surfaceError = surface
    ? refuseSurfaceUpdate(surface, surface.serviceId, input.domains)
    : null;

  /** Beim Bearbeiten: ob diese Änderung ein neues Zertifikat auslöst. Dieselbe
   *  Funktion, nach der die Route sich richtet — damit der Hinweis im Dialog
   *  nicht etwas anderes ankündigt, als danach passiert. */
  const certNeeded = edit ? certificateChanged(edit.service.domains, input.domains) : false;

  /* ── Wildcards und interne Installationen ──
   *
   * Der Hook wird verlangt, sobald das Zertifikat über DNS-01 ausgestellt wird
   * und eines fällig wäre — beim Anlegen immer, beim Bearbeiten nur bei
   * geänderten Domains. DNS-01 ist es bei einer Wildcard und bei jeder Domain
   * einer internen Installation (`needsDnsChallenge`, dieselbe Regel wie in der
   * Route). Die Liste kommt aus der Probe: welche Hooks acme.sh kennt, steht
   * in dessen Konfiguration, und HAPM hält die Zugangsdaten nicht selbst. */
  const healthcheckAllowed = healthcheckPossible(input.domains);
  const selectedProxy = proxies.find((p) => p.$id === serverId) ?? null;
  const hasWildcard = input.domains.some(isWildcardDomain);
  /** `timeout tunnel` aus dem defaults-Block: dann gilt „Lange Verbindungen“ schon für alle. */
  const globalTunnel = selectedProxy?.defaultsTunnel ?? null;
  const dnsHooks = selectedProxy?.dnsHooks ?? [];
  /** Ob ein Zertifikat fällig wäre: beim Anlegen immer, beim Bearbeiten nur bei geänderten Domains. */
  const certificateDue = input.domains.length > 0 && (!editingId || certNeeded);
  /**
   * Liegt schon ein gültiges Zertifikat für alle Domains da (eine Wildcard von
   * früher, ein hochgeladenes), wird nichts beantragt: dann braucht es weder
   * einen Hook noch ein Hochladen. Dieselbe Regel wie `findCertificateFor`.
   */
  const certificatePresent =
    input.domains.length > 0 &&
    (selectedProxy?.presentCertificates ?? []).some((names) =>
      input.domains.every((domain) => names.some((pattern) => certCovers(pattern, domain)))
    );
  const uploadOnly = selectedProxy?.certificateSource === 'upload';
  /** „Nur hochladen" und nichts da: erst hochladen, dann anlegen. */
  const uploadMissing = uploadOnly && certificateDue && !certificatePresent;
  const dnsHookNeeded =
    !uploadOnly &&
    !certificatePresent &&
    needsDnsChallenge(input.domains, selectedProxy?.exposure ?? 'public', selectedProxy?.httpChallenge ?? false) &&
    (!editingId || certNeeded);
  const dnsHookMissing = dnsHookNeeded && dnsHooks.length === 0;
  /**
   * Ohne Wildcard steht die Auswahl nur da, wenn es etwas zu wählen gibt: in
   * einer internen Installation ginge sie sonst bei jedem Ziel auf und zeigte
   * immer denselben einen Eintrag. Bei einer Wildcard bleibt sie wie bisher.
   */
  const dnsHookSelectShown = dnsHookNeeded && !dnsHookMissing && (hasWildcard || dnsHooks.length > 1);

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
          { value: '', label: t('Bitte wählen') },
          ...dnsHooks.map((hook) => ({ value: hook, label: hook })),
        ];

  /** „Nur einzelne" ohne eine einzige Auswahl wäre ein Eintrag, der gesperrt
   *  aussieht und offen ist. Leer heißt: nichts zu beanstanden. */
  const accessError =
    access !== 'open' && domainList.length > 0 && effectiveLocked.length === 0
      ? t('Für die Sperre ist keine Domain ausgewählt.')
      : '';

  /** Was am Passwort der Sperre noch fehlt. Leer heißt: nichts. */
  const lockPasswordError = !lockingByPassword
    ? ''
    : lockPassword !== ''
      ? t(validateLockPassword(lockPassword) ?? '')
      : hasStoredPassword
        ? ''
        : t('Für die Passwortsperre fehlt das Passwort.');


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
  /** Zu welchen Domains die Antwort in `dnsMatches` gehört. Weicht er von
   *  `domainsKey` ab, läuft die Abfrage noch oder wartet auf das Entprellen. */
  const [dnsMatchesKey, setDnsMatchesKey] = useState('');
  /**
   * Für welche Domains ein Eintrag gesetzt werden soll.
   *
   * Je Domain und nicht ein Schalter für alle: ein Dienst bedient oft
   * `kunde.example` und `app.example.org`, und gemeint ist manchmal nur die zweite.
   *
   * **Ein fehlender Eintrag heißt: die Vorgabe** (`dnsChosen`). Sie ist AN:
   * der Schalter erscheint nur für Domains in einer Zone, die hier
   * eingerichtet ist, und die richtet man ein, damit genau das passiert. AUS
   * ist sie nur, wenn die Domain schon woanders auflöst (`resolvesElsewhere`,
   * meist intern). Hier steht deshalb nur, was jemand selbst gewählt hat: eine
   * Vorgabe in den Zustand zu schreiben, wenn die Antwort eintrifft, wäre einen
   * Render lang eine Zeile, deren Haken beim Speichern nicht mitzählt.
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
        setDnsMatchesKey('');
        return;
      }
      apiFetch(`/api/dns/match?domains=${encodeURIComponent(list.join(','))}`)
        .then((res) => res.json())
        .then((data) => {
          if (live) {
            setDnsMatches(data.success ? (data.data as DomainMatch[]) : []);
            setDnsMatchesKey(list.join(','));
          }
        })
        // Ohne Antwort bleibt der Abschnitt weg, auch der Spinner. Das Formular
        // muss auch dann bedienbar sein, wenn Cloudflare gerade nicht
        // erreichbar ist — der Reverse-Proxy hat damit nichts zu tun.
        .catch(() => {
          if (live) {
            setDnsMatches([]);
            setDnsMatchesKey(list.join(','));
          }
        });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [domainsKey, apiFetch]);

  /** Die Domains, für die es hier überhaupt etwas zu entscheiden gibt. */
  const dnsRows = dnsMatches.filter((match) => match.zone !== null);
  /** Was der Abschnitt zeigt: dazu jede Domain, deren Auflösung etwas sagt. */
  const dnsShown = dnsMatches.filter((match) => match.zone !== null || match.resolution !== null);
  /**
   * Solange die Antwort nicht zu den eingetippten Domains passt, steht für jede
   * eine Zeile mit Spinner: sonst wäre der Abschnitt leer oder zeigte den Stand
   * der vorigen Eingabe, und es sähe aus, als gäbe es nichts zu prüfen.
   * Wildcards fehlen hier wie in der Antwort: sie haben keine eigene Adresse.
   */
  const dnsQueryKey = domainsKey.split(',').filter(Boolean).join(',');
  const dnsPending =
    dnsQueryKey !== '' && dnsMatchesKey !== dnsQueryKey
      ? input.domains.map(normalizeDomain).filter((domain) => domain && !isWildcardDomain(domain))
      : [];

  /**
   * Worauf die Domain gerade zeigt, in einem Satz. Löst sie nicht auf und kann
   * HAPM den Eintrag setzen, ist das der Vorschlag dazu: der Schalter daneben
   * steht dann schon an.
   */
  /**
   * Löst die Domain schon auf, ohne in der angebundenen Zone zu stehen, kommt
   * die Antwort von woanders, meist vom DNS-Server im eigenen Netz. Ein Eintrag
   * in der Zone machte sie dann im ganzen Internet auflösbar, und das will, wer
   * sie bewusst nur intern führt, gerade nicht. Deshalb steht der Schalter dann
   * aus und muss ausdrücklich eingeschaltet werden.
   */
  function resolvesElsewhere(match: DomainMatch): boolean {
    const verdict = match.resolution?.verdict;
    return !!match.zone && !!match.plan && !match.existing && !match.error && (verdict === 'matches' || verdict === 'elsewhere');
  }

  /** Ob der Eintrag gesetzt werden soll: was jemand gewählt hat, sonst die Vorgabe. */
  function dnsChosen(match: DomainMatch): boolean {
    return dnsWanted[match.domain] ?? !resolvesElsewhere(match);
  }

  function resolutionText(match: DomainMatch): string | null {
    const resolution = match.resolution;
    if (!resolution) return null;
    const addresses = (resolution.addresses ?? []).join(', ');
    if (resolvesElsewhere(match) && match.zone) {
      return dnsChosen(match)
        ? t('Löst schon auf ({addresses}), aber nicht über {zone}. Mit dem Eintrag ist die Domain im ganzen Internet auflösbar.', {
            addresses,
            zone: match.zone.name,
          })
        : t('Löst schon auf ({addresses}), aber nicht über {zone}, etwa über den DNS-Server Ihres Netzes. Eingeschaltet wird sie im ganzen Internet auflösbar.', {
            addresses,
            zone: match.zone.name,
          });
    }
    switch (resolution.verdict) {
      case 'matches':
        return t('Zeigt auf {addresses}, diesen Server.', { addresses });
      case 'elsewhere':
        return t('Zeigt auf {addresses}. Das ist keine Adresse dieses Servers.', { addresses });
      case 'unresolved':
        return match.zone && match.plan && !match.existing && !match.error
          ? t('Löst noch nicht auf. Der Schalter legt den Eintrag beim Speichern an.')
          : t('Löst noch nicht auf. Der DNS-Eintrag fehlt.');
      default:
        return t('Die DNS-Abfrage ist gescheitert.');
    }
  }
  /** Was mitgeschickt wird: möglich, noch nicht vorhanden und gewählt (siehe `dnsChosen`). */
  const dnsDomains = dnsRows
    .filter((m) => m.plan && !m.existing && !m.error && dnsChosen(m))
    .map((m) => m.domain);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (inputError) {
      setFormError(t(inputError));
      return;
    }
    if (accessError || lockPasswordError) {
      setFormError(accessError || lockPasswordError);
      return;
    }
    if (surfaceError) {
      setFormError(t(surfaceError));
      return;
    }
    // Dieselbe Bedingung, die `assertIssuable` auf dem Server prüft. Hier
    // vorweg, damit die Eingabe nicht für eine Meldung weggeworfen wird, die
    // ein Feld daneben beantwortet.
    if (uploadMissing) {
      setFormError(
        t('Diese Installation stellt keine Zertifikate selbst aus. Laden Sie zuerst unter Reverse-Proxy, Zertifikate eins hoch, das die Domains abdeckt.')
      );
      return;
    }
    if (dnsHookNeeded && !effectiveDnsHook) {
      setFormError(
        dnsHooks.length === 0
          ? t(
              hasWildcard
                ? 'Eine Wildcard-Domain lässt Let’s Encrypt nur über DNS-01 ausstellen, und es ist kein DNS-Hook von acme.sh eingerichtet. Die Zugangsdaten stehen unter Reverse-Proxy, Einstellungen.'
                : 'In dieser internen Installation wird jedes Zertifikat über DNS-01 ausgestellt, und es ist kein DNS-Hook von acme.sh eingerichtet. Die Zugangsdaten stehen unter Reverse-Proxy, Einstellungen.'
            )
          : t('Bitte wählen Sie den DNS-Hook, der die Challenge setzt.')
      );
      return;
    }
    setFormError('');
    setSaving(true);
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
            // Was das Formular nicht zeigt, schickt es nicht: ohne Auswahl
            // nimmt die Route den einen eingerichteten Hook selbst.
            dnsHook: dnsHookSelectShown ? effectiveDnsHook : '',
            dnsDomains,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // Ab hier ist der Vorgang gestartet, nicht fertig. Der Dialog geht zu,
      // damit niemand fünf Minuten vor einem Spinner sitzt; was die Route noch
      // synchron geprüft hat (belegte ID, fremde Domain), kam als Meldung
      // zurück und gar nicht bis hierher.
      // Die ID eines neuen Eintrags steht in der Antwort: vergeben hat sie
      // der Server.
      const startedId: string = editingId ?? data.data.serviceId;
      onStarted({
        id: data.data.runId,
        label: editingId
          ? t('Ziel „{id}“ ändern', { id: startedId })
          : t('Ziel „{id}“ anlegen', { id: startedId }),
        serviceId: startedId,
        title: input.domains[0] ?? startedId,
        isNew: !editingId,
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t(editingId ? 'Speichern fehlgeschlagen' : 'Anlegen fehlgeschlagen'),
        message: errorText(
          err,
          t(editingId ? 'Das Ziel ließ sich nicht speichern.' : 'Das Ziel ließ sich nicht anlegen.')
        ),
      });
    } finally {
      // Auch nach `onStarted`: schließt die Seite den Dialog nicht, bliebe der
      // Knopf sonst für immer gesperrt.
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
          {t(edit ? KIND_TITLES[kind].edit : KIND_TITLES[kind].create)}
          {editingId && <span className="modal-subject">{editingId}</span>}
        </h2>
        <button
          type="button"
          className="modal-close"
          onClick={() => onClose()}
          disabled={saving}
          aria-label={t('Dialog schließen')}
        >
          <X size={18} />
        </button>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          {formError && <div className="alert alert-danger"><ErrorNote text={formError} /></div>}

          {/* Dass der Eintrag in einem Zug ersetzt wird, stand hier als Satz —
              er beschrieb, wie das Werkzeug arbeitet, und nicht, was jemand
              entscheiden muss. Übrig bleibt der Hinweis, der eine Folge hat:
              geänderte Domains kosten ein neues Zertifikat. */}
          {editingId && certNeeded && (
            <div className="alert alert-info">
              {t('Die Domains ändern sich. Dafür wird ein neues Zertifikat beantragt.')}
            </div>
          )}

          {/* Vier Reiter statt einer langen Seite, wie unter Einstellungen.
              Alles bleibt im Zustand des Formulars: ein Wechsel verliert
              nichts, und gespeichert wird immer der ganze Eintrag. */}
          <div className={`tabs form-tabs ${motion}`} role="tablist">
            {FORM_TABS.filter((entry) => !(redirecting && entry.key === 'erweitert')).map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.key}
                  className={`tab ${tab === entry.key ? 'active' : ''}`}
                  onClick={() => setTab(entry.key)}
                >
                  <Icon size={15} />
                  {t(entry.label)}
                  {tabCounts[entry.key] > 0 && <span className="section-count">{tabCounts[entry.key]}</span>}
                </button>
              );
            })}
          </div>

          <div className="form-columns">
            <div className="form-col">
              {tab === 'domains' && (<>
              {/* ── Domains ──
                  Die Gruppe steht hier mit drin. Eine eigene Karte „Allgemein"
                  trug zuletzt nur noch dieses eine Feld: die Dienst-ID ergibt
                  sich aus der Hauptdomain, und die Zusätze haben ihre eigene
                  Karte. */}
              <section className="form-section">
                <div className="form-section-head">
                  <span className="form-section-icon">
                    <Globe size={17} />
                  </span>
                  <div>
                    <div className="form-section-title">{t('Domains')}</div>
                    <div className="form-section-sub">{t('Die Adressen des Eintrags und seine Gruppe.')}</div>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">{t('Gruppe')}</label>
                  <Select
                    value={scope}
                    onChange={setScope}
                    options={scopeOptions.map((s) => ({ value: s.name, label: s.label }))}
                    disabled={scopeOptions.length === 0}
                  />
                  {scopeOptions.length === 0 && (
                    <span className="form-hint">
                      {t('Noch keine Gruppe. Gruppen legt man in der Übersicht an.')}
                    </span>
                  )}
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
                    {t('Hauptdomain')}
                    <InfoHint
                      text={t(
                        editingId
                          ? 'Nach ihr heißt das Zertifikat, und sie steht im Host-Header des Healthchecks. Die Dienst-ID bleibt, auch wenn sich die Hauptdomain ändert.'
                          : 'Nach ihr heißt das Zertifikat, sie steht im Host-Header des Healthchecks, und aus ihr ergibt sich die Dienst-ID, die ACL und Backend benennt.'
                      )}
                    />
                  </label>
                  <div className="form-list-row">
                    <input
                      className="form-input"
                      value={domains[0] ?? ''}
                      onChange={(e) =>
                        setDomains(domains.map((d, i) => (i === 0 ? e.target.value : d)))
                      }
                      placeholder={'kunde.example'}
                      autoComplete="off"
                    />
                    {renderLockMark(domains[0] ?? '')}
                  </div>
                  {/* Nur lesend: sie benennt ACL und Backend in der Datei und
                      ändert sich nicht mehr. Gebraucht wird sie für die API und
                      beim Nachsehen in haproxy.cfg. */}
                  {editingId && (
                    <span className="form-hint">
                      {rich('Dienst-ID: {id}', { id: <code>{editingId}</code> })}
                    </span>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label">{t('Weitere Domains')}</label>
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
                              placeholder={'www.kunde.example'}
                              autoComplete="off"
                            />
                            {renderLockMark(domain)}
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon"
                              data-tooltip={t('Zeile entfernen')}
                              aria-label={t('Zeile entfernen')}
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
                      {t('Domain hinzufügen')}
                    </button>
                  </div>
                </div>

                {surface && (
                  <div className="form-note">
                    <ShieldCheck size={14} />
                    <span>
                      {rich(
                        'Über dieses Ziel ist die Oberfläche von HAPM erreichbar ({url}). Die Domain {host} bleibt deshalb in der Liste. Die Adresse lässt sich unter Allgemein ändern.',
                        { url: surface.url, host: <code>{surface.host}</code> }
                      )}
                    </span>
                  </div>
                )}

                {uploadMissing && (
                  <div className="alert alert-warning">
                    <span>
                      {rich(
                        'Diese Installation stellt keine Zertifikate selbst aus, und für diese Domains liegt keins vor. Laden Sie es zuerst unter {page} hoch.',
                        { page: <Link href="/reverse-proxy/zertifikate">{t('Zertifikate')}</Link> }
                      )}
                    </span>
                  </div>
                )}
                {certificateDue && certificatePresent && (uploadOnly || needsDnsChallenge(input.domains, selectedProxy?.exposure ?? 'public', selectedProxy?.httpChallenge ?? false)) && (
                  <p className="form-hint">{t('Ein Zertifikat für diese Domains liegt vor. Es wird keins beantragt.')}</p>
                )}

                {/* ── DNS-Hook ──
                    Nur da, wenn eine Wildcard im Spiel ist. Ein Feld, das immer
                    dasteht und meistens nichts tut, ist keine Auskunft; dieses
                    sagt schon durch sein Erscheinen, dass die Challenge jetzt
                    über DNS läuft. */}
                {dnsHookNeeded && (
                  <div className="form-group">
                    <label className="form-label">
                      {t(hasWildcard ? 'DNS-Hook für die Wildcard' : 'Zertifikat über DNS')}
                    </label>
                    {dnsHookMissing ? (
                      <div className="alert alert-warning">
                        {t(
                          hasWildcard
                            ? 'Es ist kein DNS-Hook von acme.sh eingerichtet. Eine Wildcard lässt Let’s Encrypt nur über DNS-01 ausstellen.'
                            : 'Es ist kein DNS-Hook von acme.sh eingerichtet. In dieser internen Installation wird jedes Zertifikat über DNS-01 ausgestellt.'
                        )}{' '}
                        {t('Die Zugangsdaten der Zone werden unter Reverse-Proxy, Einstellungen hinterlegt: einmal dort eingetragen, merkt acme.sh sie sich für jede Erneuerung.')}
                      </div>
                    ) : (
                      <>
                        {dnsHookSelectShown && (
                          <Select
                            value={effectiveDnsHook}
                            onChange={setDnsHook}
                            options={hookOptions}
                          />
                        )}
                        {!hasWildcard && (
                          <span className="form-hint">
                            {dnsHookSelectShown
                              ? t('Interne Installation: das Zertifikat wird über DNS ausgestellt.')
                              : t('Interne Installation: ausgestellt wird über {hook}.', { hook: effectiveDnsHook })}
                          </span>
                        )}
                      </>
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
                    Je Domain eine Zeile: worauf sie gerade auflöst, und liegt
                    sie in einer Zone, die hier eingerichtet ist, der Schalter
                    für den Eintrag. Eine Wildcard ohne Zone fehlt: sie hat
                    keine eigene Adresse, und es gäbe nichts zu entscheiden. */}
                {(dnsShown.length > 0 || dnsPending.length > 0) && (
                  <div className="form-group">
                    {/* Flex und nicht einfach nebeneinander: das Icon säße
                        sonst auf der Textgrundlinie und hinge unter der
                        Beschriftung heraus. Dasselbe Muster wie in
                        BackupCheckSchedule. */}
                    <label
                      className="form-label"
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      {t('DNS-Einträge')}
                      {dnsRows.length > 0 && (
                        <InfoHint
                          text={t(
                            'Der Eintrag zeigt auf die Domain der Zone selbst, deren A-Eintrag auf diesen Server zeigt. Beim Entfernen des Ziels wird angeboten, ihn mitzunehmen.'
                          )}
                        />
                      )}
                    </label>
                    <div className="form-list">
                      {dnsPending.map((domain) => (
                        <div className="form-list-row" key={domain}>
                          <span className="hapm-dns-state is-checking">
                            <Loader2 size={16} className="spin" />
                          </span>
                          <span className="hapm-dns-text">
                            <span>{domain}</span>
                            <span className="form-hint">{t('DNS wird abgefragt…')}</span>
                          </span>
                        </div>
                      ))}
                      {dnsPending.length === 0 && dnsShown.map((match) => {
                        const resolution = resolutionText(match);
                        if (!match.zone) {
                          const verdict = match.resolution?.verdict ?? 'unknown';
                          return (
                            <div className="form-list-row" key={match.domain}>
                              <span className={DNS_STATE_CLASS[verdict]}>
                                {verdict === 'matches' ? (
                                  <CircleCheck size={16} />
                                ) : verdict === 'unresolved' ? (
                                  <CircleDashed size={16} />
                                ) : (
                                  <CircleAlert size={16} />
                                )}
                              </span>
                              <span className="hapm-dns-text">
                                <span>{match.domain}</span>
                                {resolution && <span className="form-hint">{resolution}</span>}
                              </span>
                            </div>
                          );
                        }

                        const zoneName = match.zone.name;
                        // Vier Zustände, und jeder sagt etwas anderes darüber,
                        // ob hier noch eine Entscheidung offen ist.
                        const settled = !!match.existing?.managed;
                        const foreign = !!match.existing && !match.existing.managed;
                        const unreadable = !!match.error;
                        const impossible = !match.plan;
                        const locked = settled || foreign || unreadable || impossible;

                        const fqdn = match.plan?.fqdn ?? '';
                        const tooltip = settled
                          ? t('DNS-Zone {zone}: {fqdn} ist bereits als CNAME auf {zone} eingerichtet.', { zone: zoneName, fqdn })
                          : foreign
                            ? t('Dort steht ein {type}-Eintrag auf {content}. Er wird nicht angefasst.', {
                                type: match.existing?.type ?? '',
                                content: match.existing?.content ?? '',
                              })
                            : unreadable
                              ? t('Die Zone {zone} ist gerade nicht lesbar: {error}', {
                                  zone: zoneName,
                                  error: match.error ? t(match.error) : '',
                                })
                              : impossible
                                ? (match.blocked ? t(match.blocked) : '')
                                : match.zone.provider === 'cloudflare'
                                  ? t('Legt {fqdn} als CNAME auf {zone} an, ohne Cloudflare-Proxy.', { fqdn, zone: zoneName })
                                  : t('Legt {fqdn} als CNAME auf {zone} an.', { fqdn, zone: zoneName });

                        return (
                          <label className="form-list-row" key={match.domain} data-tooltip={tooltip}>
                            <span className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={settled || (!locked && dnsChosen(match))}
                                disabled={locked}
                                onChange={(e) => {
                                  // Den Wert JETZT lesen, nicht in der Update-Funktion: React setzt das
                                  // kontrollierte Feld nach dem Ereignis auf den alten Stand zurück, und
                                  // läuft die Funktion erst danach, läse sie wieder „an“. Dann blieb der
                                  // Eintrag gewählt, obwohl der Haken herausgenommen war.
                                  const checked = e.target.checked;
                                  setDnsWanted((current) => ({ ...current, [match.domain]: checked }));
                                }}
                                aria-label={t('DNS-Eintrag für {domain}', { domain: match.domain })}
                              />
                              <span className="toggle-slider" />
                            </span>
                            <span className="hapm-dns-text">
                              <span>
                                {settled
                                  ? t('{domain} steht bereits in {zone}', { domain: match.domain, zone: zoneName })
                                  : foreign
                                    ? t('{domain}: dort steht ein {type}-Eintrag', {
                                        domain: match.domain,
                                        type: match.existing?.type ?? '',
                                      })
                                    : unreadable
                                      ? t('{domain}: Zone {zone} nicht lesbar', { domain: match.domain, zone: zoneName })
                                      : impossible
                                        ? t('{domain}: hier nicht möglich', { domain: match.domain })
                                        : t('{domain} als CNAME in Zone {zone} setzen', { domain: match.domain, zone: zoneName })}
                              </span>
                              {resolution && <span className="form-hint">{resolution}</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {hasWildcard && (
                  <div className="form-note">
                    <Info size={14} />
                    <span>
                      {rich(
                        'Eine Wildcard deckt genau eine Ebene ab: {one} ja, {two} nein, {apex} selbst auch nicht: die gehört als eigene Zeile dazu.',
                        {
                          one: <code>{'app.kunde.example'}</code>,
                          two: <code>{'a.b.kunde.example'}</code>,
                          apex: <code>{'kunde.example'}</code>,
                        }
                      )}
                    </span>
                  </div>
                )}
              </section>
              </>)}

              {tab === 'ziel' && (<>
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
                    <div className="form-label-row">
                      <div className="form-section-title">
                        {t(redirecting ? 'Weiterleitung' : balancing ? 'Ziele' : 'Ziel')}
                      </div>
                      {redirecting && (
                        <InfoHint
                          text={t(
                            'Pfad-Regeln, Header, Healthcheck und Verteilverfahren gehören zu einem Eintrag mit Zielen. Wer sie braucht, legt einen Reverse-Proxy oder eine Lastverteilung an.'
                          )}
                        />
                      )}
                    </div>
                    <div className="form-section-sub">
                      {t(
                        redirecting
                          ? 'Die Domains werden nicht bedient, sondern woanders hingeschickt.'
                          : balancing
                            ? 'Die Anfragen werden auf mehrere Ziele verteilt.'
                            : 'Wohin alles geht, was auf keine Pfad-Regel passt.'
                      )}
                    </div>
                  </div>
                </div>

                {redirecting ? (
                  <>
                    <div className="form-group">
                      <label className="form-label">
                        {t('Zieladresse')}
                        <InfoHint
                          text={t(
                            'Ein Zertifikat wird trotzdem ausgestellt: die Weiterleitung antwortet über HTTPS, und der Browser prüft das Zertifikat, bevor er die Antwort liest.'
                          )}
                        />
                      </label>
                      <input
                        className="form-input"
                        value={redirectTo}
                        onChange={(e) => setRedirectTo(e.target.value)}
                        placeholder={'https://example.org'}
                        autoComplete="off"
                        spellCheck={false}
                        required
                      />
                      <span className="form-hint">{t('Mit Schema.')}</span>
                    </div>

                    <div className="form-subsection">
                      <div className="form-subsection-head">
                        <div>
                          <div className="form-section-title">{t('Pfad übernehmen')}</div>
                          <div className="form-section-sub">
                            {t('Aus, und der Aufruf landet immer auf der Zieladresse selbst.')}
                          </div>
                        </div>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={redirectKeepPath}
                            onChange={(e) => setRedirectKeepPath(e.target.checked)}
                            aria-label={t('Pfad übernehmen')}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                      <div className="form-note">
                        <Info size={14} />
                        <span>
                          {redirectKeepPath
                            ? rich('{from} geht auf {to}. Für eine Domain, die umgezogen ist.', {
                                from: <code>{domains[0]?.trim() || 'domain.example'}{'/preise'}</code>,
                                to: <code>{redirectTo.trim() || 'https://ziel.example'}{'/preise'}</code>,
                              })
                            : rich('{from} geht auf {to}. Für eine Domain, die nur auf eine andere zeigen soll.', {
                                from: <code>{domains[0]?.trim() || 'domain.example'}{'/preise'}</code>,
                                to: <code>{redirectTo.trim() || 'https://ziel.example'}</code>,
                              })}
                        </span>
                      </div>
                    </div>

                    <div className="form-subsection">
                      <div className="form-subsection-head">
                        <div>
                          <div className="form-section-title">{t('Dauerhaft (301)')}</div>
                          <div className="form-section-sub">
                            {t('Aus heißt 302: vorübergehend, und jederzeit zurücknehmbar.')}
                          </div>
                        </div>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={redirectPermanent}
                            onChange={(e) => setRedirectPermanent(e.target.checked)}
                            aria-label={t('Dauerhaft (301)')}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                      {/* Eine Folge und kein Hinweis: sie steht als Warnung da. */}
                      {redirectPermanent && (
                        <div className="alert alert-warning">
                          {t('Ein Browser merkt sich eine 301 und ruft die alte Adresse nicht mehr auf. Wer sie später ändert, erreicht damit niemanden mehr, der schon einmal hier war, bis dessen Cache abläuft.')}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                <>
                <div className="form-list">
                  <div className="form-list-head">
                    <span style={{ flex: 1 }}>{t('Adresse')}</span>
                    <span className="hapm-target-pick" />
                    {/* Die Spalte gibt es nur bei der Lastverteilung: ein
                        einzelnes Ziel bekommt ohnehin alles, und ein Feld ohne
                        Frage füllt irgendwann jemand aus. */}
                    {balancing && <span style={{ width: 76 }}>{t('Gewicht')}</span>}
                    <span style={{ width: 34 }} />
                  </div>
                  {backends.map((backend, index) => (
                    <div className="form-list-row" key={index}>
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
                      <SavedTargetPick
                        targets={savedTargets}
                        address={backend.target}
                        onPick={(target) =>
                          setBackends(backends.map((b, i) => (i === index ? { ...b, target } : b)))
                        }
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
                          aria-label={t('Gewicht von Ziel {number}', { number: index + 1 })}
                        />
                      )}
                      {/* Beim Reverse-Proxy gibt es genau eine Zeile, also
                          nichts zu entfernen. Der Knopf fehlt dort ganz, statt
                          dauerhaft gesperrt dazustehen. */}
                      {balancing && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          data-tooltip={t('Zeile entfernen')}
                          aria-label={t('Zeile entfernen')}
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
                      {t('Ziel hinzufügen')}
                    </button>
                  </div>
                )}
                <span className="form-hint">
                  {t('Adresse und Port, wie HAProxy sie erreicht, meist im privaten Netz.')}
                </span>
                {/* Der eine Weg von hier ins größere Formular. Ohne ihn wäre
                    ein zweites Ziel hinter einer laufenden Domain nur über
                    Löschen und Neuanlegen zu haben. */}
                {!balancing && editingId && onSwitchKind && (
                  <div>
                    <div className="form-label-row">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => onSwitchKind('balance')}
                      >
                        <Scale size={14} />
                        {t('Zweites Ziel: auf Lastverteilung umstellen')}
                      </button>
                      <InfoHint
                        text={t('Öffnet dasselbe Ziel im Lastverteilungs-Formular, mit Verfahren, Gewichtung und Sitzungsbindung.')}
                      />
                    </div>
                    {/* Die Folge bleibt sichtbar: sie gilt vor dem Klick. */}
                    <span className="form-hint">{t('Nicht gespeicherte Eingaben gehen dabei verloren.')}</span>
                  </div>
                )}
                {balancing && (
                  <span className="form-hint">
                    {rich(
                      'Das Gewicht ist der Anteil eines Ziels im Verhältnis zu den anderen: 2 gegen 1 heißt doppelt so viele Anfragen. Leer heißt, dass keine {weight}-Angabe geschrieben wird und HAProxys Vorgabe gilt (alle gleich). {zero} nimmt ein Ziel aus der Verteilung, ohne seine gebundenen Sitzungen abzuwerfen: der Weg, einen Server in Ruhe herauszunehmen.',
                      { weight: <code>{'weight'}</code>, zero: <strong>0</strong> }
                    )}
                  </span>
                )}

                <div className="form-subsection">
                  <BackendTlsPick
                    value={backendTls}
                    onChange={setBackendTls}
                    label={balancing ? msgid('Ziele sprechen') : msgid('Ziel spricht')}
                    targets={backends.map((b) => b.target)}
                    verifyUnsupported={verifyUnsupported}
                  />
                </div>

                {/* ── Verfahren und Bindung ──
                    Nur im Lastverteilungs-Formular. Bei einem Ziel gibt es
                    nichts zu verteilen und nichts zu binden; die Frage stünde
                    dort als Feld, das immer dieselbe Antwort hat. */}
                {balancing && (
                <div className="form-subsection">
                  <div className="form-group">
                    <div className="form-label-row">
                      <label className="form-label">{t('Verteilverfahren')}</label>
                      <InfoHint
                        text={
                          balance
                            ? t(BALANCE_HINTS[balance])
                            : t('Es wird keine balance-Zeile geschrieben. Dann gilt, was im defaults-Block der Konfiguration steht, üblicherweise Round Robin. Was dort wirklich steht, weiß dieses Formular nicht, deshalb wird nichts hingeschrieben.')
                        }
                      />
                    </div>
                    <Select
                      value={balance ?? ''}
                      onChange={(v) => setBalance(v === '' ? null : (v as HaproxyBalance))}
                      options={[
                        { value: '', label: t('Vorgabe der Konfiguration') },
                        ...HAPROXY_BALANCE.map((b) => ({ value: b, label: t(BALANCE_LABELS[b]) })),
                      ]}
                    />
                  </div>

                  <div className="form-subsection-head">
                    <div>
                      <div className="form-label-row">
                        <div className="form-section-title">{t('Sitzungsbindung')}</div>
                        {/* Die Zeile aus der Konstante und nicht abgetippt: zwei Quellen
                            für dieselbe Zeile laufen auseinander. */}
                        <InfoHint
                          text={t(
                            'HAProxy setzt einen eigenen Cookie und nimmt ihn aus der Anfrage, bevor sie beim Ziel ankommt. Nötig für Anwendungen, die Sitzungen im Arbeitsspeicher halten. Teilen die Ziele ihre Sitzungen (gemeinsame Datenbank, Redis), braucht es sie nicht. In der Konfiguration: „{line}“ im Backend und „cookie <Servername>“ an jeder server-Zeile.',
                            { line: STICKY_BACKEND_LINE }
                          )}
                        />
                      </div>
                      <div className="form-section-sub">
                        {t(
                          sticky
                            ? 'Ein Besucher bleibt bei dem Ziel, auf dem er gelandet ist.'
                            : 'Jede Anfrage kann bei einem anderen Ziel landen.'
                        )}
                      </div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={sticky}
                        onChange={(e) => setSticky(e.target.checked)}
                        aria-label={t('Sitzungsbindung')}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                </div>
                )}

                <div className="form-subsection">
                  <div className="form-subsection-head">
                    <div>
                      <div className="form-section-title">{t('Healthcheck')}</div>
                      <div className="form-section-sub">
                        {t('HAProxy prüft die Ziele und nimmt ein totes aus dem Betrieb.')}
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
                        aria-label={t('Healthcheck')}
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
                        {rich(
                          'Aus, weil die Hauptdomain eine Wildcard ist: der Check schickt sie als Host-Header, und {domain} ist kein Hostname. Das Ziel antwortete mit 404, und HAProxy nähme es aus dem Betrieb. Mit einer echten Domain an erster Stelle geht der Schalter wieder.',
                          { domain: <code>{domains[0]?.trim()}</code> }
                        )}
                      </span>
                    </div>
                  ) : (
                    healthcheck && (
                      <div className="form-note">
                        <Info size={14} />
                        <span>
                          {rich(
                            'GET auf {path}, erwartet wird 200-399, Host-Header {host}. Antwortet ein Ziel anders, nimmt HAProxy es aus dem Betrieb.',
                            { path: <code>/</code>, host: <code>{domains[0]?.trim() || t('Hauptdomain')}</code> }
                          )}
                        </span>
                      </div>
                    )
                  )}
                </div>
                </>
                )}
              </section>
              </>)}

              {tab === 'schutz' && (<>
              {/* ── Zugriff ──
                  Eine Karte mit einer Frage zuerst. Was die gewählte Antwort
                  braucht (Adressen, ein Passwort, die Auswahl der Domains),
                  steht darunter und nur dann. */}
              <section className="form-section">
                <div className="form-section-head">
                  <span className="form-section-icon">
                    <Lock size={17} />
                  </span>
                  <div>
                    <div className="form-section-title">{t('Zugriff')}</div>
                    <div className="form-section-sub">
                      {t(
                        access === 'open'
                          ? 'Jede Adresse kommt durch.'
                          : access === 'ip'
                            ? 'Nur die Admin-IPs kommen durch, alle anderen bekommen 403.'
                            : 'Besucher sehen eine Passwortabfrage.'
                      )}
                    </div>
                  </div>
                </div>

                <div className="form-group">
                  <div>
                    <div className="segmented" role="group" aria-label={t('Zugriff')}>
                      {(['open', 'ip', 'password'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={access === mode ? 'active' : ''}
                          aria-pressed={access === mode}
                          disabled={accessBlocked[mode]}
                          onClick={() => setAccess(mode)}
                        >
                          {t(ACCESS_LABELS[mode])}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Warum eine Art nicht zur Wahl steht, steht sichtbar da:
                      ein Tooltip auf einem gesperrten Knopf erscheint nicht. */}
                  {adminIps.length === 0 && (
                    <span className="form-hint">
                      {t(
                        access === 'ip'
                          ? 'Es sind keine Admin-IPs hinterlegt. Ohne Adressen kommt niemand hinein.'
                          : 'Für „Nur Admin-IPs“ sind keine Adressen hinterlegt.'
                      )}{' '}
                      <Link href="/reverse-proxy/einstellungen?bereich=zugriff">{t('Einstellungen öffnen')}</Link>
                    </span>
                  )}
                  {!passwordPossible && (
                    <span className="form-hint">
                      {t('Die Passwortsperre braucht HAProxy 2.4 oder neuer. Hier läuft {version}.', {
                        version: shortVersion(proxyVersion ?? ''),
                      })}
                    </span>
                  )}
                </div>

                {access === 'ip' && adminIps.length > 0 && (
                  <div className="form-note">
                    <ShieldCheck size={14} />
                    <span>
                      {plural(adminIps.length, {
                        one: 'Eine Adresse ist hinterlegt',
                        other: '{count} Adressen sind hinterlegt',
                      })}
                      {adminIps.length <= ADMIN_IPS_SHOWN && (
                        <>
                          : <code>{adminIps.join(', ')}</code>
                        </>
                      )}
                      . {t('Die Liste gilt für alle Ziele.')}{' '}
                      <Link href="/reverse-proxy/einstellungen?bereich=zugriff">{t('Einstellungen öffnen')}</Link>
                    </span>
                  </div>
                )}

                {access === 'password' && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="service-lock-password">
                      {t(hasStoredPassword ? 'Neues Passwort' : 'Passwort')}
                    </label>
                    <div className="form-list-row">
                      <input
                        id="service-lock-password"
                        className="form-input mono"
                        value={lockPassword}
                        onChange={(e) => setLockPassword(e.target.value)}
                        placeholder={hasStoredPassword ? t('Leer lassen: das bisherige bleibt') : ''}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        data-tooltip-pos="left"
                        data-tooltip={t('Vorschlag erzeugen')}
                        onClick={() => setLockPassword(suggestPassword())}
                        aria-label={t('Vorschlag erzeugen')}
                      >
                        <RefreshCw size={16} />
                      </button>
                    </div>
                    <span className="form-hint">
                      {hasStoredPassword
                        ? t('Ein neues Passwort meldet alle ab, die schon durchgelassen sind.')
                        : t('Mindestens {min} Zeichen. Jetzt notieren: gespeichert wird nur ein Hash.', {
                            min: LOCK_PASSWORD_MIN,
                          })}
                    </span>
                  </div>
                )}

                {/* Bei einer Domain gibt es nichts zu wählen. */}
                {access !== 'open' && lockChoices.length > 1 && (
                  <div className="form-group">
                    <label className="form-label">{t('Für welche Domains')}</label>
                    <div>
                      <div className="segmented" role="group" aria-label={t('Für welche Domains')}>
                        <button
                          type="button"
                          className={lockAll ? 'active' : ''}
                          aria-pressed={lockAll}
                          onClick={() => setLockAll(true)}
                        >
                          {t('Alle Domains')}
                        </button>
                        <button
                          type="button"
                          className={lockAll ? '' : 'active'}
                          aria-pressed={!lockAll}
                          onClick={() => setLockAll(false)}
                        >
                          {t('Nur einzelne')}
                        </button>
                      </div>
                    </div>
                    {!lockAll && (
                      <div className="form-list">
                        {lockChoices.map((domain) => (
                          <label className="form-list-row" key={domain}>
                            <span className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={lockedDomains.includes(domain)}
                                onChange={() => toggleDomainLock(domain)}
                                aria-label={t('{domain} sperren', { domain })}
                              />
                              <span className="toggle-slider" />
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>{domain}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>
              </>)}
            </div>

            <div className="form-col">
              {tab === 'ziel' && (<>
              {/* Bei einer Weiterleitung gibt es kein Backend, auf das eine
                  Pfad-Regel zeigen könnte. Der Abschnitt fällt deshalb weg,
                  statt gesperrt dazustehen: gesperrt läse er sich wie ein
                  fehlendes Recht und nicht wie eine Frage, die sich hier gar
                  nicht stellt. */}
              {redirecting && (
                <div className="form-note">
                  <Info size={14} />
                  <span>
                    {t('Eine Weiterleitung hat kein Backend, also weder Pfad-Regeln noch Header.')}
                  </span>
                </div>
              )}
              </>)}
              {tab === 'erweitert' && (<>
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
                    <div className="form-section-title">{t('Pfad-Regeln')}</div>
                    <div className="form-section-sub">
                      {t(
                        routes.length === 0
                          ? 'Alles geht an das Standard-Backend. Das ist der Normalfall.'
                          : 'Einzelne Pfade auf einen anderen Port desselben Ziels.'
                      )}
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
                    <strong>{t('Keine Pfad-Regeln')}</strong>
                    <span>
                      {t('Nötig, wenn ein Pfad auf einen anderen Port desselben Ziels gehört.')}
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
                          <label className="form-label">{t('Name')}</label>
                          <input
                            className="form-input"
                            value={route.name}
                            onChange={(e) => update({ name: e.target.value })}
                            placeholder={'terminal'}
                            autoComplete="off"
                          />
                          <span className="form-hint">
                            {editingId
                              ? t('Backend und ACL: {name}', { name: `${editingId}_${route.name || 'name'}` })
                              : t('Nur a-z, 0-9 und _. Er wird Teil des Backend-Namens.')}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          data-tooltip={t('Regel entfernen')}
                          aria-label={t('Regel entfernen')}
                          onClick={() => setRoutes(routes.filter((_, i) => i !== routeIndex))}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>

                      <div className="form-group">
                        <div className="form-label-row">
                          <label className="form-label">{t('Pfade')}</label>
                          <InfoHint text={t('Verglichen wird der Anfang des Pfads: /app trifft auch /app/socket.')} />
                        </div>
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
                                placeholder={'/terminal/ws'}
                                autoComplete="off"
                              />
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon"
                                data-tooltip={t('Zeile entfernen')}
                                aria-label={t('Zeile entfernen')}
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
                            {t('Pfad hinzufügen')}
                          </button>
                        </div>
                      </div>

                      <div className="form-group">
                        <label className="form-label">{t('Ziele dieser Regel')}</label>
                        <div className="form-list">
                          {route.servers.map((server, serverIndex) => (
                            <div className="form-list-row" key={serverIndex}>
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
                              <SavedTargetPick
                                targets={savedTargets}
                                address={server.target}
                                onPick={(target) =>
                                  update({
                                    servers: route.servers.map((s, i) => (i === serverIndex ? { ...s, target } : s)),
                                  })
                                }
                              />
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon"
                                data-tooltip={t('Zeile entfernen')}
                                aria-label={t('Zeile entfernen')}
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
                              update({ servers: [...route.servers, { ...EMPTY_ROUTE_SERVER }] })
                            }
                          >
                            <Plus size={14} />
                            {t('Ziel hinzufügen')}
                          </button>
                        </div>
                      </div>

                      <BackendTlsPick
                        value={route.backendTls}
                        onChange={(value) => update({ backendTls: value })}
                        label={msgid('Ziele dieser Regel sprechen')}
                        targets={route.servers.map((s) => s.target)}
                        verifyUnsupported={verifyUnsupported}
                      />

                      <div className="form-subsection-head">
                        <div>
                          <div className="form-label-row">
                            <div className="form-section-title">{t('Verbindungsprüfung')}</div>
                            <InfoHint
                              text={t(
                                'Eine WebSocket-Strecke antwortet auf ein GET auf / nicht mit 200. Deshalb hier kein HTTP-Check, sonst nähme HAProxy sie dauerhaft aus dem Betrieb.'
                              )}
                            />
                          </div>
                          <div className="form-section-sub">
                            {t('Nur `check` auf der server-Zeile, kein HTTP-Check.')}
                          </div>
                        </div>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={route.check}
                            onChange={(e) => update({ check: e.target.checked })}
                            aria-label={t('Verbindungsprüfung')}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                    </div>
                  );
                })}

                {routesOpen && (
                  <div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() =>
                        setRoutes([
                          ...routes,
                          { ...EMPTY_ROUTE, paths: [''], servers: [{ ...EMPTY_ROUTE_SERVER }] },
                        ])
                      }
                    >
                      <Plus size={14} />
                      {t('Pfad-Regel hinzufügen')}
                    </button>
                  </div>
                )}
              </section>
              )}
              </>)}

              {/* ── Header und Verbindung ──
                  Was früher ein Preset war, einzeln: jede Zeile hier ist eine
                  Zeile im Backend. Zugeklappt und im Normalfall leer, wie die
                  Pfad-Regeln. Bei einer Weiterleitung fehlt die Karte: ihre
                  Antwort erzeugt HAProxy selbst, und darauf wirken diese
                  Zeilen nicht. */}
              {tab === 'schutz' && (<>
              {/* Ohne CrowdSec auf dieser Installation gibt es die Frage nicht.
                  Ein Ziel, das die Zeilen trotzdem trägt (Datei von früher),
                  zeigt den Schalter, damit es sie loswerden kann. */}
              {!redirecting && (selectedProxy?.crowdsecInStack || edit?.service.crowdsec) && (
                <section className="form-section">
                  <div className="form-subsection-head">
                    <div>
                      <div className="form-label-row">
                        <div className="form-section-title">
                          <BrandLogo brand="crowdsec" />
                          {t('CrowdSec (WAF)')}
                        </div>
                        <InfoHint
                          text={t(
                            'CrowdSec prüft jede Anfrage an dieses Ziel: bekannte Angriffe (WAF) und Adressen, die gesperrt sind. Abgelehnt wird mit 403. Antwortet CrowdSec nicht, gehen Anfragen durch. Sperren und Freigaben stehen unter Reverse-Proxy, CrowdSec.'
                          )}
                        />
                      </div>
                      <div className="form-section-sub">
                        {!selectedProxy?.crowdsecInStack
                          ? t('CrowdSec ist bei dieser Installation abgeschaltet.')
                          : selectedProxy.crowdsecGlobal && !crowdsec
                            ? t('Gilt schon für alle Ziele.')
                            : selectedProxy.crowdsecGlobal
                              ? t('Gilt schon für alle Ziele. Der eigene Schalter ist überflüssig.')
                              : t(crowdsec ? 'Anfragen an dieses Ziel prüft CrowdSec.' : 'Anfragen an dieses Ziel prüft CrowdSec nicht.')}
                      </div>
                    </div>
                    {/* Wie „Lange Verbindungen“: gilt es global, steht der
                        Schalter an und gesperrt, und `crowdsec` bleibt false. */}
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={crowdsec || !!selectedProxy?.crowdsecGlobal}
                        disabled={(!!selectedProxy?.crowdsecGlobal && !crowdsec) || (!selectedProxy?.crowdsecInStack && !crowdsec)}
                        onChange={(e) => setCrowdsec(e.target.checked)}
                        aria-label={t('CrowdSec (WAF)')}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                </section>
              )}
              </>)}

              {tab === 'erweitert' && (<>
              {!redirecting && (
              <section className="form-section">
                <button
                  type="button"
                  className="form-section-head form-section-toggle"
                  onClick={() => setAddonsOpen((open) => !open)}
                  aria-expanded={addonsOpen}
                >
                  <span className="form-section-icon">
                    <SlidersHorizontal size={17} />
                  </span>
                  <div>
                    <div className="form-section-title">{t('Header und Verbindung')}</div>
                    <div className="form-section-sub">
                      {t(
                        addonCount === 0
                          ? 'Nichts gesetzt. Das ist der Normalfall.'
                          : 'Feste Header und lange Verbindungen für dieses Ziel.'
                      )}
                    </div>
                  </div>
                  <span className="form-section-count">{addonCount}</span>
                  {addonsOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>

                {addonsOpen &&
                  (['response', 'request'] as const).map((direction) => (
                    <div className="form-group" key={direction}>
                      <div className="form-label-row">
                        <label className="form-label">
                          {t('Header der {direction}', { direction: t(HEADER_DIRECTION_LABELS[direction]) })}
                        </label>
                        <InfoHint
                          text={t(
                            direction === 'response'
                              ? 'Gehen mit jeder Antwort dieses Ziels an den Besucher. Der Wert kommt wörtlich an: Ausdrücke wie %[src] werden nicht ausgewertet.'
                              : 'Gehen mit jeder Anfrage an das Ziel. Der Wert kommt wörtlich an: Ausdrücke wie %[src] werden nicht ausgewertet.'
                          )}
                        />
                      </div>
                      {headers[direction].length > 0 && (
                        <div className="form-list">
                          <div className="form-list-head">
                            <span style={{ flex: '0 0 36%' }}>{t('Name')}</span>
                            <span style={{ flex: 1 }}>{t('Wert')}</span>
                            <span style={{ width: 34 }} />
                          </div>
                          {headers[direction].map((rule, index) => {
                            const note = globalHeaderNote(direction, rule.name);
                            return (
                              <Fragment key={index}>
                                <div className="form-list-row">
                                  <input
                                    className="form-input mono"
                                    style={{ flex: '0 0 36%', minWidth: 0 }}
                                    value={rule.name}
                                    onChange={(e) =>
                                      updateHeader(direction, index, { name: e.target.value })
                                    }
                                    placeholder={
                                      direction === 'response' ? 'X-Frame-Options' : 'X-Api-Version'
                                    }
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-label={t('Name von Header {number}', { number: index + 1 })}
                                  />
                                  <input
                                    className="form-input mono"
                                    value={rule.value}
                                    onChange={(e) =>
                                      updateHeader(direction, index, { value: e.target.value })
                                    }
                                    placeholder={direction === 'response' ? 'SAMEORIGIN' : '2'}
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-label={t('Wert von Header {number}', { number: index + 1 })}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-icon"
                                    data-tooltip-pos="left"
                                    data-tooltip={t('Zeile entfernen')}
                                    aria-label={t('Zeile entfernen')}
                                    onClick={() =>
                                      setHeaders((current) => ({
                                        ...current,
                                        [direction]: current[direction].filter((_, i) => i !== index),
                                      }))
                                    }
                                  >
                                    <X size={16} />
                                  </button>
                                </div>
                                {note && <span className="form-hint">{note}</span>}
                              </Fragment>
                            );
                          })}
                        </div>
                      )}
                      <div className="hapm-inline-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={headers[direction].length >= HEADERS_MAX}
                          onClick={() =>
                            setHeaders((current) => ({
                              ...current,
                              [direction]: [...current[direction], { name: '', value: '' }],
                            }))
                          }
                        >
                          <Plus size={14} />
                          {t('Header hinzufügen')}
                        </button>
                        {/* Vorschläge und kein Preset: ein Klick fügt Zeilen
                            ein, die danach gewöhnliche Zeilen sind. */}
                        {direction === 'response' &&
                          HEADER_SUGGESTIONS.map((suggestion) => (
                            <button
                              key={suggestion.label}
                              type="button"
                              className="btn btn-ghost btn-sm"
                              data-tooltip={t(suggestion.hint)}
                              onClick={() => insertHeaders('response', suggestion.headers)}
                            >
                              {suggestion.label}
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}

                {addonsOpen && (
                  <div className="form-subsection">
                    <div className="form-subsection-head">
                      <div>
                        <div className="form-label-row">
                          <div className="form-section-title">{t('Lange Verbindungen')}</div>
                          {/* Die Zeile aus der Konstante und nicht abgetippt. */}
                          <InfoHint
                            text={t(
                              'Für WebSocket, Terminal und Live-Ansicht. Ohne den Schalter beendet HAProxy eine offene Verbindung nach der Zeit aus dem defaults-Block, üblicherweise nach einer Minute ohne Daten. In der Konfiguration: „{line}“ in jedem Backend des Eintrags, auch in denen der Pfad-Regeln.',
                              { line: TUNNEL_LINE }
                            )}
                          />
                        </div>
                        <div className="form-section-sub">
                          {globalTunnel && !tunnel
                            ? t('Gilt schon für alle Ziele: „timeout tunnel {value}“ im defaults-Block.', { value: globalTunnel })
                            : globalTunnel
                              ? t('Gilt schon für alle Ziele. Die eigene Zeile ist überflüssig.')
                              : t(
                                  tunnel
                                    ? 'Eine offene Verbindung bleibt bis zu einer Stunde bestehen.'
                                    : 'Es gilt die Zeit aus der Grundkonfiguration.'
                                )}
                        </div>
                      </div>
                      {/* Gilt es schon global und hat das Ziel keine eigene
                          Zeile, steht der Schalter an und gesperrt: eingeschaltet
                          schriebe er dieselbe Wirkung ein zweites Mal hin. Was
                          das Formular nicht zeigt, schickt es nicht: `tunnel`
                          bleibt dabei false. */}
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={tunnel || !!globalTunnel}
                          disabled={!!globalTunnel && !tunnel}
                          onChange={(e) => setTunnel(e.target.checked)}
                          aria-label={t('Lange Verbindungen')}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                  </div>
                )}
              </section>
              )}
              </>)}

              {/* Die Meldung der Validierung steht am Fuß des Formulars, wo der
                  Blick beim Ausfüllen ohnehin endet. Hier standen einmal eine
                  Konfigurations-Übersicht und eine Checkliste — beide haben
                  wiederholt, was in den Feldern darüber schon steht. */}
              {/* Erst, wenn eine Domain dasteht: ein leeres Formular ist nicht
                  falsch ausgefüllt, sondern noch gar nicht. */}
              {inputError && domainList.length > 0 && (
                <div className="alert alert-warning">{t(inputError)}</div>
              )}
              {!inputError && surfaceError && (
                <div className="alert alert-warning">{t(surfaceError)}</div>
              )}
              {/* Hier und nicht bei der Auswahl der Domains: die verschwindet,
                  sobald nur noch eine Domain zur Wahl steht, und der Knopf
                  unten wäre ohne Grund gesperrt. */}
              {!inputError && !surfaceError && accessError && (
                <div className="alert alert-warning">{accessError}</div>
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
            {t('Abbrechen')}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            // Solange die DNS-Abfrage läuft, stammt `dnsDomains` von der vorigen
            // Eingabe: der Eintrag einer eben getippten Domain fiele beim Speichern weg.
            disabled={saving || !!inputError || !!surfaceError || !!accessError || dnsPending.length > 0}
          >
            {saving && <Loader2 size={16} className="spin" />}
            {t(editingId ? 'Speichern' : 'Anlegen')}
          </button>
        </div>
      </form>
    </div>
  </div>
  );
}
