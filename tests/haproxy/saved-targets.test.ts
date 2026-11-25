import { describe, it, expect } from 'vitest';
import {
  applySavedTarget,
  findSavedTarget,
  normalizeSavedTarget,
  validateSavedTarget,
} from '@/lib/haproxy/saved-targets';

const nas = { name: 'NAS', host: '10.0.0.5', port: null };
const wiki = { name: 'Wiki', host: '10.0.0.5', port: 8080 };

describe('gespeicherte Ziele', () => {
  it('räumt die Eingabe auf: Port leer heißt keiner', () => {
    expect(normalizeSavedTarget({ name: ' NAS ', host: ' 10.0.0.5 ', port: '' })).toEqual(nas);
    expect(normalizeSavedTarget({ name: 'Wiki', host: 'Srv.Local', port: '8080' })).toEqual({
      name: 'Wiki',
      host: 'srv.local',
      port: 8080,
    });
  });

  it('lehnt ab, was nicht in eine server-Zeile gehört', () => {
    expect(validateSavedTarget(nas)).toBeNull();
    expect(validateSavedTarget({ ...nas, name: '' })).not.toBeNull();
    expect(validateSavedTarget({ ...nas, host: '10.0.0.5 # x' })).not.toBeNull();
    expect(validateSavedTarget({ ...nas, port: 70000 })).not.toBeNull();
    expect(validateSavedTarget({ ...nas, port: Number('abc') })).not.toBeNull();
  });

  it('setzt mit Port die ganze Adresse ein', () => {
    expect(applySavedTarget('192.168.1.1:80', wiki)).toBe('10.0.0.5:8080');
  });

  it('behält ohne Port den Port aus dem Feld', () => {
    expect(applySavedTarget('192.168.1.1:3000', nas)).toBe('10.0.0.5:3000');
    expect(applySavedTarget('', nas)).toBe('10.0.0.5:');
    expect(applySavedTarget('irgendwas', nas)).toBe('10.0.0.5:');
  });

  it('erkennt das Ziel an der Adresse, mit Port vor ohne', () => {
    const targets = [nas, wiki];
    expect(findSavedTarget('10.0.0.5:8080', targets)).toBe(wiki);
    expect(findSavedTarget('10.0.0.5:3000', targets)).toBe(nas);
    expect(findSavedTarget('10.0.0.6:3000', targets)).toBeNull();
    expect(findSavedTarget('', targets)).toBeNull();
  });
});
