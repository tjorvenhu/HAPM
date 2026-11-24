/**
 * Die Seiten der Passwortsperre: was ein Besucher sieht, bevor er durch ist.
 *
 * Drei statische Fassungen derselben Karte (Abfrage, falsches Passwort, zu
 * viele Versuche). HAProxy liefert sie selbst aus, über `http-request return …
 * file`, siehe `passwordLockRules` in `config.ts`.
 *
 * **Das Aussehen kommt aus `ui/static/page.ts`** und wird dort geändert,
 * nicht hier: eine Datei, kein JavaScript, nichts zum Nachladen, im Bild der
 * Anmeldekarte. Hier steht nur, was es nur an dieser Stelle gibt: die drei
 * Texte, der Name des Feldes, den die Regel liest, und wie die Seiten auf die
 * Maschine kommen.
 *
 * Geschrieben werden die Seiten mit dem nächsten Schreibvorgang am
 * Reverse-Proxy (`ensureLockPages` in `provision.ts`): ein geändertes Aussehen
 * wirkt also nach einem neuen Abbild von HAPM und dem nächsten Vorgang.
 */

import {
  renderStaticPage,
  staticButton,
  staticNote,
  staticPasswordForm,
} from '@/ui/static/page';
import { buildCommand, withStdin } from '../shell';
import { LOCK_FIELD, LOCK_PAGE_FILES, LOCK_PASSWORD_MAX } from './config';

/** Was eine Seite höchstens wiegen darf. HAProxys Puffer fasst 16384 Bytes,
 *  davon gehen 1024 Reserve und die Kopfzeilen der Antwort ab. */
export const LOCK_PAGE_MAX_BYTES = 12_000;

export type LockPageKind = keyof typeof LOCK_PAGE_FILES;

const FORM = staticPasswordForm({
  field: LOCK_FIELD,
  label: 'Passwort',
  submit: 'Öffnen',
  maxLength: LOCK_PASSWORD_MAX,
});

const BODY: Record<LockPageKind, string> = {
  ask: FORM,
  wrong: staticNote('Das Passwort stimmt nicht.', 'error') + FORM,
  /* Ohne Formular: jede weitere Eingabe zählte wieder mit und verlängerte die
     Wartezeit. Der Link lädt dieselbe Adresse neu und zeigt danach wieder die
     Abfrage. */
  throttled:
    staticNote('Zu viele Versuche. Bitte in zehn Minuten erneut versuchen.', 'warning') +
    staticButton('Zur Abfrage', ''),
};

/** Eine der drei Seiten als vollständiges Dokument. */
export function renderLockPage(kind: LockPageKind): string {
  return renderStaticPage({
    title: 'Geschützter Bereich',
    subtitle: 'Diese Seite ist mit einem Passwort geschützt.',
    body: BODY[kind],
  });
}

/** Alle drei, mit dem Dateinamen, unter dem die Regeln sie erwarten. */
export function lockPages(): { file: string; html: string }[] {
  return (Object.keys(LOCK_PAGE_FILES) as LockPageKind[]).map((kind) => ({
    file: LOCK_PAGE_FILES[kind],
    html: renderLockPage(kind),
  }));
}

/* ── Die zwei Kommandos, mit denen die Seiten auf die Maschine kommen ──
 *
 * Rein und hier, damit `tests/haproxy/lock-page.test.ts` eine echte Bash sie
 * nachrechnen lassen kann. Woran es dabei hängt: was `sha256sum` über die
 * geschriebene Datei sagt, muss die Prüfsumme des Textes sein, der hier
 * entsteht. Schriebe das Kommando ein Byte mehr oder weniger (ein Zeilenende
 * aus dem Heredoc), gälte jede Seite bei jedem Vorgang als veraltet und würde
 * für immer neu geschrieben, ohne dass irgendwo ein Fehler stünde. */

/** Die Prüfsummen der Dateien, die es gibt. Fehlende lässt `sha256sum` aus und
 *  meldet es auf stderr; das wird verworfen, denn „fehlt" ist hier die Antwort. */
export function lockPageDigestCommand(paths: string[]): string {
  return `${buildCommand(['sha256sum', ...paths])} 2>/dev/null || true`;
}

/** Eine Seite schreiben, samt Verzeichnis. Der Inhalt geht über stdin wie die
 *  Konfiguration selbst; `tee` gibt ihn wieder aus, das verwirft der Aufrufer. */
export function lockPageWriteCommand(dir: string, path: string, html: string): string {
  return `${buildCommand(['mkdir', '-p', dir])} && ${withStdin(['tee', path], html)}`;
}
