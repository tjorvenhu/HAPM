/**
 * acme.sh einrichten und aktuell halten.
 *
 * Niemand soll acme.sh von Hand auf der Maschine einrichten müssen: HAPM macht
 * das selbst. `lib/haproxy/` setzt ein eingerichtetes acme.sh voraus und tut
 * damit den Rest (ausstellen, ausrollen, entfernen).
 *
 * acme.sh liegt in einem Volume unter `/root/.acme.sh`, zusammen mit Konto,
 * Zertifikaten und Erneuerungseinträgen. Das Abbild bringt eine Fassung unter
 * `/opt/acme.sh` mit, aus der beim ersten Start installiert wird. Danach
 * aktualisiert acme.sh sich selbst (`--upgrade`), unabhängig vom Abbild.
 */

import { localExec } from './ssh';
import { buildCommand, shellEscape, withStdin } from './shell';
import { msg, msgid, type Message } from './i18n/translate';
import { DEFAULT_ACME_SERVER, registerAccountInput, registerAccountScript, type EabInput } from './acme-server';

export const ACME_HOME = '/root/.acme.sh';
export const ACME = `${ACME_HOME}/acme.sh`;
const ACME_SOURCE = process.env.HAPM_ACME_SOURCE || '/opt/acme.sh';

/**
 * Die Vorgabe für die Zertifizierungsstelle, wenn unter „Allgemein" kein
 * eigener ACME-Server eingestellt ist: ein Name, den acme.sh kennt
 * (`letsencrypt`, `letsencrypt_test`, `zerossl`) aus `HAPM_ACME_SERVER`, sonst
 * Let's Encrypt. `letsencrypt_test` ist der Weg, HAPM auszuprobieren, ohne das
 * Kontingent von Let's Encrypt anzufassen.
 *
 * Für einen Antrag gilt nicht diese Funktion, sondern `challengeFor` in
 * `lib/settings.ts`: dort steht die Einstellung vor der Umgebung.
 */
export function acmeServer(): string {
  return process.env.HAPM_ACME_SERVER?.trim() || DEFAULT_ACME_SERVER;
}

export interface AcmeStatus {
  installed: boolean;
  version: string | null;
  /** Die Adresse des Kontos, soweit acme.sh sie kennt. */
  accountEmail: string | null;
}

export function parseAcmeVersion(output: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+)\s*$/m.exec(output);
  return match ? match[1] : null;
}

export async function acmeStatus(): Promise<AcmeStatus> {
  const res = await localExec(
    `if [ -x ${shellEscape(ACME)} ]; then ${buildCommand([ACME, '--version'])} 2>/dev/null; ` +
      // Die Adresse steht je Zertifizierungsstelle in deren `ca.conf`, nicht in `account.conf`.
      `echo '---'; find ${shellEscape(`${ACME_HOME}/ca`)} -name ca.conf -exec sed -n "s/^CA_EMAIL='\\(.*\\)'$/\\1/p" {} + 2>/dev/null; fi; true`,
    20_000
  );
  const [versionPart = '', emailPart = ''] = res.stdout.split('---');
  const version = parseAcmeVersion(versionPart);
  return {
    installed: version !== null,
    version,
    accountEmail: emailPart.trim().split('\n')[0]?.trim() || null,
  };
}

/**
 * Installiert acme.sh ins Volume, falls es dort fehlt.
 *
 * `--no-cron`, weil es im Container keinen Cron gibt: die Erneuerung stößt der
 * Scheduler an (`renewCertificates`). `--no-profile`, weil niemand sich in den
 * Container einloggt. Die Vorgabe für die Zertifizierungsstelle ist
 * Let's Encrypt, acme.sh selbst nähme sonst ZeroSSL.
 */
export async function ensureAcme(email: string | null): Promise<{ ok: boolean; detail: string }> {
  const status = await acmeStatus();
  if (!status.installed) {
    const install = await localExec(
      `cd ${shellEscape(ACME_SOURCE)} && ` +
        buildCommand(['./acme.sh', '--install', '--home', ACME_HOME, '--no-cron', '--no-profile']) +
        ' 2>&1',
      120_000
    );
    if (install.code !== 0) {
      return { ok: false, detail: `acme.sh ließ sich nicht installieren: ${install.stdout.trim().slice(-500)}` };
    }
  }

  const steps = [
    // Ohne die Datei meldet die Vorabprüfung „keine acme.sh-Konfiguration".
    `touch ${shellEscape(`${ACME_HOME}/account.conf`)}`,
    `chmod 600 ${shellEscape(`${ACME_HOME}/account.conf`)}`,
  ];
  // Nur bei der Installation: wer danach eine andere Zertifizierungsstelle
  // einstellt, soll sie nicht bei jedem Start von HAPM wieder verlieren.
  if (!status.installed) {
    steps.unshift(buildCommand([ACME, '--home', ACME_HOME, '--set-default-ca', '--server', acmeServer()]));
  }
  if (email && email !== status.accountEmail) {
    steps.push(buildCommand([ACME, '--home', ACME_HOME, '--update-account', '--accountemail', email]) + ' || true');
    steps.push(buildCommand([ACME, '--home', ACME_HOME, '--register-account', '-m', email]) + ' || true');
  }
  const res = await localExec(`${steps.join(' && ')} 2>&1`, 120_000);
  if (res.code !== 0) return { ok: false, detail: res.stdout.trim().slice(-500) };
  return { ok: true, detail: msgid(status.installed ? 'acme.sh ist eingerichtet.' : 'acme.sh wurde installiert.') };
}

/**
 * Ein Konto beim ACME-Server anmelden, wahlweise mit External Account Binding.
 *
 * Für Let's Encrypt erledigt das `ensureAcme`. Ein eigener Server bekommt sein
 * Konto beim Speichern unter „Allgemein" oder im Assistenten, und zwar sofort:
 * eine falsche Adresse oder ein abgelehnter Schlüssel soll dort auffallen und
 * nicht beim ersten Ziel, Minuten später, in einem Lauf. Das ist zugleich der
 * Rückabgleich: gespeichert wird die Einstellung erst, wenn acme.sh das Konto
 * angemeldet hat.
 *
 * Der HMAC-Schlüssel geht über stdin (`registerAccountScript`). acme.sh legt
 * ihn danach selbst in seiner `ca.conf` zu diesem Server ab; HAPM speichert ihn
 * nirgends.
 */
export async function registerAcmeAccount(
  server: string,
  email: string | null,
  eab: EabInput | null
): Promise<{ ok: true } | { ok: false; message: Message }> {
  const res = await localExec(
    // Kein `2>&1` dahinter: nach der Heredoc-Marke stünde es auf ihrer Zeile, und
    // sie schlösse nicht mehr. Das Skript leitet selbst um.
    withStdin(['sh', '-c', registerAccountScript(ACME_HOME), ACME], registerAccountInput(server, email, eab)),
    120_000
  );
  if (res.code === 0) return { ok: true };
  return {
    ok: false,
    message: msg('Der ACME-Server hat das Konto nicht angenommen: {detail}', {
      detail: res.stdout.trim().slice(-500) || msgid('acme.sh nennt keinen Grund.'),
    }),
  };
}

/**
 * Der tägliche Lauf von acme.sh: erneuert, was fällig ist, und ruft für jedes
 * erneuerte Zertifikat den Deploy-Hook auf (PEM schreiben, HAProxy neu laden).
 */
export async function renewCertificates(): Promise<{ ok: boolean; output: string }> {
  const res = await localExec(`${buildCommand([ACME, '--cron', '--home', ACME_HOME])} 2>&1`, 30 * 60_000);
  return { ok: res.code === 0, output: res.stdout.slice(-4000) };
}

export async function upgradeAcme(): Promise<{ ok: boolean; output: string }> {
  const res = await localExec(`${buildCommand([ACME, '--upgrade', '--home', ACME_HOME])} 2>&1`, 180_000);
  return { ok: res.code === 0, output: res.stdout.slice(-2000) };
}

/** Die neueste veröffentlichte Fassung, von GitHub. */
export async function latestAcmeVersion(): Promise<string | null> {
  const res = await fetch('https://api.github.com/repos/acmesh-official/acme.sh/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hapm' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}.`);
  const body = (await res.json()) as { tag_name?: string };
  return body.tag_name ? body.tag_name.replace(/^v/, '') : null;
}

/** `3.1.2` gegen `3.1.10`: Zahl für Zahl, nicht als Text. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
