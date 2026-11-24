// @ts-check
/**
 * Einen Container durch einen mit neuem Abbild ersetzen, mit Rückweg.
 *
 * Docker kann das Abbild eines Containers nicht tauschen: der alte wird
 * angehalten und beiseitegelegt, ein neuer mit derselben Einrichtung angelegt
 * und gestartet. Steht der neue nicht, kommt der alte zurück. Erst wenn der
 * neue läuft, wird der alte entfernt.
 *
 * Reines JavaScript wie `engine.mjs`, weil HAPM sich damit auch selbst ersetzt:
 * das tut ein Hilfscontainer aus dem neuen Abbild über `hapm-ctl replace`, denn
 * ein Prozess kann den Container, in dem er läuft, nicht überleben.
 */

import * as docker from './engine.mjs';

/**
 * Was am Container eingestellt wurde, ohne das, was sein Abbild vorgibt.
 *
 * `inspect` liefert beides vermischt: `Env` enthält auch `HAPROXY_VERSION=3.4.8`
 * aus dem Abbild. Unverändert übernommen stünde im neuen Container die Version
 * des alten Abbilds, und sein Kommando und sein Einstiegspunkt ebenso. Also
 * bleibt nur, was vom alten Abbild abweicht.
 *
 * @param {any} container  Ergebnis von `inspectContainer`
 * @param {any} oldImage   Ergebnis von `inspectImage` für das bisherige Abbild
 * @param {string} newReference
 * @param {any} [newImage]  Das neue Abbild. Nur gebraucht, wenn das bisherige fehlt.
 */
export function recreateBody(container, oldImage, newReference, newImage) {
  const config = { ...container.Config };
  // Fehlt das bisherige Abbild, ist das neue der beste Maßstab, den es gibt:
  // Einstiegspunkt, Kommando und Prüfung ändern sich zwischen zwei Fassungen
  // desselben Abbilds praktisch nie.
  const base = oldImage?.Config ?? newImage?.Config ?? {};

  const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  const imageEnv = new Set(base.Env ?? []);
  config.Env = (config.Env ?? []).filter((/** @type {string} */ entry) => !imageEnv.has(entry));
  if (!oldImage && newImage) {
    // Ohne das bisherige Abbild lässt sich nicht sagen, welche Werte eingestellt
    // wurden. Sicher vom Abbild stammen seine Angaben über sich selbst: sie
    // blieben sonst als die des alten stehen (`HAPROXY_VERSION=3.4.8`).
    const own = new Set(
      (newImage.Config?.Env ?? [])
        .map((/** @type {string} */ entry) => entry.slice(0, entry.indexOf('=')))
        .filter((/** @type {string} */ key) => /(_VERSION|_URL|_SHA256)$/.test(key))
    );
    config.Env = config.Env.filter((/** @type {string} */ entry) => !own.has(entry.slice(0, entry.indexOf('='))));
  }

  // Docker übernimmt das Kommando des Abbilds nur, wenn auch der Einstiegspunkt
  // vom Abbild kommt. Neben einem eigenen Einstiegspunkt bleibt es deshalb stehen.
  const ownEntrypoint = !same(config.Entrypoint, base.Entrypoint);
  if (!ownEntrypoint && same(config.Cmd, base.Cmd)) delete config.Cmd;
  if (!ownEntrypoint) delete config.Entrypoint;
  if (same(config.WorkingDir, base.WorkingDir)) delete config.WorkingDir;
  if (same(config.User, base.User)) delete config.User;
  if (same(config.Healthcheck, base.Healthcheck)) delete config.Healthcheck;
  if (same(config.StopSignal, base.StopSignal)) delete config.StopSignal;
  if (same(config.ExposedPorts, base.ExposedPorts)) delete config.ExposedPorts;
  if (same(config.Volumes, base.Volumes)) delete config.Volumes;

  /** @type {Record<string, string>} */
  const labels = {};
  for (const [key, value] of Object.entries(config.Labels ?? {})) {
    // Fehlt das bisherige Abbild, gehört ein Label, das auch das neue trägt, dem Abbild.
    const fromImage = oldImage ? (base.Labels ?? {})[key] === value : key in (base.Labels ?? {});
    if (!fromImage) labels[key] = /** @type {string} */ (value);
  }
  config.Labels = labels;

  config.Image = newReference;

  const mode = String(container.HostConfig?.NetworkMode ?? '');
  const sharesNetwork = mode === 'host' || mode.startsWith('container:');
  if (sharesNetwork) {
    // Der Name gehört dann dem Host oder dem anderen Container, und Docker
    // lehnt ihn zusammen mit diesem Netzmodus ab.
    delete config.Hostname;
    delete config.Domainname;
    delete config.ExposedPorts;
  }
  // Der Name des alten Containers ist seine Kennung, sie gälte für den neuen nicht.
  if (typeof config.Hostname === 'string' && container.Id?.startsWith(config.Hostname)) delete config.Hostname;

  /** @type {Record<string, unknown>} */
  const endpoints = {};
  if (!sharesNetwork) {
    for (const [name, endpoint] of Object.entries(container.NetworkSettings?.Networks ?? {})) {
      const e = /** @type {any} */ (endpoint);
      endpoints[name] = {
        IPAMConfig: e.IPAMConfig ?? undefined,
        Links: e.Links ?? undefined,
        // Ohne die Kennung des alten Containers, die Docker selbst als Alias einträgt.
        Aliases: (e.Aliases ?? []).filter((/** @type {string} */ a) => !container.Id?.startsWith(a)),
      };
    }
  }

  return {
    ...config,
    HostConfig: container.HostConfig,
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wartet, bis der Container läuft und, falls er eine Prüfung hat, gesund ist.
 *
 * @param {string} name
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function waitUntilUp(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'unbekannt';
  // Ein Container, der sofort wieder endet, läuft im ersten Moment trotzdem.
  // Erst nach ein paar stabilen Sekunden gilt er als oben.
  let runningSince = 0;
  while (Date.now() < deadline) {
    const info = await docker.findContainer(name);
    if (!info) return { ok: false, detail: 'Der neue Container ist verschwunden.' };
    const state = info.State ?? {};
    last = state.Health?.Status ?? state.Status ?? 'unbekannt';
    if (state.Running && !state.Restarting) {
      if (!runningSince) runningSince = Date.now();
      const health = state.Health?.Status;
      if (health === 'healthy') return { ok: true, detail: 'läuft und ist gesund' };
      if (health === 'unhealthy') return { ok: false, detail: 'Die Prüfung des Containers meldet einen Fehler.' };
      if (!health && Date.now() - runningSince >= 5000) return { ok: true, detail: 'läuft' };
    } else {
      runningSince = 0;
      if (state.Status === 'exited' || state.Status === 'dead') {
        return { ok: false, detail: `Der Container ist beendet (Exit-Code ${state.ExitCode ?? '?'}).` };
      }
    }
    await sleep(1000);
  }
  return { ok: false, detail: `Nach ${Math.round(timeoutMs / 1000)} s nicht bereit (Zustand: ${last}).` };
}

/**
 * @param {string} name       Name oder Kennung des Containers
 * @param {string} reference  Das neue Abbild, schon geholt
 * @param {{ log?: (line: string) => void, timeoutMs?: number, stopGraceSeconds?: number, oldImage?: any }} [options]
 *   `oldImage`: das bisherige Abbild, vor dem Holen des neuen gelesen (`inspectImage`).
 * @returns {Promise<{ ok: boolean, error?: string, tail?: string }>}
 */
export async function replaceContainer(name, reference, options = {}) {
  const log = options.log ?? (() => undefined);
  const current = await docker.inspectContainer(name);
  const containerName = String(current.Name ?? name).replace(/^\//, '');
  // Das bisherige Abbild kommt vom Aufrufer, wenn er es hat. Nach dem Holen des
  // neuen trägt das alte keinen Namen mehr und kann schon verschwunden sein. Ohne
  // es bliebe im neuen Container stehen, was das alte Abbild vorgab, etwa dessen
  // Versionsangabe in der Umgebung.
  const oldImage = options.oldImage ?? (await docker.inspectImage(current.Image).catch(() => null));
  const newImage = oldImage ? null : await docker.inspectImage(reference).catch(() => null);
  const body = recreateBody(current, oldImage, reference, newImage);
  const parked = `${containerName}-hapm-alt`;

  // Ein Rest aus einem abgebrochenen Lauf stünde dem Umbenennen im Weg.
  const leftover = await docker.findContainer(parked);
  if (leftover) await docker.removeContainer(parked, { force: true });

  log(`Halte ${containerName} an`);
  if (current.State?.Running) await docker.stop(current.Id, options.stopGraceSeconds ?? 20);
  await docker.rename(current.Id, parked);

  const rollback = async (/** @type {string} */ reason) => {
    log(`Zurück zum bisherigen Container: ${reason}`);
    const failed = await docker.findContainer(containerName);
    let tail = '';
    if (failed) {
      tail = await docker.logs(containerName, { tail: 40 }).catch(() => '');
      await docker.removeContainer(containerName, { force: true }).catch(() => undefined);
    }
    await docker.rename(parked, containerName);
    await docker.start(containerName);
    return { ok: false, error: reason, tail };
  };

  try {
    log(`Lege ${containerName} mit ${reference} an`);
    await docker.createContainer(containerName, body);
    await docker.start(containerName);
  } catch (err) {
    return rollback(err instanceof Error ? err.message : String(err));
  }

  const up = await waitUntilUp(containerName, options.timeoutMs ?? 90_000);
  if (!up.ok) return rollback(up.detail);

  log(`${containerName} ${up.detail}`);
  await docker.removeContainer(parked, { force: true }).catch(() => undefined);

  const fresh = await docker.findContainer(containerName);
  if (fresh) await reattachDependents(current.Id, fresh.Id, log);
  return { ok: true };
}

/**
 * Container neu anlegen, die sich das Netz mit dem ersetzten teilten.
 *
 * `network_mode: service:…` wird zu `container:<kennung>`, und die Kennung ist
 * die des alten Containers. Nach dem Tausch hinge so ein Container an einem
 * Netz, das es nicht mehr gibt: er läuft weiter und ist nicht erreichbar. Im
 * Betrieb (beide im Netz des Hosts) kommt das nicht vor, in
 * `docker-compose.dev.yml` teilt sich HAProxy das Netz mit HAPM.
 *
 * @param {string} oldId
 * @param {string} newId
 * @param {(line: string) => void} log
 */
export async function reattachDependents(oldId, newId, log) {
  /** @type {any[]} */
  const all = (await docker.request('GET', '/containers/json', { query: { all: true } })) ?? [];
  for (const entry of all) {
    if (entry.HostConfig?.NetworkMode !== `container:${oldId}`) continue;
    try {
      const dependent = await docker.inspectContainer(entry.Id);
      const name = String(dependent.Name ?? entry.Id).replace(/^\//, '');
      const image = await docker.inspectImage(dependent.Image).catch(() => null);
      const body = recreateBody(dependent, image, dependent.Config.Image);
      body.HostConfig = { ...dependent.HostConfig, NetworkMode: `container:${newId}` };
      log(`Hänge ${name} an das Netz des neuen Containers`);
      await docker.removeContainer(dependent.Id, { force: true });
      await docker.createContainer(name, body);
      if (dependent.State?.Running) await docker.start(name);
    } catch (err) {
      log(`Ein abhängiger Container ließ sich nicht neu anlegen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
