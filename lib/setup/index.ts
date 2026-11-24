import { localServer } from '../helpers';
import { probeProxy } from '../haproxy/provision';
import { getSettings, publicOrigin } from '../settings';
import type { Exposure, SetupExecution, SetupStatus } from '../types';
import { serverAddresses } from './address';
import { listenPort, resumeStep, settleExecution, type SetupChoices, type SetupStep } from './rules';
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
  /**
   * Ob die Einrichtung den Eintrag der Oberfläche beim Anbieter selbst setzen
   * kann: das Token liegt noch vor, und der Anbieter hat eine Anbindung.
   */
  dnsApi: boolean;
  /** Die unter „DNS" eingerichtete Zone, in der die Domain liegt. */
  dnsZone: string | null;
}

export async function readSetupView(): Promise<SetupView> {
  const [settings, state] = await Promise.all([getSettings(), getSetupState()]);

  // HAProxy, das gerade nicht antwortet, ist eine Auskunft und kein Fehler der Seite.
  const probe = await probeProxy(localServer()).catch(() => null);
  const dnsHooks = probe ? probe.dnsHooks : null;

  const access = await getDnsAccess();
  const zone = state.domain ? await zoneForDomain(state.domain).catch(() => null) : null;

  const { execution, ...choices } = state;
  return {
    ...choices,
    status: settings.setupStatus,
    step: resumeStep(state, { hasAccount: true, dnsHooks }),
    activeExposure: settings.exposure,
    dnsHooks,
    acmeReady: probe ? probe.acmeReady : null,
    execution: settleExecution(execution, setupExecutionAlive()),
    publicUrl: publicOrigin(settings),
    listenPort: listenPort(process.env.PORT),
    serverAddresses: serverAddresses(),
    dnsApi: Boolean(access && access.hook === state.dnsHook && dnsProviderForHook(access.hook)),
    dnsZone: zone?.name ?? null,
  };
}
