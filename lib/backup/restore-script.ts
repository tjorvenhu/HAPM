/**
 * Was der Helfer `hapm-restore` ausführt, und wie HAPM seinen Fortschritt liest.
 *
 * Rein (kein `lib/db`, kein Docker), damit `tests/backup/restore.test.ts` das
 * Skript mit einer echten Shell über ein Temp-Verzeichnis nachrechnen kann:
 * Tauschen, und Zurücktauschen an jeder Stelle, an der es scheitern kann.
 *
 * ── Der Fortschritt ──
 *
 * Eine Textdatei im Daten-Ordner (`/data/.restore/progress`), eine Zeile je
 * Schritt: `ok <schritt> <detail>` oder `fail <schritt> <detail>`, am Ende
 * `done success` oder `done error <schritt>`. In einer Datei und nicht in der
 * Datenbank, weil die gerade ersetzt wird. HAPM schreibt die ersten beiden
 * Schritte selbst (`backup`, `handover`), den Rest der Helfer.
 */

import { msgid } from '../i18n';

export type RestoreStep =
  | 'backup'
  | 'handover'
  | 'prepare'
  | 'stop'
  | 'database'
  | 'files'
  | 'check'
  | 'reload'
  | 'start'
  | 'key'
  | 'rollback_files'
  | 'rollback_database'
  | 'rollback_reload'
  | 'aborted';

/** Die Schritte eines gelungenen Laufs, der Reihe nach. Die Seite zeigt danach, was noch kommt. */
export const RESTORE_PLAN: RestoreStep[] = ['backup', 'handover', 'prepare', 'stop', 'database', 'files', 'check', 'reload', 'start'];

export const RESTORE_STEP_LABELS: Record<RestoreStep, string> = {
  backup: msgid('Aktuellen Stand sichern'),
  handover: msgid('Helfer starten'),
  prepare: msgid('Archiv auspacken'),
  stop: msgid('HAPM anhalten'),
  database: msgid('Datenbank einspielen'),
  files: msgid('Dateien tauschen'),
  check: msgid('Konfiguration prüfen'),
  reload: msgid('HAProxy neu laden'),
  start: msgid('HAPM starten'),
  key: msgid('Schlüssel prüfen'),
  rollback_files: msgid('Dateien zurücktauschen'),
  rollback_database: msgid('Bisherige Datenbank einspielen'),
  rollback_reload: msgid('HAProxy mit dem bisherigen Stand neu laden'),
  aborted: msgid('Abbruch'),
};

/** Was der Lauf als Fehler nennt, je nachdem, an welchem Schritt er endete. */
export const RESTORE_FAILURES: Partial<Record<RestoreStep, string>> = {
  backup: msgid('Die Sicherung des aktuellen Stands ist gescheitert. Es wurde nichts zurückgespielt.'),
  handover: msgid('Der Helfer ließ sich nicht starten. Es wurde nichts zurückgespielt.'),
  prepare: msgid('Das Archiv ließ sich nicht auspacken. Es wurde nichts zurückgespielt.'),
  stop: msgid('HAPM ließ sich nicht anhalten. Es wurde nichts zurückgespielt.'),
  database: msgid('Die Datenbank ließ sich nicht einspielen. Postgres hat alles zurückgerollt, es gilt der bisherige Stand.'),
  files: msgid('Die Dateien ließen sich nicht tauschen. Der bisherige Stand ist wiederhergestellt.'),
  check: msgid('HAProxy lehnt die Konfiguration aus der Sicherung ab. Der bisherige Stand ist wiederhergestellt.'),
  reload: msgid('HAProxy ließ sich mit dem Stand der Sicherung nicht neu laden. Der bisherige Stand ist wiederhergestellt.'),
  aborted: msgid('Der Helfer wurde mitten im Zurückspielen beendet. Die Schritte zeigen, was wiederhergestellt ist.'),
};

export const ROLLBACK_INCOMPLETE = msgid(
  'Das Zurücktauschen ist nicht vollständig gelungen. Die Schritte zeigen, was fehlt. Der alte Stand der Dateien liegt in .hapm-restore-old.'
);

export const NO_RESULT = msgid('Der Helfer endete ohne Ergebnis. Die Schritte zeigen, wie weit er kam.');

export interface ProgressLine {
  step: RestoreStep | string;
  ok: boolean;
  detail: string;
}

export interface Progress {
  steps: ProgressLine[];
  done: { status: 'success' | 'error'; step: string | null } | null;
}

export function progressLine(state: 'ok' | 'fail', step: RestoreStep, detail = ''): string {
  return `${state} ${step} ${detail.replace(/[\r\n\t]+/g, ' ').slice(0, 1500)}\n`;
}

export function parseProgress(text: string): Progress {
  const steps: ProgressLine[] = [];
  let done: Progress['done'] = null;
  for (const line of text.split('\n')) {
    const match = /^(ok|fail|done) (\S+) ?(.*)$/.exec(line.replace(/\r$/, ''));
    if (!match) continue;
    const [, state, step, rest] = match;
    if (state === 'done') {
      done = { status: step === 'success' ? 'success' : 'error', step: rest.trim() || null };
    } else {
      steps.push({ step, ok: state === 'ok', detail: rest.trim() });
    }
  }
  return { steps, done };
}

/**
 * Der Helfer, der ein Archiv aus dem Sicherungsordner in den Daten-Ordner
 * kopiert. HAPM selbst sieht den Ordner nicht. Der Name kommt über die
 * Umgebung, der Ordner ist eine Einbindung (nur lesend).
 */
export const STAGE_SCRIPT = [
  'set -eu',
  'umask 077',
  'D="${RESTORE_DATA:-/data}"',
  'mkdir -p "$D/.restore"',
  'tmp="$D/.restore/archive.tar.gz.part"',
  'trap \'rm -f "$tmp"\' EXIT',
  'cp -- "/backup/$RESTORE_NAME" "$tmp"',
  'mv -f -- "$tmp" "$D/.restore/archive.tar.gz"',
].join('\n');

/**
 * Das Zurückspielen. Fester Text, alles Veränderliche kommt aus der Umgebung:
 *
 *  - `RESTORE_HAPM`  Kennung des HAPM-Containers, den der Helfer anhält und startet
 *  - `RESTORE_DATA`, `RESTORE_HAPROXY`, `RESTORE_ACME`  die Ordner (Vorgaben wie im Container)
 *  - `RESTORE_CTL`   wie `hapm-ctl` aufgerufen wird (die Tests setzen eine Attrappe)
 *
 * Reihenfolge: erst auspacken und neben die Ordner legen, solange HAPM noch
 * läuft und nichts verändert ist. Dann HAPM anhalten (Postgres läuft weiter),
 * die Datenbank in einer Transaktion einspielen, die Dateien tauschen, die
 * Konfiguration mit HAProxy prüfen, HAProxy neu laden, HAPM starten.
 *
 * Getauscht wird innerhalb jedes Volumes: der neue Stand liegt in
 * `.hapm-restore-new`, der alte geht nach `.hapm-restore-old`. Beides sind
 * Umbenennungen auf demselben Dateisystem. Scheitert etwas, kommt der alte
 * Stand zurück, und war die Datenbank schon ersetzt, wird die Sicherung von
 * unmittelbar vorher eingespielt (`before.sql`). Erst nach einem gelungenen
 * Lauf verschwindet `.hapm-restore-old`; scheitert das Zurücktauschen, bleibt
 * es liegen, und ein neuer Lauf beginnt nicht, solange es da ist.
 */
export const RESTORE_SCRIPT = String.raw`set -u
umask 077
D="${'$'}{RESTORE_DATA:-/data}"
H="${'$'}{RESTORE_HAPROXY:-/etc/haproxy}"
A="${'$'}{RESTORE_ACME:-/root/.acme.sh}"
CTL="${'$'}{RESTORE_CTL:-node /app/bin/hapm-ctl.mjs}"
R="$D/.restore"
P="$R/progress"
NEW="$R/new"
SO="$R/old-secrets.json"
stopped=0; db=0; sw_h=0; sw_a=0; sw_s=0; reload=0

note() {
  printf '%s %s %s\n' "$1" "$2" "$(printf '%s' "${'$'}{3:-}" | tr '\r\n\t' '   ' | head -c 1500)" >> "$P"
}

move_all() {
  for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    case "${'$'}{e##*/}" in .hapm-restore-new|.hapm-restore-old) continue ;; esac
    mv -T -- "$e" "$2/${'$'}{e##*/}" || return 1
  done
  return 0
}

swap_in() {
  N="$1/.hapm-restore-new"; O="$1/.hapm-restore-old"
  mkdir "$O" || return 1
  if ! move_all "$1" "$O"; then move_all "$O" "$1"; rmdir "$O"; return 1; fi
  if ! move_all "$N" "$1"; then move_all "$1" "$N"; move_all "$O" "$1"; rmdir "$O"; return 1; fi
  rmdir "$N"
}

swap_back() {
  N="$1/.hapm-restore-new"; O="$1/.hapm-restore-old"
  mkdir -p "$N" && move_all "$1" "$N" && move_all "$O" "$1" && rmdir "$O"
}

swap_secrets() {
  if [ -e "$D/secrets.json" ]; then mv -f -- "$D/secrets.json" "$SO" || return 1; fi
  if ! mv -f -- "$NEW/data/secrets.json" "$D/secrets.json"; then
    if [ -e "$SO" ]; then mv -f -- "$SO" "$D/secrets.json"; fi
    return 1
  fi
}

secrets_back() {
  if [ -e "$SO" ]; then mv -f -- "$SO" "$D/secrets.json"; else rm -f -- "$D/secrets.json"; fi
}

finish() {
  note done "$1" "${'$'}{2:-}"
  if [ "$stopped" = 1 ]; then
    if out=$($CTL start "$RESTORE_HAPM" 2>&1); then note ok start; else note fail start "$out"; fi
  fi
  if [ "$1" = success ]; then exit 0; fi
  exit 1
}

rollback() {
  trap '' TERM INT HUP
  ok=1
  if [ "$sw_s" = 1 ]; then secrets_back || ok=0; fi
  if [ "$sw_a" = 1 ]; then swap_back "$A" || ok=0; fi
  if [ "$sw_h" = 1 ]; then swap_back "$H" || ok=0; fi
  if [ "$sw_s$sw_a$sw_h" != 000 ]; then
    if [ "$ok" = 1 ]; then note ok rollback_files; else note fail rollback_files "Der alte Stand liegt in .hapm-restore-old."; fi
  fi
  if [ "$db" = 1 ]; then
    if out=$($CTL restore-db "$R/before.sql" --keep-sessions 2>&1); then note ok rollback_database; else note fail rollback_database "$out"; fi
  fi
  if [ "$reload" = 1 ]; then
    if out=$($CTL reload 2>&1); then note ok rollback_reload; else note fail rollback_reload "$out"; fi
  fi
  rm -rf -- "$NEW" "$H/.hapm-restore-new" "$A/.hapm-restore-new"
}

fail() {
  note fail "$1" "${'$'}{2:-}"
  rollback
  finish error "$1"
}

trap 'fail aborted "Der Helfer wurde beendet."' TERM INT HUP

mkdir -p "$R"
if [ -z "${'$'}{RESTORE_HAPM:-}" ]; then fail prepare "RESTORE_HAPM fehlt."; fi

# 1. Auspacken und neben die Ordner legen. HAPM läuft noch, verändert ist nichts.
if [ -e "$H/.hapm-restore-old" ] || [ -e "$A/.hapm-restore-old" ] || [ -e "$SO" ]; then
  note fail prepare "Ein früheres Zurückspielen hat .hapm-restore-old hinterlassen. Bitte von Hand prüfen und entfernen."
  finish error prepare
fi
rm -rf -- "$NEW" "$H/.hapm-restore-new" "$A/.hapm-restore-new"
if ! out=$(mkdir -p "$NEW" 2>&1 && tar -xzf "$R/archive.tar.gz" -C "$NEW" 2>&1); then fail prepare "$out"; fi
for f in database.sql data/secrets.json haproxy/haproxy.cfg; do
  [ -f "$NEW/$f" ] || fail prepare "Im Archiv fehlt $f."
done
[ -d "$NEW/.acme.sh" ] || fail prepare "Im Archiv fehlt .acme.sh/."
[ -f "$R/before.sql" ] || fail prepare "Die Sicherung des aktuellen Stands fehlt."
if ! out=$(mkdir "$H/.hapm-restore-new" 2>&1 && cp -a "$NEW/haproxy/." "$H/.hapm-restore-new/" 2>&1 \
    && mkdir "$A/.hapm-restore-new" 2>&1 && cp -a "$NEW/.acme.sh/." "$A/.hapm-restore-new/" 2>&1); then
  fail prepare "$out"
fi
note ok prepare

# 2. HAPM anhalten: während die Datenbank ersetzt wird, schreibt niemand hinein.
stopped=1
if out=$($CTL stop "$RESTORE_HAPM" 2>&1); then note ok stop; else fail stop "$out"; fi

# 3. Die Datenbank, in einer Transaktion. Scheitert sie, ist nichts verändert.
if out=$($CTL restore-db "$NEW/database.sql" 2>&1); then db=1; note ok database; else fail database "$out"; fi

# 4. Die Dateien tauschen.
if swap_in "$H"; then sw_h=1; else fail files "HAProxy: der Tausch in $H ist gescheitert."; fi
if swap_in "$A"; then sw_a=1; else fail files "acme.sh: der Tausch in $A ist gescheitert."; fi
if swap_secrets; then sw_s=1; else fail files "secrets.json ließ sich nicht tauschen."; fi
note ok files

# 5. Erst prüfen, dann laden: HAProxy startet nie ungeprüft mit dem Stand der Sicherung.
if out=$($CTL check "$H/haproxy.cfg" 2>&1); then note ok check "$out"; else fail check "$out"; fi
reload=1
if out=$($CTL reload 2>&1); then note ok reload "$out"; else fail reload "$out"; fi

# 6. Aufräumen, dann HAPM starten.
rm -rf -- "$H/.hapm-restore-old" "$A/.hapm-restore-old" "$NEW"
rm -f -- "$SO"
finish success
`;
