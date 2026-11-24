import os from 'node:os';
import { Resolver } from 'node:dns/promises';
import { judgeAddresses, pickServerAddresses, type AddressVerdict } from './rules';

/** Die Adressen dieses Servers. Beide Container laufen im Netz des Hosts, es sind also seine. */
export function serverAddresses(): string[] {
  return pickServerAddresses(os.networkInterfaces());
}

/** Antworten, die „es gibt keinen Eintrag" heißen und nicht „die Abfrage ging nicht". */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Worauf die Domain zeigt: A und AAAA zusammen. Leer heißt, es gibt keinen
 * Eintrag. `null` heißt, die Abfrage selbst ist gescheitert, und das ist keine
 * Auskunft über die Domain.
 */
export async function resolveDomain(domain: string): Promise<string[] | null> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const lookup = async (query: () => Promise<string[]>): Promise<string[] | null> => {
    try {
      return await query();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      return NO_RECORD.has(code) ? [] : null;
    }
  };
  const [v4, v6] = await Promise.all([
    lookup(() => resolver.resolve4(domain)),
    lookup(() => resolver.resolve6(domain)),
  ]);
  if (v4 === null && v6 === null) return null;
  return [...(v4 ?? []), ...(v6 ?? [])];
}

export interface AddressCheck {
  domain: string;
  /** `null`: die Abfrage ist gescheitert. */
  resolved: string[] | null;
  verdict: AddressVerdict;
  serverAddresses: string[];
}

export async function checkDomainAddress(domain: string): Promise<AddressCheck> {
  const own = serverAddresses();
  const resolved = await resolveDomain(domain);
  return { domain, resolved, verdict: judgeAddresses(resolved, own), serverAddresses: own };
}
