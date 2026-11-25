/**
 * Der ACME-Server, bei dem HAPM Zertifikate beantragt: die Regeln ohne Netz.
 *
 * Rein, damit Route, Seite „Allgemein" und Assistent dieselbe Prüfung
 * benutzen und `tests/acme-server.test.ts` sie nachrechnen kann. Was acme.sh
 * damit tut, steht in `lib/acme.ts`.
 *
 * ── Warum die Adresse so eng geprüft wird ──
 *
 * Sie geht als Argument an `acme.sh --server` (das ist über `buildCommand`
 * sicher), aber acme.sh schreibt sie danach als `Le_API='…'` in den
 * Erneuerungseintrag jedes Zertifikats und liest diese Datei bei jeder
 * Erneuerung mit `eval` wieder ein. Ein Apostroph darin bräche nicht heute,
 * sondern beim ersten Erneuerungslauf, und zwar für dieses Zertifikat und
 * still. Deshalb nur die Zeichen, die in einer Directory-URL vorkommen.
 *
 * ── External Account Binding ──
 *
 * Manche CAs (ZeroSSL, Sectigo, Google, eigene step-ca mit Provisioner) nehmen
 * ein Konto nur mit Key-ID und HMAC-Schlüssel an. Gebraucht wird beides genau
 * einmal, bei der Anmeldung des Kontos. acme.sh legt es danach selbst in
 * seiner `ca.conf` ab. HAPM ist dabei Durchreiche und nicht Tresor, wie bei
 * den DNS-Zugangsdaten: der Schlüssel geht über stdin an acme.sh und steht
 * danach weder in der Datenbank noch im Protokoll.
 */

import { msg, type Message } from './i18n/translate';

/** Was acme.sh ohne eigene Angabe nimmt. Ein Name, den acme.sh kennt. */
export const DEFAULT_ACME_SERVER = 'letsencrypt';

/**
 * Der Server, bei dem beantragt wird: die Einstellung, sonst die Umgebung
 * (`HAPM_ACME_SERVER`, etwa `letsencrypt_test` zum Ausprobieren), sonst
 * Let's Encrypt.
 */
export function effectiveAcmeServer(directory: string | null, env: string | undefined): string {
  return directory?.trim() || env?.trim() || DEFAULT_ACME_SERVER;
}

const MAX_URL = 300;
const URL_CHARS = /^https:\/\/[A-Za-z0-9._~:/-]+$/;

/** `https://CA.example:9000/acme/acme/directory/` bleibt bis auf Leerraum, wie es ist. */
export function normalizeAcmeDirectory(input: string): string {
  return input.trim();
}

/** Die Meldung für den Benutzer oder `null`. Erwartet die normalisierte Form. */
export function validateAcmeDirectory(url: string): Message | null {
  if (!url) return msg('Bitte geben Sie die Directory-URL des ACME-Servers ein.');
  if (!/^https:\/\//.test(url)) {
    return msg('Die Directory-URL beginnt mit https://, zum Beispiel https://ca.example.org/acme/acme/directory.');
  }
  if (url.length > MAX_URL || !URL_CHARS.test(url)) {
    return msg('Die Directory-URL enthält Zeichen, die HAPM nicht an acme.sh weitergibt. Erlaubt sind Buchstaben, Ziffern und . _ ~ : / -');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return msg('Die Directory-URL ist keine gültige Adresse.');
  }
  const host = parsed.hostname;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const name = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host);
  if (!ipv4 && !name) return msg('Die Directory-URL enthält keinen gültigen Servernamen.');
  return null;
}

export interface EabInput {
  keyId: string;
  hmacKey: string;
}

const EAB_KEY_ID = /^[A-Za-z0-9_.:+/=-]{1,200}$/;
const EAB_HMAC = /^[A-Za-z0-9_+/=-]{8,500}$/;

/**
 * Beides oder keins. Eng, weil acme.sh beides als `KEY='wert'` in seine
 * `ca.conf` schreibt und mit `eval` wieder liest: ein Apostroph darin nähme
 * bei der nächsten Anmeldung die ganze Datei mit.
 */
export function validateEab(input: EabInput): Message | null {
  const keyId = input.keyId.trim();
  const hmacKey = input.hmacKey.trim();
  if (!keyId && !hmacKey) return null;
  if (!keyId || !hmacKey) {
    return msg('External Account Binding braucht beides: die Key-ID und den HMAC-Schlüssel.');
  }
  if (!EAB_KEY_ID.test(keyId)) return msg('Die Key-ID enthält Zeichen, die keine CA vergibt.');
  if (!EAB_HMAC.test(hmacKey)) {
    return msg('Der HMAC-Schlüssel ist kein Base64-Text. Kopieren Sie ihn so, wie ihn die CA anzeigt.');
  }
  return null;
}

/**
 * Das Skript, das ein Konto beim ACME-Server anmeldet, ohne dass der
 * HMAC-Schlüssel in einer Kommandozeile steht.
 *
 * Die Werte kommen zeilenweise über stdin (Server, Adresse, Key-ID, Schlüssel;
 * `registerAccountInput`). Das Skript setzt daraus die Argumente und **liest
 * acme.sh mit `.` ein**, statt es aufzurufen: acme.sh endet mit `main "$@"`
 * und arbeitet die Argumente dann im selben Prozess ab. Ein Aufruf
 * `acme.sh … --eab-hmac-key "$hmac"` stünde dagegen mit dem Schlüssel in `ps`.
 *
 * Nicht zu verhindern ist, was acme.sh selbst tut: es rechnet die Signatur mit
 * `openssl dgst -mac HMAC` und gibt den Schlüssel dafür für einen Augenblick
 * als Argument an openssl. Das steht in `docs/reverse-proxy.md`.
 *
 * `$0` ist der Pfad von acme.sh (der Aufrufer gibt ihn als erstes Argument
 * nach dem Skript mit), damit acme.sh beim Einlesen sich selbst findet.
 */
export function registerAccountScript(home: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(home)) throw new Error(`registerAccountScript: ungültiger Pfad ${home}`);
  return [
    'exec 2>&1',
    'IFS= read -r server',
    'IFS= read -r email',
    'IFS= read -r kid',
    'IFS= read -r hmac',
    `set -- --register-account --home '${home}' --server "$server"`,
    'if [ -n "$email" ]; then set -- "$@" --accountemail "$email"; fi',
    'if [ -n "$kid" ]; then set -- "$@" --eab-kid "$kid" --eab-hmac-key "$hmac"; fi',
    'unset hmac',
    '. "$0"',
  ].join('\n');
}

/** Die Zeilen für stdin. Ohne EAB bleiben die letzten beiden leer. */
export function registerAccountInput(server: string, email: string | null, eab: EabInput | null): string {
  const values = [server, email ?? '', eab?.keyId.trim() ?? '', eab?.hmacKey.trim() ?? ''];
  if (values.some((value) => /[\r\n]/.test(value))) throw new Error('registerAccountInput: Zeilenumbruch im Wert');
  return `${values.join('\n')}\n`;
}
