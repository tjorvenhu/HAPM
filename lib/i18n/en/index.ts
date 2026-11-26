/**
 * Das englische Wörterbuch: Schlüssel ist der deutsche Text, Wert der
 * englische. Je Bereich eine Datei, damit zwei Leute an zwei Bereichen nicht
 * dieselbe Datei bearbeiten. Ein Schlüssel steht in genau einer davon, was
 * mehrere Bereiche brauchen, steht in `common.ts`.
 *
 * Regeln für das Englische und das Glossar: docs/i18n.md.
 */

import { account } from './account';
import { auth } from './auth';
import { common } from './common';
import { format } from './format';
import { setup } from './setup';
import { shell } from './shell';
import { proxyForms } from './proxyForms';
import { proxyPages } from './proxyPages';
import { proxyServer } from './proxyServer';
import { system } from './system';
import { mail } from './mail';
import { logs } from './logs';
import { audit } from './audit';
import { mcp } from './mcp';
import { branding } from './branding';
import { crowdsec } from './crowdsec';
import { sync } from './sync';

export type Dictionary = Readonly<Record<string, string>>;

/** Die Teile einzeln, für den Test, der doppelte Schlüssel sucht. */
export const PARTS: Readonly<Record<string, Dictionary>> = {
  common,
  format,
  shell,
  auth,
  account,
  setup,
  proxyForms,
  proxyPages,
  proxyServer,
  system,
  mail,
  logs,
  audit,
  mcp,
  branding,
  crowdsec,
  sync,
};

export const en: Dictionary = Object.freeze(Object.assign({}, ...Object.values(PARTS)));
