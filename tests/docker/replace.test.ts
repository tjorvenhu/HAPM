import { describe, it, expect } from 'vitest';
import { recreateBody } from '@/lib/docker/replace.mjs';

const CONTAINER_ID = '4f2a9c1e7b3d5a6f8e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9c0b1a2f';
const NEW_IMAGE = 'haproxy:lts';

/** Das Abbild, wie `inspectImage` es für `haproxy:lts` liefert. */
const IMAGE = {
  Config: {
    Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin', 'HAPROXY_VERSION=3.4.8', 'HAPROXY_SHA256=abc'],
    Cmd: ['haproxy', '-f', '/usr/local/etc/haproxy/haproxy.cfg'],
    Entrypoint: ['docker-entrypoint.sh'],
    WorkingDir: '/var/lib/haproxy',
    User: 'haproxy',
    StopSignal: 'SIGUSR1',
    Labels: { 'org.opencontainers.image.version': '3.4.8', maintainer: 'docker-library' },
  },
};

/** Ein Container, wie Compose ihn aus diesem Abbild anlegt. */
function composeContainer(overrides: Record<string, unknown> = {}, hostConfig: Record<string, unknown> = {}) {
  return {
    Id: CONTAINER_ID,
    Name: '/hapm-haproxy',
    Image: 'sha256:0000',
    Config: {
      Hostname: CONTAINER_ID.slice(0, 12),
      Domainname: '',
      Image: 'haproxy:lts',
      Env: [...IMAGE.Config.Env, 'TZ=Europe/Berlin'],
      Cmd: [...IMAGE.Config.Cmd],
      Entrypoint: [...IMAGE.Config.Entrypoint],
      WorkingDir: IMAGE.Config.WorkingDir,
      User: IMAGE.Config.User,
      StopSignal: IMAGE.Config.StopSignal,
      Labels: {
        ...IMAGE.Config.Labels,
        'com.docker.compose.project': 'hapm',
        'com.docker.compose.service': 'haproxy',
      },
      ...overrides,
    },
    HostConfig: {
      NetworkMode: 'hapm_default',
      Binds: ['hapm_config:/etc/haproxy'],
      RestartPolicy: { Name: 'unless-stopped' },
      ...hostConfig,
    },
    NetworkSettings: {
      Networks: {
        hapm_default: {
          IPAMConfig: null,
          Links: null,
          Aliases: ['hapm-haproxy', 'haproxy', CONTAINER_ID.slice(0, 12)],
          MacAddress: '02:42:ac:12:00:03',
          IPAddress: '172.18.0.3',
        },
      },
    },
  };
}

describe('recreateBody', () => {
  it('setzt das neue Abbild ein', () => {
    expect(recreateBody(composeContainer(), IMAGE, 'haproxy:3.5').Image).toBe('haproxy:3.5');
  });

  it('zieht die Umgebung des Abbilds ab und behält die eigene', () => {
    const body = recreateBody(composeContainer(), IMAGE, NEW_IMAGE);
    expect(body.Env).toEqual(['TZ=Europe/Berlin']);
  });

  it('behält eine eigene Variable, die das Abbild mit anderem Wert kennt', () => {
    const container = composeContainer({ Env: ['PATH=/opt/bin', 'HAPROXY_VERSION=3.4.8'] });
    expect(recreateBody(container, IMAGE, NEW_IMAGE).Env).toEqual(['PATH=/opt/bin']);
  });

  it('überlässt Kommando, Einstiegspunkt und Vorgaben dem neuen Abbild, wenn sie die des alten sind', () => {
    const body = recreateBody(composeContainer(), IMAGE, NEW_IMAGE);
    for (const key of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'StopSignal']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('behält ein eigenes Kommando', () => {
    const cmd = ['haproxy', '-f', '/etc/haproxy/haproxy.cfg', '-W'];
    const body = recreateBody(composeContainer({ Cmd: cmd }), IMAGE, NEW_IMAGE);
    expect(body.Cmd).toEqual(cmd);
    expect(body).not.toHaveProperty('Entrypoint');
  });

  it('behält das Kommando neben einem eigenen Einstiegspunkt, auch wenn es dem des Abbilds gleicht', () => {
    // Docker übernimmt das Kommando des Abbilds nur, wenn auch der Einstiegspunkt vom Abbild kommt.
    const body = recreateBody(composeContainer({ Entrypoint: ['/usr/local/bin/hapm-entry'] }), IMAGE, NEW_IMAGE);
    expect(body.Entrypoint).toEqual(['/usr/local/bin/hapm-entry']);
    expect(body.Cmd).toEqual(IMAGE.Config.Cmd);
  });

  it('lässt die Labels des Abbilds weg und behält die von Compose', () => {
    const body = recreateBody(composeContainer(), IMAGE, NEW_IMAGE);
    expect(body.Labels).toEqual({
      'com.docker.compose.project': 'hapm',
      'com.docker.compose.service': 'haproxy',
    });
  });

  it('behält ein Label, das den Wert des Abbilds überschreibt', () => {
    const container = composeContainer({ Labels: { maintainer: 'betreiber', 'org.opencontainers.image.version': '3.4.8' } });
    expect(recreateBody(container, IMAGE, NEW_IMAGE).Labels).toEqual({ maintainer: 'betreiber' });
  });

  it('lässt den Hostnamen weg, der die Kennung des alten Containers ist', () => {
    expect(recreateBody(composeContainer(), IMAGE, NEW_IMAGE)).not.toHaveProperty('Hostname');
  });

  it('behält einen eigenen Hostnamen', () => {
    const body = recreateBody(composeContainer({ Hostname: 'proxy' }), IMAGE, NEW_IMAGE);
    expect(body.Hostname).toBe('proxy');
  });

  it('lässt bei NetworkMode host Hostname, Domainname, Ports und Endpunkte weg', () => {
    const container = composeContainer(
      { Hostname: 'docker-host', Domainname: 'example.invalid', ExposedPorts: { '80/tcp': {}, '443/tcp': {} } },
      { NetworkMode: 'host' }
    );
    const body = recreateBody(container, IMAGE, NEW_IMAGE);
    expect(body).not.toHaveProperty('Hostname');
    expect(body).not.toHaveProperty('Domainname');
    expect(body).not.toHaveProperty('ExposedPorts');
    expect(body.NetworkingConfig).toEqual({ EndpointsConfig: {} });
    expect(body.HostConfig.NetworkMode).toBe('host');
  });

  it('behandelt das Netz eines anderen Containers wie das des Hosts', () => {
    const container = composeContainer({ Hostname: 'other' }, { NetworkMode: 'container:abc' });
    const body = recreateBody(container, IMAGE, NEW_IMAGE);
    expect(body).not.toHaveProperty('Hostname');
    expect(body.NetworkingConfig).toEqual({ EndpointsConfig: {} });
  });

  it('übernimmt die Netze mit ihren Aliasen, ohne die Kennung des alten Containers', () => {
    const body = recreateBody(composeContainer(), IMAGE, NEW_IMAGE);
    const endpoint = body.NetworkingConfig.EndpointsConfig.hapm_default as Record<string, unknown>;
    expect(endpoint.Aliases).toEqual(['hapm-haproxy', 'haproxy']);
    expect(endpoint).not.toHaveProperty('MacAddress');
    expect(endpoint).not.toHaveProperty('IPAddress');
  });

  it('übernimmt eine feste Adresse im Netz', () => {
    const container = composeContainer();
    container.NetworkSettings.Networks.hapm_default.IPAMConfig = { IPv4Address: '172.18.0.10' } as never;
    const body = recreateBody(container, IMAGE, NEW_IMAGE);
    const endpoint = body.NetworkingConfig.EndpointsConfig.hapm_default as Record<string, unknown>;
    expect(endpoint.IPAMConfig).toEqual({ IPv4Address: '172.18.0.10' });
  });

  it('reicht die Einrichtung des Hosts unverändert durch', () => {
    const container = composeContainer();
    expect(recreateBody(container, IMAGE, NEW_IMAGE).HostConfig).toEqual(container.HostConfig);
  });

  it('verändert den übergebenen Container nicht', () => {
    const container = composeContainer();
    const before = JSON.stringify(container);
    recreateBody(container, IMAGE, NEW_IMAGE);
    expect(JSON.stringify(container)).toBe(before);
  });

  it('kommt ohne Auskunft über das alte Abbild aus und behält dann alles', () => {
    const body = recreateBody(composeContainer(), null, NEW_IMAGE);
    expect(body.Env).toContain('HAPROXY_VERSION=3.4.8');
    expect(body.Cmd).toEqual(IMAGE.Config.Cmd);
    expect(body.Image).toBe(NEW_IMAGE);
  });

  it('nimmt ohne das alte Abbild das neue als Maßstab und lässt dessen Angaben über sich selbst weg', () => {
    // Das alte Abbild kann nach dem Holen des neuen schon verschwunden sein.
    const newer = {
      Config: {
        ...IMAGE.Config,
        Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin', 'HAPROXY_VERSION=3.4.9', 'HAPROXY_SHA256=def'],
        Labels: { 'org.opencontainers.image.version': '3.4.9', maintainer: 'docker-library' },
      },
    };
    const body = recreateBody(composeContainer(), null, NEW_IMAGE, newer);
    // Die Version des alten Abbilds bliebe sonst im neuen Container stehen.
    expect(body.Env).not.toContain('HAPROXY_VERSION=3.4.8');
    expect(body.Env).not.toContain('HAPROXY_SHA256=abc');
    expect(body.Env).toContain('TZ=Europe/Berlin');
    // Kommando und Einstiegspunkt gleichen denen des neuen Abbilds, also gehören sie ihm.
    expect(body.Cmd).toBeUndefined();
    expect(body.Entrypoint).toBeUndefined();
    expect(body.Labels).toEqual({
      'com.docker.compose.project': 'hapm',
      'com.docker.compose.service': 'haproxy',
    });
  });

  it('behält ohne das alte Abbild eine eigene Variable, auch wenn das neue sie kennt', () => {
    // Ein eingestellter Port darf beim Update nicht auf die Vorgabe zurückfallen.
    const newer = { Config: { ...IMAGE.Config, Env: ['PORT=7080', 'HAPM_VERSION=0.2.0'] } };
    const container = composeContainer({ Env: ['PORT=9000', 'HAPM_VERSION=0.1.0'] });
    const body = recreateBody(container, null, NEW_IMAGE, newer);
    expect(body.Env).toEqual(['PORT=9000']);
  });
});
