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
 * Farben, Logo und die drei Texte der Abfrage (Überschrift, Text, Knopf)
 * kommen aus dem gespeicherten Design (`page-design.ts`), wenn es „Selbst
 * gestalten“ ist. Bei der Seite von HAPM und bei eigenem HTML für die
 * Fehlerseiten bleibt die Abfrage die von HAPM (`builtInDesign`): sie braucht
 * ein Formular, das die Regel in `haproxy.cfg` versteht.
 *
 * Geschrieben werden die Seiten beim Speichern des Designs
 * (`page-design-apply.ts`) und vor jedem Schreibvorgang am Reverse-Proxy
 * (`ensureLockPages` in `provision.ts`): dort über die Prüfsumme, also nur bei
 * einer Abweichung. So kommt auch eine neue Fassung der Vorlage an, nach einem
 * neuen Abbild von HAPM mit dem nächsten Vorgang.
 */

import {
  renderStaticPage,
  staticButton,
  staticNote,
  staticPasswordForm,
} from '@/ui/static/page';
import { DEFAULT_LOCALE, msgid, translate, type Locale } from '@/lib/i18n';
import { buildCommand, withStdin } from '../shell';
import { LOCK_FIELD, LOCK_PAGE_FILES, LOCK_PASSWORD_MAX } from './config';
import { activeDesign, builtInDesign, designTheme, PAGE_MAX_BYTES, type PageDesign } from './page-design';

/** Was eine Seite höchstens wiegen darf. Woher die Zahl kommt, steht in
 *  `page-design.ts`: über dieser Grenze antwortet HAProxy mit 500, und
 *  `haproxy -c` merkt es nicht. */
export const LOCK_PAGE_MAX_BYTES = PAGE_MAX_BYTES;

export type LockPageKind = keyof typeof LOCK_PAGE_FILES;

/** Die Texte, wie HAPM sie ohne eigenes Design schreibt. Deutsch, die Schlüssel für `lockPageDefaults`. */
export const LOCK_PAGE_DEFAULTS = {
  title: msgid('Geschützter Bereich'),
  subtitle: msgid('Diese Seite ist mit einem Passwort geschützt.'),
  submit: msgid('Öffnen'),
} as const;

/** Die Vorgaben in der Sprache der Seiten. */
export function lockPageDefaults(locale: Locale = DEFAULT_LOCALE): { title: string; subtitle: string; submit: string } {
  return {
    title: translate(locale, LOCK_PAGE_DEFAULTS.title),
    subtitle: translate(locale, LOCK_PAGE_DEFAULTS.subtitle),
    submit: translate(locale, LOCK_PAGE_DEFAULTS.submit),
  };
}

function body(kind: LockPageKind, submit: string, locale: Locale): string {
  const form = staticPasswordForm({
    field: LOCK_FIELD,
    label: translate(locale, 'Passwort'),
    submit,
    maxLength: LOCK_PASSWORD_MAX,
  });
  if (kind === 'ask') return form;
  if (kind === 'wrong') return staticNote(translate(locale, 'Das Passwort stimmt nicht.'), 'error') + form;
  /* Ohne Formular: jede weitere Eingabe zählte wieder mit und verlängerte die
     Wartezeit. Der Link lädt dieselbe Adresse neu und zeigt danach wieder die
     Abfrage. */
  return (
    staticNote(translate(locale, 'Zu viele Versuche. Bitte in zehn Minuten erneut versuchen.'), 'warning') +
    staticButton(translate(locale, 'Zur Abfrage'), '')
  );
}

/** Eine der drei Seiten als vollständiges Dokument. Ohne `design` gilt das
 *  gespeicherte. */
export function renderLockPage(kind: LockPageKind, stored: PageDesign = activeDesign()): string {
  const design = builtInDesign(stored);
  const defaults = lockPageDefaults(design.locale);
  return renderStaticPage(
    {
      locale: design.locale,
      title: design.lock.title ?? defaults.title,
      subtitle: design.lock.subtitle ?? defaults.subtitle,
      body: body(kind, design.lock.submit ?? defaults.submit, design.locale),
    },
    designTheme(design)
  );
}

/** Alle drei, mit dem Dateinamen, unter dem die Regeln sie erwarten. */
export function lockPages(design: PageDesign = activeDesign()): { file: string; html: string }[] {
  return (Object.keys(LOCK_PAGE_FILES) as LockPageKind[]).map((kind) => ({
    file: LOCK_PAGE_FILES[kind],
    html: renderLockPage(kind, design),
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
