import { describe, it, expect } from 'vitest';
import {
  EMPTY_SETUP,
  INTERRUPTED,
  certificateDomains,
  certificateFactsOf,
  certificatePathOpen,
  executionOutcome,
  executionPlan,
  hapmServiceInput,
  judgeAddresses,
  listenPort,
  newExecution,
  normalizeSetupDomain,
  pickServerAddresses,
  resumeStep,
  settleExecution,
  stepReached,
  validateSetupDomain,
  validateWildcardBase,
  wildcardBaseOf,
  wildcardPossible,
  type CertificateFacts,
  type SetupChoices,
} from '@/lib/setup/rules';
import { validateCreateInput } from '@/lib/haproxy/config';
import { judgeTokenResponse } from '@/lib/setup/token-check';
import { withDefaults, setupOpen } from '@/lib/settings';

/**
 * Der Assistent der Einrichtung: welcher Schritt als Nächstes kommt, was als
 * Domain durchgeht und was das Ausführen tut.
 *
 * Der Schritt wird aus dem Zustand abgeleitet. Daran hängt das Fortsetzen nach
 * einem Abbruch: wer die Seite schließt und in drei Tagen wiederkommt, landet
 * dort, wo noch etwas fehlt, und nicht dort, wo ein Zähler stehen geblieben ist.
 */

const ACCOUNT = { hasAccount: true, dnsHooks: [] as string[] | null };

function state(patch: Partial<SetupChoices>): SetupChoices {
  return { ...EMPTY_SETUP, ...patch };
}

describe('resumeStep', () => {
  it('ohne Konto: das Konto', () => {
    expect(resumeStep(EMPTY_SETUP, { hasAccount: false, dnsHooks: null })).toBe('account');
  });

  it('nach dem Konto: die Erreichbarkeit', () => {
    expect(resumeStep(EMPTY_SETUP, ACCOUNT)).toBe('exposure');
  });

  it('nach der Erreichbarkeit: der DNS-Anbieter, intern wie öffentlich', () => {
    expect(resumeStep(state({ exposure: 'internal' }), ACCOUNT)).toBe('dns');
    expect(resumeStep(state({ exposure: 'public' }), ACCOUNT)).toBe('dns');
  });

  it('öffentlich darf den DNS-Anbieter überspringen', () => {
    expect(resumeStep(state({ exposure: 'public', dns: 'skipped' }), ACCOUNT)).toBe('certificates');
  });

  it('ein eigener DNS-Server ist eine Antwort, intern wie öffentlich', () => {
    expect(resumeStep(state({ exposure: 'internal', dns: 'manual' }), ACCOUNT)).toBe('certificates');
    expect(resumeStep(state({ exposure: 'public', dns: 'manual' }), ACCOUNT)).toBe('certificates');
  });

  it('intern nicht: ein übersprungener Anbieter kommt wieder', () => {
    // Der Fall: erst „öffentlich" gewählt und übersprungen, dann auf „intern" umgestellt.
    expect(resumeStep(state({ exposure: 'internal', dns: 'skipped' }), ACCOUNT)).toBe('dns');
  });

  it('ein gewählter Anbieter zählt nur, solange sein Hook eingerichtet ist', () => {
    const chosen = state({ exposure: 'internal', dns: 'configured', dnsHook: 'dns_cf', certificates: 'set' });
    expect(resumeStep(chosen, { hasAccount: true, dnsHooks: ['dns_cf'] })).toBe('address');
    // Jemand hat die Zugangsdaten inzwischen entfernt.
    expect(resumeStep(chosen, { hasAccount: true, dnsHooks: [] })).toBe('dns');
    expect(resumeStep(chosen, { hasAccount: true, dnsHooks: ['dns_hetznercloud'] })).toBe('dns');
  });

  it('unbekannte Hooks werfen niemanden zurück', () => {
    // HAProxy antwortet gerade nicht: das ist keine Auskunft über die Zugangsdaten.
    const chosen = state({ exposure: 'internal', dns: 'configured', dnsHook: 'dns_cf', certificates: 'set' });
    expect(resumeStep(chosen, { hasAccount: true, dnsHooks: null })).toBe('address');
  });

  it('mit Adresse: das Ausführen', () => {
    const ready = state({
      exposure: 'internal',
      dns: 'configured',
      dnsHook: 'dns_cf',
      certificates: 'set',
      address: 'set',
      domain: 'hapm.example.org',
      wildcard: true,
      wildcardBase: 'example.org',
    });
    expect(resumeStep(ready, { hasAccount: true, dnsHooks: ['dns_cf'] })).toBe('run');
  });

  it('öffentlich ohne Adresse ist fertig, intern nicht', () => {
    expect(
      resumeStep(state({ exposure: 'public', dns: 'skipped', certificates: 'set', address: 'skipped' }), ACCOUNT)
    ).toBe('done');
    expect(
      resumeStep(
        state({ exposure: 'internal', dns: 'configured', dnsHook: 'dns_cf', certificates: 'set', address: 'skipped' }),
        { hasAccount: true, dnsHooks: ['dns_cf'] }
      )
    ).toBe('address');
  });

  it('eine Wildcard ohne Anbieter führt zurück zur Adresse', () => {
    const broken = state({
      exposure: 'public',
      dns: 'skipped',
      certificates: 'set',
      address: 'set',
      domain: 'hapm.example.org',
      wildcard: true,
      wildcardBase: 'example.org',
    });
    expect(resumeStep(broken, ACCOUNT)).toBe('address');
  });

  it('setzt nach einem Abbruch dort fort, wo etwas fehlt', () => {
    // Ein gescheitertes Ausführen ändert den Schritt nicht: er bleibt „Ausführen".
    const failed = state({
      exposure: 'public',
      dns: 'skipped',
      certificates: 'set',
      address: 'set',
      domain: 'hapm.example.org',
      execution: {
        startedAt: '2026-11-24T10:00:00.000Z',
        running: false,
        stages: [{ key: 'scope', status: 'error', detail: 'kaputt', runId: null }],
      },
    });
    expect(resumeStep(failed, ACCOUNT)).toBe('run');
  });
});

describe('die Zertifikatsfrage', () => {
  const LE: CertificateFacts = { source: 'acme', customServer: false, httpReachable: false };
  const CUSTOM: CertificateFacts = { source: 'acme', customServer: true, httpReachable: false };
  const CUSTOM_HTTP: CertificateFacts = { source: 'acme', customServer: true, httpReachable: true };
  const UPLOAD: CertificateFacts = { source: 'upload', customServer: false, httpReachable: false };

  it('kommt nach dem DNS-Anbieter und bleibt, bis sie beantwortet ist', () => {
    const answered = state({ exposure: 'public', dns: 'manual', certificates: 'set' });
    expect(resumeStep({ ...answered, certificates: 'pending' }, { ...ACCOUNT, certificates: LE })).toBe('certificates');
    expect(resumeStep(answered, { ...ACCOUNT, certificates: LE })).toBe('address');
  });

  it("intern mit eigenem DNS-Server: Let's Encrypt hat keinen Weg", () => {
    const manual = { exposure: 'internal' as const, dns: 'manual' as const };
    expect(certificatePathOpen(manual, LE)).toBe(false);
    expect(certificatePathOpen(manual, CUSTOM)).toBe(false);
    expect(certificatePathOpen(manual, CUSTOM_HTTP)).toBe(true);
    expect(certificatePathOpen(manual, UPLOAD)).toBe(true);
    // Eine gespeicherte Antwort ohne Weg zählt nicht: zurück zur Frage.
    const stuck = state({ ...manual, certificates: 'set' });
    expect(resumeStep(stuck, { ...ACCOUNT, certificates: LE })).toBe('certificates');
    expect(resumeStep(stuck, { ...ACCOUNT, certificates: CUSTOM_HTTP })).toBe('address');
    expect(resumeStep(stuck, { ...ACCOUNT, certificates: UPLOAD })).toBe('address');
  });

  it('öffentlich oder mit DNS-Anbieter geht jeder Weg', () => {
    for (const facts of [LE, CUSTOM, CUSTOM_HTTP, UPLOAD]) {
      expect(certificatePathOpen({ exposure: 'public', dns: 'manual' }, facts)).toBe(true);
      expect(certificatePathOpen({ exposure: 'internal', dns: 'configured' }, facts)).toBe(true);
    }
  });

  it('eine Wildcard gibt es nur über ACME mit DNS-Anbieter', () => {
    expect(wildcardPossible({ dns: 'configured' }, LE)).toBe(true);
    expect(wildcardPossible({ dns: 'configured' }, CUSTOM_HTTP)).toBe(true);
    expect(wildcardPossible({ dns: 'configured' }, UPLOAD)).toBe(false);
    expect(wildcardPossible({ dns: 'manual' }, LE)).toBe(false);
    const wildcard = state({
      exposure: 'internal',
      dns: 'configured',
      dnsHook: 'dns_cf',
      certificates: 'set',
      address: 'set',
      domain: 'hapm.example.org',
      wildcard: true,
      wildcardBase: 'example.org',
    });
    expect(resumeStep(wildcard, { hasAccount: true, dnsHooks: ['dns_cf'], certificates: UPLOAD })).toBe('address');
  });

  it('liest die Einstellungen: HTTP nur mit eigenem Server', () => {
    expect(certificateFactsOf({ certificateSource: 'acme', acmeDirectory: null, acmeHttpReachable: true })).toEqual(LE);
    expect(
      certificateFactsOf({ certificateSource: 'acme', acmeDirectory: 'https://ca.example.org/dir', acmeHttpReachable: true })
    ).toEqual(CUSTOM_HTTP);
  });
});

describe('stepReached', () => {
  it('lässt zurück, aber nicht voraus', () => {
    expect(stepReached('exposure', 'address')).toBe(true);
    expect(stepReached('address', 'address')).toBe(true);
    expect(stepReached('run', 'address')).toBe(false);
  });
});

describe('die Domain der Oberfläche', () => {
  it('nimmt eine eingefügte Adresse', () => {
    expect(normalizeSetupDomain('  https://HAPM.Example.org/ ')).toBe('hapm.example.org');
    expect(normalizeSetupDomain('hapm.example.org.')).toBe('hapm.example.org');
  });

  it('lässt einen Domainnamen durch', () => {
    expect(validateSetupDomain('hapm.example.org')).toBeNull();
    expect(validateSetupDomain('hapm.intern.example.org')).toBeNull();
  });

  it.each(['', '*.example.org', '10.0.0.5', '2001:db8::1', 'hapm', 'hapm example.org', 'hapm.example.org/pfad'])(
    'lehnt %j ab',
    (domain) => {
      expect(validateSetupDomain(domain)).not.toBeNull();
    }
  );
});

describe('die Basis der Wildcard', () => {
  it('ist die Domain ohne ihr erstes Label', () => {
    expect(wildcardBaseOf('hapm.example.org')).toBe('example.org');
    expect(wildcardBaseOf('hapm.intern.example.org')).toBe('intern.example.org');
  });

  it('gibt es nicht, wenn nur eine Endung übrig bliebe', () => {
    expect(wildcardBaseOf('example.org')).toBeNull();
    expect(wildcardBaseOf('hapm')).toBeNull();
  });

  it('muss die Domain der Oberfläche abdecken', () => {
    expect(validateWildcardBase('hapm.example.org', 'example.org')).toBeNull();
    // Eine Wildcard gilt für genau eine Ebene.
    expect(validateWildcardBase('hapm.intern.example.org', 'example.org')).not.toBeNull();
    expect(validateWildcardBase('hapm.example.org', 'example.net')).not.toBeNull();
  });

  it('lehnt einen Stern, eine Endung und Leeres ab', () => {
    expect(validateWildcardBase('hapm.example.org', '*.example.org')).not.toBeNull();
    expect(validateWildcardBase('hapm.org', 'org')).not.toBeNull();
    expect(validateWildcardBase('hapm.example.org', '')).not.toBeNull();
  });
});

describe('certificateDomains', () => {
  it('ohne Wildcard nur die eine Domain', () => {
    expect(certificateDomains({ domain: 'hapm.example.org', wildcard: false, wildcardBase: null })).toEqual([
      'hapm.example.org',
    ]);
  });

  it('mit Wildcard die Basis samt Wildcard', () => {
    expect(
      certificateDomains({ domain: 'hapm.example.org', wildcard: true, wildcardBase: 'example.org' })
    ).toEqual(['example.org', '*.example.org']);
  });
});

describe('das Ziel der Oberfläche', () => {
  it('ist eine Eingabe, die die Prüfung der Ziele besteht', () => {
    const input = hapmServiceInput('hapm.example.org', 7080);
    expect(validateCreateInput(input)).toBeNull();
    expect(input.id).toBe('hapm');
    expect(input.scope).toBe('HAPM');
    expect(input.servers.map((server) => server.target)).toEqual(['127.0.0.1:7080']);
  });

  it('nimmt den Port aus der Umgebung, sonst 7080', () => {
    expect(listenPort('9000')).toBe(9000);
    expect(listenPort(undefined)).toBe(7080);
    expect(listenPort('abc')).toBe(7080);
    expect(listenPort('0')).toBe(7080);
  });
});

describe('executionPlan', () => {
  const base = { domain: 'hapm.example.org', wildcard: false, wildcardBase: null };

  it('öffentlich ohne Wildcard: ohne DNS-Schritt', () => {
    expect(executionPlan({ ...base, exposure: 'public' })).toEqual([
      'scope',
      'certificate',
      'service',
      'publicUrl',
    ]);
  });

  it('intern: die DNS-Zugangsdaten zuerst', () => {
    expect(executionPlan({ ...base, exposure: 'internal' })[0]).toBe('dns');
  });

  it('öffentlich mit Wildcard: ebenfalls', () => {
    expect(
      executionPlan({ exposure: 'public', domain: 'hapm.example.org', wildcard: true, wildcardBase: 'example.org' })[0]
    ).toBe('dns');
  });

  it('intern mit einem ACME-Server, der HAPM über Port 80 erreicht: ohne DNS-Schritt', () => {
    expect(
      executionPlan({ ...base, exposure: 'internal' }, { source: 'acme', customServer: true, httpReachable: true })[0]
    ).toBe('scope');
  });

  it('nur hochladen: nie ein DNS-Schritt, auch nicht mit Wildcard', () => {
    const upload = { source: 'upload' as const, customServer: false, httpReachable: false };
    expect(executionPlan({ ...base, exposure: 'internal' }, upload)).not.toContain('dns');
    expect(
      executionPlan({ exposure: 'public', domain: 'hapm.example.org', wildcard: true, wildcardBase: 'example.org' }, upload)
    ).not.toContain('dns');
  });
});

describe('settleExecution', () => {
  const started = newExecution(['scope', 'certificate'], '2026-11-24T10:00:00.000Z');
  const midway = {
    ...started,
    stages: [
      { ...started.stages[0], status: 'ok' as const },
      { ...started.stages[1], status: 'running' as const },
    ],
  };

  it('lässt ein laufendes Ausführen stehen, solange der Prozess daran arbeitet', () => {
    expect(settleExecution(midway, true)).toBe(midway);
    expect(executionOutcome(settleExecution(midway, true))).toBe('running');
  });

  it('liest es nach einem Neustart als abgebrochen', () => {
    const settled = settleExecution(midway, false)!;
    expect(settled.running).toBe(false);
    expect(settled.stages.map((stage) => stage.status)).toEqual(['ok', 'error']);
    expect(settled.stages[1].detail).toBe(INTERRUPTED);
    expect(executionOutcome(settled)).toBe('failed');
  });

  it('fasst ein beendetes nicht an', () => {
    const done = { ...midway, running: false };
    expect(settleExecution(done, false)).toBe(done);
    expect(settleExecution(null, false)).toBeNull();
  });
});

describe('executionOutcome', () => {
  const started = newExecution(['scope', 'publicUrl'], '2026-11-24T10:00:00.000Z');

  it('ohne Ausführen: nichts', () => {
    expect(executionOutcome(null)).toBe('idle');
  });

  it('gelungen erst, wenn jeder Schritt gelungen ist', () => {
    const ok = { ...started, running: false, stages: started.stages.map((stage) => ({ ...stage, status: 'ok' as const })) };
    expect(executionOutcome(ok)).toBe('succeeded');
    const half = { ...ok, stages: [ok.stages[0], { ...ok.stages[1], status: 'pending' as const }] };
    expect(executionOutcome(half)).toBe('idle');
  });
});

describe('die Adressen des Servers', () => {
  it('ohne Loopback und ohne link-lokale, IPv4 zuerst', () => {
    expect(
      pickServerAddresses({
        lo: [
          { address: '127.0.0.1', family: 'IPv4', internal: true },
          { address: '::1', family: 'IPv6', internal: true },
        ],
        eth0: [
          { address: 'fe80::1', family: 'IPv6', internal: false },
          { address: '2001:db8::5', family: 'IPv6', internal: false },
          { address: '192.0.2.5', family: 'IPv4', internal: false },
        ],
        eth1: [{ address: '169.254.10.1', family: 'IPv4', internal: false }],
        down: undefined,
      })
    ).toEqual(['192.0.2.5', '2001:db8::5']);
  });
});

describe('judgeAddresses', () => {
  const own = ['192.0.2.5', '2001:db8::5'];

  it('passt, wenn eine der Adressen diesem Server gehört', () => {
    expect(judgeAddresses(['192.0.2.5'], own)).toBe('matches');
    expect(judgeAddresses(['198.51.100.9', '2001:DB8::5'], own)).toBe('matches');
  });

  it('zeigt woandershin', () => {
    expect(judgeAddresses(['198.51.100.9'], own)).toBe('elsewhere');
  });

  it('löst nicht auf', () => {
    expect(judgeAddresses([], own)).toBe('unresolved');
  });

  it('eine gescheiterte Abfrage ist unbekannt, nicht „löst nicht auf"', () => {
    expect(judgeAddresses(null, own)).toBe('unknown');
  });
});

describe('judgeTokenResponse', () => {
  it('nimmt eine gelungene Antwort an', () => {
    expect(judgeTokenResponse('Cloudflare', 200)).toEqual({ result: 'accepted' });
  });

  it.each([400, 401, 403])('liest %i als Ablehnung und sagt, dass nichts gespeichert wurde', (status) => {
    const check = judgeTokenResponse('Hetzner', status);
    expect(check.result).toBe('rejected');
    expect((check as { message: string }).message).toContain('Hetzner');
    expect((check as { message: string }).message).toContain('nichts gespeichert');
  });

  it.each([429, 500, 503])('behauptet bei %i nichts', (status) => {
    // Ein Ausfall beim Anbieter ist kein falscher Token.
    expect(judgeTokenResponse('Cloudflare', status).result).toBe('unknown');
  });
});

describe('die Einstellungen dazu', () => {
  it('eine Zeile von vor dem Assistenten ist öffentlich und gilt als abgeschlossen', () => {
    const settings = withDefaults({ acmeEmail: 'ops@example.org' });
    expect(settings.exposure).toBe('public');
    expect(settings.setupStatus).toBeNull();
    expect(setupOpen(settings)).toBe(false);
  });

  it('offen ist nur, was ausdrücklich offen ist', () => {
    expect(setupOpen({ setupStatus: 'open' })).toBe(true);
    expect(setupOpen({ setupStatus: 'skipped' })).toBe(false);
    expect(setupOpen({ setupStatus: 'done' })).toBe(false);
  });

  it('liest einen unbekannten Wert als Vorgabe', () => {
    const settings = withDefaults({ exposure: 'beides' as never, setupStatus: 'vielleicht' as never });
    expect(settings.exposure).toBe('public');
    expect(settings.setupStatus).toBeNull();
  });
});
