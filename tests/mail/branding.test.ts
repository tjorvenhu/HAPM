import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/lib/types';

/**
 * Die Mails mit der Darstellung: Name, Logo und Akzentfarbe. Ohne Darstellung
 * ist jede Mail Byte für Byte die von HAPM, das halten `layout.test.ts` und
 * `send.test.ts` fest, ohne davon zu wissen. Hier steht, was sich mit ihr
 * ändert und was nicht.
 */

const sent: Record<string, unknown>[] = [];
let row: Partial<Settings> = {};

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: Record<string, unknown>) => {
        sent.push(message);
        return { messageId: 'test' };
      },
      close: () => undefined,
    }),
  },
}));

vi.mock('@/lib/db', () => ({
  getSingleton: async () => ({ ...row, $id: 'main', $createdAt: '', $updatedAt: '' }),
  updateDocument: vi.fn(),
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (ciphertext: string) => ciphertext.replace(/^enc:/, ''),
}));

const LOGO_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x90, 0, 0, 0, 100,
]).toString('base64');

vi.mock('@/lib/branding/store', () => ({
  loadBrandingImage: async (slot: string) => (slot === 'logo' ? { mime: 'image/png', data: LOGO_PNG } : null),
  loadBrandingSafe: async () => ({ name: null, pill: { text: '', enabled: false }, accent: null, images: {} }),
}));

import { sendMail } from '@/lib/mail';
import { mailAccent, mailText, renderHapmMail, type MailInstallation } from '@/lib/mail/layout';
import { rememberMailBranding, type MailBranding } from '@/lib/mail/installation';
import { mailLogoSize } from '@/lib/mail/branding';
import { formatSender } from '@/lib/mail/config';
import { imageDimensions } from '@/lib/branding/branding';
import { base64ToBytes } from '@/lib/haproxy/page-design';
import { contrastRatio } from '@/lib/branding/color';

const content = {
  subject: 'Betreff',
  heading: 'Überschrift',
  eyebrow: 'Zertifikate',
  body: mailText('Inhalt mit <a href="https://example.org">Link</a>.'),
  action: { label: 'Öffnen', url: 'https://hapm.example.org/' },
};

const installation: MailInstallation = { nodeName: 'proxy01', publicUrl: 'https://hapm.example.org' };

const BRANDING: MailBranding = {
  name: 'Beispiel GmbH',
  accent: '#c2410c',
  logo: { width: 128, height: 32 },
  logoDark: false,
};

afterEach(() => rememberMailBranding(null));

describe('ohne Darstellung', () => {
  it('ist die Mail dieselbe, ob keine angegeben oder ausdrücklich keine', () => {
    const implicit = renderHapmMail(content, installation);
    expect(renderHapmMail(content, { ...installation, branding: null })).toEqual(implicit);
    expect(implicit.html).toContain('cid:hapm-logo');
    expect(implicit.html).toContain('#1a5c4c');
  });

  it('auch mit einer Darstellung, die nichts davon setzt', () => {
    const empty: MailBranding = { name: null, accent: null, logo: null, logoDark: false };
    expect(renderHapmMail(content, { ...installation, branding: empty })).toEqual(renderHapmMail(content, installation));
  });
});

describe('mit Darstellung', () => {
  const { html, text } = renderHapmMail(content, { ...installation, branding: BRANDING });

  it('zeigt das eigene Logo als Anhang, mit dem Namen als Alternativtext', () => {
    expect(html).toContain('src="cid:brand-logo" width="128" height="32" alt="Beispiel GmbH"');
    expect(html).not.toContain('cid:hapm-logo');
    // Ohne helle Fassung gibt es keine Umschaltung in dunklem Design.
    expect(html).not.toContain('brand-logo-dark');
    expect(html).not.toContain('class="v-logo-dark"');
  });

  it('nennt den Namen im Fuß, die Herkunft bleibt bei HAPM', () => {
    expect(html).toContain('font-weight:600;color:#090b0a">Beispiel GmbH</p>');
    expect(html).toContain('Diese Mail kommt von der HAPM-Installation auf dem Server proxy01.');
    expect(text).toContain('Diese Mail kommt von der HAPM-Installation auf dem Server proxy01.');
  });

  it('färbt Knöpfe, Links und Stichwort in der Akzentfarbe, nirgends bleibt das Grün', () => {
    expect(html).toContain('background-color:#c2410c');
    expect(html).toContain('fillcolor="#c2410c"');
    expect(html).toContain('color:#c2410c;font-weight:500;text-decoration:underline');
    for (const green of ['#1a5c4c', '#237a65', '#aed9cc', '#e6f2ee', '#154c40', '#0a2a23']) {
      expect(html, green).not.toContain(green);
    }
  });

  it('lässt einen Farbwert im Text stehen', () => {
    const mail = renderHapmMail(
      { ...content, body: mailText('Die alte Farbe war #1a5c4c.') },
      { ...installation, branding: BRANDING }
    );
    expect(mail.html).toContain('Die alte Farbe war #1a5c4c.');
  });

  it('nimmt mit heller Fassung beide Logos und schaltet in dunklem Design um', () => {
    const dark = renderHapmMail(content, { ...installation, branding: { ...BRANDING, logoDark: true } }).html;
    expect(dark).toContain('cid:brand-logo-dark');
    expect(dark).toContain('class="v-logo-light"');
  });

  it('nimmt ohne eigenes Logo den Kopf von HAPM, mit Name und Farbe', () => {
    const plain = renderHapmMail(content, { ...installation, branding: { ...BRANDING, logo: null } }).html;
    expect(plain).toContain('cid:hapm-logo');
    expect(plain).toContain('alt="Beispiel GmbH"');
    expect(plain).toContain('background-color:#c2410c');
  });

  it('gilt auch ohne Angabe, wenn die Darstellung im Prozess bekannt ist', () => {
    rememberMailBranding(BRANDING);
    expect(renderHapmMail(content, installation).html).toBe(html);
  });
});

describe('die Farben', () => {
  it.each(['#c2410c', '#ffd700', '#7dd3fc', '#1a5c4c', '#111111', '#ffffff'])('%s hält überall 4,5:1', (chosen) => {
    const colors = mailAccent(chosen);
    expect(contrastRatio(colors.accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.accentTintText, colors.accentTint)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.darkAccent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    // Akzent als Schrift auf der dunklen Karte (`dark.card`).
    expect(contrastRatio(colors.darkAccentText, '#181a19')).toBeGreaterThanOrEqual(4.5);
  });

  it('eine helle Farbe wird abgedunkelt wie in der Oberfläche', () => {
    expect(mailAccent('#ffd700').accent).not.toBe('#ffd700');
    expect(mailAccent('#c2410c').accent).toBe('#c2410c');
  });
});

describe('die Größe des Logos', () => {
  it('liest PNG und SVG aus dem Kopf der Datei', () => {
    expect(imageDimensions(base64ToBytes(LOGO_PNG)!, 'image/png')).toEqual({ width: 400, height: 100 });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60"></svg>');
    expect(imageDimensions(svg, 'image/svg+xml')).toEqual({ width: 240, height: 60 });
    const sized = new TextEncoder().encode('<svg width="120px" height="30" stroke-width="2"></svg>');
    expect(imageDimensions(sized, 'image/svg+xml')).toEqual({ width: 120, height: 30 });
    expect(imageDimensions(new TextEncoder().encode('<svg></svg>'), 'image/svg+xml')).toBeNull();
  });

  it('zeigt das Logo 32 Pixel hoch und höchstens 200 breit', () => {
    expect(mailLogoSize({ width: 400, height: 100 })).toEqual({ width: 128, height: 32 });
    expect(mailLogoSize({ width: 2000, height: 100 })).toEqual({ width: 200, height: 10 });
    expect(mailLogoSize({ width: 64, height: 64 })).toEqual({ width: 32, height: 32 });
  });
});

describe('der Versand', () => {
  beforeEach(() => {
    sent.length = 0;
    row = {
      smtpHost: 'smtp.example.org',
      smtpPort: 465,
      smtpSecurity: 'tls',
      mailFrom: 'hapm@example.org',
    };
  });

  it('hängt das eigene Logo an und nennt den Namen als Absender', async () => {
    rememberMailBranding(BRANDING);
    const mail = renderHapmMail(content, installation);
    await sendMail({ to: 'admin@example.org', subject: 'Betreff', ...mail });
    const attachments = sent[0].attachments as { cid: string; contentType?: string; content: Buffer }[];
    expect(attachments.map((entry) => entry.cid)).toEqual(['brand-logo']);
    expect(attachments[0].contentType).toBe('image/png');
    expect(attachments[0].content.equals(Buffer.from(LOGO_PNG, 'base64'))).toBe(true);
    expect(sent[0].from).toBe('"Beispiel GmbH" <hapm@example.org>');
  });

  it('ein Name im Absender gewinnt', async () => {
    rememberMailBranding(BRANDING);
    row = { ...row, mailFrom: 'Proxy <hapm@example.org>' };
    await sendMail({ to: 'admin@example.org', subject: 'Betreff', ...renderHapmMail(content, installation) });
    expect(sent[0].from).toBe('"Proxy" <hapm@example.org>');
  });

  it('ohne Darstellung bleibt HAPM der Absender', () => {
    expect(formatSender({ name: null, address: 'hapm@example.org' })).toBe('"HAPM" <hapm@example.org>');
    expect(formatSender({ name: null, address: 'a@b.de' }, 'Firma "X"')).toBe('"Firma X" <a@b.de>');
  });
});
