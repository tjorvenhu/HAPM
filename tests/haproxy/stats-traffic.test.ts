import { describe, it, expect } from 'vitest';
import { trafficRows } from '@/lib/haproxy/stats-collect';
import { CROWDSEC_SPOA_BACKEND } from '@/lib/haproxy/config';

describe('trafficRows', () => {
  it('nimmt das Backend zum CrowdSec-Bouncer heraus, Ziele und Frontends bleiben', () => {
    const rows = [
      { scope: 'public_https', kind: 'frontend' },
      { scope: 'svc_abc', kind: 'backend' },
      { scope: CROWDSEC_SPOA_BACKEND, kind: 'backend' },
      { scope: 'acme_challenge', kind: 'backend' },
    ];
    expect(trafficRows(rows).map((row) => row.scope)).toEqual(['public_https', 'svc_abc', 'acme_challenge']);
  });
});
