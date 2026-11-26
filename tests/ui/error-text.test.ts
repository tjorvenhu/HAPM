import { describe, it, expect } from 'vitest';
import { errorText } from '@/ui/tool/errorText';

const FALLBACK = 'Das Speichern ist fehlgeschlagen.';

describe('errorText', () => {
  it('zeigt die Meldung der Route', () => {
    expect(errorText(new Error('Die Gruppe gibt es schon.'), FALLBACK)).toBe('Die Gruppe gibt es schon.');
  });

  it('ersetzt, was der Browser wirft, durch den Satz der Seite', () => {
    expect(errorText(new TypeError('Failed to fetch'), FALLBACK)).toBe(FALLBACK);
    expect(errorText(new SyntaxError('Unexpected token < in JSON at position 0'), FALLBACK)).toBe(FALLBACK);
    expect(errorText(new DOMException('The operation was aborted.', 'AbortError'), FALLBACK)).toBe(FALLBACK);
  });

  it('nimmt den Satz der Seite, wenn nichts Lesbares geworfen wurde', () => {
    expect(errorText(new Error(''), FALLBACK)).toBe(FALLBACK);
    expect(errorText('kaputt', FALLBACK)).toBe(FALLBACK);
    expect(errorText(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
