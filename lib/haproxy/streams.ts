/**
 * TCP-Weiterleitungen: ein Port des Proxys, durchgereicht an ein Ziel
 * im Netz dahinter.
 *
 * ── Warum eine eigene Datei und nicht ein Feld an `HaproxyService` ──
 *
 * Ein Dienst in `config.ts` ist eine Domain. Er besteht aus einer Host-ACL im
 * Frontend, einer Weiche und einem Backend, er braucht ein Zertifikat, er kann
 * verdeckt werden (`shadowedBy`), und die Reihenfolge seines Blocks trägt
 * Bedeutung. Von alldem gilt hier nichts: eine TCP-Weiterleitung hat keine
 * Domain, kein Zertifikat, keine ACL und keine Nachbarn, die sie verdecken
 * könnten. Sie ist ein `listen`-Abschnitt, und der steht für sich.
 *
 * Beides in denselben Typ zu zwingen hieße, an jeder Stelle in `config.ts` ein
 * `if (stream)` einzuziehen — in der Domainprüfung, in der Einfügereihenfolge,
 * im Zertifikatspfad, im Sperrpfad.
 *
 * ── Was sie mit den Diensten teilt ──
 *
 * Die Marker-Blöcke. Eine TCP-Weiterleitung liegt im BACKENDS-Teil ihrer
 * Gruppe — dem einzigen der beiden, der außerhalb des Frontends liegt, und ein
 * `listen` innerhalb eines `frontend` wäre keine gültige Konfiguration. Sie
 * erscheint deshalb auf derselben Gruppenseite wie die Dienste, und
 * `scopeMarkers`/`scopeResolver` kommen aus `config.ts` statt hier noch einmal
 * dazustehen.
 *
 * ── Der Port ist das Gefährliche ──
 *
 * Ein doppelt vergebener Port fällt `haproxy -c` NICHT auf: die Prüfung liest
 * die Datei, sie bindet keine Sockets. Bemerkt wird er erst beim Reload, und
 * dann steht die Maschine mit einer Konfiguration da, die durch die Prüfung
 * gekommen ist. Deshalb `bindConflict` — gegen jede `bind`-Zeile der Datei,
 * bevor überhaupt etwas geschrieben wird. Was auf der Maschine sonst noch auf
 * dem Port sitzt (sshd, ein Postgres, ein Docker-Mapping), weiß diese Datei
 * nicht; danach fragt die Vorabprüfung in `provision.ts`.
 *
 * Ohne Importe außer denen aus `config.ts`, damit Formular und Route dieselbe
 * Prüfung benutzen und `tests/haproxy/streams.test.ts` jede Einfügung an echtem
 * Konfigurationstext nachrechnen kann.
 */

import {
  HaproxyConfigError,
  SECTION_KEYWORDS,
  clean,
  escapeRegExp,
  insertBeforeScopeMarker,
  isValidBackendName,
  isValidBackendTarget,
  isValidServiceId,
  isValidSourceAddress,
  isValidWeight,
  readServerParams,
  readWeight,
  scopeMarkers,
  scopeResolver,
  serverParams,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type HaproxyBackendServer,
  type HaproxyScope,
} from './config';

/* ── Das Verteilverfahren ──
 *
 * Eine eigene, kürzere Liste als bei den Diensten: `balance uri` liest den
 * angefragten Pfad, und den gibt es in `mode tcp` nicht — HAProxy lehnt die
 * Datei mit „only supported in HTTP mode" ab. Das fiele zwar schon beim
 * `haproxy -c` auf, aber eine Auswahl, die eine Möglichkeit anbietet, die
 * anschließend abgelehnt wird, ist keine Auswahl. */
export const STREAM_BALANCE = ['roundrobin', 'leastconn', 'source', 'random'] as const;
export type StreamBalance = (typeof STREAM_BALANCE)[number];

/** Dieselben etablierten Namen wie bei den Diensten, siehe `BALANCE_LABELS`.
 *  Eine eigene Karte statt eines `Pick<…>`, weil `uri` hier gar nicht
 *  existiert — ein Eintrag, der nur im Typ fehlt, stünde trotzdem in der
 *  Auswahl. */
export const STREAM_BALANCE_LABELS: Record<StreamBalance, string> = {
  roundrobin: 'Round Robin',
  leastconn: 'Least Connections',
  source: 'Source IP Hash',
  random: 'Random',
};

/** Die Erklärungen hinter dem „i". Bis auf `uri` dieselben wie bei den
 *  Diensten; `source` steht hier anders da, weil es in `mode tcp` die einzige
 *  Bindung überhaupt ist — einen Cookie gibt es ohne HTTP nicht. */
export const STREAM_BALANCE_HINTS: Record<StreamBalance, string> = {
  roundrobin:
    'balance roundrobin: jede Verbindung an das nächste Ziel, der Reihe nach. Der Normalfall.',
  leastconn:
    'balance leastconn: immer an das Ziel mit den wenigsten offenen Verbindungen. Bei TCP meistens die richtige Wahl, denn eine Verbindung bleibt hier lange offen: eine Datenbanksitzung dauert Minuten, keine Millisekunden.',
  source:
    'balance source: aus der Quell-IP wird ein Hash, und der bestimmt das Ziel. In mode tcp ist das der einzige Weg zu einer Bindung: einen Cookie gibt es ohne HTTP nicht. Sie bricht, sobald ein Ziel ausfällt oder dazukommt.',
  random: 'balance random: ein zufällig gewähltes Ziel.',
};

/** Ports, die auf dem Proxy bereits vergeben sind — nicht in der
 *  Datei, sondern durch den Zweck der Maschine. Sie stehen hier als Meldung mit
 *  Grund, damit nicht erst der Reload sagt, was los ist. */
const RESERVED_PORTS: Record<number, string> = {
  22: 'SSH. Darüber wird dieser Server verwaltet.',
  80: 'HTTP. Darüber läuft die Weiterleitung auf HTTPS.',
  443: 'HTTPS. Das ist das Frontend, in dem die Dienste liegen.',
  8888: 'Die ACME-Challenge von acme.sh. Ohne den Port lässt sich kein Zertifikat mehr erneuern.',
};

export interface HaproxyStream {
  /** Der Name des `listen`-Abschnitts. Er ist die Kennung. */
  id: string;
  /** In welchem Marker-Block der Eintrag steht. `null` heißt: außerhalb — von
   *  Hand gepflegt, wird angezeigt und nicht angefasst. */
  scope: HaproxyScope | null;
  /**
   * Der Port aus der `bind`-Zeile. `null` heißt: keine lesbare Zeile — keine,
   * mehrere, oder eine mit Parametern, die dieses Formular nicht kennt.
   *
   * Nicht 0: ein Eintrag ohne bestimmbaren Port ist unbekannt und nicht „Port
   * null".
   */
  port: number | null;
  servers: HaproxyBackendServer[];
  balance: StreamBalance | null;
  /** Ob die server-Zeilen ein `check` tragen. In `mode tcp` ist das eine reine
   *  Verbindungsprobe: nimmt der Port drüben Verbindungen an. */
  check: boolean;
  /**
   * Von welchen Adressen der Port erreichbar ist. Leer heißt: von überall.
   *
   * Eine eigene Liste je Eintrag und NICHT die Admin-IPs der Maschine. Die sind
   * eine Antwort auf „wer darf ein Verwaltungs-Frontend sehen"; hier steht die
   * Frage „wer darf an diese Datenbank", und das ist regelmäßig ein
   * Anwendungsserver und kein Büro. Dazu kommt ein technischer Grund: die ACL
   * `admin_ips` ist im Frontend deklariert, und eine ACL gilt in HAProxy nur
   * innerhalb ihres Abschnitts — hier wäre sie unbekannt.
   */
  allowedSources: string[];
  /** Trägt den `# AUTO: id`-Kommentar, stammt also aus einem Vorgang wie diesem. */
  auto: boolean;
  /** Zeilen des Abschnitts, die dieses Modul nicht abbildet. Wie bei einem
   *  Dienst der Grund, warum `editable` existiert. */
  extras: string[];
  removable: boolean;
  editable: boolean;
}

export interface StreamServerInput {
  /** Leer heißt: `server1`, `server2`, … nach Position. */
  name: string;
  target: string;
  /** Der Anteil dieses Ziels. `null` schreibt keine `weight`-Angabe. Dieselbe
   *  Bedeutung wie beim Dienst, siehe `HaproxyBackendServer.weight`. */
  weight: number | null;
}

export interface CreateStreamInput {
  scope: HaproxyScope;
  id: string;
  port: number;
  servers: StreamServerInput[];
  balance: StreamBalance | null;
  check: boolean;
  allowedSources: string[];
}

/* ── Was in einen Abschnitt geschrieben wird ── */

const MODE_LINE = 'mode tcp';
/**
 * Das Zugriffsprotokoll.
 *
 * Ohne die Zeile gilt, was im `defaults`-Block steht, und dort steht in der
 * Grundkonfiguration `option httplog` — ein HTTP-Format für einen Abschnitt ohne HTTP.
 * HAProxy meldet das als Warnung und schreibt danach Zeilen, in denen die
 * interessanten Felder leer sind. Eine Warnung, die jeder Neustart wiederholt,
 * liest irgendwann niemand mehr.
 */
const LOG_LINE = 'option tcplog';

/** Die Sperre auf die erlaubten Absender. `connection` und nicht `content`: die
 *  Entscheidung hängt allein an der Quell-IP, und dann soll sie fallen, bevor
 *  ein einziges Byte gelesen wird. */
export function sourceRuleFor(sources: string[]): string {
  return `tcp-request connection reject if !{ src ${sources.join(' ')} }`;
}

const SOURCE_RULE = /^tcp-request\s+connection\s+reject\s+if\s+!\{\s*src\s+([^}]+?)\s*\}$/;
const BALANCE_RULE = /^balance\s+(\S+)$/;
/** Die `bind`-Zeile, so wie `renderStreamBlock` sie schreibt: nur der Port,
 *  ohne Adresse davor und ohne Parameter dahinter. Alles andere (`ssl`, `v4v6`,
 *  eine feste Adresse) wird gelesen und nicht nachgebaut. */
const BIND_LINE = /^bind\s+:(\d{1,5})$/;

export const STREAM_PORT_MIN = 1;
export const STREAM_PORT_MAX = 65535;

/**
 * Die Eingabe prüfen. Gibt die Meldung zurück, die der Benutzer lesen soll,
 * oder `null` — wie `validateCreateInput`, und aus demselben Grund: dieselbe
 * Funktion läuft im Browser und in der Route.
 *
 * Was hier NICHT geprüft wird, ist der Portkonflikt. Dafür braucht es die
 * Konfiguration, und die liegt erst in `addStream` vor.
 */
export function validateStreamInput(input: CreateStreamInput): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(input.scope)) return 'Es wurde keine Gruppe ausgewählt.';
  if (!isValidServiceId(input.id)) {
    return 'Die Kennung darf nur a-z, 0-9 und _ enthalten und muss mit einem Buchstaben oder einer Ziffer beginnen.';
  }

  if (!Number.isInteger(input.port) || input.port < STREAM_PORT_MIN || input.port > STREAM_PORT_MAX) {
    return `Der Port muss eine ganze Zahl zwischen ${STREAM_PORT_MIN} und ${STREAM_PORT_MAX} sein.`;
  }
  const reserved = RESERVED_PORTS[input.port];
  if (reserved) return `Port ${input.port} ist auf einem Reverse-Proxy belegt: ${reserved}`;

  if (input.balance !== null && !STREAM_BALANCE.includes(input.balance)) {
    return 'Unbekanntes Verteilverfahren.';
  }

  if (input.servers.length === 0) return 'Mindestens ein Ziel wird benötigt.';
  const seenNames = new Set<string>();
  for (const server of input.servers) {
    if (server.name) {
      if (!isValidBackendName(server.name)) return `Ungültiger Zielname: ${server.name}`;
      if (seenNames.has(server.name)) {
        return `Der Zielname ${server.name} steht doppelt. HAProxy lehnt zwei gleich benannte Server in einem Abschnitt ab.`;
      }
      seenNames.add(server.name);
    }
    if (!isValidBackendTarget(server.target)) {
      return `Ungültiges Ziel: ${server.target}. Erwartet wird host:port.`;
    }
    if (server.weight !== null && !isValidWeight(server.weight)) {
      return `Ungültige Gewichtung für ${server.target}: ${server.weight}. HAProxy nimmt eine ganze Zahl von ${WEIGHT_MIN} bis ${WEIGHT_MAX}.`;
    }
  }

  const seenSources = new Set<string>();
  for (const source of input.allowedSources) {
    if (!isValidSourceAddress(source)) {
      return `Ungültige Absenderadresse: ${source}. Erwartet wird eine IP oder ein CIDR-Block.`;
    }
    if (seenSources.has(source)) return `Die Adresse ${source} steht doppelt in der Liste.`;
    seenSources.add(source);
  }

  return null;
}

/* ── Lesen ── */

/** Wo ein `listen`-Abschnitt aufhört: beim nächsten Abschnitt oder bei einer
 *  Marke, die zu einem anderen Eintrag gehört. Dieselben Fälle wie beim
 *  Herausnehmen eines Dienstes — ohne die beiden Marker-Formen risse das
 *  Löschen die Stelle mit heraus, an der der nächste Eintrag eingefügt wird. */
function endsSection(line: string): boolean {
  return (
    SECTION_KEYWORDS.test(line) ||
    /^#\s*AUTO:/.test(line) ||
    /^#\s*(BEGIN|END)\s+AUTO/.test(line) ||
    /^#\s*=+/.test(line)
  );
}

/**
 * Alle Ports, die in dieser Konfiguration schon gebunden sind, mit dem
 * Abschnitt, der sie bindet.
 *
 * Gelesen wird jede `bind`-Zeile, auch die, die dieses Modul selbst nicht
 * schreiben würde: `bind *:80`, `bind 10.0.0.1:8404 ssl crt …`, mehrere
 * Adressen durch Komma getrennt. Für den Konflikt zählt der Port und nicht die
 * Form der Zeile — wer hier nur die eigene Form erkennt, hält ausgerechnet das
 * bestehende Frontend für frei.
 */
export function parseBindPorts(text: string): { port: number; section: string }[] {
  const found: { port: number; section: string }[] = [];
  let section = '(global)';

  for (const raw of text.split('\n')) {
    const line = clean(raw);
    const head = /^(frontend|backend|listen)\s+(\S+)/.exec(line);
    if (head) {
      section = `${head[1]} ${head[2]}`;
      continue;
    }
    if (SECTION_KEYWORDS.test(line)) {
      section = line.split(/\s+/)[0];
      continue;
    }
    const bind = /^bind\s+(\S+)/.exec(line);
    if (!bind) continue;

    for (const address of bind[1].split(',')) {
      // Der Port steht hinter dem LETZTEN Doppelpunkt: `:::443` und
      // `[2001:db8::1]:443` haben davor beliebig viele.
      const cut = address.lastIndexOf(':');
      if (cut === -1) continue;
      const port = Number(address.slice(cut + 1));
      if (Number.isInteger(port) && port > 0) found.push({ port, section });
    }
  }
  return found;
}

/**
 * Die Ports, auf denen die Maschine gerade lauscht — aus `ss -Hltn`.
 *
 * `null` heißt **unbekannt** und nicht „keiner": eine leere Ausgabe kommt
 * daher, dass `ss` fehlt oder nichts liefert, denn es lauscht immer mindestens
 * HAPM selbst. Ein leeres Ergebnis als „alle Ports frei" zu lesen wäre eine
 * beruhigende Zahl ohne Deckung: die Prüfung ginge dann still durch und der
 * Reload scheiterte.
 *
 * Die vierte Spalte ist die lokale Adresse, der Port steht hinter ihrem letzten
 * Doppelpunkt (`0.0.0.0:22`, `[::]:443`, `*:80`).
 */
export function parseListeningPorts(output: string): number[] | null {
  const ports = new Set<number>();
  for (const raw of output.split('\n')) {
    const cells = clean(raw).split(/\s+/).filter(Boolean);
    if (cells.length < 4) continue;
    const address = cells[3];
    const cut = address.lastIndexOf(':');
    if (cut === -1) continue;
    const port = Number(address.slice(cut + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports.size === 0 ? null : [...ports].sort((a, b) => a - b);
}

/**
 * Ob dieser Port schon vergeben ist. Gibt den Abschnitt zurück, der ihn hält,
 * oder `null`.
 *
 * `exclude` ist der eigene Abschnitt beim Ändern: ohne ihn meldete jede
 * Änderung, die den Port behält, einen Konflikt mit sich selbst.
 */
export function bindConflict(text: string, port: number, exclude?: string): string | null {
  const own = exclude ? `listen ${exclude}` : null;
  const hit = parseBindPorts(text).find((b) => b.port === port && b.section !== own);
  return hit ? hit.section : null;
}

/**
 * Die TCP-Weiterleitungen einer Konfiguration.
 *
 * Ausgegangen wird von `listen`, und zwar von JEDEM — auch von einem in
 * `mode http`. Der ist keine TCP-Weiterleitung und wird deshalb nur lesbar
 * angezeigt; ganz wegzulassen wäre ein blinder Fleck, und der fällt erst auf,
 * wenn jemand denselben Port ein zweites Mal vergibt.
 */
export function parseStreams(text: string): HaproxyStream[] {
  const lines = text.split('\n');
  const scopeOf = scopeResolver(lines, 'backends');

  const autoIds = new Set<string>();
  const streams: HaproxyStream[] = [];

  let current: {
    id: string;
    index: number;
    binds: number[];
    /** Wie viele `bind`-Zeilen dastanden, auch die unlesbaren. Aus `binds`
     *  allein ließe sich „keine" nicht von „eine, aber mit Parametern"
     *  unterscheiden. */
    bindLines: number;
    mode: string | null;
    log: boolean;
    balance: StreamBalance | null;
    servers: HaproxyBackendServer[];
    allowedSources: string[];
    sourceRules: number;
    extras: string[];
  } | null = null;

  const finish = () => {
    if (!current) return;
    const c = current;
    current = null;

    const extras = [...c.extras];
    // Genau eine lesbare `bind`-Zeile. Zwei Ports in einem Abschnitt sind
    // gültige Konfiguration und trotzdem nichts, was dieses Formular
    // zurückschriebe — es hat ein Feld.
    const port = c.bindLines === 1 && c.binds.length === 1 ? c.binds[0] : null;
    if (port === null && c.bindLines > 0) extras.push(`bind (${c.bindLines}×, nicht abbildbar)`);
    if (c.bindLines === 0) extras.push('ohne bind-Zeile');
    if (c.mode !== 'tcp') extras.push(c.mode === null ? 'ohne mode-Zeile' : `mode ${c.mode}`);
    if (!c.log) extras.push('ohne option tcplog');
    if (c.sourceRules > 1) extras.push('mehrere tcp-request-connection-Regeln');

    // `check` gilt für alle oder für keinen: gemischt geschrieben käme beim
    // Speichern für die Hälfte etwas anderes heraus, als dasteht.
    const check = c.servers.length > 0 && c.servers.every((s) => s.check);
    if (c.servers.some((s) => s.check !== check)) {
      extras.push('server-Zeilen mit unterschiedlichem check');
    }

    const scope = scopeOf(c.index);
    const removable = scope !== null;

    streams.push({
      id: c.id,
      scope,
      port,
      servers: c.servers,
      balance: c.balance,
      check,
      allowedSources: c.allowedSources,
      auto: autoIds.has(c.id),
      extras,
      removable,
      // Wie bei einem Dienst: Bearbeiten heißt entfernen und aus der
      // Eingabemaske neu schreiben, und das setzt voraus, dass sich der ganze
      // Abschnitt daraus reproduzieren lässt.
      editable: removable && extras.length === 0 && port !== null && c.servers.length > 0,
    });
  };

  lines.forEach((raw, index) => {
    const line = clean(raw);

    const auto = /^#\s*AUTO:\s*(\S+)$/.exec(line);
    if (auto) {
      finish();
      autoIds.add(auto[1]);
      return;
    }

    const listen = /^listen\s+(\S+)\s*$/.exec(line);
    if (listen) {
      finish();
      current = {
        id: listen[1],
        index,
        binds: [],
        bindLines: 0,
        mode: null,
        log: false,
        balance: null,
        servers: [],
        allowedSources: [],
        sourceRules: 0,
        extras: [],
      };
      return;
    }

    if (!current) return;
    if (endsSection(line)) {
      finish();
      return;
    }
    if (line === '' || line.startsWith('#')) return;

    const bind = BIND_LINE.exec(line);
    if (bind) {
      current.bindLines++;
      current.binds.push(Number(bind[1]));
      return;
    }
    if (/^bind\s/.test(line)) {
      current.bindLines++;
      return;
    }

    const mode = /^mode\s+(\S+)$/.exec(line);
    if (mode) {
      // Eine zweite mode-Zeile gewinnt bei HAProxy; hier zählt sie als
      // Abweichung, denn das Formular schreibt eine.
      if (current.mode !== null) current.extras.push(line);
      current.mode = mode[1];
      return;
    }

    if (line === LOG_LINE) {
      if (current.log) current.extras.push(line);
      current.log = true;
      return;
    }

    const balance = BALANCE_RULE.exec(line);
    if (balance) {
      if (current.balance === null && STREAM_BALANCE.includes(balance[1] as StreamBalance)) {
        current.balance = balance[1] as StreamBalance;
      } else {
        current.extras.push(line);
      }
      return;
    }

    const source = SOURCE_RULE.exec(line);
    if (source) {
      current.sourceRules++;
      if (current.sourceRules === 1) {
        current.allowedSources = source[1].split(/\s+/).filter(Boolean);
      } else {
        current.extras.push(line);
      }
      return;
    }

    const server = /^server\s+(\S+)\s+(\S+)(\s.*)?$/.exec(line);
    if (server) {
      // Dieselbe Zeilenform wie in einem Backend, also derselbe Leser. Ein
      // eigener hier wäre der, der die Gewichtung vergisst.
      const { check, weight, cookie, leftover } = readServerParams(server[3] ?? '');
      current.servers.push({ name: server[1], target: server[2], check, weight });
      // Eine Cookie-Marke gibt es in `mode tcp` nicht: sie setzt HTTP voraus.
      // Steht sie da, hat sie jemand von Hand hingeschrieben.
      if (leftover.length > 0 || cookie !== null) current.extras.push(line);
      return;
    }

    current.extras.push(line);
  });

  finish();
  return streams;
}

export function findStream(streams: HaproxyStream[], id: string): HaproxyStream | undefined {
  return streams.find((stream) => stream.id === id);
}

/* ── Schreiben ── */

/**
 * Der ganze Abschnitt, mit seinem `# AUTO:`-Kommentar darüber.
 *
 * `listen` und nicht `frontend` plus `backend`: es gibt nichts zu entscheiden
 * zwischen den beiden Hälften — ein Port, ein Satz Ziele. Zwei Abschnitte wären
 * zwei Namen, zwei Stellen beim Löschen und eine `use_backend`-Zeile dazwischen,
 * die nichts unterscheidet.
 */
export function renderStreamBlock(input: CreateStreamInput): string[] {
  const lines = ['', `# AUTO: ${input.id}`, `listen ${input.id}`, `    ${MODE_LINE}`, `    ${LOG_LINE}`];

  lines.push(`    bind :${input.port}`);

  // Vor allem anderen: wer die Datei liest, soll sehen, dass der Port nicht
  // offen ist, bevor er sieht, wohin er zeigt.
  if (input.allowedSources.length > 0) {
    lines.push(`    ${sourceRuleFor(input.allowedSources)}`);
  }
  if (input.balance) lines.push(`    balance ${input.balance}`);

  lines.push('');
  input.servers.forEach((server, position) => {
    const name = server.name || `server${position + 1}`;
    lines.push(
      `    server ${name} ${server.target}${serverParams({
        check: input.check,
        weight: server.weight,
        cookie: null,
      })}`
    );
  });

  return lines;
}

/**
 * Eine TCP-Weiterleitung einsetzen.
 *
 * Prüft vorher, was HAProxy erst beim Laden oder — beim Port — erst beim Reload
 * bemerken würde. Der Portkonflikt ist der teure Fall: `haproxy -c` bindet
 * keine Sockets und sieht daran nichts Falsches.
 */
export function addStream(text: string, input: CreateStreamInput): string {
  const invalid = validateStreamInput(input);
  if (invalid) throw new HaproxyConfigError(invalid);

  const lines = text.split('\n');

  // Ein Name gilt in HAProxy über `frontend`, `backend` und `listen` hinweg.
  // Nur gegen `listen` zu prüfen ließe einen Abschnitt entstehen, der so heißt
  // wie ein bestehendes Backend — und die Datei wird als Ganzes abgelehnt.
  const taken = lines.find((line) =>
    new RegExp(`^\\s*(frontend|backend|listen)\\s+${escapeRegExp(input.id)}\\s*$`).test(clean(line))
  );
  if (taken) {
    throw new HaproxyConfigError(
      `Der Name "${input.id}" ist in der Konfiguration bereits vergeben (${clean(taken)}).`
    );
  }

  const conflict = bindConflict(text, input.port);
  if (conflict) {
    throw new HaproxyConfigError(
      `Port ${input.port} wird in der Konfiguration bereits von "${conflict}" gebunden. ` +
        'Ein zweiter Abschnitt auf demselben Port kommt durch die Prüfung und scheitert erst beim Reload.'
    );
  }

  const scope = findBackendScope(lines, input.scope);
  if (!scope) {
    throw new HaproxyConfigError(
      `In der Konfiguration gibt es keinen Marker "# END AUTO ${input.scope.toUpperCase()} BACKENDS". ` +
        'Ohne ihn ist nicht bestimmbar, wo der Abschnitt hingehört.'
    );
  }

  return insertBeforeScopeMarker(lines, scope, 'backends', renderStreamBlock(input)).join('\n');
}

/** Der Name der Gruppe, wie er im Marker steht — die Schreibweise aus dem
 *  Formular muss ihn nicht auf das Zeichen treffen. */
function findBackendScope(lines: string[], scope: string): string | null {
  const marker = scopeMarkers(lines).find(
    (m) => m.edge === 'end' && m.kind === 'backends' && m.name.toUpperCase() === scope.toUpperCase()
  );
  return marker ? marker.name : null;
}

/**
 * Eine TCP-Weiterleitung herausnehmen: der Kommentar und der ganze Abschnitt.
 *
 * Wie bei einem Dienst geht die Leerzeile davor mit — eingefügt wird immer mit
 * einer, und bliebe sie stehen, wüchse die Datei bei jedem Anlegen und Löschen
 * um eine weitere leere Zeile.
 */
export function removeStream(text: string, id: string): string {
  const out: string[] = [];
  let skipping = false;
  let touched = false;
  let lastWasSkipped = false;

  const skip = () => {
    if (!lastWasSkipped && out.length > 0 && clean(out[out.length - 1]) === '') out.pop();
    lastWasSkipped = true;
    touched = true;
  };

  for (const raw of text.split('\n')) {
    const line = clean(raw);

    if (skipping) {
      if (!endsSection(line)) {
        skip();
        continue;
      }
      skipping = false;
    }

    if (line === `# AUTO: ${id}`) {
      skip();
      continue;
    }

    if (new RegExp(`^listen\\s+${escapeRegExp(id)}\\s*$`).test(line)) {
      skip();
      skipping = true;
      continue;
    }

    out.push(raw);
    lastWasSkipped = false;
  }

  if (!touched) {
    throw new HaproxyConfigError(`Die TCP-Weiterleitung "${id}" steht nicht in der Konfiguration.`);
  }
  return out.join('\n');
}

/**
 * Ersetzen: entfernen und neu einsetzen, in EINEM Text.
 *
 * Entfernen zuerst, aus demselben Grund wie bei `replaceService`: erst danach
 * sind Name und Port wieder frei, und `addStream` kann seine Prüfungen
 * unverändert durchlaufen. Ein Vorgang und nicht zwei, damit zwischen den
 * beiden kein Reload liegt, in dem der Port nicht bedient wird.
 */
export function replaceStream(text: string, oldId: string, input: CreateStreamInput): string {
  return addStream(removeStream(text, oldId), input);
}

/**
 * Einen gelesenen Abschnitt zurück in die Form bringen, aus der er entstanden
 * ist. Nur für `editable`-Einträge sinnvoll; bei allen anderen wäre das
 * Ergebnis eine Behauptung darüber, was in der Datei steht.
 */
export function toStreamInput(stream: HaproxyStream): CreateStreamInput {
  if (!stream.editable || !stream.scope || stream.port === null) {
    throw new HaproxyConfigError(
      `"${stream.id}" lässt sich nicht bearbeiten: der Abschnitt enthält Einstellungen, die dieses Formular nicht abbildet.`
    );
  }
  return {
    scope: stream.scope,
    id: stream.id,
    port: stream.port,
    servers: stream.servers.map((s) => ({ name: s.name, target: s.target, weight: s.weight })),
    balance: stream.balance,
    check: stream.check,
    allowedSources: [...stream.allowedSources],
  };
}

/**
 * Einen Request-Rumpf in eine Eingabe umformen — normalisiert, aber nicht
 * geprüft. Wie `readServiceInput`: das Prüfen bleibt an einer Stelle.
 */
export function readStreamInput(body: unknown): CreateStreamInput {
  const raw = (body ?? {}) as Record<string, unknown>;

  const rawBalance = String(raw.balance ?? '').trim();

  return {
    scope: String(raw.scope ?? '').trim(),
    id: String(raw.id ?? '').trim().toLowerCase(),
    // `Number` und nicht `parseInt`: „8080abc" soll als ungültig durchfallen
    // und nicht als 8080 durchgehen. NaN scheitert an `Number.isInteger`.
    port: Number(String(raw.port ?? '').trim()),
    servers: Array.isArray(raw.servers)
      ? raw.servers.map((entry) => {
          const s = (entry ?? {}) as Record<string, unknown>;
          return {
            name: String(s.name ?? '').trim(),
            target: String(s.target ?? '').trim(),
            weight: readWeight(s.weight),
          };
        })
      : [],
    // Ein unbekannter Wert wird durchgereicht und abgelehnt, nicht gebogen.
    balance: rawBalance === '' ? null : (rawBalance as StreamBalance),
    check: raw.check === true,
    allowedSources: Array.isArray(raw.allowedSources)
      ? raw.allowedSources.map((entry) => String(entry).trim()).filter(Boolean)
      : [],
  };
}

/** Passt eine Weiterleitung zur Suche? Kennung, Port und Ziele — alles, was auf
 *  der Karte steht und wonach man sucht. */
export function matchesStreamSearch(stream: HaproxyStream, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (
    stream.id.toLowerCase().includes(needle) ||
    String(stream.port ?? '').includes(needle) ||
    stream.servers.some(
      (s) => s.target.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle)
    )
  );
}
