/**
 * Wer den Zugriffsschutz speichert, soll sich damit nicht selbst aussperren.
 *
 * Die Oberfläche von HAPM läuft über dasselbe HAProxy. Eine Sperre auf die
 * eigene Adresse oder das eigene Land wirkte also nach dem Neuladen auch auf
 * die Seite, auf der man sie zurücknehmen könnte. Abgelehnt wird deshalb vor
 * dem Vorgang, mit dem Grund und dem Ausweg.
 *
 * Rein: die Adresse und ihr Land kommen als Werte herein. Ist die Adresse
 * unbekannt oder ohne Land (Entwicklung, ein privates Netz), wird nichts
 * abgelehnt, denn dann lässt sich nichts sagen.
 */

import { addressInNetwork } from '../geoip/networks';
import { parseAddress } from '../geoip/format';
import { msg, type Message } from '../i18n/translate';
import type { AccessProtection } from './config';

export function lockoutReason(
  protection: AccessProtection,
  adminIps: string[],
  client: { ip: string; country: string | null }
): Message | null {
  if (!parseAddress(client.ip)) return null;

  const blocked = protection.blockedIps.find((network) => addressInNetwork(client.ip, network));
  if (blocked) {
    return msg(
      'Ihre Adresse {ip} fällt unter die Sperre {network}. Damit wäre auch diese Oberfläche für Sie nicht mehr erreichbar.',
      { ip: client.ip, network: blocked }
    );
  }

  const admin = adminIps.some((network) => addressInNetwork(client.ip, network));
  if (!admin && client.country && protection.blockedCountries.includes(client.country)) {
    return msg(
      'Ihre Adresse {ip} liegt im gesperrten Land {country}. Damit wäre auch diese Oberfläche für Sie nicht mehr erreichbar. Unter Admin-IPs eingetragen gilt die Ländersperre für Sie nicht.',
      { ip: client.ip, country: client.country }
    );
  }
  return null;
}
