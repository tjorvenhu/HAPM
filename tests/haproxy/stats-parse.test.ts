import { describe, it, expect } from 'vitest';
import {
  counterDelta,
  hasMeasurement,
  parseProcessInfo,
  parseStatRows,
  statRates,
  usableGap,
  MAX_GAP_MS,
  type StatCounters,
  type StatSnapshot,
} from '@/lib/haproxy/stats-parse';

/**
 * HAProxys eigene Statistik, zurückgelesen.
 *
 * Die CSV unten hat den Spaltensatz einer echten `show stat`-Ausgabe — samt der
 * Spalten, die dieses Modul gar nicht liest. Genau darum geht es: die Zuordnung
 * läuft über die Kopfzeile, und ein Test, der nur die gebrauchten Spalten
 * enthält, hätte bei einer festen Feldnummer ebenfalls bestanden.
 */

const COLUMNS =
  '# pxname,svname,qcur,qmax,scur,smax,slim,stot,bin,bout,dreq,dresp,ereq,econ,eresp,' +
  'wretr,wredis,status,weight,act,bck,chkfail,chkdown,lastchg,downtime,qlimit,pid,iid,sid,' +
  'throttle,lbtot,tracked,type,rate,rate_lim,rate_max,check_status,check_code,check_duration,' +
  'hrsp_1xx,hrsp_2xx,hrsp_3xx,hrsp_4xx,hrsp_5xx,hrsp_other,hanafail,req_rate,req_rate_max,' +
  'req_tot,cli_abrt,srv_abrt,comp_in,comp_out,comp_byp,comp_rsp,lastsess,last_chk,last_agt,' +
  'qtime,ctime,rtime,ttime,';

/** Eine Zeile bauen, damit im Test nur dasteht, was er meint. */
function row(values: Record<string, string | number>): string {
  const names = COLUMNS.replace(/^#\s*/, '').split(',');
  return names.map((name) => String(values[name] ?? '')).join(',');
}

const CSV = [
  COLUMNS,
  row({
    pxname: 'https-in', svname: 'FRONTEND', scur: 42, smax: 310, stot: 98000,
    bin: 51200, bout: 2097152, dreq: 12, ereq: 3,
    hrsp_1xx: 1, hrsp_2xx: 90000, hrsp_3xx: 5000, hrsp_4xx: 2900, hrsp_5xx: 99, hrsp_other: 0,
    req_tot: 98000, status: 'OPEN',
  }),
  row({
    pxname: 'kunde_shop', svname: 'srv1', scur: 3, stot: 1200, status: 'UP',
  }),
  row({
    pxname: 'kunde_shop', svname: 'BACKEND', scur: 4, smax: 40, stot: 1500,
    bin: 2048, bout: 409600, dresp: 1, econ: 2, eresp: 5, wretr: 7, wredis: 1,
    hrsp_2xx: 1400, hrsp_3xx: 40, hrsp_4xx: 55, hrsp_5xx: 5, hrsp_other: 0,
    req_tot: 1500, qtime: 0, ctime: 1, rtime: 87, ttime: 91, status: 'UP',
  }),
].join('\n');

describe('parseStatRows', () => {
  const rows = parseStatRows(CSV);

  it('liest genau die Sammelzeilen — die Server-Zeilen bleiben draußen', () => {
    // Die Zahlen einer server-Zeile stecken in der BACKEND-Zeile ihres
    // Abschnitts schon drin. Mitgezählt wäre jede Anfrage doppelt.
    expect(rows.map((r) => `${r.scope}/${r.kind}`)).toEqual([
      'https-in/frontend',
      'kunde_shop/backend',
    ]);
  });

  it('rechnet die Sammelspalten zusammen', () => {
    const backend = rows[1];
    // dreq + dresp
    expect(backend.denied).toBe(1);
    // ereq + econ + eresp
    expect(backend.errors).toBe(7);
    // wretr + wredis
    expect(backend.retries).toBe(8);
    // hrsp_1xx + hrsp_other
    expect(backend.httpOther).toBe(0);
    expect(rows[0].httpOther).toBe(1);
  });

  it('nimmt req_tot und hält stot daneben', () => {
    expect(rows[1].requests).toBe(1500);
    expect(rows[1].sessions).toBe(1500);
    expect(rows[1].responseMs).toBe(87);
    expect(rows[1].totalMs).toBe(91);
    expect(rows[1].sessionsCurrent).toBe(4);
    expect(rows[1].sessionsMax).toBe(40);
  });

  it('findet die Spalten über die Kopfzeile und nicht über ihre Nummer', () => {
    // Dieselben Daten, aber vier Spalten weiter vorn eingeschoben. Eine feste
    // Feldnummer läse hier irgendeine andere Zahl und meldete sie als
    // Antwortzeit — und das fiele nie auf, weil eine plausible herauskommt.
    const shifted = CSV.split('\n')
      .map((line) =>
        line.startsWith('#')
          ? line.replace('# pxname', '# a,b,pxname')
          : `1,2,${line}`
      )
      .join('\n');
    expect(parseStatRows(shifted)[1].responseMs).toBe(87);
  });

  it('macht aus einer fehlenden Spalte unbekannt und nicht 0', () => {
    // Eine ältere HAProxy-Version kennt hrsp_other nicht. Als 0 gelesen stünde
    // dort „null Anfragen dieser Art" statt „diese Version sagt nichts dazu".
    const withoutTiming = ['# pxname,svname,stot', 'a,BACKEND,5'].join('\n');
    const parsed = parseStatRows(withoutTiming)[0];
    expect(parsed.responseMs).toBeNull();
    expect(parsed.httpOther).toBeNull();
    expect(parsed.denied).toBeNull();
    // stot ist da, req_tot nicht: dann zählt die Sitzung.
    expect(parsed.requests).toBe(5);
  });

  it('gibt bei einer Ausgabe ohne Kopfzeile nichts zurück', () => {
    expect(parseStatRows('irgendwas\n')).toEqual([]);
    expect(parseStatRows('')).toEqual([]);
  });
});

describe('parseProcessInfo', () => {
  it('liest die Zeilen von show info', () => {
    const info = parseProcessInfo(
      [
        'Name: HAProxy',
        'Version: 2.8.5-1ppa1~jammy',
        'Uptime_sec: 86401',
        'CurrConns: 17',
        'CumReq: 4120933',
        'ConnRate: 12',
        'Idle_pct: 98',
        'Maxconn: 4000',
      ].join('\n')
    );
    expect(info.version).toBe('2.8.5-1ppa1~jammy');
    expect(info.uptimeSec).toBe(86401);
    expect(info.cumulativeRequests).toBe(4120933);
    expect(info.idlePct).toBe(98);
  });

  it('macht aus einer fehlenden Zeile null', () => {
    const info = parseProcessInfo('Name: HAProxy\n');
    expect(info.uptimeSec).toBeNull();
    expect(info.idlePct).toBeNull();
  });
});

/* ── Die Differenzen ── */

const ZERO: StatCounters = {
  scope: 'x', kind: 'backend',
  requests: null, sessions: null,
  http2xx: null, http3xx: null, http4xx: null, http5xx: null, httpOther: null,
  bytesIn: null, bytesOut: null,
  denied: null, errors: null, retries: null,
  responseMs: null, totalMs: null, queueMs: null,
  sessionsCurrent: null, sessionsMax: null,
};

function snap(at: number, requests: number, uptimeSec: number, bytesOut = 0): StatSnapshot {
  return { at, counters: { ...ZERO, requests, bytesOut }, uptimeSec };
}

describe('usableGap', () => {
  it('ohne Vorgängerin gibt es kein Fenster', () => {
    expect(usableGap(null, 1000)).toBeNull();
  });

  it('zwei Proben in derselben Sekunde messen nichts', () => {
    expect(usableGap({ at: 1000 }, 3000)).toBeNull();
  });

  it('eine zu große Lücke ist kein Fünf-Minuten-Fenster mehr', () => {
    // Stand HAPM dazwischen, ergäbe die Differenz eine saubere Summe
    // über die ganze Auszeit — gezeichnet als EIN Balken wäre das eine Spitze,
    // die es nie gab.
    expect(usableGap({ at: 0 }, MAX_GAP_MS + 1)).toBeNull();
    expect(usableGap({ at: 0 }, 5 * 60_000)).toBe(300_000);
  });
});

describe('counterDelta', () => {
  it('rechnet die Differenz', () => {
    expect(counterDelta(100, 250)).toBe(150);
  });

  it('macht aus einem Rücksprung unbekannt und nicht 0', () => {
    expect(counterDelta(500, 3)).toBeNull();
    expect(counterDelta(null, 3)).toBeNull();
    expect(counterDelta(3, null)).toBeNull();
  });
});

describe('statRates', () => {
  it('die erste Probe hat keine Differenz', () => {
    const rates = statRates(null, snap(300_000, 1000, 900));
    expect(rates.requests).toBeNull();
    expect(rates.bytesOutKb).toBeNull();
  });

  it('rechnet das Fenster aus zwei Proben', () => {
    const rates = statRates(snap(0, 1000, 600, 1024), snap(300_000, 1600, 900, 1024 * 1024));
    expect(rates.requests).toBe(600);
    expect(rates.bytesOutKb).toBe(1023);
  });

  it('erkennt einen Reload an der Laufzeit, auch wenn die Zähler NICHT zurücksprangen', () => {
    /*
     * Der Fall, für den `uptimeSec` mitläuft: zwischen den Proben wurde neu
     * geladen, und danach kamen MEHR Anfragen als vorher gezählt waren. Der
     * Zählerstand steigt, die Differenz sieht plausibel aus — und ist trotzdem
     * falsch, weil sie zwei verschiedene Prozesse vergleicht.
     */
    const before = snap(0, 1000, 7200);
    const after = snap(300_000, 1500, 120);
    expect(statRates(before, after).requests).toBeNull();
  });

  it('übernimmt die Mittelwerte auch ohne Vorgängerin', () => {
    // Sie sind die einzigen Werte, die schon aus EINER Probe stimmen: HAProxy
    // führt sie als gleitendes Mittel und nicht als Zähler.
    const current: StatSnapshot = {
      at: 1000,
      counters: { ...ZERO, responseMs: 87.6, sessionsCurrent: 4 },
      uptimeSec: 100,
    };
    const rates = statRates(null, current);
    expect(rates.responseMs).toBe(88);
    expect(rates.sessionsCurrent).toBe(4);
    expect(rates.requests).toBeNull();
  });
});

describe('hasMeasurement', () => {
  it('eine Zeile aus lauter Unbekanntem ist keine Messung', () => {
    const empty = statRates(null, { at: 0, counters: ZERO, uptimeSec: null });
    expect(hasMeasurement(empty)).toBe(false);
  });

  it('ein einziger bekannter Wert reicht', () => {
    const some = statRates(null, {
      at: 0,
      counters: { ...ZERO, sessionsCurrent: 0 },
      uptimeSec: null,
    });
    expect(hasMeasurement(some)).toBe(true);
  });
});
