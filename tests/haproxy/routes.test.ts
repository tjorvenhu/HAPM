import { describe, it, expect } from 'vitest';
import {
  parseHaproxyConfig,
  addService,
  removeService,
  replaceService,
  renderServiceBlock,
  renderBackendBlock,
  toCreateInput,
  validateCreateInput,
  matchesSearch,
  shortTarget,
  readServiceInput,
  HaproxyConfigError,
  type CreateServiceInput,
} from '@/lib/haproxy/config';

/**
 * Pfad-Regeln: dieselbe Domain, ein anderer Port.
 *
 * Der Fall, für den es sie gibt, ist Coolify — Oberfläche auf 8000, Terminal
 * auf 6002, Live-Ansicht auf 6001, alles unter coolify.example.org. Was daran
 * schiefgehen kann, ist nicht das Schreiben, sondern das Zurücklesen und das
 * Löschen:
 *
 *  - Die Weiche ohne Pfadbedingung passt IMMER. Steht sie oben, greift keine
 *    Regel darunter, und `haproxy -c` sieht daran nichts Falsches.
 *  - Beim Löschen müssen ACL, Weiche und Backend jeder Regel mitgehen. Bleibt
 *    eine Weiche stehen, deren ACL weg ist, startet HAProxy nicht mehr.
 *  - Und mitgehen darf nur, was wirklich dazugehört: ein eigenständiger Dienst
 *    „coolify_ui" neben „coolify" ist kein Teil von ihm, auch wenn sein Name so
 *    aussieht.
 */

const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

# END AUTO INTERN SERVICES

# END AUTO KUNDEN SERVICES

# ============================================================

# END AUTO INTERN BACKENDS

# END AUTO KUNDEN BACKENDS
`;

const COOLIFY: CreateServiceInput = {
  scope: 'INTERN',
  id: 'coolify',
  domains: ['coolify.example.org'],
  servers: [{ name: 'coolify', target: '10.10.0.5:8000', weight: null }],
  redirect: null,
  routes: [
    {
      name: 'terminal',
      paths: ['/terminal/ws'],
      servers: [{ name: 'coolify', target: '10.10.0.5:6002' }],
      check: true,
    },
    {
      name: 'realtime',
      paths: ['/app'],
      servers: [{ name: 'coolify', target: '10.10.0.5:6001' }],
      check: true,
    },
  ],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  preset: 'coolify',
  healthcheck: false,
};

function find(text: string, id: string) {
  return parseHaproxyConfig(text).find((s) => s.id === id)!;
}

describe('rendern', () => {
  it('schreibt die Weichen der Regeln VOR die des Dienstes', () => {
    const lines = renderServiceBlock(COOLIFY).map((l) => l.trim());

    expect(lines).toContain('acl host_coolify hdr(host),lower -i coolify.example.org');
    expect(lines).toContain('acl path_coolify_terminal path_beg /terminal/ws');
    expect(lines).toContain('use_backend coolify_terminal if host_coolify path_coolify_terminal');

    // Die Reihenfolge IST das Verhalten: die letzte Weiche fängt alles ab, was
    // keine Regel getroffen hat.
    const catchAll = lines.indexOf('use_backend coolify if host_coolify');
    const terminal = lines.indexOf('use_backend coolify_terminal if host_coolify path_coolify_terminal');
    const realtime = lines.indexOf('use_backend coolify_realtime if host_coolify path_coolify_realtime');
    expect(terminal).toBeLessThan(catchAll);
    expect(realtime).toBeLessThan(catchAll);
  });

  it('gibt jeder Regel einen eigenen Backend-Block', () => {
    const lines = renderBackendBlock(COOLIFY).map((l) => l.trim());
    expect(lines).toContain('backend coolify');
    expect(lines).toContain('backend coolify_terminal');
    expect(lines).toContain('server coolify 10.10.0.5:6002 check');
    expect(lines).toContain('server coolify 10.10.0.5:6001 check');
  });

  it('setzt EINEN Kommentar über die Gruppe, nicht einen je Block', () => {
    // Drei `# AUTO: coolify` über drei Blöcken lesen sich beim Nachsehen von
    // Hand wie drei einzelne Dienste, die zufällig ähnlich heißen.
    const lines = renderBackendBlock(COOLIFY).map((l) => l.trim());
    expect(lines.filter((l) => l === '# AUTO: coolify')).toHaveLength(1);
    expect(lines.indexOf('# AUTO: coolify')).toBeLessThan(lines.indexOf('backend coolify'));
  });

  it('setzt „timeout tunnel" aus dem Preset in JEDEN Block', () => {
    // Ohne das reißen Terminal und Live-Ansicht nach `timeout client` ab. Es
    // gehört deshalb in die Regel-Backends und nicht nur in das des Dienstes.
    const blocks = renderBackendBlock(COOLIFY)
      .join('\n')
      .split(/^backend /m)
      .slice(1);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) expect(block).toContain('timeout tunnel 1h');
  });

  it('schreibt ohne Preset auch kein Timeout', () => {
    const text = renderBackendBlock({ ...COOLIFY, preset: 'default' }).join('\n');
    expect(text).not.toContain('timeout tunnel');
  });

  it('setzt auf einer Regel kein httpchk, nur `check`', () => {
    // Eine WebSocket-Strecke antwortet auf ein GET auf / nicht mit 200. Ein
    // HTTP-Check nähme sie dauerhaft aus dem Betrieb.
    const text = renderBackendBlock(COOLIFY).join('\n');
    const routeBlock = text.slice(text.indexOf('backend coolify_terminal'));
    expect(routeBlock).not.toContain('option httpchk');
    expect(routeBlock).toContain(' check');
  });
});

describe('zurücklesen', () => {
  const text = addService(CONFIG, COOLIFY);
  const service = find(text, 'coolify');

  it('findet den Dienst mit seinen Regeln, nicht drei Dienste', () => {
    expect(parseHaproxyConfig(text).map((s) => s.id)).toEqual(['coolify']);
    expect(service.routes.map((r) => r.name)).toEqual(['terminal', 'realtime']);
    expect(service.routes[0].paths).toEqual(['/terminal/ws']);
    expect(service.routes[0].servers[0].target).toBe('10.10.0.5:6002');
    expect(service.routes[0].check).toBe(true);
  });

  it('bleibt bearbeitbar und gibt dem Formular exakt die Eingabe zurück', () => {
    expect(service.extras).toEqual([]);
    expect(service.editable).toBe(true);
    expect(service.preset).toBe('coolify');
    expect(toCreateInput(service)).toEqual(COOLIFY);
  });

  it('behält die Reihenfolge der Regeln', () => {
    // Sie ist keine Kosmetik: bei überlappenden Pfaden gewinnt die erste.
    const zwei = addService(CONFIG, {
      ...COOLIFY,
      routes: [
        { ...COOLIFY.routes[1], paths: ['/app/spezial'] },
        { ...COOLIFY.routes[0], paths: ['/app'] },
      ],
    });
    expect(find(zwei, 'coolify').routes.map((r) => r.paths[0])).toEqual(['/app/spezial', '/app']);
  });

  it('ist nur lesbar, wenn die Weiche des Dienstes VOR den Regeln steht', () => {
    // Dann greift keine Regel — ein Zustand, den ein Neuschreiben still
    // reparieren würde. Gelesen wird er, geändert nicht.
    const verdreht = addService(CONFIG, COOLIFY).replace(
      /(    use_backend coolify_terminal.*\n)(    use_backend coolify_realtime.*\n)(    use_backend coolify if host_coolify\n)/,
      '$3$1$2'
    );
    const kaputt = find(verdreht, 'coolify');
    expect(kaputt.routes).toHaveLength(2);
    expect(kaputt.editable).toBe(false);
    // Löschen bleibt erlaubt: dabei geht ohnehin alles weg.
    expect(kaputt.removable).toBe(true);
  });

  it('macht eine fremde Weiche auf derselben ACL unlöschbar', () => {
    // Sie zeigt auf eine ACL, die beim Löschen mitginge — HAProxy startet
    // danach nicht mehr. Deshalb wird hier nichts angeboten.
    const fremd = addService(CONFIG, COOLIFY).replace(
      '    use_backend coolify if host_coolify',
      '    use_backend etwas_anderes if host_coolify pfad_von_hand\n    use_backend coolify if host_coolify'
    );
    const service = find(fremd, 'coolify');
    expect(service.removable).toBe(false);
    expect(service.editable).toBe(false);
    expect(service.extras.join(' ')).toContain('etwas_anderes');
  });

  it('nimmt eine Regel mit httpchk nicht als reproduzierbar an', () => {
    const mit = addService(CONFIG, COOLIFY).replace(
      'backend coolify_terminal\n',
      'backend coolify_terminal\n    option httpchk\n'
    );
    const service = find(mit, 'coolify');
    expect(service.editable).toBe(false);
    expect(service.extras).toContain('option httpchk');
  });

  it('erkennt eine Regel auch, wenn Host- und Pfadbedingung vertauscht sind', () => {
    // HAProxy verknüpft mit UND, die Reihenfolge trägt keine Bedeutung.
    const getauscht = addService(CONFIG, COOLIFY).replace(
      'if host_coolify path_coolify_terminal',
      'if path_coolify_terminal host_coolify'
    );
    expect(find(getauscht, 'coolify').routes.map((r) => r.name)).toContain('terminal');
  });

  it('kürzt ein Regel-Ziel auf den Port, solange es dieselbe Maschine ist', () => {
    // Auf der Karte stehen vier Adressen untereinander, die sich in einer
    // Ziffer unterscheiden.
    expect(shortTarget('10.10.0.5:6002', '10.10.0.5:8000')).toBe(':6002');
    // Eine andere Maschine steht voll da: die Abkürzung behauptete sonst eine
    // Adresse, die es nicht ist.
    expect(shortTarget('10.10.0.9:6002', '10.10.0.5:8000')).toBe('10.10.0.9:6002');
    expect(shortTarget('10.10.0.5:6002', undefined)).toBe('10.10.0.5:6002');
  });

  it('findet über Pfad und Regel-Ziel', () => {
    expect(matchesSearch(service, '6002')).toBe(true);
    expect(matchesSearch(service, '/terminal')).toBe(true);
    expect(matchesSearch(service, 'realtime')).toBe(true);
  });
});

describe('löschen', () => {
  it('nimmt ACL, Weiche und Backend jeder Regel mit', () => {
    const text = addService(CONFIG, COOLIFY);
    const zurueck = removeService(text, 'coolify');

    expect(zurueck).not.toContain('path_coolify_terminal');
    expect(zurueck).not.toContain('coolify_realtime');
    expect(zurueck).not.toContain('backend coolify');
    // Und es bleibt exakt die Ausgangsdatei übrig, ohne angesammelte Leerzeilen.
    expect(zurueck).toBe(CONFIG);
  });

  it('lässt einen eigenständigen Dienst mit passendem Namenspräfix stehen', () => {
    // Die Falle: `coolify_ui` sieht nach einer Regel von `coolify` aus, ist aber
    // ein eigener Dienst mit eigener Domain. Wer beim Löschen nach dem Präfix
    // geht, nimmt eine fremde Seite offline.
    const beides = addService(addService(CONFIG, COOLIFY), {
      ...COOLIFY,
      id: 'coolify_ui',
      domains: ['ui.example.org'],
      routes: [],
      preset: 'default',
    });

    const zurueck = removeService(beides, 'coolify');
    const services = parseHaproxyConfig(zurueck);
    expect(services.map((s) => s.id)).toEqual(['coolify_ui']);
    expect(zurueck).toContain('backend coolify_ui');
    expect(zurueck).not.toContain('backend coolify_terminal');
  });

  it('ersetzt einen Dienst samt Regeln in einem Zug', () => {
    const text = addService(CONFIG, COOLIFY);
    const next = replaceService(text, 'coolify', {
      ...COOLIFY,
      routes: [{ ...COOLIFY.routes[0], servers: [{ name: 'coolify', target: '10.10.0.9:6002' }] }],
    });

    const service = find(next, 'coolify');
    expect(service.routes).toHaveLength(1);
    expect(service.routes[0].servers[0].target).toBe('10.10.0.9:6002');
    // Die weggefallene Regel darf nirgends mehr stehen.
    expect(next).not.toContain('coolify_realtime');
  });
});

describe('anlegen weist ab', () => {
  it('wenn der Backend-Name einer Regel schon vergeben ist', () => {
    const belegt = addService(CONFIG, {
      ...COOLIFY,
      id: 'coolify_terminal',
      domains: ['terminal.example.org'],
      routes: [],
      preset: 'default',
    });
    expect(() => addService(belegt, COOLIFY)).toThrow(HaproxyConfigError);
    expect(() => addService(belegt, COOLIFY)).toThrow(/coolify_terminal/);
  });
});

describe('validateCreateInput', () => {
  it('nimmt den Coolify-Fall an', () => {
    expect(validateCreateInput(COOLIFY)).toBeNull();
  });

  it('lehnt zwei Regeln mit demselben Namen ab', () => {
    const doppelt = { ...COOLIFY, routes: [COOLIFY.routes[0], COOLIFY.routes[0]] };
    expect(validateCreateInput(doppelt)).toMatch(/steht doppelt/);
  });

  it('lehnt denselben Pfad in zwei Regeln ab', () => {
    // Die zweite griffe nie: HAProxy nimmt die erste passende Weiche.
    const doppelt = {
      ...COOLIFY,
      routes: [COOLIFY.routes[0], { ...COOLIFY.routes[1], paths: ['/terminal/ws'] }],
    };
    expect(validateCreateInput(doppelt)).toMatch(/steht in zwei Regeln/);
  });

  it('lehnt eine Regel ohne Pfad und mit ungültigem Pfad ab', () => {
    expect(validateCreateInput({ ...COOLIFY, routes: [{ ...COOLIFY.routes[0], paths: [] }] }))
      .toMatch(/keinen Pfad/);
    expect(validateCreateInput({ ...COOLIFY, routes: [{ ...COOLIFY.routes[0], paths: ['app'] }] }))
      .toMatch(/muss mit \/ beginnen/);
  });

  it('lehnt einen Regelnamen ab, der kein Backend-Name werden kann', () => {
    expect(validateCreateInput({ ...COOLIFY, routes: [{ ...COOLIFY.routes[0], name: 'Term-1' }] }))
      .toMatch(/Ungültiger Name der Pfad-Regel/);
  });

  it('lehnt eine Regel ohne Ziel ab', () => {
    expect(validateCreateInput({ ...COOLIFY, routes: [{ ...COOLIFY.routes[0], servers: [] }] }))
      .toMatch(/Pfad-Regel/);
  });
});

describe('readServiceInput', () => {
  it('liest Regeln aus dem Rumpf und überlebt Unsinn darin', () => {
    const input = readServiceInput({
      routes: [
        { name: ' Terminal ', paths: [' /a ', ''], servers: [{ target: '10.0.0.1:1' }], check: true },
        null,
      ],
    });
    expect(input.routes[0]).toEqual({
      name: 'terminal',
      paths: ['/a'],
      // Ohne `weight`: eine Pfad-Regel verteilt nichts. Ein mitgeschicktes
      // Feld fällt hier weg und nicht erst beim Schreiben.
      servers: [{ name: '', target: '10.0.0.1:1' }],
      check: true,
    });
    expect(input.routes[1]).toEqual({ name: '', paths: [], servers: [], check: false });
  });

  it('macht aus einem Rumpf ohne Regeln eine leere Liste', () => {
    expect(readServiceInput({ id: 'x' }).routes).toEqual([]);
  });
});
