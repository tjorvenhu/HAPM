'use client';

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useT } from '@/lib/i18n/react';
import { errorCodeIn, openErrorDetail } from '@/lib/error-code';

/**
 * Die Meldungen nach einer Handlung — unten rechts, mit ablaufender Zeit.
 *
 * ── Warum nicht als Block über der Seite ──
 *
 * Eine Meldung, die sich als `alert` über den Inhalt schiebt, lässt die Liste
 * beim Erscheinen nach unten springen und beim Verschwinden zurück, und wer
 * gerade auf eine Karte zielt, klickt daneben. Dazu bleibt sie stehen, bis
 * jemand eine andere Handlung auslöst — nach zehn Minuten steht dort immer
 * noch „gespeichert", und man weiß nicht mehr, ob das eben war oder vorhin.
 *
 * Eine Meldung hier ist deshalb dreierlei: sie verschiebt nichts, sie sagt
 * durch den Balken darunter, wie lange sie noch bleibt, und sie lässt sich
 * wegdrücken.
 *
 * ── Zwei Regeln, die den Unterschied machen ──
 *
 * **Sie hält an, solange der Zeiger darauf liegt.** Eine Meldung, die
 * verschwindet, während man sie liest, ist der Grund, aus dem Leute Toasts
 * hassen. Der Balken hält mit an, sonst behauptete er etwas anderes als der
 * Zähler dahinter.
 *
 * **Ein Fehler bleibt länger als ein Erfolg** (siehe `DURATIONS`). „Gespeichert"
 * hat man nach zwei Sekunden gelesen; „fehlgeschlagen: Reload verweigert" nicht.
 *
 * Hierher gehört auch die Absage der Route nach dem Absenden eines Formulars
 * oder Dialogs: als Fehler mit Titel („Speichern fehlgeschlagen"), das Fenster
 * bleibt offen, die Eingabe steht noch da.
 *
 * Nicht hierher gehört, was kein Ereignis ist, sondern ein Zustand: „Server
 * nicht erreichbar" oder die Prüfung einer Eingabe VOR dem Absenden bleiben als
 * `alert` oder Hinweis an ihrer Stelle stehen. Sie verschwinden nicht von
 * selbst, weil sie nicht von selbst aufhören.
 */

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  /** Der Toast schließt sich danach von selbst — die Handlung ist erledigt. */
  onClick: () => void;
}

export interface ToastInput {
  message: string;
  /** Fett über der Meldung. Für „was" — die Meldung selbst sagt „wie es ausging". */
  title?: string;
  variant?: ToastVariant;
  /** Millisekunden. Ohne Angabe entscheidet die Art, siehe `DURATIONS`. */
  duration?: number;
  action?: ToastAction;
}

interface Toast extends ToastInput {
  id: number;
  variant: ToastVariant;
  duration: number;
}

const DURATIONS: Record<ToastVariant, number> = {
  success: 5000,
  info: 6000,
  warning: 8000,
  // Ein Fehler trägt meist eine Ursache im Text, und die will gelesen werden.
  error: 10000,
};

/**
 * Die Klasse je Art, ausgeschrieben statt zusammengesetzt.
 *
 * `toast-${variant}` wäre kürzer, aber `tests/ui/css-classes.test.ts` liest die
 * Klassennamen aus dem Quelltext und prüft, dass es sie im Stylesheet gibt —
 * aus einem zusammengesetzten Namen wird dabei das Fragment `.toast-`, das
 * nirgends steht. Die Prüfung ist mehr wert als die drei gesparten Zeilen.
 */
const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: 'toast-success',
  error: 'toast-error',
  warning: 'toast-warning',
  info: 'toast-info',
};

const ICONS: Record<ToastVariant, ReactNode> = {
  success: <CheckCircle2 size={18} />,
  error: <XCircle size={18} />,
  warning: <AlertTriangle size={18} />,
  info: <Info size={18} />,
};

interface ToastContextValue {
  notify: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

/** Höchstens so viele auf einmal. Darüber ist es keine Meldung mehr, sondern
 *  eine Wand — und die unterste sieht ohnehin niemand. */
const MAX_VISIBLE = 4;

export function ToastProvider({
  children,
  errorDetails = true,
}: {
  children: ReactNode;
  /**
   * `false` auf den Seiten vor der Anmeldung: das Fenster mit den Einzelheiten
   * zu einer Kennung (`components/ErrorDetails.tsx`) hängt am Rahmen und
   * verlangt eine Sitzung. Die Kennung steht dort trotzdem in der Meldung.
   */
  errorDetails?: boolean;
}) {
  const { t } = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (given: ToastInput) => {
      const id = nextId.current++;
      // Ein unbekannter Fehler nennt nur seine Kennung (`lib/error-log.ts`). Die
      // Einzelheiten dazu öffnet jede solche Meldung mit „Anzeigen", ohne dass
      // jeder Aufrufer daran denken muss.
      const code = given.action || !errorDetails ? null : errorCodeIn(`${given.title ?? ''} ${given.message}`);
      const input: ToastInput = code
        ? { ...given, action: { label: t('Anzeigen'), onClick: () => openErrorDetail(code) } }
        : given;
      const variant = input.variant ?? 'info';
      setToasts((current) =>
        [...current, { ...input, id, variant, duration: input.duration ?? DURATIONS[variant] }].slice(
          -MAX_VISIBLE
        )
      );
      return id;
    },
    [t, errorDetails]
  );

  return (
    <ToastContext.Provider value={{ notify, dismiss }}>
      {children}
      {/* `aria-live="polite"`: ein Screenreader liest die Meldung vor, ohne den
          Benutzer mitten im Satz zu unterbrechen. */}
      <div className="toast-stack" role="region" aria-live="polite" aria-label={t('Meldungen')}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useT();
  const [paused, setPaused] = useState(false);
  /** Was von der Zeit übrig ist. Ohne das fangen die Sekunden nach jedem
   *  Anhalten von vorne an, und ein Toast, über dem der Zeiger liegen bleibt,
   *  bekäme bei jeder Bewegung seine volle Dauer geschenkt. */
  const remaining = useRef(toast.duration);
  // 0 heißt „noch nie gestartet". Der Wert entsteht im Effekt und nicht beim
  // Rendern: eine Uhr abzulesen ist eine Nebenwirkung, und React darf ein
  // Rendern verwerfen und wiederholen (react-hooks/purity).
  const startedAt = useRef(0);

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const timer = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, onDismiss]);

  return (
    <div
      className={`toast-item ${VARIANT_CLASS[toast.variant]}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-icon">{ICONS[toast.variant]}</span>
      <div className="toast-body">
        {toast.title && <div className="toast-title">{toast.title}</div>}
        <div className="toast-message">{toast.message}</div>
        {toast.action && (
          <button
            type="button"
            className="btn btn-secondary btn-sm toast-action"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className="toast-close"
        onClick={onDismiss}
        aria-label={t('Meldung schließen')}
      >
        <X size={15} />
      </button>
      <span
        className="toast-progress"
        style={{
          animationDuration: `${toast.duration}ms`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
    </div>
  );
}
