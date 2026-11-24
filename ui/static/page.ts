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
 * Beide Erscheinungen nehmen ein `StaticTheme` an: Farben, Logo, Schriftzug, Fußzeile.
 * Ohne es entsteht die Seite im Aussehen von HAPM.
 *
 * Reines TypeScript ohne React und ohne Umgebung. Es baut Zeichenketten, damit die Seite
 * sich ohne Server testen und an jede Stelle schreiben lässt.
 *
 * Die Texte, die die Seite selbst mitbringt (Vorgaben je Status, Knöpfe, „Zurück"), gibt
 * es deutsch und englisch (`locale`). Deutsch ist die Quelle: ohne Angabe entsteht Zeichen
 * für Zeichen die deutsche Seite von vorher.
 */

import { msgid, translate, type Locale } from "@/lib/i18n"
import { STATIC_LOGO_SVG } from "./logo"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/* ── Ein eigenes Aussehen ──
 *
 * Drei Farben, ein Logo, ein Schriftzug und eine Fußzeile lassen sich von außen setzen
 * (`StaticTheme`). Alles Weitere ergibt sich daraus: die Fläche von Karte und Kopfleiste
 * aus dem Hintergrund, Rahmen und gedämpfter Text aus Hintergrund und Textfarbe, die
 * Farbe beim Überfahren und die Schrift auf dem Knopf aus der Akzentfarbe.
 *
 * Ohne Angabe entsteht Zeichen für Zeichen die Seite von vorher: jede Vorgabe steht
 * unten als fester Wert, und gerechnet wird nur, wo eine Farbe gesetzt ist. Daran
 * hängt, dass eine bestehende Installation ihre Dateien nach einem Update noch als die
 * eigenen erkennt (`tests/haproxy/page-design.test.ts` hält die Prüfsummen fest).
 */

/** Eine Farbe als `#rrggbb`. Nur diese Form geht in das `<style>` der Seite. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
}

export interface StaticTheme {
  /** Knopf, Fokusrahmen. `#rrggbb`. */
  accent?: string | null
  /** Die Fläche der Seite. `#rrggbb`. */
  background?: string | null
  /** Überschrift und Fließtext. `#rrggbb`. */
  text?: string | null
  /**
   * `undefined`: das Logo von HAPM. `null`: keines. Sonst ein Bild als Data-URI. Es
   * steht in einem `<img>`: ein SVG führt dort kein Skript aus und lädt nichts nach.
   */
  logo?: { src: string } | null
  /** Schriftzug neben dem Logo. */
  brand?: string
  /** Kleine Zeile am Fuß, etwa ein Kontakt. */
  footer?: string
}

function channels(hex: string): [number, number, number] {
  const digits = hex.slice(1)
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as [number, number, number]
}

/** `share` ist der Anteil von `to`. */
function mix(from: string, to: string, share: number): string {
  const a = channels(from)
  const b = channels(to)
  return `#${a.map((value, i) => Math.round(value + (b[i] - value) * share).toString(16).padStart(2, "0")).join("")}`
}

function rgba(hex: string, alpha: string): string {
  return `rgba(${channels(hex).join(",")},${alpha})`
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const share = value / 255
    return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Das Kontrastverhältnis zweier Farben nach WCAG, von 1 bis 21. */
export function contrastRatio(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (high + 0.05) / (low + 0.05)
}

interface AccentColors {
  accent: string
  accentHover: string
  onAccent: string
}

function accentColors(theme: StaticTheme, defaults: AccentColors): AccentColors {
  if (!isHexColor(theme.accent)) return defaults
  const accent = theme.accent.toLowerCase()
  const onAccent = contrastRatio(accent, "#ffffff") >= contrastRatio(accent, "#0f0f0f") ? "#fff" : "#0f0f0f"
  return {
    accent,
    // Beim Überfahren weg von der Schrift auf dem Knopf, sonst sänke der Kontrast.
    accentHover: onAccent === "#fff" ? mix(accent, "#ffffff", 0.14) : mix(accent, "#000000", 0.12),
    onAccent,
  }
}

/**
 * Die Fläche von Karte und Kopfleiste zu einem Hintergrund: auf hellem Grund weiß, auf
 * dunklem ein wenig heller als der Grund.
 */
function surfaceOn(background: string): string {
  return luminance(background) > 0.4 ? "#ffffff" : mix(background, "#ffffff", 0.08)
}

/** Die Farben, wie die Seiten sie ohne eigenes Aussehen tragen. Für die Vorbelegung eines Formulars. */
export const STATIC_THEME_DEFAULTS = {
  accent: "#1a5c4c",
  /** Die Fehlerseiten. Die Karte der Passwortabfrage steht auf `#edf0ef`. */
  background: "#f5f4f0",
  text: "#0f0f0f",
} as const

/**
 * Die Werte der Oberfläche (`css/08-shell-tokens.css`) als sRGB. Die Namen sind die der
 * Variablen im Stylesheet.
 */
function staticStyle(theme: StaticTheme): string {
  const accent = accentColors(theme, { accent: "#1a5c4c", accentHover: "#237a65", onAccent: "#fff" })
  const custom = isHexColor(theme.background) || isHexColor(theme.text)
  const bg = isHexColor(theme.background) ? theme.background.toLowerCase() : "#edf0ef"
  const text = isHexColor(theme.text) ? theme.text.toLowerCase() : "#090b0a"
  const surface = isHexColor(theme.background) ? surfaceOn(bg) : "#fff"

  const tokens = [
    `--bg:${bg}`,
    `--surface:${surface}`,
    `--field:${custom ? mix(surface, text, 0.05) : "#f2f5f4"}`,
    `--border:${custom ? mix(surface, text, 0.11) : "#e3e6e5"}`,
    `--border-strong:${custom ? mix(surface, text, 0.58) : "#707473"}`,
    `--text:${text}`,
    `--text-secondary:${custom ? mix(surface, text, 0.72) : "#4f5352"}`,
    `--text-tertiary:${custom ? mix(surface, text, 0.58) : "#707473"}`,
    `--accent:${accent.accent}`,
    `--accent-hover:${accent.accentHover}`,
    "--danger-light:#fff2f0",
    "--danger-fg:#90000c",
    "--warning-light:#fff3e6",
    "--warning-fg:#684001",
    "--info-light:#eff6ff",
    "--info-fg:#004991",
  ].join(";")

  return [
    `:root{${tokens}}`,
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
    `background:var(--accent);color:${accent.onAccent};font-family:inherit;font-size:.9375rem;font-weight:500;line-height:1.2;`,
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
    themeLogoSrc(theme) ? ".logo img{display:block;max-width:200px;max-height:72px;margin:0 auto}" : "",
    theme.brand ? ".brand{margin:0;font-size:1rem;font-weight:600;line-height:1.3;text-align:center}.logo img+.brand,.logo svg+.brand{margin-top:.75rem}" : "",
  ].join("")
}

/** Nur ein eingebettetes Bild: alles andere wäre eine zweite Anfrage an eine fremde Stelle. */
function themeLogoSrc(theme: StaticTheme): string | null {
  const src = theme.logo?.src
  return typeof src === "string" && /^data:image\/(?:svg\+xml|png|jpeg|webp)[;,]/.test(src) ? src : null
}

/** Das Logo einer Seite: das von HAPM, ein eigenes Bild oder nichts. */
function themeLogo(theme: StaticTheme, hidden: boolean): string {
  if (hidden || theme.logo === null) return ""
  if (theme.logo === undefined) return STATIC_LOGO_SVG
  const src = themeLogoSrc(theme)
  // Steht der Schriftzug daneben, ist das Bild Schmuck und wird nicht vorgelesen.
  return src ? `<img src="${escapeHtml(src)}" alt="${theme.brand ? "" : "Logo"}">` : ""
}

export interface StaticPage {
  /** Sprache des Dokuments. Vorgabe ist `locale`. */
  lang?: string
  /** Sprache der Seite. Vorgabe `de`. */
  locale?: Locale
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
export function renderStaticPage(page: StaticPage, theme: StaticTheme = {}): string {
  const mark =
    themeLogo(theme, page.logo === false) + (theme.brand ? `<p class="brand">${escapeHtml(theme.brand)}</p>` : "")
  const logo = mark ? `<div class="logo">${mark}</div>` : ""
  const footnote = page.footnote ?? theme.footer
  return (
    "<!doctype html>" +
    `<html lang="${escapeHtml(page.lang ?? page.locale ?? "de")}">` +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${escapeHtml(page.documentTitle ?? page.title)}</title>` +
    `<style>${staticStyle(theme)}</style>` +
    "</head>" +
    "<body>" +
    '<main class="card">' +
    logo +
    `<h1>${escapeHtml(page.title)}</h1>` +
    (page.subtitle ? `<p class="sub">${escapeHtml(page.subtitle)}</p>` : "") +
    (page.body ?? "") +
    (footnote ? `<p class="foot">${escapeHtml(footnote)}</p>` : "") +
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

function siteStyle(theme: StaticTheme): string {
  const accent = accentColors(theme, { accent: "#1a5c4c", accentHover: "#237a65", onAccent: "#fff" })
  const custom = isHexColor(theme.background) || isHexColor(theme.text)
  const bg = isHexColor(theme.background) ? theme.background.toLowerCase() : STATIC_THEME_DEFAULTS.background
  const text = isHexColor(theme.text) ? theme.text.toLowerCase() : STATIC_THEME_DEFAULTS.text
  const surface = isHexColor(theme.background) ? surfaceOn(bg) : "#fff"
  const navSurface = isHexColor(theme.background) ? rgba(surface, ".84") : "rgba(255,255,255,.84)"
  const hover = isHexColor(theme.text) ? rgba(text, ".06") : "rgba(15,15,15,.06)"
  const glow = custom ? rgba(mix(bg, text, 0.1), ".6") : "rgba(221,220,216,.6)"
  const buttonGlow = isHexColor(theme.accent) ? rgba(accent.accent, ".5") : "rgba(26,92,76,.5)"

  const tokens = [
    `--bg:${bg}`,
    `--surface:${surface}`,
    `--text:${text}`,
    `--text-secondary:${custom ? mix(bg, text, 0.67) : "#5a5753"}`,
    `--border:${custom ? mix(bg, text, 0.13) : "#d8d6d1"}`,
    `--accent:${accent.accent}`,
    `--accent-hover:${accent.accentHover}`,
    "--serif:'Instrument Serif','Times New Roman',Times,serif",
  ].join(";")

  return [
    `:root{${tokens}}`,
    "*{box-sizing:border-box;margin:0}",
    "body{background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;",
    "font:400 1rem/1.6 'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    /* .nav, .nav-inner: 12 px Abstand nach oben und 60 px Höhe ergeben 72 px. */
    ".nav{position:fixed;top:0;left:0;right:0;z-index:2;height:72px;padding:.75rem 2rem 0}",
    ".nav-inner{max-width:calc(1280px - 4rem);height:100%;margin:0 auto;padding:0 .625rem 0 calc(2rem - 1px);",
    "display:flex;align-items:center;justify-content:space-between;gap:1.5rem;border:1px solid var(--border);",
    `border-radius:100px;background:${navSurface};backdrop-filter:blur(18px);`,
    "box-shadow:0 1px 2px rgba(0,0,0,.04),0 14px 32px -18px rgba(0,0,0,.22)}",
    ".nav-logo{display:block;line-height:0}",
    ".nav-logo svg{display:block;width:152px;height:30px}",
    /* .nav-back */
    ".nav-back{display:inline-flex;align-items:center;gap:.5rem;height:2.5rem;padding:0 1rem 0 .75rem;",
    "border-radius:100px;color:var(--text-secondary);font-size:.875rem;font-weight:500;text-decoration:none}",
    `.nav-back:hover{background:${hover};color:var(--text)}`,
    ".nav-back svg{width:16px;height:16px}",
    /* .not-found, .not-found-content */
    ".nf{position:relative;display:flex;align-items:center;justify-content:center;min-height:100vh;",
    "min-height:100dvh;padding:72px 2rem 4rem;overflow:hidden;text-align:center}",
    ".nf::before{content:'';position:absolute;top:40%;left:50%;width:700px;height:700px;",
    "transform:translate(-50%,-50%);pointer-events:none;",
    `background:radial-gradient(ellipse,${glow} 0%,transparent 60%)}`,
    ".nf-c{position:relative;max-width:520px}",
    /* .not-found-code, -title, -desc */
    ".code{margin-bottom:1rem;color:var(--border);font-family:var(--serif);",
    "font-size:clamp(6rem,15vw,10rem);font-weight:400;line-height:1;letter-spacing:-.04em}",
    "h1{margin-bottom:1rem;font-family:var(--serif);font-size:clamp(1.5rem,3vw,2rem);font-weight:400;line-height:1.3}",
    ".desc{margin-bottom:3rem;color:var(--text-secondary);line-height:1.7}",
    ".desc:last-child{margin-bottom:0}",
    /* Der Knopf */
    ".btn{display:inline-flex;align-items:center;justify-content:center;gap:.55rem;padding:.9rem 2rem;",
    `border-radius:10px;background:var(--accent);color:${accent.onAccent};font-size:.9rem;font-weight:600;line-height:1.2;`,
    "text-decoration:none;",
    `box-shadow:0 1px 2px rgba(15,42,35,.16),0 6px 16px -8px ${buttonGlow},inset 0 1px 0 rgba(255,255,255,.14)}`,
    ".btn:hover{background:var(--accent-hover)}",
    ".btn svg{width:16px;height:16px}",
    ".btn:focus-visible,.nav-back:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    "@media(max-width:640px){.nav{padding:.75rem 1rem 0}.nav-inner{padding-left:1.25rem}.nf{padding:72px 1.25rem 3rem}}",
    themeLogoSrc(theme) ? ".nav-logo img{display:block;width:auto;height:30px;max-width:200px}" : "",
    theme.brand
      ? ".nav-logo{display:flex;align-items:center;gap:.625rem;color:var(--text);font-size:1rem;font-weight:600;line-height:1.2;text-decoration:none}"
      : "",
    theme.footer ? ".foot{margin-top:2.5rem;color:var(--text-secondary);font-size:.8125rem;line-height:1.5}.desc+.foot{margin-top:0}" : "",
  ].join("")
}

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
    title: msgid("Ungültige Anfrage"),
    text: msgid("Der Server konnte diese Anfrage nicht verarbeiten."),
    action: "home",
  },
  401: {
    title: msgid("Anmeldung erforderlich"),
    text: msgid("Für diese Seite ist eine Anmeldung nötig."),
    action: "none",
  },
  403: {
    title: msgid("Kein Zugriff"),
    text: msgid("Diese Seite ist von Ihrem Anschluss aus nicht erreichbar."),
    action: "none",
  },
  404: {
    title: msgid("Seite nicht gefunden"),
    text: msgid("Diese Seite gibt es nicht oder sie wurde verschoben."),
    action: "home",
  },
  405: {
    title: msgid("Nicht erlaubt"),
    text: msgid("Diese Art von Anfrage nimmt die Seite nicht an."),
    action: "home",
  },
  408: {
    title: msgid("Zeitüberschreitung"),
    text: msgid("Die Anfrage hat zu lange gedauert. Bitte laden Sie die Seite neu."),
    action: "retry",
  },
  410: {
    title: msgid("Nicht mehr vorhanden"),
    text: msgid("Diese Seite gibt es nicht mehr."),
    action: "home",
  },
  413: {
    title: msgid("Zu groß"),
    text: msgid("Die gesendeten Daten sind größer, als die Seite annimmt."),
    action: "none",
  },
  429: {
    title: msgid("Zu viele Anfragen"),
    text: msgid("Bitte warten Sie einen Moment und versuchen Sie es dann erneut."),
    action: "retry",
  },
  500: {
    title: msgid("Interner Fehler"),
    text: msgid("Auf dem Server ist ein Fehler aufgetreten. Bitte versuchen Sie es später erneut."),
    action: "retry",
  },
  501: {
    title: msgid("Nicht unterstützt"),
    text: msgid("Diese Art von Anfrage unterstützt der Server nicht."),
    action: "home",
  },
  502: {
    title: msgid("Fehlerhafte Antwort"),
    text: msgid("Die Seite hat nicht richtig geantwortet. Bitte versuchen Sie es in Kürze erneut."),
    action: "retry",
  },
  503: {
    title: msgid("Gerade nicht erreichbar"),
    text: msgid("Die Seite ist im Moment nicht erreichbar. Bitte versuchen Sie es in Kürze erneut."),
    action: "retry",
  },
  504: {
    title: msgid("Zeitüberschreitung"),
    text: msgid("Die Seite hat nicht rechtzeitig geantwortet. Bitte versuchen Sie es in Kürze erneut."),
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
 *
 * `locale` übersetzt, was die Seite selbst mitbringt. Was in `override` steht, bleibt,
 * wie es kommt: ein eigener Text ist in der Sprache, in der jemand ihn geschrieben hat.
 */
export function renderErrorPage(
  status: number,
  override: Partial<ErrorPageText> & { logo?: boolean; lang?: string; locale?: Locale } = {},
  theme: StaticTheme = {},
): string {
  const locale = override.locale ?? "de"
  const t = (text: string) => translate(locale, text)
  const known = ERROR_PAGE_TEXTS[status]
  const base: ErrorPageText = known ?? {
    title: msgid("Fehler"),
    text:
      status >= 500
        ? msgid("Auf dem Server ist ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.")
        : msgid("Diese Anfrage ließ sich nicht verarbeiten."),
    action: status >= 500 ? "retry" : "home",
  }
  const page: ErrorPageText = {
    title: override.title ?? t(base.title),
    text: override.text ?? t(base.text),
    action: override.action ?? base.action,
  }
  const button =
    page.action === "retry"
      ? `<a class="btn" href="">${escapeHtml(t("Erneut versuchen"))}${ARROW}</a>`
      : page.action === "home"
        ? `<a class="btn" href="/">${escapeHtml(t("Zur Startseite"))}${ARROW}</a>`
        : ""
  const logo =
    themeLogo(theme, override.logo === false) +
    (theme.brand ? `<span class="nav-brand">${escapeHtml(theme.brand)}</span>` : "")

  return (
    "<!doctype html>" +
    `<html lang="${escapeHtml(override.lang ?? locale)}">` +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${escapeHtml(`${page.title} (${status})`)}</title>` +
    `<style>${siteStyle(theme)}</style>` +
    "</head>" +
    "<body>" +
    '<header class="nav"><div class="nav-inner">' +
    `<a class="nav-logo" href="/" aria-label="${escapeHtml(t("Startseite"))}">${logo}</a>` +
    /* „Zurück" heißt zurück: mit JavaScript die vorige Seite, ohne die Startseite. Das
       ist die einzige Stelle mit Skript, und die Seite funktioniert ohne. */
    `<a class="nav-back" href="/" onclick="history.back();return false">${CHEVRON}${escapeHtml(t("Zurück"))}</a>` +
    "</div></header>" +
    '<main class="nf"><div class="nf-c">' +
    `<p class="code" aria-hidden="true">${escapeHtml(String(status))}</p>` +
    `<h1>${escapeHtml(page.title)}</h1>` +
    `<p class="desc">${escapeHtml(page.text)}</p>` +
    button +
    (theme.footer ? `<p class="foot">${escapeHtml(theme.footer)}</p>` : "") +
    "</div></main>" +
    "</body>" +
    "</html>\n"
  )
}
