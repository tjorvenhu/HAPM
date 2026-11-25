import { describe, it, expect } from 'vitest';
import { parseDefaultsTunnel } from '@/lib/haproxy/config';

/**
 * Ob „Lange Verbindungen“ schon für alle Ziele gilt: ein `timeout tunnel` in
 * dem `defaults`-Abschnitt, den HAProxy auf die Backends von HAPM anwendet.
 */

const config = (defaults: string, extra = '') => `global
    log stdout format raw local0

defaults
    mode http
    timeout client 50s
${defaults}
frontend https
    bind :443
    # BEGIN AUTO WEB SERVICES
    # END AUTO WEB SERVICES
${extra}
# BEGIN AUTO WEB BACKENDS
backend app
    server server1 10.0.0.5:80
# END AUTO WEB BACKENDS
`;

describe('parseDefaultsTunnel', () => {
  it('findet die Zeile im defaults-Block', () => {
    expect(parseDefaultsTunnel(config('    timeout tunnel 1h'))).toBe('1h');
  });

  it('liefert null ohne die Zeile', () => {
    expect(parseDefaultsTunnel(config(''))).toBeNull();
  });

  it('zählt eine Zeile in einem Backend nicht als global', () => {
    const text = config('').replace('    server server1 10.0.0.5:80', '    timeout tunnel 1h\n    server server1 10.0.0.5:80');
    expect(parseDefaultsTunnel(text)).toBeNull();
  });

  it('nimmt den letzten defaults-Abschnitt vor den Backends von HAPM', () => {
    const text = config('    timeout tunnel 10m', 'defaults\n    mode http\n    timeout tunnel 2h\n');
    expect(parseDefaultsTunnel(text)).toBe('2h');
  });

  it('übersieht einen defaults-Abschnitt hinter den Backends', () => {
    const text = `${config('')}\ndefaults\n    timeout tunnel 3h\n`;
    expect(parseDefaultsTunnel(text)).toBeNull();
  });

  it('kommt ohne Marker aus und nimmt dann den defaults vor dem ersten backend', () => {
    const text = 'defaults\n    timeout tunnel 30m\n\nbackend app\n    server s 10.0.0.5:80\n';
    expect(parseDefaultsTunnel(text)).toBe('30m');
  });

  it('liefert null ohne defaults-Abschnitt', () => {
    expect(parseDefaultsTunnel('backend app\n    server s 10.0.0.5:80\n')).toBeNull();
  });
});
