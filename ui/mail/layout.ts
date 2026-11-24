/**
 * Der Rahmen aller E-Mails von HAPM: Kopf mit Logo, Karte, Bausteine für den
 * Inhalt, Knopf, Fußzeile.
 *
 * Hellgraue Seitenfläche, weiße Karte mit 24 px Radius, Flächen in der Karte mit
 * 18 px, Knöpfe als Pill, Akzent Grün. Die Farben stehen hier als feste Werte,
 * weil ein Mailprogramm keine CSS-Variablen kennt. Ändert sich eine Farbe in
 * `ui/css/`, wird sie hier von Hand angepasst.
 *
 * Die Datei kennt weder SMTP noch Datenbank. Sie baut nur Zeichenketten, damit
 * sie sich ohne Umgebung testen und ohne Versand rendern lässt.
 *
 * Es wird nichts nachgeladen: keine Web-Schrift, kein Bild von einem Server.
 * Ein Nachladen überträgt beim Öffnen die IP des Empfängers. Die Schrift ist
 * deshalb nur ein Wunsch mit Systemschriften dahinter, das Logo hängt als
 * Anhang an der Mail (`cid:`).
 *
 * Was der Rahmen selbst schreibt (Fuß, Hinweis unter dem Knopf, `<html lang>`),
 * steht in der Sprache des Absenders (`MailSender.locale`, Vorgabe Deutsch).
 */

import { translate, type Locale } from "@/lib/i18n"

/**
 * Wer die Mail verschickt. Daraus entsteht die Fußzeile.
 *
 * HAPM betreibt, wer es installiert hat. Der Absender ist deshalb eine
 * Installation auf einem Server und keine Firma: der Fuß nennt, woher die Mail
 * kommt und warum man sie bekommt, sonst nichts.
 */
export interface MailSender {
  /** Name des Werkzeugs: fett im Fuß und als Alternativtext am Logo. */
  name: string
  /** Name des Servers, auf dem die Installation läuft. */
  nodeName: string
  /** Adresse der Oberfläche. Ohne sie (oder ohne `http(s)`) steht kein Link im Fuß. */
  url?: string | null
  /**
   * Ein Satz dazu, warum der Empfänger die Mail bekommt. Reiner Text. Er steht
   * direkt hinter dem Satz zur Herkunft und darf sich auf ihn beziehen.
   */
  reason?: string
  /** Sprache der Mail. Vorgabe `de`. */
  locale?: Locale
}

/** Verweise auf die beiden Logo-Anhänge, die der Versand an jede Mail hängt. */
export const MAIL_LOGO_CID = "hapm-logo"
export const MAIL_LOGO_DARK_CID = "hapm-logo-dark"

/**
 * Anzeigegröße des Logos (Dateien unter `public/email/`, 228 × 64, erzeugt mit
 * `scripts/build-mail-logos.mjs`). Das Logo steht frei, ohne Fläche dahinter.
 * Dafür gibt es zwei: das dunkle für helle Darstellung und das weiße, auf das
 * Programme mit dunklem Design umschalten (Media Query und `[data-ogsc]`).
 * Programme, die nur den Hintergrund abdunkeln und Bilder stehen lassen
 * (Gmail-App), zeigen weiter das dunkle. Es hat deshalb einen feinen hellen
 * Saum, der auf Weiß nicht zu sehen ist. Das klassische Outlook bekommt nur das
 * dunkle, das weiße steht in einem Kommentar, den es überspringt.
 */
const LOGO_SIZE = { width: 142, height: 28 } as const

/** Breite der Karte in Pixeln. */
const COLUMN_WIDTH = 600

/** Farben hell: neutrale Töne, Akzent Grün. */
const light = {
  page: "#f2f5f4",
  card: "#ffffff",
  panel: "#f2f5f4",
  border: "#e3e6e5",
  text: "#090b0a",
  muted: "#4f5352",
  accent: "#1a5c4c",
  accentTint: "#e6f2ee",
  accentTintText: "#154c40",
  warningTint: "#fdeaea",
  warningText: "#6a0d12",
  danger: "#b10613",
  dangerTint: "#fff2f0",
} as const

/** Farben für Mailprogramme mit dunklem Design. */
const dark = {
  page: "#0d0f0e",
  card: "#181a19",
  panel: "#242726",
  border: "#242726",
  rule: "#353938",
  text: "#f8fbfa",
  muted: "#b5b8b7",
  /** Knopf: das hellere Grün, damit er sich von der dunklen Karte abhebt. */
  accent: "#237a65",
  /** Grüner Text auf dunklem Grund. */
  accentText: "#aed9cc",
  accentTint: "#0a2a23",
  warningTint: "#3a0d10",
  warningText: "#ffc9c4",
  danger: "#ff7267",
  dangerTint: "#4f0003",
} as const

const FONT =
  "'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO =
  "ui-monospace,'SFMono-Regular','Cascadia Mono','Segoe UI Mono',Consolas,'Courier New',monospace"

/** Schrift mit Zeilenhöhe ohne Einheit: sie wächst mit, wenn ein Mailprogramm die Schrift vergrößert. */
const type = (size: number, lineHeight: number) =>
  `font-family:${FONT};font-size:${size}px;line-height:${Number((lineHeight / size).toFixed(3))}`

/** Lange Wörter (Adressen, Token, Domains) brechen auf schmalen Bildschirmen um. */
const WRAP = "overflow-wrap:anywhere;word-wrap:break-word;word-break:break-word"

const TEXT = `${type(16, 26)};${WRAP};color:${light.muted}`
const SMALL = `${type(14, 22)};${WRAP};color:${light.muted}`

const SHADOW_CARD = "0 1px 2px rgba(20,23,22,0.03),0 6px 20px -6px rgba(20,23,22,0.07)"
const SHADOW_BUTTON = "0 1px 2px rgba(20,23,22,0.18),0 2px 6px -2px rgba(20,23,22,0.16)"

const TABLE = `role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  )
}

/** Text aus einem Formular: maskiert, Zeilenumbrüche bleiben. */
export function escapeMultiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br>")
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value)

/** Ziele, die ein Knopf haben darf. Alles andere (`javascript:`, `data:`) fällt weg. */
const isActionUrl = (value: string) => isHttpUrl(value) || /^mailto:[^\s<>"]+$/i.test(value)

/* ── Bausteine ─────────────────────────────────────────────────────────────
 *
 * Jeder Baustein liefert fertiges HTML für `body`. Was als `html` hereinkommt,
 * ist bereits maskiert (Aufrufer nutzt `escapeHtml`); was als `text`, `label`,
 * `value` oder `title` hereinkommt, maskiert der Baustein selbst.
 */

/** Absatz. `html` ist bereits maskiert und darf `<strong>`, `<br>` und Links enthalten. */
export function mailText(html: string): string {
  return `<p class="v-muted" style="margin:0 0 16px;${TEXT}">${html}</p>`
}

/** Kleingedrucktes: Gültigkeit, Hinweise, Haftungssatz. */
export function mailSmall(html: string): string {
  return `<p class="v-muted" style="margin:0 0 12px;${SMALL}">${html}</p>`
}

/** Link im Fließtext. Ohne `label` steht die Adresse selbst da. */
export function mailLink(url: string, label?: string, tone: "accent" | "danger" = "accent"): string {
  const cls = tone === "danger" ? "v-danger" : "v-accent"
  const color = tone === "danger" ? light.danger : light.accent
  return `<a href="${escapeHtml(url)}" class="${cls}" style="color:${color};font-weight:500;text-decoration:underline">${escapeHtml(label ?? url.replace(/^mailto:/i, ""))}</a>`
}

export interface MailFact {
  label: string
  value: string
  /** Macht den Wert zum Link. */
  href?: string
  /** Festbreitenschrift, für Passwörter und Schlüssel. */
  mono?: boolean
  /** `strike`: überholte Angabe (abgesagter Termin). `accent`: die Angabe, auf die es ankommt. */
  tone?: "strike" | "accent" | "muted"
}

/**
 * Angaben in einer Fläche: Bezeichnung links, Wert rechts, feine Linie
 * dazwischen. Auf schmalen Bildschirmen steht der Wert unter der Bezeichnung.
 * `stacked` setzt das immer so, für lange Werte wie Freitext.
 */
export function mailFacts(
  facts: MailFact[],
  options: { title?: string; stacked?: boolean } = {}
): string {
  const rows = facts.filter((f) => f.label || f.value)
  if (rows.length === 0) return ""

  const rule = (i: number) => (i > 0 || options.title ? `border-top:1px solid ${light.border};` : "")
  const valueHtml = (f: MailFact) => {
    const text = escapeMultiline(f.value || "–")
    if (!f.href || !isActionUrl(f.href)) return text
    return `<a href="${escapeHtml(f.href)}" class="v-text" style="color:${light.text};text-decoration:underline">${text}</a>`
  }
  const valueStyle = (f: MailFact) => {
    const color = f.tone === "strike" || f.tone === "muted" ? light.muted : f.tone === "accent" ? light.accent : light.text
    const cls = f.tone === "strike" || f.tone === "muted" ? "v-muted" : f.tone === "accent" ? "v-accent" : "v-text"
    const font = f.mono ? `font-family:${MONO};font-size:14px;line-height:1.571` : type(14, 22)
    const extra = f.tone === "strike" ? ";text-decoration:line-through" : ""
    return { cls, style: `${font};font-weight:${f.tone === "strike" || f.tone === "muted" ? 400 : 500};color:${color};word-break:break-word${extra}` }
  }

  const body = rows
    .map((f, i) => {
      const v = valueStyle(f)
      if (options.stacked) {
        return `<tr><td class="v-rule" valign="top" style="padding:10px 0;${rule(i)}"><span class="v-muted" style="display:block;${type(13, 20)};color:${light.muted}">${escapeHtml(f.label)}</span><span class="${v.cls}" style="display:block;${v.style}">${valueHtml(f)}</span></td></tr>`
      }
      return `<tr><td class="v-muted v-rule v-fl" valign="top" style="padding:10px 16px 10px 0;${rule(i)}${type(14, 22)};color:${light.muted}">${escapeHtml(f.label)}</td><td class="${v.cls} v-rule v-fv" valign="top" align="right" style="padding:10px 0;${rule(i)}${v.style};text-align:right">${valueHtml(f)}</td></tr>`
    })
    .join("")

  const title = options.title
    ? `<tr><td class="v-text"${options.stacked ? "" : ' colspan="2"'} style="padding:12px 0 10px;${type(14, 22)};font-weight:600;color:${light.text}">${escapeHtml(options.title)}</td></tr>`
    : ""

  return panel(
    `<tr><td class="v-panel-pad" style="padding:6px 20px"><table ${TABLE} style="border-collapse:collapse">${title}${body}</table></td></tr>`,
    "8px 0 24px"
  )
}

/** Text, den ein Mensch geschrieben hat (eine Notiz, eine Nachricht), in einer Fläche. */
export function mailQuote(text: string, label?: string): string {
  const head = label
    ? `<p class="v-muted" style="margin:0 0 6px;${type(13, 20)};font-weight:500;color:${light.muted}">${escapeHtml(label)}</p>`
    : ""
  return panel(
    `<tr><td class="v-panel-pad" style="padding:16px 20px">${head}<p class="v-text" style="margin:0;${type(15, 24)};${WRAP};color:${light.text}">${escapeMultiline(text)}</p></td></tr>`,
    "8px 0 24px"
  )
}

export type MailNoteTone = "neutral" | "accent" | "warning" | "danger"

const NOTE_TONES: Record<MailNoteTone, { bg: string; color: string; panel: string; text: string }> = {
  neutral: { bg: light.panel, color: light.muted, panel: "v-panel", text: "v-muted" },
  accent: { bg: light.accentTint, color: light.accentTintText, panel: "v-tint", text: "v-tint-text" },
  warning: { bg: light.warningTint, color: light.warningText, panel: "v-warn", text: "v-warn-text" },
  danger: { bg: light.dangerTint, color: light.danger, panel: "v-danger-tint", text: "v-danger" },
}

/** Infokasten. `html` ist bereits maskiert, `title` nicht. */
export function mailNote(html: string, tone: MailNoteTone = "neutral", title?: string): string {
  const t = NOTE_TONES[tone]
  const head = title
    ? `<p class="${t.text}" style="margin:0 0 2px;font-weight:600;color:${t.color}">${escapeHtml(title)}</p>`
    : ""
  return `<table ${TABLE} class="${t.panel}" bgcolor="${t.bg}" style="margin:8px 0 24px;border-collapse:separate;background-color:${t.bg};border-radius:18px"><tr><td class="v-panel-pad ${t.text}" style="padding:14px 20px;${type(14, 22)};${WRAP};color:${t.color}">${head}${html}</td></tr></table>`
}

/** Nummerierte Schritte unter einer Zwischenüberschrift. */
export function mailSteps(steps: string[], title?: string): string {
  const items = steps.filter((s) => s.trim())
  if (items.length === 0) return ""
  const head = title
    ? `<p class="v-text" style="margin:8px 0 8px;${type(15, 24)};font-weight:600;color:${light.text}">${escapeHtml(title)}</p>`
    : ""
  const rows = items
    .map(
      (step, i) =>
        `<tr><td class="v-accent" valign="top" width="26" style="padding:4px 0;${type(15, 24)};font-weight:600;color:${light.accent}">${i + 1}.</td><td class="v-muted" valign="top" style="padding:4px 0;${type(15, 24)};${WRAP};color:${light.muted}">${escapeHtml(step)}</td></tr>`
    )
    .join("")
  return `${head}<table ${TABLE} style="margin:0 0 24px;border-collapse:collapse">${rows}</table>`
}

/** Kasten mit einem Link als Überschrift, etwa zur Anleitung eines Dienstes. */
export function mailLinkCard(card: { eyebrow?: string; title: string; text?: string; url: string }): string {
  const eyebrow = card.eyebrow
    ? `<p class="v-accent" style="margin:0 0 4px;${type(13, 20)};font-weight:500;color:${light.accent}">${escapeHtml(card.eyebrow)}</p>`
    : ""
  const text = card.text
    ? `<p class="v-muted" style="margin:4px 0 0;${SMALL}">${escapeHtml(card.text)}</p>`
    : ""
  return `<table ${TABLE} class="v-border" style="margin:8px 0 24px;border-collapse:separate;border:1px solid ${light.border};border-radius:18px"><tr><td class="v-panel-pad" style="padding:16px 20px">${eyebrow}<p style="margin:0;${type(16, 24)};${WRAP};font-weight:600"><a href="${escapeHtml(card.url)}" class="v-text" style="color:${light.text};text-decoration:none">${escapeHtml(card.title)} &rarr;</a></p>${text}</td></tr></table>`
}

/** Eine Wahlmöglichkeit mit eigenem Knopf, etwa ein Terminvorschlag. */
export function mailOption(option: { label?: string; title: string; detail?: string; action: MailAction }): string {
  const label = option.label
    ? `<p class="v-muted" style="margin:0 0 2px;${type(13, 20)};font-weight:500;color:${light.muted}">${escapeHtml(option.label)}</p>`
    : ""
  const detail = option.detail
    ? `<p class="v-muted" style="margin:2px 0 0;${SMALL}">${escapeHtml(option.detail)}</p>`
    : ""
  return panel(
    `<tr><td class="v-panel-pad" style="padding:16px 20px 18px">${label}<p class="v-text" style="margin:0;${type(16, 24)};${WRAP};font-weight:600;color:${light.text}">${escapeHtml(option.title)}</p>${detail}${mailButtons([option.action], "14px 0 0")}</td></tr>`,
    "0 0 12px"
  )
}

/** Bild von der eigenen Domain mit Bezeichnung darüber. Ohne `http(s)`-Adresse fällt es weg. */
export function mailImage(image: { src: string; alt: string; label?: string }): string {
  if (!isHttpUrl(image.src)) return ""
  const label = image.label
    ? `<p class="v-muted" style="margin:0 0 6px;${type(13, 20)};font-weight:500;color:${light.muted}">${escapeHtml(image.label)}</p>`
    : ""
  return `<div style="margin:0 0 20px">${label}<img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" width="536" class="v-border" style="display:block;width:100%;max-width:536px;height:auto;border:1px solid ${light.border};border-radius:14px"></div>`
}

/** Zwischenüberschrift im Inhalt. */
export function mailSubheading(text: string): string {
  return `<p class="v-text" style="margin:8px 0 8px;${type(18, 26)};${WRAP};font-weight:600;letter-spacing:-0.27px;color:${light.text}">${escapeHtml(text)}</p>`
}

const panel = (inner: string, margin: string) =>
  `<table ${TABLE} class="v-panel" bgcolor="${light.panel}" style="margin:${margin};border-collapse:separate;background-color:${light.panel};border-radius:18px">${inner}</table>`

/* ── Knöpfe ────────────────────────────────────────────────────────────── */

export interface MailAction {
  label: string
  url: string
  /** `primary`: grün mit weißer Schrift. `secondary`: graue Fläche. `danger`: Absage, Storno. */
  tone?: "primary" | "secondary" | "danger"
}

const BUTTON_TONES = {
  primary: { bg: light.accent, color: "#ffffff", cls: "v-btn", shadow: `box-shadow:${SHADOW_BUTTON};` },
  secondary: { bg: light.panel, color: light.text, cls: "v-btn2", shadow: "" },
  danger: { bg: light.dangerTint, color: light.danger, cls: "v-btn-danger", shadow: "" },
} as const

/** Breite des Knopfes für Outlook: VML kennt keine Breite aus dem Inhalt. */
const buttonWidth = (label: string) => Math.max(120, Math.round(label.length * 8.6) + 44)

/**
 * Pill-Knöpfe nebeneinander, auf schmalen Bildschirmen untereinander. Outlook
 * für Windows kennt weder Radius noch Innenabstand an Links und bekommt je
 * Knopf eine VML-Fläche.
 */
export function mailButtons(actions: MailAction[], margin = "8px 0 24px"): string {
  const valid = actions.filter((a) => a.label && isActionUrl(a.url))
  if (valid.length === 0) return ""
  const many = valid.length > 1

  const vml = valid
    .map((a) => {
      const t = BUTTON_TONES[a.tone ?? "primary"]
      const href = escapeHtml(a.url)
      const label = escapeHtml(a.label)
      return `<td style="padding:0 8px 8px 0"><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" alt="${label}" style="height:44px;v-text-anchor:middle;width:${buttonWidth(a.label)}px" arcsize="50%" stroke="f" fillcolor="${t.bg}"><w:anchorlock/><center style="color:${t.color};font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:600">${label}</center></v:roundrect></td>`
    })
    .join("")

  const links = valid
    .map((a) => {
      const t = BUTTON_TONES[a.tone ?? "primary"]
      return `<a class="${t.cls}" href="${escapeHtml(a.url)}" target="_blank" rel="noopener" style="display:inline-block;${many ? "margin:0 8px 8px 0;" : ""}padding:12px 20px;border-radius:9999px;background-color:${t.bg};${t.shadow}${type(15, 20)};font-weight:600;letter-spacing:-0.08px;color:${t.color};text-decoration:none">${escapeHtml(a.label)}</a>`
    })
    .join("")

  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${margin}"><tr><td>`,
    `<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${vml}</tr></table><![endif]-->`,
    `<!--[if !mso]><!-->${links}<!--<![endif]-->`,
    "</td></tr></table>",
  ].join("")
}

/* ── Rahmen ────────────────────────────────────────────────────────────── */

export interface MailFrame {
  /** Betreff, steht im `<title>`. */
  subject: string
  /** Vorschauzeile im Posteingang; ohne sie der Anfang des Inhalts. */
  preheader?: string
  /** Stichwort über der Überschrift, etwa „Support". */
  eyebrow?: string
  /** Überschrift, eine je Mail. */
  heading: string
  /** Anrede, etwa „Hallo Erika Mustermann,". */
  greeting?: string
  /** Inhalt aus den Bausteinen dieser Datei oder bereits maskiertes HTML. */
  body: string
  /** Hauptaktion als Knopf nach dem Inhalt. */
  action?: MailAction
  /** Kleingedrucktes nach der Hauptaktion, bereits maskiertes HTML. */
  afterAction?: string
  /** Nennt die Adresse der Hauptaktion am Ende der Karte zum Kopieren. Standard: ja. */
  actionLink?: boolean
  /**
   * Zeile über dem Absender in der Fußzeile, bereits maskiertes HTML. Für das,
   * was je Mail verschieden ist: wo sich diese Art Mail abstellen lässt.
   */
  footerNote?: string
}

/** Ob eine Zeile eine Anrede ist und keine Überschrift. */
export function isSalutation(line: string): boolean {
  return /^(hallo|guten (tag|morgen|abend)|sehr geehrte|liebe[rs]?)\b/i.test(line.trim())
}

/** Überschrift aus einem Betreff der Form „Was – Wozu": der Teil vor dem Strich. */
export function headingFromSubject(subject: string): string {
  return (subject.split(/\s[–—]\s/)[0] ?? "").trim() || subject.trim()
}

/**
 * HTML ohne eigene Stile bekommt die des Rahmens. Das betrifft Inhalte, die
 * Aufrufer als fertige Zeichenkette übergeben (`<strong>`, schlichte Links).
 */
function styleBareTags(html: string): string {
  return html
    .replace(/<strong>/g, `<strong class="v-text" style="font-weight:600;color:${light.text}">`)
    .replace(/<a href="([^"]*)">/g, `<a href="$1" class="v-accent" style="color:${light.accent};font-weight:500;text-decoration:underline">`)
    .replace(/<code>/g, `<code class="v-text" style="font-family:${MONO};font-size:14px;color:${light.text}">`)
}

/** Der Servername einer Adresse, wie er im Fuß als Linktext steht. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Was der Fuß über den Absender sagt, als reiner Text: woher die Mail kommt,
 * warum man sie bekommt und, wenn eingerichtet, die Adresse der Oberfläche.
 * Der Fuß der HTML-Fassung und die Textfassung einer Mail bauen beide darauf
 * auf, damit sie dasselbe sagen.
 */
export function mailSenderLines(sender: MailSender): { origin: string; reason?: string; url?: string } {
  return {
    origin: translate(sender.locale ?? "de", "Diese Mail kommt von der {name}-Installation auf dem Server {node}.", {
      name: sender.name,
      node: sender.nodeName,
    }),
    reason: sender.reason?.trim() || undefined,
    url: sender.url && isHttpUrl(sender.url) ? sender.url : undefined,
  }
}

function footer(sender: MailSender, note?: string): string {
  const link = `class="v-muted" style="color:${light.muted};text-decoration:underline"`
  const p = (html: string, margin: string) =>
    `<p class="v-muted" style="margin:${margin};${type(13, 22)};${WRAP};color:${light.muted}">${html}</p>`
  const { origin, reason, url } = mailSenderLines(sender)
  // Eigene Zeile für die Adresse: eine lange Zeile bräche auf dem Telefon mitten
  // im Servernamen um.
  const lines = [escapeHtml(reason ? `${origin} ${reason}` : origin)]
  if (url) {
    const label = escapeHtml(translate(sender.locale ?? "de", "Oberfläche:"))
    lines.push(`${label} <a href="${escapeHtml(url)}" ${link}>${escapeHtml(hostOf(url))}</a>`)
  }
  return [
    note ? p(note.replace(/<a href="([^"]*)">/g, `<a href="$1" ${link}>`), "0 0 16px") : "",
    `<p class="v-text" style="margin:0 0 4px;${type(14, 22)};font-weight:600;color:${light.text}">${escapeHtml(sender.name)}</p>`,
    p(lines.join("<br>"), "0"),
  ].join("")
}

/** Farben für Mailprogramme mit dunklem Design (Apple Mail, Outlook-Apps, Outlook.com). */
function darkStyles(): string {
  const rules = (prefix: string) =>
    [
      `${prefix}.v-bg{background-color:${dark.page}!important}`,
      `${prefix}.v-card{background-color:${dark.card}!important;border-color:${dark.border}!important;box-shadow:none!important}`,
      `${prefix}.v-text{color:${dark.text}!important}`,
      `${prefix}.v-muted{color:${dark.muted}!important}`,
      `${prefix}.v-accent{color:${dark.accentText}!important}`,
      `${prefix}.v-border{border-color:${dark.rule}!important}`,
      `${prefix}.v-rule{border-color:${dark.rule}!important}`,
      `${prefix}.v-panel{background-color:${dark.panel}!important}`,
      `${prefix}.v-tint{background-color:${dark.accentTint}!important}`,
      `${prefix}.v-tint-text{color:${dark.accentText}!important}`,
      `${prefix}.v-warn{background-color:${dark.warningTint}!important}`,
      `${prefix}.v-warn-text{color:${dark.warningText}!important}`,
      `${prefix}.v-logo-light{display:none!important}`,
      `${prefix}.v-logo-dark{display:block!important;max-height:none!important;overflow:visible!important}`,
      `${prefix}.v-danger{color:${dark.danger}!important}`,
      `${prefix}.v-danger-tint{background-color:${dark.dangerTint}!important}`,
      `${prefix}.v-btn{background-color:${dark.accent}!important;color:#ffffff!important;box-shadow:none!important}`,
      `${prefix}.v-btn2{background-color:${dark.panel}!important;color:${dark.text}!important}`,
      `${prefix}.v-btn-danger{background-color:${dark.dangerTint}!important;color:${dark.danger}!important}`,
    ].join("")
  return `@media (prefers-color-scheme:dark){${rules("")}}${rules("[data-ogsc] ")}${rules("[data-ogsb] ")}`
}

/** Schmale Bildschirme: weniger Rand, kleinere Überschrift, Angaben untereinander. */
const MOBILE_STYLES = [
  "@media (max-width:600px){",
  ".v-outer{padding:24px 12px!important}",
  ".v-head{padding:18px 20px!important}",
  ".v-pad{padding:28px 20px 32px!important}",
  ".v-foot{padding:24px 20px 0!important}",
  ".v-panel-pad{padding-left:16px!important;padding-right:16px!important}",
  ".v-h1{font-size:26px!important}",
  ".v-fl{display:block!important;padding:10px 0 0!important}",
  ".v-fv{display:block!important;padding:2px 0 10px!important;border-top:0!important;text-align:left!important}",
  "}",
].join("")

/** Baut die vollständige HTML-Mail. */
export function renderMailHtml(frame: MailFrame, sender: MailSender): string {
  const locale = sender.locale ?? "de"
  const action = frame.action && isActionUrl(frame.action.url) ? frame.action : undefined
  const body = styleBareTags(frame.body)
  const preheader = frame.preheader ?? htmlToText(frame.body).replace(/\s+/g, " ").slice(0, 140)

  const content: string[] = []
  if (frame.eyebrow) {
    content.push(
      `<p class="v-accent" style="margin:0 0 12px;${type(14, 20)};font-weight:500;color:${light.accent}">${escapeHtml(frame.eyebrow)}</p>`
    )
  }
  content.push(
    `<h1 class="v-text v-h1" style="margin:0 0 20px;${type(30, 34)};${WRAP};font-weight:600;letter-spacing:-0.9px;color:${light.text}">${escapeHtml(frame.heading)}</h1>`
  )
  if (frame.greeting) content.push(mailText(escapeHtml(frame.greeting)))
  // Der Rahmen um den Inhalt gibt auch schlichtem Text ohne Absatz die Schrift.
  content.push(`<div class="v-muted" style="${TEXT}">${body}</div>`)
  if (action) content.push(mailButtons([action], "8px 0 32px"))
  if (frame.afterAction) content.push(styleBareTags(frame.afterAction))
  if (action && isHttpUrl(action.url) && frame.actionLink !== false) {
    content.push(
      `<p class="v-muted" style="margin:32px 0 0;${type(13, 20)};color:${light.muted}">${escapeHtml(translate(locale, "Oder diesen Link im Browser öffnen:"))}<br><a href="${escapeHtml(action.url)}" target="_blank" rel="noopener" class="v-muted" style="color:${light.muted};text-decoration:underline;word-break:break-all">${escapeHtml(action.url)}</a></p>`
    )
  }

  // Die Farbe am Bild gilt dem Alternativtext, wenn Bilder blockiert sind.
  const logoImg = (cid: string, cls: string, color: string) =>
    `<img${cls ? ` class="${cls}"` : ""} src="cid:${cid}" width="${LOGO_SIZE.width}" height="${LOGO_SIZE.height}" alt="${escapeHtml(sender.name)}" style="display:block;border:0;outline:none;text-decoration:none;width:${LOGO_SIZE.width}px;height:${LOGO_SIZE.height}px;${type(20, LOGO_SIZE.height)};font-weight:600;color:${color}">`
  const logo = [
    logoImg(MAIL_LOGO_CID, "v-logo-light", light.text),
    `<!--[if !mso]><!--><div class="v-logo-dark" style="display:none;max-height:0;overflow:hidden">${logoImg(MAIL_LOGO_DARK_CID, "", dark.text)}</div><!--<![endif]-->`,
  ].join("")

  return [
    "<!doctype html>",
    `<html lang="${locale}" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="x-apple-disable-message-reformatting">`,
    `<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="supported-color-schemes" content="light dark">`,
    `<title>${escapeHtml(frame.subject)}</title>`,
    "<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>body,table,td,p,a,h1,span,div{font-family:'Segoe UI',Arial,sans-serif!important}</style><![endif]-->",
    "<style>",
    ":root{color-scheme:light dark;supported-color-schemes:light dark}",
    "body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;-webkit-font-smoothing:antialiased}",
    "table,td{mso-table-lspace:0;mso-table-rspace:0}",
    "img{-ms-interpolation-mode:bicubic}",
    MOBILE_STYLES,
    darkStyles(),
    "</style>",
    "</head>",
    `<body class="v-bg" style="margin:0;padding:0;background-color:${light.page}">`,
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`,
    `<table ${TABLE} class="v-bg" bgcolor="${light.page}" style="background-color:${light.page}">`,
    `<tr><td class="v-outer" align="center" style="padding:40px 16px">`,
    `<!--[if mso]><table role="presentation" width="${COLUMN_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->`,
    `<table ${TABLE} style="max-width:${COLUMN_WIDTH}px">`,
    `<tr><td class="v-card" bgcolor="${light.card}" style="background-color:${light.card};border:1px solid ${light.border};border-radius:24px;box-shadow:${SHADOW_CARD}">`,
    `<table ${TABLE}>`,
    `<tr><td class="v-head v-border" align="left" style="padding:20px 32px;border-bottom:1px solid ${light.border}">${logo}</td></tr>`,
    `<tr><td class="v-pad" align="left" style="padding:36px 32px 40px">${content.join("")}</td></tr>`,
    "</table>",
    "</td></tr>",
    `<tr><td class="v-foot" align="left" style="padding:28px 32px 0">${footer(sender, frame.footerNote)}</td></tr>`,
    "</table>",
    "<!--[if mso]></td></tr></table><![endif]-->",
    "</td></tr></table>",
    "</body>",
    "</html>",
  ].join("\n")
}

/* ── Text-Alternative ──────────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", ensp: " ", zwnj: "",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  bdquo: "„", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–",
  middot: "·", bull: "•", rarr: "→", euro: "€",
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name.charAt(1).toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name] ?? match
  })
}

/**
 * Inhalt als reiner Text, für die Text-Alternative einer Mail.
 *
 * Angaben aus `mailFacts` werden „Bezeichnung: Wert", Links „Text: Adresse",
 * Absätze und Flächen trennt eine Leerzeile. Die Teile nur für Outlook (VML)
 * fallen weg, sonst stünde jeder Knopf doppelt da.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Knöpfe nebeneinander: je einer pro Zeile.
    .replace(/<\/a>(?=<a\b)/gi, "</a><br>")
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      // Maskiert lassen: was hier schon entschlüsselt würde, fiele unten als Tag weg.
      const label = inner.replace(/<[^>]+>/g, "").replace(/\s*(&rarr;|→)\s*$/, "").trim()
      const plain = decodeEntities(href).replace(/^mailto:/i, "")
      return !label || decodeEntities(label) === plain ? escapeHtml(plain) : `${label}: ${escapeHtml(plain)}`
    })
    .replace(/<\/td>\s*<td\b[^>]*class="[^"]*\bv-fv\b[^"]*"[^>]*>/gi, ": ")
    .replace(/<\/td>\s*<td\b[^>]*>/gi, " ")
    .replace(/<\/span>\s*<span\b[^>]*>/gi, ": ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(tr|li)>(?=\s*<(tr|li|\/table|\/ol|\/ul)\b)/gi, "\n")
    .replace(/<\/(p|div|table|h1|h2|h3|ol|ul|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
  return decodeEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
