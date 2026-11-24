'use client';

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  /** Optional opt-in checkbox (e.g. "delete the data too"). Its state is passed
   *  to onConfirm; callers that don't set a label just ignore the argument. */
  checkboxLabel?: string;
  /** Die zweite, leisere Zeile unter der Beschriftung — wofür der Schalter
   *  konkret gilt (die betroffenen Domains, ein Pfad). */
  checkboxHint?: string;
  /**
   * Ob der Schalter offen steht, wenn der Dialog aufgeht. Vorgabe: aus.
   *
   * An gehört er dorthin, wo das Häkchen den Normalfall beschreibt und nicht
   * die Ausnahme — beim Reverse-Proxy-Ziel etwa der DNS-Eintrag, der ohne den
   * Dienst keinen Zweck mehr hat. Ein Schalter, den man bei neunundzwanzig von
   * dreißig Löschvorgängen erst setzen müsste, wird beim dreißigsten vergessen.
   */
  checkboxDefault?: boolean;
  /**
   * Verlangt, dass genau dieser Text abgetippt wird, bevor bestätigt werden kann.
   *
   * Für die Handvoll Vorgänge, bei denen ein Klick zu wenig ist, weil sie sich
   * nicht zurücknehmen lassen. Ein Häkchen klickt man weg, einen Namen tippt
   * man nicht versehentlich ab. Bewusst kein zweites Muster daneben: sonst
   * baut die nächste Seite ihr eigenes Löschmodal, und jedes sieht anders aus.
   */
  requireText?: string;
  /** Was über dem Eingabefeld steht. Ohne Angabe eine neutrale Aufforderung. */
  requireTextLabel?: string;
  onConfirm?: (checkboxChecked: boolean) => Promise<void>;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm() {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used within ConfirmProvider');
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<ConfirmOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  /** Zurückgesetzt beim Öffnen: der Haken am Kopierknopf gehört zu diesem Dialog. */
  const [copied, setCopied] = useState(false);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setDialog(options);
      setLoading(false);
      setChecked(options.checkboxDefault ?? false);
      setTyped('');
      setCopied(false);
    });
  }, []);

  // Exakter Vergleich, kein trim und kein toLowerCase: wer den Namen abtippt,
  // soll den Namen abtippen. Eine Nachsicht hier ist eine Nachsicht beim
  // einzigen Vorgang, der sich nicht rückgängig machen lässt.
  const textSatisfied = !dialog?.requireText || typed === dialog.requireText;

  function handleClose(result: boolean) {
    if (loading) return;
    resolveRef.current?.(result);
    resolveRef.current = null;
    setDialog(null);
  }

  async function handleConfirm() {
    if (dialog?.onConfirm) {
      setLoading(true);
      try {
        await dialog.onConfirm(checked);
      } catch {
        setLoading(false);
        return;
      }
      setLoading(false);
      resolveRef.current?.(true);
      resolveRef.current = null;
      setDialog(null);
    } else {
      handleClose(true);
    }
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleClose(false)}>
          <div className="confirm-dialog">
            <div className="confirm-dialog-icon" data-variant={dialog.variant || 'default'}>
              <AlertTriangle size={24} />
            </div>
            {dialog.title && <h3 className="confirm-dialog-title">{dialog.title}</h3>}
            <p className="confirm-dialog-message">{dialog.message}</p>
            {/* Derselbe Rahmen wie ein Schalter in einem Formular
                (`.form-subsection` mit `-head`): Beschriftung links, Schalter
                rechts, in einem Kasten. Frei zwischen zwei zentrierten Absätzen
                sähe der Schalter aus wie hingefallen, und bei jeder Textlänge
                säße er woanders. */}
            {dialog.checkboxLabel && (
              <label
                className="form-subsection"
                style={{
                  alignSelf: 'stretch',
                  textAlign: 'left',
                  margin: '4px 0 16px',
                  cursor: loading ? 'default' : 'pointer',
                }}
              >
                <div className="form-subsection-head">
                  <div>
                    <div className="form-section-title">{dialog.checkboxLabel}</div>
                    {dialog.checkboxHint && (
                      <div className="form-section-sub">{dialog.checkboxHint}</div>
                    )}
                  </div>
                  <span className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={loading}
                      onChange={(e) => setChecked(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </span>
                </div>
              </label>
            )}
            {/* `alignSelf: stretch`, weil der Dialog eine zentrierte Spalte ist:
                ohne das nimmt der Block die Breite seines Inhalts an, und das
                Feld stand mit seiner Standardbreite von zwanzig Zeichen mitten
                im Fenster. So endet es genau dort, wo auch der Bestätigen-Knopf
                endet — `.confirm-dialog-actions` ist ebenfalls 100 % breit. */}
            {dialog.requireText && (
              <div className="form-group confirm-require">
                {/* Zwei Zeilen, fest: die Aufforderung oben, darunter die
                    Kennung mit ihrem Kopierknopf. Vorher lief beides in einer
                    umbrechenden Zeile, und sobald sie zu lang wurde, stand der
                    Knopf allein unter dem Text — er sah dann nach „kopiert
                    irgendetwas" aus statt nach „gehört zu dieser Kennung".
                    Der Knopf steht NEBEN dem Label und nicht darin: ein Knopf
                    innerhalb eines `label` löst beim Klick zusätzlich dessen
                    Fokuswechsel ins Eingabefeld aus. */}
                <label className="form-label is-small">
                  {dialog.requireTextLabel || 'Zum Bestätigen abtippen:'}
                </label>
                <div className="confirm-require-row">
                  <code className="confirm-require-text">{dialog.requireText}</code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={copied ? 'Kopiert' : 'Kopieren'}
                    disabled={loading}
                    onClick={() => {
                      void navigator.clipboard.writeText(dialog.requireText ?? '');
                      setCopied(true);
                    }}
                    aria-label="Kennung kopieren"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <input
                  className="form-input"
                  value={typed}
                  disabled={loading}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            <div className="confirm-dialog-actions">
              <button className="btn btn-secondary" onClick={() => handleClose(false)} disabled={loading}>
                {dialog.cancelLabel || 'Abbrechen'}
              </button>
              <button
                className={`btn ${dialog.variant === 'danger' ? 'btn-danger' : dialog.variant === 'warning' ? 'btn-warning' : 'btn-primary'}`}
                onClick={handleConfirm}
                // Der Fokus gehört ins Eingabefeld, wenn es eines gibt.
                autoFocus={!dialog.requireText}
                disabled={loading || !textSatisfied}
              >
                {loading && <Loader2 size={16} className="spin" />}
                {dialog.confirmLabel || 'Bestätigen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
