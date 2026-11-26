/**
 * Der Anbieter war nicht zu erreichen: keine Verbindung, keine Antwort in der
 * Frist. Eine eigene Klasse, weil es der eine Fehler ist, der nichts über die
 * Zugangsdaten sagt. Der Einrichtungsassistent legt sie dann trotzdem ab
 * (`lib/setup/token-check.ts`), statt sie als abgelehnt zu melden.
 */

import { ApiError } from '../api';

export class DnsUnreachableError extends ApiError {}
