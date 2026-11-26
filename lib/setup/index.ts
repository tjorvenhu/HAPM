import { crowdsecInstalled } from '../crowdsec/paths';
import { localServer } from '../helpers';
import { probeProxy, readCertificateInventory } from '../haproxy/provision';
import { findCertificateFor } from '../haproxy/certs';
import { uploadedCoverage } from '../haproxy/cert-upload';
import { getSettings, publicOrigin } from '../settings';
import type { CertificateSource, Exposure, SetupExecution, SetupStatus, SmtpSecurity } from '../types';
import { headers } from 'next/headers';
import { getClientIP } from '../audit';
import { recordAddresses } from './address';
import {
  certificateDomains,
  certificateFactsOf,
  isPublicAddress,
  listenPort,
  resumeStep,
  settleExecution,
  type SetupChoices,
  type SetupStep,
} from './rules';
import { setupExecutionAlive } from './run';
import { getDnsAccess, getSetupState } from './store';
import { zoneForDomain } from '../dns/store';
import { dnsProviderForHook } from '../dns/zones';

/**
 * Was die Seite der Einrichtung und der Hinweis in der Übersicht lesen. Nur für
 * Angemeldete: wer nicht angemeldet ist, erfährt von `/api/setup` allein, ob es
 * schon ein Konto gibt.
 */
export interface SetupView extends Omit<SetupChoices, 'execution'> {
  /** `null`: eine Installation von vor dem Assistenten, sie gilt als abgeschlossen. */
  status: SetupStatus | null;
  /** Der Schritt, bei dem es weitergeht. */
  step: SetupStep;
  /** Was in den Einstellungen gilt. Vor der Wahl im Assistenten die Vorgabe. */
  activeExposure: Exposure;
  /** Die bei acme.sh eingerichteten Hooks. `null` heißt unbekannt. */
  dnsHooks: string[] | null;
  acmeReady: boolean | null;
  execution: SetupExecution | null;
  publicUrl: string | null;
  listenPort: number;
  serverAddresses: string[];
  /** Die Adresse des Aufrufers, als Vorschlag für die erlaubten Adressen. `null`: unbekannt. */
  clientIp: string | null;
  /** Ob der Stack CrowdSec mitbringt: dann schlägt der Assistent es vor. */
  crowdsecInStack: boolean;
  /**
   * Ob die Einrichtung den Eintrag der Oberfläche beim Anbieter selbst setzen
   * kann: das Token liegt noch vor, und der Anbieter hat eine Anbindung.
   */
  dnsApi: boolean;
  /** Die unter „DNS" eingerichtete Zone, in der die Domain liegt. */
  dnsZone: string | null;
  /** Aus den Einstellungen: woher Zertifikate kommen und bei welchem ACME-Server. */
  certificateSource: CertificateSource;
  acmeDirectory: string | null;
  acmeHttpReachable: boolean;
  /**
   * Bei „nur hochladen": das Zertifikat, das die Domain der Oberfläche schon
   * abdeckt. `null` heißt keins (oder nicht gefragt, weil Zertifikate über
   * ACME kommen oder die Domain noch fehlt).
   */
  presentCertificate: { mainDomain: string; domains: string[]; notAfter: string | null } | null;
  /**
   * Das SMTP-Konto aus den Einstellungen, für den Schritt dazu. Das Passwort
   * nie, nur ob eines gesetzt ist (wie `SettingsView`).
   */
  mailAccount: {
    smtpHost: string | null;
    smtpPort: number;
    smtpSecurity: SmtpSecurity;
    smtpUser: string | null;
    smtpPassSet: boolean;
    mailFrom: string | null;
  };
}

/**
 * Die Adresse des Aufrufers aus den Kopfzeilen der laufenden Anfrage, wenn es
 * eine öffentliche ist. Wer über einen Tunnel oder aus dem Netz des Servers
 * kommt (127.0.0.1, 10.x), erreicht die Domain später von einer anderen
 * Adresse: die hier wäre als Vorschlag falsch. Außerhalb einer Anfrage `null`.
 */
async function callerAddress(): Promise<string | null> {
  try {
    const ip = getClientIP(new Request('http://hapm.invalid/', { headers: await headers() }));
    return isPublicAddress(ip) ? ip : null;
  } catch {
    return null;
  }
}

export async function readSetupView(): Promise<SetupView> {
  const [settings, state] = await Promise.all([getSettings(), getSetupState()]);

  // HAProxy, das gerade nicht antwortet, ist eine Auskunft und kein Fehler der Seite.
  const probe = await probeProxy(localServer()).catch(() => null);
  const dnsHooks = probe ? probe.dnsHooks : null;

  const access = await getDnsAccess();
  const zone = state.domain ? await zoneForDomain(state.domain).catch(() => null) : null;

  // Nur bei „nur hochladen": sonst stellt das Ausführen das Zertifikat selbst aus,
  // und `acme.sh --list` im Takt des Pollens wäre verschenkt.
  let presentCertificate: SetupView['presentCertificate'] = null;
  if (settings.certificateSource === 'upload' && state.domain && probe) {
    const inventory = await readCertificateInventory(localServer()).catch(() => null);
    if (inventory) {
      const found = findCertificateFor(
        [...inventory.acme, ...uploadedCoverage(inventory.uploaded, Date.now())],
        certificateDomains(state)
      );
      const uploaded = found ? inventory.uploaded.find((cert) => cert.mainDomain === found.mainDomain) : null;
      presentCertificate = found
        ? { mainDomain: found.mainDomain, domains: found.domains, notAfter: uploaded?.notAfter ?? null }
        : null;
    }
  }

  const { execution, ...choices } = state;
  return {
    ...choices,
    status: settings.setupStatus,
    step: resumeStep(state, { hasAccount: true, dnsHooks, certificates: certificateFactsOf(settings) }),
    activeExposure: settings.exposure,
    dnsHooks,
    acmeReady: probe ? probe.acmeReady : null,
    execution: settleExecution(execution, setupExecutionAlive()),
    publicUrl: publicOrigin(settings),
    listenPort: listenPort(process.env.PORT),
    serverAddresses: await recordAddresses(state.exposure ?? settings.exposure),
    clientIp: await callerAddress(),
    crowdsecInStack: crowdsecInstalled(),
    dnsApi: Boolean(access && access.hook === state.dnsHook && dnsProviderForHook(access.hook)),
    dnsZone: zone?.name ?? null,
    certificateSource: settings.certificateSource,
    acmeDirectory: settings.acmeDirectory,
    acmeHttpReachable: settings.acmeHttpReachable,
    presentCertificate,
    mailAccount: {
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecurity: settings.smtpSecurity,
      smtpUser: settings.smtpUser,
      smtpPassSet: Boolean(settings.smtpPass),
      mailFrom: settings.mailFrom,
    },
  };
}
