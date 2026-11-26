/**
 * Was die Routen unter `/api/crowdsec` liefern, für die Seiten. Nur Typen: eine
 * Client-Komponente importiert nichts, was `lib/docker` erreicht.
 */

import type { CrowdsecAlertRow, CrowdsecStatus, CrowdsecSummary } from '@/lib/crowdsec/actions';
import type { AllowlistEntry, CrowdsecDecision, CrowdsecStats } from '@/lib/crowdsec/data';
import type { CrsMode } from '@/lib/crowdsec/files';

export type { CrowdsecAlertRow, CrowdsecDecision, AllowlistEntry, CrowdsecStats, CrsMode, CrowdsecSummary };

export interface CrowdsecOverview {
  status: CrowdsecStatus;
  summary: CrowdsecSummary;
  protection: {
    readable: boolean;
    global: boolean | null;
    inUse: boolean;
    services: { id: string; domains: string[]; own: boolean }[];
    total: number;
    targets: { id: string; label: string }[];
  };
  crs: CrsMode;
  client: string;
}

export interface CrowdsecAppRules {
  id: string;
  label: string;
  hint: string;
  kinds: ('log' | 'waf' | 'owasp')[];
  items: string[];
  installed: boolean;
  /** Nur ein Teil liegt, etwa nach einem Eingriff mit `cscli`. */
  partial: boolean;
}

export interface CrowdsecRules {
  crs: CrsMode;
  apps: CrowdsecAppRules[];
  base: { name: string; installed: boolean; version: string | null }[];
  optional: { name: string; label: string; hint: string; installed: boolean; version: string | null }[];
  /**
   * Änderungen, die warten, gerade laufen oder auf das Neuladen von CrowdSec
   * warten: `crs`, `app:<id>`, der Name einer Sammlung oder `hub`, mit dem
   * gewünschten Zustand (bei `crs` der Modus).
   */
  pending: Record<string, boolean | string>;
}

export interface CrowdsecStatsResponse {
  window: string;
  stats: CrowdsecStats;
  truncated?: boolean;
  activeDecisions: number | null;
  communityBlocklist: number | null;
}
