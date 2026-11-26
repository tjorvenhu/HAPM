import { describe, it, expect } from 'vitest';
import { HAPROXY_PHASES, HAPROXY_PHASE_LABELS, haproxyPhases } from '@/components/runPhases';

/**
 * Das Fenster eines Laufs zeigt die Phasen, die diese Art durchläuft. Ein
 * Schalter in den Einstellungen (etwa CrowdSec für alle Ziele) hat weder DNS
 * noch Zertifikat und soll beides auch nicht als Kreis zeigen.
 */
describe('haproxyPhases', () => {
  it('zeigt für Einstellungen, Gruppen, Weiterleitungen und Import nur Lesen, Prüfen, Einsetzen', () => {
    for (const action of ['settings', 'scope-add', 'scope-remove', 'stream-create', 'stream-update', 'stream-delete', 'import']) {
      expect(haproxyPhases(action), action).toEqual(['preflight', 'checking', 'installing']);
    }
  });

  it('räumt beim Entfernen eines Ziels auf, beantragt aber kein Zertifikat', () => {
    expect(haproxyPhases('delete')).toEqual(['preflight', 'checking', 'installing', 'cleanup']);
  });

  it('zeigt beim Anlegen, Ändern und ohne bekannte Art die volle Reihe', () => {
    for (const action of ['create', 'update', 'certificate', null, undefined]) {
      expect(haproxyPhases(action)).toEqual(HAPROXY_PHASES);
    }
  });

  it('hat für jede Phase eine Beschriftung', () => {
    for (const phase of HAPROXY_PHASES) expect(HAPROXY_PHASE_LABELS[phase], phase).toBeTruthy();
  });
});
