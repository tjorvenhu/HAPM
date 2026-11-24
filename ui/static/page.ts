/**
 * Eine Seite, die für sich allein steht: ein Dokument, kein Stylesheet daneben, kein Skript,
 * das sie bräuchte, nichts zum Nachladen.
 *
 * Gedacht für alles, was nicht HAPM ausliefert, sondern HAProxy selbst: die Fehlerseiten
 * (502, 503, 504, unbekannte Domain) und die Passwortabfrage vor einer gesperrten Seite.
 * Dort gibt es weder Next noch ein Stylesheet, und jede weitere Anfrage ginge an
 * denselben Proxy, der gerade die Fehlerseite schickt.
 *
 * Zwei Erscheinungen:
 *
 *  - `renderStaticPage`: die Karte der Anmeldeseiten (`auth/AuthCard`). Hellgraue
 *    Seitenfläche, weiße Karte mit 24 px Radius, Logo, Überschrift, Felder mit 14 px Radius,
 *    Knopf als Pill. Für alles, was eine Eingabe verlangt (Passwortabfrage).
 *  - `renderErrorPage`: warme helle Fläche, schwebende runde Kopfleiste mit Logo und
 *    „Zurück", der Code groß und blass in der Serif, darunter Überschrift, Satz und
 *    Knopf. Ohne Karte.
 *
 * Die Farben und Maße stehen hier als feste Werte, je mit dem Namen der Variable daneben,
 * weil die Seite das Stylesheet nicht einbinden kann. Wie bei den Mails (`mail/layout`):
 * wer eine Farbe in `ui/css/` ändert, zieht sie hier nach. Die Schrift ist die des
 * Systems, `Instrument Sans` nur ein Wunsch davor.
 *
 * Reines TypeScript ohne React und ohne Umgebung. Es baut Zeichenketten, damit die Seite
 * sich ohne Server testen und an jede Stelle schreiben lässt.
 */

import { STATIC_LOGO_SVG } from "./logo"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Die Werte der Oberfläche (`css/08-shell-tokens.css`) als sRGB. Die Namen sind die der
 * Variablen im Stylesheet.
 */
const TOKENS = [
  "--bg:#edf0ef",
  "--surface:#fff",
  "--field:#f2f5f4",
  "--border:#e3e6e5",
  "--border-strong:#707473",
  "--text:#090b0a",
  "--text-secondary:#4f5352",
  "--text-tertiary:#707473",
  "--accent:#1a5c4c",
  "--accent-hover:#237a65",
  "--danger-light:#fff2f0",
  "--danger-fg:#90000c",
  "--warning-light:#fff3e6",
  "--warning-fg:#684001",
  "--info-light:#eff6ff",
  "--info-fg:#004991",
].join(";")

const STYLE = [
  `:root{${TOKENS}}`,
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;",
  "padding:1.5rem;background:var(--bg);color:var(--text);",
  "font:400 0.9375rem/1.6 'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
  /* .auth-card */
  ".card{width:100%;max-width:27.5rem;padding:2.5rem;border:1px solid var(--border);border-radius:1.5rem;",
  "background:var(--surface);box-shadow:0 1px 2px rgba(42,48,46,.03),0 6px 20px -6px rgba(42,48,46,.07)}",
  /* .auth-logo */
  ".logo{margin-bottom:1.5rem}",
  ".logo svg{display:block;width:200px;max-width:100%;height:auto;margin:0 auto}",
  /* .auth-title, .auth-subtitle */
  "h1{margin:0 0 .5rem;font-size:1.75rem;font-weight:600;line-height:1.1;letter-spacing:-.03em;text-align:center}",
  ".sub{margin:0 0 2rem;color:var(--text-secondary);text-align:center}",
  ".sub:last-child{margin-bottom:0}",
  /* .auth-form, .auth-field */
  "form{display:flex;flex-direction:column;gap:1.25rem}",
  "label{display:block;margin-bottom:.5rem;font-size:.875rem;font-weight:500;line-height:1.25}",
  "input{width:100%;min-height:3rem;padding:.25rem 1rem;border:1px solid var(--border-strong);",
  "border-radius:.875rem;background:var(--field);color:var(--text);font:inherit;line-height:1.25rem;outline:none}",
  "input:focus{border-color:var(--accent);background:var(--surface);box-shadow:0 0 0 1px var(--accent)}",
  /* .auth-submit, auch als Link */
  ".btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:3rem;",
  "margin-top:.5rem;padding:0 1.25rem;border:1px solid transparent;border-radius:9999px;",
  "background:var(--accent);color:#fff;font-family:inherit;font-size:.9375rem;font-weight:500;line-height:1.2;",
  "letter-spacing:-.005em;text-decoration:none;cursor:pointer;",
  "box-shadow:0 1px 2px rgba(42,48,46,.18),0 2px 6px -2px rgba(42,48,46,.16)}",
  ".btn:hover{background:var(--accent-hover)}",
  ".btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
  /* .auth-error und seine Geschwister */
  ".note{margin:0 0 1.25rem;padding:.75rem 1rem;border-radius:1.125rem;font-size:.875rem;line-height:1.5}",
  ".note.error{background:var(--danger-light);color:var(--danger-fg)}",
  ".note.warning{background:var(--warning-light);color:var(--warning-fg)}",
  ".note.info{background:var(--info-light);color:var(--info-fg)}",
  ".text{margin:0 0 1.25rem;color:var(--text-secondary)}",
  ".foot{margin:1.5rem 0 0;color:var(--text-tertiary);font-size:.8125rem;line-height:1.4;text-align:center}",
  "@media(max-width:480px){.card{padding:1.75rem}}",
  "@media(pointer:coarse){input{font-size:1rem}}",
].join("")

export interface StaticPage {
  /** Sprache des Dokuments. Vorgabe `de`. */
  lang?: string
  /** Was im Tab steht. Vorgabe ist `title`. */
  documentTitle?: string
  /** Überschrift der Karte. */
  title: string
  /** Zeile unter der Überschrift. */
  subtitle?: string
  /** Der Inhalt der Karte, aus den Bausteinen unten (`staticNote`, `staticPasswordForm` …). */
  body?: string
  /** Kleine Zeile am Fuß der Karte. */
  footnote?: string
  /** Ohne Logo, wenn die Seite auf einer Domain steht, die das Logo von HAPM nicht zeigen soll. */
  logo?: boolean
}

/**
 * Das vollständige Dokument. Texte werden maskiert, `body` nicht: er kommt aus den
 * Bausteinen unten, und die maskieren selbst.
 *
 * Immer `noindex`: eine Fehlerseite oder eine Passwortabfrage gehört in keinen Suchindex,
 * und sie steht unter der Adresse der Seite, die eigentlich gemeint war.
 */
export function renderStaticPage(page: StaticPage): string {
  const logo = page.logo === false ? "" : `<div class="logo">${STATIC_LOGO_SVG}</div>`
  return (
    "<!doctype html>" +
    `<html lang="${escapeHtml(page.lang ?? "de")}">` +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${escapeHtml(page.documentTitle ?? page.title)}</title>` +
    `<style>${STYLE}</style>` +
    "</head>" +
    "<body>" +
    '<main class="card">' +
    logo +
    `<h1>${escapeHtml(page.title)}</h1>` +
    (page.subtitle ? `<p class="sub">${escapeHtml(page.subtitle)}</p>` : "") +
    (page.body ?? "") +
    (page.footnote ? `<p class="foot">${escapeHtml(page.footnote)}</p>` : "") +
    "</main>" +
    "</body>" +
    "</html>\n"
  )
}

/** Ein Hinweis in einer farbigen Fläche. `error` und `warning` werden vorgelesen. */
export function staticNote(text: string, tone: "error" | "warning" | "info" = "info"): string {
  const role = tone === "info" ? "" : ' role="alert"'
  return `<p class="note ${tone}"${role}>${escapeHtml(text)}</p>`
}

/** Ein Absatz in gedämpfter Farbe. */
export function staticText(text: string): string {
  return `<p class="text">${escapeHtml(text)}</p>`
}

/**
 * Ein Knopf, der ein Link ist. `href: ""` lädt die Adresse neu, unter der die Seite gerade
 * steht: das Richtige für „Erneut versuchen" auf einer Fehlerseite.
 */
export function staticButton(label: string, href: string): string {
  return `<a class="btn" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
}

/**
 * Ein Formular mit einem Passwortfeld, das an die eigene Adresse schickt.
 *
 * Ohne `action`: wo der Besucher hinwollte, steht damit in der Adresse und nicht in einem
 * Feld, und wer das Formular auswertet, kann ihn dorthin zurückschicken.
 */
export function staticPasswordForm(form: {
  /** Name des Feldes, wie ihn die auswertende Stelle liest. */
  field: string
  label: string
  submit: string
  maxLength?: number
}): string {
  const max = form.maxLength ? ` maxlength="${Math.trunc(form.maxLength)}"` : ""
  return (
    '<form method="post">' +
    "<div>" +
    `<label for="pw">${escapeHtml(form.label)}</label>` +
    `<input id="pw" name="${escapeHtml(form.field)}" type="password" required autofocus${max} autocomplete="current-password">` +
    "</div>" +
    `<button class="btn" type="submit">${escapeHtml(form.submit)}</button>` +
    "</form>"
  )
}

/* ── Fehlerseiten ──
 *
 * Eine schwebende Kopfleiste (Logo links, „Zurück" rechts) über einer warmen hellen
 * Fläche. Die Werte sind eigene (`SITE_TOKENS`), nicht die der Oberfläche: die Seite
 * steht unter den Domains hinter dem Proxy und soll nicht wie ein Verwaltungswerkzeug
 * aussehen.
 *
 * Verweise auf andere Seiten fehlen mit Absicht, bis auf „Zurück" und die Startseite:
 * die Seite steht unter fremden Domains, und was es dort gibt, weiß sie nicht.
 *
 * Die Serif (`Instrument Serif`) ist hier nur ein Wunsch: die Seite kann keine Schrift
 * laden, und für eine eingebettete fehlt der Platz (16 KB für die ganze Antwort, das Logo
 * allein braucht 5,5). Wo sie nicht installiert ist, steht Times New Roman und nicht
 * Georgia: dessen Ziffern haben Unterlängen, und die 4 der großen Zahl hinge in die
 * Überschrift.
 */

const SITE_TOKENS = [
  "--bg:#f5f4f0",
  "--surface:#fff",
  "--text:#0f0f0f",
  "--text-secondary:#5a5753",
  "--border:#d8d6d1",
  "--accent:#1a5c4c",
  "--accent-hover:#237a65",
  "--serif:'Instrument Serif','Times New Roman',Times,serif",
].join(";")

const SITE_STYLE = [
  `:root{${SITE_TOKENS}}`,
  "*{box-sizing:border-box;margin:0}",
  "body{background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;",
  "font:400 1rem/1.6 'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
  /* .nav, .nav-inner: 12 px Abstand nach oben und 60 px Höhe ergeben 72 px. */
  ".nav{position:fixed;top:0;left:0;right:0;z-index:2;height:72px;padding:.75rem 2rem 0}",
  ".nav-inner{max-width:calc(1280px - 4rem);height:100%;margin:0 auto;padding:0 .625rem 0 calc(2rem - 1px);",
  "display:flex;align-items:center;justify-content:space-between;gap:1.5rem;border:1px solid var(--border);",
  "border-radius:100px;background:rgba(255,255,255,.84);backdrop-filter:blur(18px);",
  "box-shadow:0 1px 2px rgba(0,0,0,.04),0 14px 32px -18px rgba(0,0,0,.22)}",
  ".nav-logo{display:block;line-height:0}",
  ".nav-logo svg{display:block;width:152px;height:30px}",
  /* .nav-back */
  ".nav-back{display:inline-flex;align-items:center;gap:.5rem;height:2.5rem;padding:0 1rem 0 .75rem;",
  "border-radius:100px;color:var(--text-secondary);font-size:.875rem;font-weight:500;text-decoration:none}",
  ".nav-back:hover{background:rgba(15,15,15,.06);color:var(--text)}",
  ".nav-back svg{width:16px;height:16px}",
  /* .not-found, .not-found-content */
  ".nf{position:relative;display:flex;align-items:center;justify-content:center;min-height:100vh;",
  "min-height:100dvh;padding:72px 2rem 4rem;overflow:hidden;text-align:center}",
  ".nf::before{content:'';position:absolute;top:40%;left:50%;width:700px;height:700px;",
  "transform:translate(-50%,-50%);pointer-events:none;",
  "background:radial-gradient(ellipse,rgba(221,220,216,.6) 0%,transparent 60%)}",
  ".nf-c{position:relative;max-width:520px}",
  /* .not-found-code, -title, -desc */
  ".code{margin-bottom:1rem;color:var(--border);font-family:var(--serif);",
  "font-size:clamp(6rem,15vw,10rem);font-weight:400;line-height:1;letter-spacing:-.04em}",
  "h1{margin-bottom:1rem;font-family:var(--serif);font-size:clamp(1.5rem,3vw,2rem);font-weight:400;line-height:1.3}",
  ".desc{margin-bottom:3rem;color:var(--text-secondary);line-height:1.7}",
  ".desc:last-child{margin-bottom:0}",
  /* Der Knopf */
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:.55rem;padding:.9rem 2rem;",
  "border-radius:10px;background:var(--accent);color:#fff;font-size:.9rem;font-weight:600;line-height:1.2;",
  "text-decoration:none;",
  "box-shadow:0 1px 2px rgba(15,42,35,.16),0 6px 16px -8px rgba(26,92,76,.5),inset 0 1px 0 rgba(255,255,255,.14)}",
  ".btn:hover{background:var(--accent-hover)}",
  ".btn svg{width:16px;height:16px}",
  ".btn:focus-visible,.nav-back:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
  "@media(max-width:640px){.nav{padding:.75rem 1rem 0}.nav-inner{padding-left:1.25rem}.nf{padding:72px 1.25rem 3rem}}",
].join("")

const ARROW =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>'
const CHEVRON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 4l-4 4 4 4"/></svg>'

export interface ErrorPageText {
  title: string
  text: string
  /** Was der Knopf anbietet. `retry` lädt neu, `home` führt auf `/`, `none` lässt ihn weg. */
  action: "retry" | "home" | "none"
}

/**
 * Was auf der Seite zu einem Statuscode steht.
 *
 * Kurz, ohne Fachwort und ohne Schuldzuweisung: wer hier landet, hat nichts falsch
 * gemacht und kann auch nichts reparieren. Der Code steht groß daneben für den, der ihn
 * am Telefon durchgeben soll.
 *
 * Neu laden bietet nur an, was sich durch Warten ändern kann.
 */
export const ERROR_PAGE_TEXTS: Record<number, ErrorPageText> = {
  400: {
    title: "Ungültige Anfrage",
    text: "Der Server konnte diese Anfrage nicht verarbeiten.",
    action: "home",
  },
  401: {
    title: "Anmeldung erforderlich",
    text: "Für diese Seite ist eine Anmeldung nötig.",
    action: "none",
  },
  403: {
    title: "Kein Zugriff",
    text: "Diese Seite ist von Ihrem Anschluss aus nicht erreichbar.",
    action: "none",
  },
  404: {
    title: "Seite nicht gefunden",
    text: "Diese Seite gibt es nicht oder sie wurde verschoben.",
    action: "home",
  },
  405: {
    title: "Nicht erlaubt",
    text: "Diese Art von Anfrage nimmt die Seite nicht an.",
    action: "home",
  },
  408: {
    title: "Zeitüberschreitung",
    text: "Die Anfrage hat zu lange gedauert. Bitte laden Sie die Seite neu.",
    action: "retry",
  },
  410: {
    title: "Nicht mehr vorhanden",
    text: "Diese Seite gibt es nicht mehr.",
    action: "home",
  },
  413: {
    title: "Zu groß",
    text: "Die gesendeten Daten sind größer, als die Seite annimmt.",
    action: "none",
  },
  429: {
    title: "Zu viele Anfragen",
    text: "Bitte warten Sie einen Moment und versuchen Sie es dann erneut.",
    action: "retry",
  },
  500: {
    title: "Interner Fehler",
    text: "Auf dem Server ist ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.",
    action: "retry",
  },
  501: {
    title: "Nicht unterstützt",
    text: "Diese Art von Anfrage unterstützt der Server nicht.",
    action: "home",
  },
  502: {
    title: "Fehlerhafte Antwort",
    text: "Die Seite hat nicht richtig geantwortet. Bitte versuchen Sie es in Kürze erneut.",
    action: "retry",
  },
  503: {
    title: "Gerade nicht erreichbar",
    text: "Die Seite ist im Moment nicht erreichbar. Bitte versuchen Sie es in Kürze erneut.",
    action: "retry",
  },
  504: {
    title: "Zeitüberschreitung",
    text: "Die Seite hat nicht rechtzeitig geantwortet. Bitte versuchen Sie es in Kürze erneut.",
    action: "retry",
  },
}

/** Die Codes, für die es einen eigenen Text gibt, aufsteigend. */
export const ERROR_PAGE_STATUSES: number[] = Object.keys(ERROR_PAGE_TEXTS)
  .map(Number)
  .sort((a, b) => a - b)

/**
 * Die Fehlerseite zu einem Statuscode.
 *
 * Ein Code ohne eigenen Text bekommt einen allgemeinen: besser eine ehrliche Seite
 * „Fehler 507" als gar keine. `override` ersetzt einzelne Angaben, etwa den Text der 403
 * auf einer Maschine, auf der sie „nur aus dem Büro erreichbar" heißt.
 */
export function renderErrorPage(
  status: number,
  override: Partial<ErrorPageText> & { logo?: boolean; lang?: string } = {},
): string {
  const known = ERROR_PAGE_TEXTS[status]
  const base: ErrorPageText = known ?? {
    title: "Fehler",
    text:
      status >= 500
        ? "Auf dem Server ist ein Fehler aufgetreten. Bitte versuchen Sie es später erneut."
        : "Diese Anfrage ließ sich nicht verarbeiten.",
    action: status >= 500 ? "retry" : "home",
  }
  const page: ErrorPageText = {
    title: override.title ?? base.title,
    text: override.text ?? base.text,
    action: override.action ?? base.action,
  }
  const button =
    page.action === "retry"
      ? `<a class="btn" href="">Erneut versuchen${ARROW}</a>`
      : page.action === "home"
        ? `<a class="btn" href="/">Zur Startseite${ARROW}</a>`
        : ""
  const logo = override.logo === false ? "" : STATIC_LOGO_SVG

  return (
    "<!doctype html>" +
    `<html lang="${escapeHtml(override.lang ?? "de")}">` +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${escapeHtml(`${page.title} (${status})`)}</title>` +
    `<style>${SITE_STYLE}</style>` +
    "</head>" +
    "<body>" +
    '<header class="nav"><div class="nav-inner">' +
    `<a class="nav-logo" href="/" aria-label="Startseite">${logo}</a>` +
    /* „Zurück" heißt zurück: mit JavaScript die vorige Seite, ohne die Startseite. Das
       ist die einzige Stelle mit Skript, und die Seite funktioniert ohne. */
    `<a class="nav-back" href="/" onclick="history.back();return false">${CHEVRON}Zurück</a>` +
    "</div></header>" +
    '<main class="nf"><div class="nf-c">' +
    `<p class="code" aria-hidden="true">${escapeHtml(String(status))}</p>` +
    `<h1>${escapeHtml(page.title)}</h1>` +
    `<p class="desc">${escapeHtml(page.text)}</p>` +
    button +
    "</div></main>" +
    "</body>" +
    "</html>\n"
  )
}
