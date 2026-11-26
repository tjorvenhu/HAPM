'use client';

import { useCallback, useState, type FormEvent } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { Server, Plus, Pencil, Trash2, Loader2, Check, X } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { errorText } from '@/components/errorText';
import { useMountedLoad } from '@/components/useMountedLoad';
import { SkeletonRows } from '@/components/Skeleton';
import {
  normalizeSavedTarget,
  savedTargetAddress,
  validateSavedTarget,
  type SavedTarget,
} from '@/lib/haproxy/saved-targets';
import { useT } from '@/lib/i18n/react';

/**
 * Backend-Server verwalten (gespeicherte Ziele, `lib/haproxy/saved-targets.ts`):
 * Name, Host, auf Wunsch ein Port. Die Dialoge bieten sie neben dem Adressfeld
 * zur Auswahl an. Steht auf der Übersicht der Ziele und nicht in einer Gruppe,
 * weil ein Server Dienste in mehreren Gruppen tragen kann.
 *
 * In der Oberfläche heißen sie „Backend-Server" und nicht „Ziele": ein Ziel ist
 * in HAPM der Eintrag am Reverse-Proxy, und dasselbe Wort für zwei Dinge auf
 * einer Seite wäre eine Verwechslung mit Ansage.
 */

interface Draft {
  name: string;
  host: string;
  port: string;
}

const EMPTY: Draft = { name: '', host: '', port: '' };

export default function SavedTargetsPanel() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t } = useT();

  const [targets, setTargets] = useState<SavedTarget[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** `new` für die Zeile zum Anlegen, sonst die Kennung der Zeile, die bearbeitet wird. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  /** Nur die Prüfung vor dem Absenden. Was die Route antwortet, ist eine Meldung. */
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/targets');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setTargets(data.data as SavedTarget[]);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [apiFetch]);

  useMountedLoad(load);

  function start(target: SavedTarget | null) {
    setEditing(target ? target.$id : 'new');
    setDraft(target ? { name: target.name, host: target.host, port: target.port === null ? '' : String(target.port) } : EMPTY);
    setFormError('');
  }

  function cancel() {
    setEditing(null);
    setFormError('');
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const input = normalizeSavedTarget(draft);
    const invalid = validateSavedTarget(input);
    if (invalid) {
      setFormError(t(invalid));
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const isNew = editing === 'new';
      const res = await apiFetch(isNew ? '/api/haproxy/targets' : `/api/haproxy/targets/${editing}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      notify({
        variant: 'success',
        message: isNew
          ? t('Der Server {name} ist hinterlegt.', { name: input.name })
          : t('Der Server {name} ist geändert.', { name: input.name }),
      });
      setEditing(null);
      await load();
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Der Server ließ sich nicht speichern.')),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: SavedTarget) {
    await confirm({
      title: t('Server {name} entfernen?', { name: target.name }),
      message: t('Ziele, die diese Adresse benutzen, bleiben unverändert. Der Server steht danach nur nicht mehr zur Auswahl.'),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
      failedTitle: t('Entfernen fehlgeschlagen'),
      // Im Dialog und nicht danach: solange er offen ist, liegt er über der
      // Liste, und ein zweiter Klick auf dieselbe Zeile kommt nicht an.
      onConfirm: async () => {
        const res = await apiFetch(`/api/haproxy/targets/${target.$id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        notify({ variant: 'success', message: t('Der Server {name} ist entfernt.', { name: target.name }) });
        await load();
      },
    });
  }

  const form = (
    <form className="hapm-target-form" onSubmit={save}>
      <input
        className="form-input"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder={t('Name, z. B. NAS')}
        aria-label={t('Name')}
        disabled={busy}
        autoFocus
        autoComplete="off"
      />
      <input
        className="form-input"
        value={draft.host}
        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
        placeholder="10.10.0.20"
        aria-label={t('IP-Adresse oder Hostname')}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
      />
      <input
        className="form-input"
        value={draft.port}
        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
        placeholder={t('Port (frei)')}
        aria-label={t('Port')}
        inputMode="numeric"
        disabled={busy}
        autoComplete="off"
      />
      <div className="hapm-form-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
          {t('Speichern')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={cancel} disabled={busy}>
          <X size={14} />
          {t('Abbrechen')}
        </button>
      </div>
    </form>
  );

  return (
    <div className="sys-block">
      <div className="section-header">
        <h2 className="section-title">
          {t('Backend-Server')}
          {targets && <span className="section-count">{targets.length}</span>}
        </h2>
        <InfoHint
          text={t(
            'Ein Server, auf dem mehrere Dienste laufen, wird hier einmal mit Namen hinterlegt. Im Dialog eines Ziels wählen Sie ihn dann neben dem Adressfeld aus, statt IP und Port zu tippen. Ohne Port bleibt der Port im Dialog frei. In der HAProxy-Konfiguration steht weiter die Adresse selbst, eine Änderung hier ändert also kein bestehendes Ziel.'
          )}
        />
        <span className="section-hint">{t('Einmal hinterlegt, in jedem Ziel auswählbar')}</span>
        {editing === null && targets && (
          <button className="btn btn-secondary btn-sm hapm-section-action" onClick={() => start(null)}>
            <Plus size={14} />
            {t('Hinzufügen')}
          </button>
        )}
      </div>

      {!targets ? (
        loadFailed ? (
          <div className="alert alert-danger">{t('Die Backend-Server konnten nicht geladen werden.')}</div>
        ) : (
          <SkeletonRows count={2} />
        )
      ) : (
        <div className="hapm-target-list">
          {targets.length === 0 && editing !== 'new' && (
            <p className="form-list-empty">
              <Server size={14} />
              {t('Noch keine Backend-Server hinterlegt.')}
            </p>
          )}
          {targets.map((target) =>
            editing === target.$id ? (
              <div className="hapm-target-row is-editing" key={target.$id}>
                {form}
              </div>
            ) : (
              <div className="hapm-target-row" key={target.$id}>
                <span className="hapm-target-icon">
                  <Server size={16} />
                </span>
                <span className="hapm-target-text">
                  <span className="hapm-target-name">{target.name}</span>
                  <code className="hapm-target-address">{savedTargetAddress(target)}</code>
                </span>
                <span className="hapm-target-actions">
                  <button
                    className="btn btn-ghost btn-icon"
                    data-tooltip={t('Bearbeiten')}
                    aria-label={t('Bearbeiten')}
                    onClick={() => start(target)}
                    disabled={editing !== null}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    data-tooltip={t('Entfernen')}
                    aria-label={t('Entfernen')}
                    onClick={() => void remove(target)}
                    disabled={editing !== null}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </div>
            )
          )}
          {editing === 'new' && <div className="hapm-target-row is-editing">{form}</div>}
          {formError && <div className="alert alert-danger"><ErrorNote text={formError} /></div>}
        </div>
      )}
    </div>
  );
}
