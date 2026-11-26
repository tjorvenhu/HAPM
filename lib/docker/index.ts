/**
 * Die beiden Container des Stacks, wie die Anwendung sie sieht.
 *
 * Die Engine selbst steht in `engine.mjs` (ohne Build, weil `bin/hapm-ctl.mjs`
 * sie ebenfalls benutzt). Hier steht, welche Container gemeint sind und was
 * HAPM über sie wissen will.
 */

import fs from 'node:fs';
import os from 'node:os';
import * as engine from './engine.mjs';
import { versionOf } from './registry';

export { engine };
export { DockerError } from './engine.mjs';

export function haproxyContainerName(): string {
  return process.env.HAPM_HAPROXY_CONTAINER || 'hapm-haproxy';
}

let ownId: string | null | undefined;

/** Der Container, in dem HAPM selbst läuft. `null` außerhalb von Docker. */
export function ownContainer(): string | null {
  if (ownId === undefined) {
    ownId = process.env.HAPM_CONTAINER || engine.ownContainerId((p) => fs.readFileSync(p, 'utf8'));
  }
  return ownId;
}

export interface ContainerInfo {
  id: string;
  name: string;
  /** Das Abbild, wie es angegeben wurde, etwa `haproxy:lts`. */
  reference: string;
  imageId: string;
  /** Digests, unter denen das lokale Abbild in einer Registry bekannt ist. */
  repoDigests: string[];
  version: string | null;
  imageCreated: string | null;
  running: boolean;
  status: string;
  health: string | null;
  startedAt: string | null;
  restartCount: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- die Antworten der Engine sind untypisiert */
export async function containerInfo(nameOrId: string): Promise<ContainerInfo | null> {
  const container: any = await engine.findContainer(nameOrId);
  if (!container) return null;
  const image: any = await engine.inspectImage(container.Image).catch(() => null);
  const state = container.State ?? {};
  return {
    id: container.Id,
    name: String(container.Name ?? nameOrId).replace(/^\//, ''),
    reference: container.Config?.Image ?? '',
    imageId: container.Image,
    repoDigests: (image?.RepoDigests ?? []).map((entry: string) => entry.slice(entry.indexOf('@') + 1)),
    version: versionOf(image?.Config?.Env, image?.Config?.Labels),
    imageCreated: image?.Created ?? null,
    // Docker meldet in der Pause einer Neustartschleife `Running` und
    // `Restarting` zugleich. Ein Container, der immer wieder abbricht, läuft nicht.
    running: Boolean(state.Running) && !state.Restarting,
    status: state.Status ?? 'unbekannt',
    health: state.Health?.Status ?? null,
    startedAt: state.Running && !state.Restarting ? (state.StartedAt ?? null) : null,
    restartCount: Number(container.RestartCount ?? 0),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Die Architektur, wie Registries sie nennen. */
export function registryArchitecture(): string {
  const arch = os.arch();
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm') return 'arm';
  return arch;
}

/** Ob die Engine erreichbar ist. Ohne sie gibt es weder Prüfen noch Updates. */
export async function dockerAvailable(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const info = (await engine.version()) as { Version?: string };
    return { ok: true, version: info.Version ?? 'unbekannt' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
