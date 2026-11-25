'use client';

import { useCallback, useState } from 'react';
import { Server } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useMountedLoad } from '@/components/useMountedLoad';
import Select from '@/components/Select';
import {
  applySavedTarget,
  findSavedTarget,
  savedTargetAddress,
  type SavedTarget,
} from '@/lib/haproxy/saved-targets';
import { useT } from '@/lib/i18n/react';

/**
 * Die gespeicherten Ziele, einmal je Dialog geladen. Ohne Antwort bleibt die
 * Liste leer: das Adressfeld daneben geht auch ohne sie.
 */
export function useSavedTargets(): SavedTarget[] {
  const { apiFetch } = useApp();
  const [targets, setTargets] = useState<SavedTarget[]>([]);
  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/targets');
      const data = await res.json();
      if (data.success) setTargets(data.data as SavedTarget[]);
    } catch {
      // Siehe oben: das Formular bleibt bedienbar.
    }
  }, [apiFetch]);
  useMountedLoad(load);
  return targets;
}

/**
 * Neben dem Adressfeld: ein gespeichertes Ziel wählen statt IP und Port zu
 * tippen. Gezeigt wird das Ziel, dessen Adresse gerade im Feld steht, so sieht
 * man auch beim Bearbeiten, welcher Server gemeint ist.
 */
export default function SavedTargetPick({
  targets,
  address,
  onPick,
}: {
  targets: SavedTarget[];
  address: string;
  onPick: (address: string) => void;
}) {
  const { t } = useT();
  const current = findSavedTarget(address.trim(), targets);
  return (
    <div className="hapm-target-pick">
      <Select
        value={current?.$id ?? null}
        placeholder={t('Server')}
        emptyText={t('Backend-Server legen Sie auf der Seite Ziele an.')}
        options={targets.map((target) => ({
          value: target.$id,
          label: target.name,
          hint: target.port === null ? t('{host}, Port frei', { host: target.host }) : savedTargetAddress(target),
          icon: <Server size={14} />,
        }))}
        onChange={(id) => {
          const target = targets.find((candidate) => candidate.$id === id);
          if (target) onPick(applySavedTarget(address, target));
        }}
      />
    </div>
  );
}
