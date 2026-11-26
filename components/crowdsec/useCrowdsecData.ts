'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useT } from '@/lib/i18n/react';

interface Loaded<T> {
  /** Für welche Adresse der Stand gilt. Wechselt sie, lädt der Hook neu. */
  path: string | null;
  data: T | null;
  error: string;
}

/**
 * Eine Route unter `/api/crowdsec` lesen und im Takt nachladen. Nachladen ist
 * leise: der letzte Stand bleibt stehen, bis der neue da ist. Ein Fehler steht
 * daneben und löscht den Stand nicht. Eine Antwort für eine Adresse, die nicht
 * mehr gilt (Zeitraum gewechselt), wird verworfen.
 */
export function useCrowdsecData<T>(path: string, pollMs = 30_000) {
  const { apiFetch } = useApp();
  const { t } = useT();
  const [state, setState] = useState<Loaded<T>>({ path: null, data: null, error: '' });
  const latest = useRef(path);

  useEffect(() => {
    latest.current = path;
  }, [path]);

  const load = useCallback(async () => {
    let next: Loaded<T>;
    try {
      const res = await apiFetch(path);
      const body = await res.json();
      next = body.success
        ? { path, data: body.data as T, error: '' }
        : { path, data: null, error: body.error || t('CrowdSec ist nicht erreichbar.') };
    } catch {
      next = { path, data: null, error: t('CrowdSec ist nicht erreichbar.') };
    }
    if (latest.current !== path) return;
    // Bei einem Fehler bleibt stehen, was zu DIESEM Pfad schon da war. Die
    // Daten eines anderen (voriger Zeitraum, anderer Container) nicht: sie
    // stünden sonst unter der neuen Auswahl.
    setState((current) => ({ ...next, data: next.data ?? (next.error && current.path === path ? current.data : null) }));
  }, [apiFetch, path, t]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(() => void load(), pollMs);

  return {
    data: state.path === path ? state.data : null,
    error: state.path === path ? state.error : '',
    loading: state.path !== path,
    reload: load,
  };
}

/** Eine Änderung schicken. Gibt die Antwort zurück oder wirft mit der Meldung der Route. */
export function useCrowdsecSend() {
  const { apiFetch } = useApp();
  const { t } = useT();
  return useCallback(
    async <T = unknown>(path: string, method: 'POST' | 'DELETE' | 'PATCH', body: unknown): Promise<T> => {
      const res = await apiFetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || t('Unbekannter Fehler.'));
      return data.data as T;
    },
    [apiFetch, t]
  );
}
