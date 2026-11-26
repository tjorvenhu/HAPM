import { describe, it, expect } from 'vitest';
import { parseCrowdsecLogLine, parseLogfmt } from '@/lib/crowdsec/log-lines';

/** Zeilen, wie CrowdSec 1.8.2 und der SPOA-Bouncer 0.3.1 sie schreiben. */

describe('parseCrowdsecLogLine', () => {
  it('liest eine Anfrage an die lokale API und nennt sie Routine', () => {
    const line = parseCrowdsecLogLine(
      'time="2026-11-26T11:12:39+01:00" level=info msg="172.18.0.3 - [Thu, 26 Nov 2026 11:12:39 CET] \\"GET /v1/decisions/stream?additional_pull=false&community_pull=false HTTP/1.1 200 22.289921ms \\"crowdsec-spoa-bouncer/v0.3.1-4705eac\\" \\"\\"" module=lapi'
    );
    expect(line.time).toBe('2026-11-26T10:12:39.000Z');
    expect(line.level).toBe('info');
    expect(line.fields).toEqual({ module: 'lapi' });
    expect(line.request).toEqual({
      client: '172.18.0.3',
      method: 'GET',
      path: '/v1/decisions/stream?additional_pull=false&community_pull=false',
      status: 200,
      durationMs: 22.289921,
      agent: 'crowdsec-spoa-bouncer/v0.3.1-4705eac',
    });
    expect(line.routine).toBe(true);
  });

  it('liest die Zeile so, wie CrowdSec 1.8 sie wirklich schreibt (Referer ohne Gegenstück)', () => {
    const line = parseCrowdsecLogLine(
      'time="2026-11-26T11:12:36+01:00" level=info msg="127.0.0.1 - [Thu, 26 Nov 2026 11:12:36 CET] \\"POST /v1/watchers/login HTTP/1.1 200 65.520517ms \\"crowdsec/v1.8.2-3d369d64-docker\\" \\"" module=lapi'
    );
    expect(line.request).toMatchObject({ method: 'POST', path: '/v1/watchers/login', status: 200, agent: 'crowdsec/v1.8.2-3d369d64-docker' });
    expect(line.routine).toBe(true);
  });

  it('eine abgelehnte Anfrage ist keine Routine', () => {
    const line = parseCrowdsecLogLine(
      'time="2026-11-26T11:12:39+01:00" level=info msg="172.18.0.3 - [Thu, 26 Nov 2026 11:12:39 CET] \\"GET /v1/decisions/stream HTTP/1.1 403 1.2ms \\"crowdsec-spoa-bouncer/v0.3.1\\" \\"\\"" module=lapi'
    );
    expect(line.request?.status).toBe(403);
    expect(line.routine).toBe(false);
  });

  it('liest Meldungen des Bouncers mit Komponente und Stufe', () => {
    const line = parseCrowdsecLogLine(
      'time="2026-11-26T08:12:59Z" level=error msg="empty captcha provider" has_ban=true has_captcha=false host="*"'
    );
    expect(line.level).toBe('error');
    expect(line.message).toBe('empty captcha provider');
    expect(line.fields).toEqual({ has_ban: 'true', has_captcha: 'false', host: '*' });
    expect(line.request).toBeNull();
    expect(line.routine).toBe(false);
  });

  it('übernimmt `warn` als Warnung', () => {
    expect(parseCrowdsecLogLine('time="2026-11-26T08:12:59Z" level=warning msg="x"').level).toBe('warning');
    expect(parseCrowdsecLogLine('time="2026-11-26T08:12:59Z" level=warn msg="x"').level).toBe('warning');
  });

  it('lässt fremde Zeilen als Text stehen', () => {
    const line = parseCrowdsecLogLine('Populating configuration directory...');
    expect(line).toEqual({ time: null, level: null, message: 'Populating configuration directory...', fields: {}, request: null, routine: false });
  });
});

describe('parseLogfmt', () => {
  it('liest Werte mit Leerzeichen und maskierten Anführungszeichen', () => {
    expect(parseLogfmt('a=1 b="x y" c="q\\"z"')).toEqual({ a: '1', b: 'x y', c: 'q"z' });
  });

  it('gibt bei keinem Feld null zurück', () => {
    expect(parseLogfmt('kein feld hier')).toBeNull();
  });
});
