/**
 * Eine Registry fragen, was hinter einem Tag gerade liegt.
 *
 * Damit erkennt HAPM ein neues Abbild, ohne es zu holen: der Digest des Tags
 * in der Registry wird mit dem des lokalen Abbilds verglichen. Gefragt wird
 * anonym, das reicht für öffentliche Abbilder auf Docker Hub und GHCR.
 *
 * Rein bis auf `fetch`: `parseReference` und `parseChallenge` sind getestet.
 */

export interface ImageReference {
  registry: string;
  repository: string;
  tag: string;
}

/**
 * `haproxy:lts` → Docker Hub, `library/haproxy`, `lts`.
 *
 * Der erste Teil ist nur dann eine Registry, wenn er wie ein Hostname aussieht
 * (Punkt, Port oder `localhost`). Sonst ist er ein Benutzer auf Docker Hub.
 */
export function parseReference(reference: string): ImageReference {
  let rest = reference.trim();
  const at = rest.indexOf('@');
  if (at !== -1) rest = rest.slice(0, at);

  let registry = 'registry-1.docker.io';
  const firstSlash = rest.indexOf('/');
  if (firstSlash !== -1) {
    const head = rest.slice(0, firstSlash);
    if (head.includes('.') || head.includes(':') || head === 'localhost') {
      registry = head;
      rest = rest.slice(firstSlash + 1);
    }
  }
  if (registry === 'docker.io' || registry === 'index.docker.io') registry = 'registry-1.docker.io';

  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon !== -1 && !rest.slice(colon).includes('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }

  const repository = registry === 'registry-1.docker.io' && !rest.includes('/') ? `library/${rest}` : rest;
  return { registry, repository, tag };
}

/** `Bearer realm="…",service="…",scope="…"` zerlegen. */
export function parseChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out.realm ? out : null;
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const TIMEOUT_MS = 15_000;

async function registryFetch(
  ref: ImageReference,
  path: string,
  init: { method?: string; accept?: string; token?: string | null }
): Promise<Response> {
  const scheme = /^(localhost|127\.)/.test(ref.registry) ? 'http' : 'https';
  return fetch(`${scheme}://${ref.registry}/v2/${ref.repository}/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.accept ? { Accept: init.accept } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function anonymousToken(challenge: Record<string, string>): Promise<string | null> {
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set('service', challenge.service);
  if (challenge.scope) url.searchParams.set('scope', challenge.scope);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? null;
}

/** Eine Sitzung gegen eine Registry: holt das Token beim ersten 401 und merkt es sich. */
function session(ref: ImageReference) {
  let token: string | null = null;
  return async (path: string, init: { method?: string; accept?: string } = {}): Promise<Response> => {
    let res = await registryFetch(ref, path, { ...init, token });
    if (res.status === 401 && !token) {
      const challenge = parseChallenge(res.headers.get('www-authenticate'));
      if (challenge) {
        token = await anonymousToken(challenge);
        if (token) res = await registryFetch(ref, path, { ...init, token });
      }
    }
    return res;
  };
}

/**
 * Der Digest, auf den der Tag gerade zeigt. Ein `HEAD`, damit die Abfrage bei
 * Docker Hub nicht gegen das Kontingent anonymer Abrufe zählt.
 */
export async function remoteDigest(reference: string): Promise<string> {
  const ref = parseReference(reference);
  const call = session(ref);
  const res = await call(`manifests/${ref.tag}`, { method: 'HEAD', accept: MANIFEST_TYPES });
  if ([401, 403, 404].includes(res.status)) {
    // Ein Abbild, das es dort nicht gibt, und eines, das nicht öffentlich ist,
    // beantwortet eine Registry gleich.
    throw new Error(
      `${ref.repository}:${ref.tag} gibt es in der Registry ${ref.registry} nicht, oder es ist nicht öffentlich.`
    );
  }
  if (!res.ok) {
    throw new Error(`Die Registry ${ref.registry} antwortet mit ${res.status} für ${ref.repository}:${ref.tag}.`);
  }
  const digest = res.headers.get('docker-content-digest');
  if (!digest) throw new Error(`Die Registry ${ref.registry} nennt keinen Digest für ${ref.repository}:${ref.tag}.`);
  return digest;
}

export interface RemoteImageDetails {
  /** Aus `HAPROXY_VERSION` oder dem Label `org.opencontainers.image.version`. */
  version: string | null;
  created: string | null;
}

interface Manifest {
  mediaType?: string;
  manifests?: { digest: string; platform?: { architecture?: string; os?: string } }[];
  config?: { digest: string };
}

/**
 * Was in dem Abbild hinter dem Tag steckt: die Version, damit die Oberfläche
 * „3.4.8 → 3.4.9" sagen kann statt zwei Digests zu zeigen.
 */
export async function remoteDetails(reference: string, architecture: string): Promise<RemoteImageDetails> {
  const ref = parseReference(reference);
  const call = session(ref);

  let res = await call(`manifests/${ref.tag}`, { accept: MANIFEST_TYPES });
  if (!res.ok) throw new Error(`Manifest nicht lesbar (${res.status}).`);
  let manifest = (await res.json()) as Manifest;

  if (manifest.manifests) {
    const entry =
      manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform.architecture === architecture) ??
      manifest.manifests.find((m) => m.platform?.os === 'linux');
    if (!entry) return { version: null, created: null };
    res = await call(`manifests/${entry.digest}`, { accept: MANIFEST_TYPES });
    if (!res.ok) throw new Error(`Manifest der Plattform nicht lesbar (${res.status}).`);
    manifest = (await res.json()) as Manifest;
  }
  if (!manifest.config?.digest) return { version: null, created: null };

  res = await call(`blobs/${manifest.config.digest}`);
  if (!res.ok) throw new Error(`Beschreibung des Abbilds nicht lesbar (${res.status}).`);
  const config = (await res.json()) as {
    created?: string;
    config?: { Env?: string[]; Labels?: Record<string, string> };
  };
  return {
    version: versionOf(config.config?.Env, config.config?.Labels),
    created: config.created ?? null,
  };
}

/** Die Version eines Abbilds aus seiner Umgebung oder seinen Labels. */
export function versionOf(env: string[] | null | undefined, labels: Record<string, string> | null | undefined): string | null {
  const fromEnv = (env ?? []).find((entry) => entry.startsWith('HAPROXY_VERSION='));
  const version = fromEnv?.slice('HAPROXY_VERSION='.length).trim();
  return version || labels?.['org.opencontainers.image.version'] || null;
}
