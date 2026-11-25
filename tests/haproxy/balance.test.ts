import { describe, it, expect } from 'vitest';
import {
  parseHaproxyConfig,
  addService,
  removeService,
  renderBackendBlock,
  toCreateInput,
  readServiceInput,
  validateCreateInput,
  serviceKind,
  STICKY_BACKEND_LINE,
  STICKY_COOKIE,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { germanText, type Message } from '@/lib/i18n/translate';

/** Die Meldung einer Prüfung auf Deutsch, wie sie ohne Sprache herauskommt. */
const de = (message: Message | null) => (message ? germanText(message) : message);

/**
 * Lastverteilung: das Verfahren aus `balance` und die Sitzungsbindung über
 * einen Cookie.
 *
 * Beides war vorher eine Zeile, die niemand reproduzieren konnte — sie landete
 * in `extras` und machte den Eintrag unbearbeitbar. Diese Datei hält fest, was
 * jetzt zurückgelesen wird und was weiterhin durchfällt: die Grenze ist die
 * Frage, ob ein Speichern denselben Text erzeugt.
 */

const CONFIG = `# ============================================================
frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

# END AUTO INTERN SERVICES

    default_backend nichts

# ============================================================

# END AUTO INTERN BACKENDS

backend nichts
    http-request deny deny_status 404
`;

const INPUT: CreateServiceInput = {
  scope: 'INTERN',
  id: 'shop',
  domains: ['shop.example.org'],
  servers: [
    { name: 'web1', target: '10.10.0.10:80', weight: null },
    { name: 'web2', target: '10.10.0.11:80', weight: null },
  ],
  redirect: null,
  routes: [],
  balance: 'leastconn',
  sticky: true,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  healthcheck: true,
  backendTls: 'off',
};

function find(text: string, id: string) {
  return parseHaproxyConfig(text).find((s) => s.id === id)!;
}

describe('renderBackendBlock', () => {
  it('schreibt Verfahren und Bindung über die server-Zeilen', () => {
    const lines = renderBackendBlock(INPUT).map((l) => l.trim());
    const balance = lines.indexOf('balance leastconn');
    const cookie = lines.indexOf(STICKY_BACKEND_LINE);
    const server = lines.findIndex((l) => l.startsWith('server web1'));
    expect(balance).toBeGreaterThan(-1);
    expect(cookie).toBeGreaterThan(balance);
    expect(server).toBeGreaterThan(cookie);
  });

  it('setzt als Cookie-Marke den Servernamen und nichts Eigenes', () => {
    // HAProxy schickt den Wert aus dem Cookie an den Server, der so heißt. Ein
    // zweiter Name daneben wäre eine zweite Quelle für dieselbe Zuordnung.
    const lines = renderBackendBlock(INPUT).map((l) => l.trim());
    expect(lines).toContain('server web1 10.10.0.10:80 check cookie web1');
    expect(lines).toContain('server web2 10.10.0.11:80 check cookie web2');
  });

  it('lässt beides weg, wenn nichts gewählt ist', () => {
    const plain = renderBackendBlock({ ...INPUT, balance: null, sticky: false }).join('\n');
    expect(plain).not.toContain('balance');
    expect(plain).not.toContain('cookie');
    expect(plain).toContain('server web1 10.10.0.10:80 check');
  });

  it('nimmt bei leerem Namen den Positionsnamen auch für den Cookie', () => {
    const anonym = renderBackendBlock({
      ...INPUT,
      servers: [{ name: '', target: '10.10.0.10:80', weight: null }],
    }).map((l) => l.trim());
    expect(anonym).toContain('server server1 10.10.0.10:80 check cookie server1');
  });
});

describe('Zurücklesen', () => {
  const config = addService(CONFIG, INPUT);
  const service = find(config, 'shop');

  it('liest Verfahren und Bindung zurück', () => {
    expect(service.balance).toBe('leastconn');
    expect(service.sticky).toBe(true);
    expect(service.extras).toEqual([]);
    expect(service.editable).toBe(true);
  });

  it('gibt exakt die Eingabe zurück', () => {
    expect(toCreateInput(service)).toEqual(INPUT);
  });

  it('anlegen und wieder entfernen ergibt den Anfang', () => {
    expect(removeService(config, 'shop')).toBe(CONFIG);
  });

  it('liest ohne balance-Zeile null und nicht roundrobin', () => {
    /* `null` heißt „es steht keine Zeile da", und dann gilt der defaults-Block
     * der Maschine. Eine Vorgabe hinzuschreiben wäre eine Behauptung über eine
     * Datei, in die dieses Modul nicht sieht. */
    const ohne = find(addService(CONFIG, { ...INPUT, balance: null }), 'shop');
    expect(ohne.balance).toBeNull();
    expect(ohne.editable).toBe(true);
  });
});

describe('was weiterhin durchfällt', () => {
  const config = addService(CONFIG, INPUT);

  it('ein balance mit Parameter', () => {
    // `balance uri whole` käme beim Neuschreiben ohne seinen Parameter wieder.
    const mit = config.replace('    balance leastconn', '    balance uri whole');
    const service = find(mit, 'shop');
    expect(service.balance).toBeNull();
    expect(service.extras).toContain('balance uri whole');
    expect(service.editable).toBe(false);
  });

  it('ein Verfahren außerhalb der Allow-Liste', () => {
    const mit = config.replace('    balance leastconn', '    balance hdr(Host)');
    expect(find(mit, 'shop').editable).toBe(false);
  });

  it('zwei balance-Zeilen', () => {
    const mit = config.replace(
      '    balance leastconn',
      '    balance leastconn\n    balance source'
    );
    const service = find(mit, 'shop');
    // Die erste zählt, die zweite ist ein extras-Eintrag: HAProxy nimmt die
    // letzte, das Formular kennt eine.
    expect(service.balance).toBe('leastconn');
    expect(service.editable).toBe(false);
  });

  it('die Cookie-Zeile ohne Marken auf den Servern', () => {
    // Sie setzt einen Cookie, den niemand einlöst.
    const halb = config
      .replace(' check cookie web1', ' check')
      .replace(' check cookie web2', ' check');
    const service = find(halb, 'shop');
    expect(service.sticky).toBe(false);
    expect(service.extras).toContain(STICKY_BACKEND_LINE);
    expect(service.editable).toBe(false);
  });

  it('Marken ohne die Cookie-Zeile im Backend', () => {
    // Sie werden nie gesetzt.
    const halb = config.replace(`    ${STICKY_BACKEND_LINE}\n`, '');
    const service = find(halb, 'shop');
    expect(service.sticky).toBe(false);
    expect(service.editable).toBe(false);
  });

  it('eine Marke, die nicht der eigene Servername ist', () => {
    /* Der teuerste Fall: HAProxy schickt den Wert an den Server, der so heißt.
     * Neu geschrieben stünde dort der eigene Name, und alle gebundenen
     * Sitzungen wanderten still auf ein anderes Ziel. */
    const falsch = config.replace(' check cookie web1', ' check cookie web2');
    const service = find(falsch, 'shop');
    expect(service.sticky).toBe(false);
    expect(service.editable).toBe(false);
  });

  it('nur ein Teil der Server trägt eine Marke', () => {
    const halb = config.replace(' check cookie web2', ' check');
    expect(find(halb, 'shop').sticky).toBe(false);
    expect(find(halb, 'shop').editable).toBe(false);
  });
});

describe('Gewichtung', () => {
  const GEWICHTET: CreateServiceInput = {
    ...INPUT,
    sticky: false,
    servers: [
      { name: 'web1', target: '10.10.0.10:80', weight: 3 },
      { name: 'web2', target: '10.10.0.11:80', weight: 1 },
    ],
  };

  it('steht zwischen check und der Cookie-Marke', () => {
    /* Für HAProxy ist die Reihenfolge dieser Parameter beliebig, für den Leser
     * hier nicht: eine anders sortierte Zeile käme beim Speichern umsortiert
     * heraus, und ein Diff, in dem sich Zeilen ohne Änderung bewegen, ist der,
     * den beim Nachsehen niemand liest. */
    const lines = renderBackendBlock({ ...GEWICHTET, sticky: true }).map((l) => l.trim());
    expect(lines).toContain('server web1 10.10.0.10:80 check weight 3 cookie web1');
  });

  it('wird ohne Angabe gar nicht geschrieben', () => {
    // `null` heißt „keine weight-Angabe" und nicht 1. Eine hingeschriebene 1
    // stünde danach in jeder Zeile, in der sie vorher nicht stand.
    expect(renderBackendBlock(INPUT).join('\n')).not.toContain('weight');
  });

  it('liest sich vollständig zurück', () => {
    const service = find(addService(CONFIG, GEWICHTET), 'shop');
    expect(service.servers.map((s) => s.weight)).toEqual([3, 1]);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(GEWICHTET);
  });

  it('nimmt die 0: sie nimmt ein Ziel aus der Verteilung, ohne es abzuwerfen', () => {
    const aus = { ...GEWICHTET, servers: [{ ...GEWICHTET.servers[0], weight: 0 }] };
    expect(de(validateCreateInput(aus))).toBeNull();
    const service = find(addService(CONFIG, aus), 'shop');
    expect(service.servers[0].weight).toBe(0);
    expect(service.editable).toBe(true);
  });

  it('lehnt einen Wert außerhalb von 0 bis 256 ab', () => {
    expect(
      de(validateCreateInput({ ...GEWICHTET, servers: [{ ...GEWICHTET.servers[0], weight: 300 }] }))
    ).toContain('Ungültige Gewichtung');
    expect(
      de(validateCreateInput({ ...GEWICHTET, servers: [{ ...GEWICHTET.servers[0], weight: -1 }] }))
    ).toContain('Ungültige Gewichtung');
  });

  it('macht einen unlesbaren Wert in der Datei nur lesbar, statt ihn zu biegen', () => {
    const kaputt = addService(CONFIG, GEWICHTET).replace('weight 3', 'weight viel');
    const service = find(kaputt, 'shop');
    expect(service.servers[0].weight).toBeNull();
    expect(service.editable).toBe(false);
  });

  it('gibt es bei einer Pfad-Regel nicht: sie verteilt nichts, sie trennt', () => {
    const mitRoute: CreateServiceInput = {
      ...INPUT,
      sticky: false,
      routes: [
        {
          name: 'api',
          paths: ['/api'],
          servers: [{ name: 'api1', target: '10.10.0.12:80' }],
          check: true,
          backendTls: 'off',
        },
      ],
    };
    const text = addService(CONFIG, mitRoute);
    expect(text).toContain('server api1 10.10.0.12:80 check');
    expect(text).not.toContain('server api1 10.10.0.12:80 check weight');
    expect(toCreateInput(find(text, 'shop'))).toEqual(mitRoute);
  });

  it('macht eine vorgefundene Gewichtung in einer Pfad-Regel nur lesbar', () => {
    /* Gelesen wird sie — die Karte soll das Ziel zeigen —, aber
     * `renderRouteBackend` schriebe sie nicht wieder hin. Sie stillschweigend
     * wegzuschreiben wäre dieselbe Sorte Verlust, gegen die `extras` gebaut ist. */
    const mitRoute: CreateServiceInput = {
      ...INPUT,
      sticky: false,
      routes: [
        { name: 'api', paths: ['/api'], servers: [{ name: 'api1', target: '10.10.0.12:80' }], check: true, backendTls: 'off' },
      ],
    };
    const kaputt = addService(CONFIG, mitRoute).replace(
      'server api1 10.10.0.12:80 check',
      'server api1 10.10.0.12:80 check weight 5'
    );
    const service = find(kaputt, 'shop');
    expect(service.routes[0].servers[0].weight).toBe(5);
    expect(service.editable).toBe(false);
  });

  it('liest ein fehlendes Feld als „keine Angabe"', () => {
    expect(readServiceInput({ servers: [{ target: '10.0.0.1:80' }] }).servers[0].weight).toBeNull();
    expect(readServiceInput({ servers: [{ target: '10.0.0.1:80', weight: '' }] }).servers[0].weight).toBeNull();
    expect(readServiceInput({ servers: [{ target: '10.0.0.1:80', weight: 0 }] }).servers[0].weight).toBe(0);
  });

  it('lässt „2abc" ungültig, statt daraus 2 zu machen', () => {
    const input = readServiceInput({ servers: [{ target: '10.0.0.1:80', weight: '2abc' }] });
    expect(Number.isNaN(input.servers[0].weight)).toBe(true);
    expect(de(validateCreateInput({ ...INPUT, servers: input.servers }))).toContain(
      'Ungültige Gewichtung'
    );
  });
});

describe('validateCreateInput', () => {
  it('lehnt ein unbekanntes Verfahren ab', () => {
    expect(de(validateCreateInput({ ...INPUT, balance: 'schnellste' as never }))).toBe(
      'Unbekanntes Verteilverfahren.'
    );
  });

  it('schließt beides bei einer Weiterleitung aus', () => {
    const redirect: CreateServiceInput = {
      ...INPUT,
      servers: [],
      redirect: { to: 'https://example.org', keepPath: false, permanent: false },
      healthcheck: false,
    };
    expect(de(validateCreateInput(redirect))).toContain('Verteilverfahren');
    expect(de(validateCreateInput({ ...redirect, balance: null }))).toContain('Sitzungsbindung');
    expect(de(validateCreateInput({ ...redirect, balance: null, sticky: false }))).toBeNull();
  });
});

describe('readServiceInput', () => {
  it('liest ein fehlendes Feld als „keine balance-Zeile"', () => {
    // Und nicht als roundrobin: ein Aufrufer, der davon nichts weiß, soll den
    // defaults-Block der Maschine gelten lassen.
    expect(readServiceInput({ domains: ['a.example'] }).balance).toBeNull();
    expect(readServiceInput({ domains: ['a.example'] }).sticky).toBe(false);
  });

  it('reicht einen unbekannten Wert durch, statt ihn zu biegen', () => {
    const input = readServiceInput({ balance: 'schnellste' });
    expect(input.balance).toBe('schnellste');
    // Auf einen Vorgabewert gebogen wäre er eine Entscheidung, die niemand
    // getroffen hat. Abgelehnt wird er erst von der Prüfung, und die ist
    // dieselbe, die auch das Formular aufruft.
    expect(de(validateCreateInput({ ...INPUT, balance: input.balance }))).toBe(
      'Unbekanntes Verteilverfahren.'
    );
  });

  it('nimmt beides bei einer Weiterleitung zurück, statt es abzulehnen', () => {
    const input = readServiceInput({
      domains: ['alt.example'],
      redirect: { to: 'https://neu.example' },
      balance: 'leastconn',
      sticky: true,
    });
    expect(input.balance).toBeNull();
    expect(input.sticky).toBe(false);
  });
});

/**
 * Die Ableitung entscheidet, welches Formular aufgeht — und jedes Formular
 * zeigt nur die Felder seiner Sorte. Was es nicht zeigt, schreibt es beim
 * Speichern auch nicht.
 *
 * Deshalb ist eine zu enge Ableitung hier gleichbedeutend mit Datenverlust: ein
 * Eintrag mit Sitzungsbindung, den diese Funktion `proxy` nennt, ginge im
 * Reverse-Proxy-Formular auf und verlöre seine Cookie-Zeilen beim ersten
 * Speichern. Jede einzelne Eigenschaft, die nur die Lastverteilung kann, muss
 * deshalb für sich allein reichen.
 */
describe('serviceKind', () => {
  const EIN_ZIEL = [{ ...INPUT.servers[0], weight: null }];
  const PROXY = { redirect: null, servers: EIN_ZIEL, balance: null, sticky: false } as const;

  it('nennt einen Eintrag mit einem schlichten Ziel Reverse-Proxy', () => {
    expect(serviceKind(PROXY)).toBe('proxy');
  });

  it('nennt eine Weiterleitung eine Weiterleitung', () => {
    expect(
      serviceKind({
        ...PROXY,
        redirect: { to: 'https://example.org', keepPath: false, permanent: false },
        servers: [],
      })
    ).toBe('redirect');
  });

  it.each([
    ['zwei Ziele', { servers: [EIN_ZIEL[0], { ...EIN_ZIEL[0], name: 'web2' }] }],
    ['ein benanntes Verfahren', { balance: 'leastconn' as const }],
    ['eine Sitzungsbindung', { sticky: true }],
    ['eine Gewichtung', { servers: [{ ...EIN_ZIEL[0], weight: 3 }] }],
  ])('macht %s allein schon eine Lastverteilung daraus', (_was, patch) => {
    expect(serviceKind({ ...PROXY, ...patch })).toBe('balance');
  });

  it('nennt jeden gelesenen Eintrag so, dass sein Formular ihn vollständig zeigt', () => {
    /* Der Test, der die Regel trägt: für jede Eingabe, die das
     * Lastverteilungs-Formular schreiben kann, muss die Ableitung „balance"
     * sagen. Wäre auch nur eine davon „proxy", ginge sie im kleineren Formular
     * auf und verlöre beim Speichern, was dieses nicht kennt. */
    const KANN_NUR_BALANCE: Partial<CreateServiceInput>[] = [
      { balance: 'roundrobin' },
      { sticky: true },
      { servers: [{ name: 'a', target: '10.0.0.1:80', weight: 7 }] },
      {
        servers: [
          { name: 'a', target: '10.0.0.1:80', weight: null },
          { name: 'b', target: '10.0.0.2:80', weight: null },
        ],
      },
    ];

    for (const patch of KANN_NUR_BALANCE) {
      const eingabe: CreateServiceInput = { ...INPUT, balance: null, sticky: false, ...patch };
      const gelesen = find(addService(CONFIG, eingabe), 'shop');
      expect(gelesen.editable).toBe(true);
      expect(serviceKind(gelesen)).toBe('balance');
      // Und der Rückweg stimmt: was das Formular vorbelegt, ist die Eingabe.
      expect(toCreateInput(gelesen)).toEqual(eingabe);
    }
  });
});

describe('der Cookie-Name', () => {
  it('steht in der Zeile, die geschrieben wird', () => {
    // Zwei Stellen für denselben Namen wären zwei, die auseinanderlaufen.
    expect(STICKY_BACKEND_LINE).toContain(STICKY_COOKIE);
  });
});
