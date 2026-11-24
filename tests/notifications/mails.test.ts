import { describe, expect, it } from 'vitest';
import { notificationMail, testMail, type NotificationMailContext } from '@/lib/notifications/mails';
import type { NotificationEvent } from '@/lib/notifications/events';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/types';

const ctx: NotificationMailContext = {
  nodeName: 'proxy01',
  publicUrl: 'https://hapm.example.org',
  now: new Date('2026-11-24T12:00:00.000Z'),
  recoveryEnabled: true,
  autoUpdateHaproxy: false,
  autoUpdateTime: '04:00',
};

/** Ein Beispiel je Ereignis, dazu was im Betreff und im Text stehen muss. */
const SAMPLES: { event: NotificationEvent; subject: string; text: string[]; path: string | null }[] = [
  {
    event: { type: 'certificate_renewal_failed', output: 'shop.example.org: Verify error: DNS problem: NXDOMAIN' },
    subject: 'Erneuerung der Zertifikate gescheitert',
    text: ['acme.sh', 'proxy01', 'Verify error: DNS problem: NXDOMAIN', 'Was zu tun ist'],
    path: '/reverse-proxy/zertifikate',
  },
  {
    event: {
      type: 'certificate_expiring',
      certificates: [{ mainDomain: 'shop.example.org', expiresAt: '2026-11-29T12:00:00.000Z', daysLeft: 5 }],
    },
    subject: 'Zertifikat für shop.example.org läuft in 5 Tagen ab',
    text: ['shop.example.org', 'in 5 Tagen', 'proxy01', 'Was zu tun ist'],
    path: '/reverse-proxy/zertifikate',
  },
  {
    event: {
      type: 'backend_down',
      kind: 'service',
      id: 'kunde_shop',
      addresses: ['shop.example.org', 'www.shop.example.org'],
      targets: ['10.0.0.5:8080', '10.0.0.6:8080'],
      since: '2026-11-24T11:56:00.000Z',
    },
    subject: 'shop.example.org: kein Ziel antwortet',
    text: ['kunde_shop', 'www.shop.example.org', '10.0.0.5:8080', '10.0.0.6:8080', 'Seit:', 'proxy01', 'Was zu tun ist'],
    path: '/reverse-proxy',
  },
  {
    event: {
      type: 'backend_recovered',
      kind: 'service',
      id: 'kunde_shop',
      addresses: ['shop.example.org'],
      up: 2,
      total: 2,
      downSince: '2026-11-24T09:55:00.000Z',
    },
    subject: 'shop.example.org: Ziele antworten wieder',
    text: ['kunde_shop', '2 von 2', 'Dauer seit der Meldung: 2 Stunden 5 Minuten'],
    path: '/reverse-proxy',
  },
  {
    event: { type: 'haproxy_down', container: 'hapm-haproxy', exists: true, status: 'exited', since: '2026-11-24T11:58:00.000Z' },
    subject: 'HAProxy läuft nicht',
    text: ['hapm-haproxy', 'exited', 'proxy01', 'docker logs hapm-haproxy', 'docker start hapm-haproxy'],
    path: null,
  },
  {
    event: {
      type: 'run_failed',
      action: 'create',
      entry: 'kunde_shop',
      addresses: 'shop.example.org',
      error: 'Zertifikat ausstellen\nacme.sh: Rate limit erreicht',
      triggeredBy: 'admin@example.org',
    },
    subject: 'Vorgang gescheitert: Eintrag anlegen (kunde_shop)',
    text: ['Eintrag anlegen', 'kunde_shop', 'shop.example.org', 'admin@example.org', 'Rate limit erreicht', 'Was zu tun ist'],
    path: '/reverse-proxy/logs',
  },
  {
    event: {
      type: 'update_available',
      component: 'haproxy',
      currentVersion: '3.4.8',
      latestVersion: '3.4.9',
      latestDigest: 'sha256:abc',
    },
    subject: 'Update verfügbar: HAProxy 3.4.9',
    text: ['HAProxy', 'Läuft: 3.4.8', 'Verfügbar: 3.4.9', 'Von selbst geschieht nichts'],
    path: '/updates',
  },
  {
    event: {
      type: 'update_completed',
      component: 'hapm',
      runId: 'run_1',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      triggeredBy: 'scheduler',
    },
    subject: 'HAPM aktualisiert auf 0.2.0',
    text: ['Vorher: 0.1.0', 'Jetzt: 0.2.0', 'Zeitplan'],
    path: '/updates',
  },
  {
    event: {
      type: 'update_failed',
      component: 'haproxy',
      fromVersion: '3.4.8',
      error: 'Die neue Fassung von HAProxy lehnt die vorhandene Konfiguration ab. Es wurde nichts geändert.',
      triggeredBy: 'scheduler',
    },
    subject: 'Update von HAProxy gescheitert',
    text: ['3.4.8', 'lehnt die vorhandene Konfiguration ab', 'Zeitplan', 'Was zu tun ist'],
    path: '/updates',
  },
  {
    event: { type: 'backup_failed', detail: 'Der Ordner /srv/hapm-backup ist nicht beschreibbar.' },
    subject: 'Sicherung gescheitert',
    text: ['proxy01', 'Der Ordner /srv/hapm-backup ist nicht beschreibbar.', 'Was zu tun ist'],
    path: '/backup',
  },
];

describe('notificationMail', () => {
  it('hat für jedes Ereignis ein Beispiel', () => {
    expect(SAMPLES.map((sample) => sample.event.type).sort()).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
  });

  describe.each(SAMPLES)('$event.type', ({ event, subject, text, path }) => {
    const mail = notificationMail(event, ctx);

    it('sagt im Betreff, was los ist', () => {
      expect(mail.subject).toBe(subject);
      expect(mail.html).toContain('<title>');
    });

    it('nennt in der Textfassung das Wesentliche', () => {
      for (const fragment of text) expect(mail.text, fragment).toContain(fragment);
    });

    it('führt in die Oberfläche, wenn es dort etwas zu sehen gibt', () => {
      if (path) {
        expect(mail.text).toContain(`https://hapm.example.org${path}`);
        expect(mail.html).toContain(`href="https://hapm.example.org${path}"`);
      } else {
        expect(mail.html).not.toContain('class="v-btn"');
      }
    });

    it('hat keinen Knopf, solange die Adresse von HAPM fehlt', () => {
      const plain = notificationMail(event, { ...ctx, publicUrl: null });
      expect(plain.html).not.toContain('class="v-btn"');
      expect(plain.text).not.toContain('https://');
      expect(plain.subject).toBe(subject);
    });

    it('kommt ohne Gedankenstrich, Sinnbild und Firmenangaben aus', () => {
      const visible = `${mail.subject}\n${mail.text}`;
      expect(visible).not.toMatch(/[–—]/);
      expect(visible).not.toMatch(/[←-⇿☀-➿]|\p{Extended_Pictographic}/u);
      for (const fragment of ['USt-IdNr', 'Steuernr', 'Impressum', 'Mit freundlichen']) expect(mail.html).not.toContain(fragment);
      expect(mail.html).not.toMatch(/\bIhr\s+\S+[- ]Team\b/);
    });

    it('nennt den Absender und wo sich die Mails abstellen lassen', () => {
      expect(mail.text).toContain('HAPM-Installation auf dem Server proxy01');
      expect(mail.text).toContain('unter „Benachrichtigungen“');
    });
  });

  it('maskiert, was von außen kommt', () => {
    const mail = notificationMail({ type: 'backup_failed', detail: '<img src=x onerror=alert(1)>' }, ctx);
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;img src=x');
    expect(mail.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('kürzt eine lange Ausgabe auf ihr Ende', () => {
    const output = `${'Zeile ohne Belang\n'.repeat(400)}Der eigentliche Fehler steht hier.`;
    const mail = notificationMail({ type: 'certificate_renewal_failed', output }, ctx);
    expect(mail.text).toContain('Der eigentliche Fehler steht hier.');
    expect(mail.text.length).toBeLessThan(3500);
  });

  it('fasst mehrere Zertifikate in einer Mail zusammen, das dringendste zuerst', () => {
    const mail = notificationMail(
      {
        type: 'certificate_expiring',
        certificates: [
          { mainDomain: 'b.example.org', expiresAt: '2026-12-04T12:00:00.000Z', daysLeft: 10 },
          { mainDomain: 'a.example.org', expiresAt: '2026-11-22T12:00:00.000Z', daysLeft: -2 },
        ],
      },
      ctx
    );
    expect(mail.subject).toBe('2 Zertifikate laufen ab, 1 davon ist abgelaufen');
    expect(mail.text.indexOf('a.example.org')).toBeLessThan(mail.text.indexOf('b.example.org'));
    expect(mail.text).toContain('abgelaufen');
    expect(mail.text).toContain('in 10 Tagen');
  });

  it('kündigt die Entwarnung nur an, wenn sie eingeschaltet ist', () => {
    const event = SAMPLES[2].event;
    expect(notificationMail(event, ctx).text).toContain('kommt eine zweite Mail');
    expect(notificationMail(event, { ...ctx, recoveryEnabled: false }).text).not.toContain('zweite Mail');
  });

  it('sagt bei einer Weiterleitung, über welchen Port sie läuft', () => {
    const mail = notificationMail(
      { type: 'backend_down', kind: 'stream', id: 'postgres', addresses: ['Port 5432'], targets: ['10.0.0.9:5432'], since: ctx.now.toISOString() },
      ctx
    );
    expect(mail.subject).toBe('Weiterleitung postgres (Port 5432): kein Ziel antwortet');
    expect(mail.text).toContain('Erreichbar über: Port 5432');
  });

  it('nennt die Uhrzeit des selbsttätigen Updates, wenn es eingeschaltet ist', () => {
    const event = SAMPLES[6].event;
    const mail = notificationMail(event, { ...ctx, autoUpdateHaproxy: true, autoUpdateTime: '04:30' });
    expect(mail.text).toContain('um 04:30 Uhr selbsttätig');
  });

  it('behauptet keine neue Fassung, wenn die Nummer gleich geblieben ist', () => {
    const mail = notificationMail(
      { type: 'update_completed', component: 'haproxy', runId: 'r', fromVersion: '3.4.8', toVersion: '3.4.8', triggeredBy: 'a@example.org' },
      ctx
    );
    expect(mail.subject).toBe('Update von HAProxy durchgelaufen');
    expect(mail.text).toContain('Die Versionsnummer ist dieselbe geblieben');
  });

  it('nennt unbekannt, was unbekannt ist', () => {
    const mail = notificationMail(
      { type: 'update_available', component: 'hapm', currentVersion: null, latestVersion: null, latestDigest: 'sha256:abc' },
      ctx
    );
    expect(mail.subject).toBe('Update verfügbar: neues Abbild für HAPM');
    expect(mail.text).toContain('Läuft: Version unbekannt');
  });
});

describe('auf Englisch', () => {
  const en: NotificationMailContext = { ...ctx, locale: 'en' };

  it.each(SAMPLES)('$event.type: Betreff, Text und Rahmen sind englisch', ({ event }) => {
    const mail = notificationMail(event, en);
    expect(mail.html).toContain('<html lang="en"');
    expect(mail.text).toContain('This email comes from the HAPM installation on the server proxy01.');
    expect(mail.text).toContain('under “Notifications”');
    const visible = `${mail.subject}\n${mail.text}`;
    expect(visible).not.toMatch(/[–—]/);
    // Was die Mail selbst schreibt, ist englisch. Deutsch steht nur in dem, was
    // von außen kommt (Fehlermeldung eines Laufs, Ausgabe), und bleibt, wie es ist.
    const external = JSON.stringify(event);
    const own = visible.split('\n').filter((line) => !external.includes(line.trim()));
    expect(own.join('\n')).not.toMatch(/\b(nicht|Zertifikat|gescheitert|Was zu tun ist|Oberfläche|Uhr)\b/);
  });

  it('schreibt Datum und Anzahl in der Form der Sprache', () => {
    const mail = notificationMail(
      {
        type: 'certificate_expiring',
        certificates: [{ mainDomain: 'shop.example.org', expiresAt: '2026-11-29T12:00:00.000Z', daysLeft: 5 }],
      },
      en
    );
    expect(mail.subject).toBe('Certificate for shop.example.org expires in 5 days');
    expect(mail.text).toContain('expires on 11/29/2026, in 5 days');
    const recovered = notificationMail(SAMPLES[3].event, en);
    expect(recovered.text).toContain('Time since the report: 2 hours 5 minutes');
    expect(recovered.text).toContain('2 of 2');
  });

  it('gilt auch für die Testmail', () => {
    const mail = testMail({ nodeName: 'proxy01', publicUrl: 'https://hapm.example.org', locale: 'en' });
    expect(mail.subject).toBe('Test email from HAPM');
    expect(mail.text).toContain('Open notifications: https://hapm.example.org/notifications');
    expect(mail.text).toContain('Interface: https://hapm.example.org');
  });
});

describe('testMail', () => {
  it('sagt, was sie beweist, und verspricht nicht mehr', () => {
    const mail = testMail({ nodeName: 'proxy01', publicUrl: 'https://hapm.example.org' });
    expect(mail.subject).toBe('Testmail von HAPM');
    expect(mail.text).toContain('proxy01');
    expect(mail.text).toContain('https://hapm.example.org/notifications');
    expect(mail.text).not.toMatch(/[–—]/);
  });
});
