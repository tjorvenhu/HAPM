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
    services: { id: string; domains: string[]; own: boolean }[];
    total: number;
    targets: { id: string; label: string }[];
  };
  crs: CrsMode;
  client: string;
}

export interface CrowdsecRules {
  crs: CrsMode;
  base: { name: string; installed: boolean; version: string | null }[];
  optional: { name: string; label: string; hint: string; installed: boolean; version: string | null }[];
}

export interface CrowdsecStatsResponse {
  window: string;
  stats: CrowdsecStats;
  activeDecisions: number | null;
  communityBlocklist: number | null;
}
