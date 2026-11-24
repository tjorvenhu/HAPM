'use client';

import { X, Globe, Scale, CornerUpRight, Cable } from 'lucide-react';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Was für ein Ziel es werden soll.
 *
 * ── Warum eine eigene Stufe vor dem Formular ──
 *
 * „Ziel anlegen" führte auf ein Formular mit dreißig Feldern, in dem die
 * Entscheidung, um die es eigentlich geht, ein Dropdown in der Mitte war
 * („Wohin die Domains gehen"). Wer eine Weiterleitung wollte, füllte erst
 * Backend-Zeilen aus und fand den Schalter danach.
 *
 * Die vier Arten unterscheiden sich zu stark, um sie als Feld zu behandeln: ein
 * Reverse-Proxy-Eintrag beantragt ein Zertifikat, eine Lastverteilung braucht
 * ein Verfahren, eine Weiterleitung hat gar kein Backend, und eine
 * TCP-Weiterleitung hat weder Domain noch Zertifikat, dafür einen Port der
 * Maschine, der danach offen ist. Das gehört vor die Eingabe und nicht hinein.
 *
 * Jede der vier führt auf ein eigenes Formular, und jedes zeigt nur die Felder
 * seiner Sorte: im Reverse-Proxy-Formular gibt es kein Verteilverfahren, im
 * Weiterleitungs-Formular keine Backend-Zeilen. Der Umschalter, der früher
 * mittendrin stand, ist damit weg.
 *
 * ── Die Art ist trotzdem keine Eigenschaft ──
 *
 * Sie steht nirgends in `haproxy.cfg` und wird auch nirgends gespeichert. Beim
 * Bearbeiten sagt der Eintrag selbst, welches Formular aufgeht (`serviceKind`)
 * — wer die Verteilung aus einem Eintrag herausnimmt, findet ihn beim nächsten
 * Öffnen als Reverse-Proxy vor, ohne dass irgendwo ein Feld umgestellt wurde.
 */

/** Die drei Arten, die auf einen Dienst hinauslaufen, plus die TCP-Weiterleitung,
 *  die ein eigener Abschnitt in der Konfiguration ist. */
export type TargetKind = 'proxy' | 'balance' | 'redirect' | 'stream';

/** In dieser Reihenfolge stehen sie überall: in der Auswahl beim Anlegen und im
 *  Filter über der Liste. */
export const TARGET_KINDS: TargetKind[] = ['proxy', 'balance', 'redirect', 'stream'];

/**
 * Die Wörter, an einer Stelle.
 *
 * Der Filter über der Liste liest dieselbe Karte wie die Karten hier: eine
 * Liste, in der man einen Eintrag anlegt, und eine, in der man ihn
 * wiederfindet, dürfen nicht verschieden heißen. Zwei Aufzählungen wären genau
 * die zwei, von denen eine bei der nächsten Umbenennung stehen bleibt.
 */
export const TARGET_KIND_LABELS: Record<TargetKind, string> = {
  proxy: msgid('Reverse-Proxy'),
  balance: msgid('Lastverteilung'),
  redirect: msgid('HTTP-Weiterleitung'),
  stream: msgid('TCP-Weiterleitung'),
};

const KINDS: {
  kind: TargetKind;
  icon: React.ReactNode;
  sub: string;
}[] = [
  {
    kind: 'proxy',
    icon: <Globe size={18} />,
    sub: msgid('Eine Domain auf ein Ziel im Backend. Mit Zertifikat und Healthcheck, der Normalfall.'),
  },
  {
    kind: 'balance',
    icon: <Scale size={18} />,
    sub: msgid('Eine Domain auf mehrere Ziele: Verfahren, Gewichtung und auf Wunsch Sitzungsbindung.'),
  },
  {
    kind: 'redirect',
    icon: <CornerUpRight size={18} />,
    sub: msgid('Eine Domain antwortet mit 301 oder 302 und zeigt woanders hin. Ohne eigenen Server dahinter.'),
  },
  {
    kind: 'stream',
    icon: <Cable size={18} />,
    sub: msgid('Ein Port dieses Servers, durchgereicht an ein Ziel dahinter: Datenbank, SSH, SMTP. Ohne Domain und ohne Zertifikat.'),
  },
];

export default function TargetKindDialog({
  onPick,
  onClose,
}: {
  onPick: (kind: TargetKind) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{t('Was soll angelegt werden?')}</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label={t('Dialog schließen')}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="kind-grid">
            {KINDS.map(({ kind, icon, sub }) => (
              <button
                type="button"
                key={kind}
                className="kind-card"
                onClick={() => onPick(kind)}
              >
                <span className="kind-card-icon">{icon}</span>
                <span className="kind-card-text">
                  <span className="kind-card-title">{t(TARGET_KIND_LABELS[kind])}</span>
                  <span className="kind-card-sub">{t(sub)}</span>
                </span>
              </button>
            ))}
          </div>
          {/* Kein Satz „die Auswahl lässt sich später ändern": sie stimmt nur
              für einen der Wege (Reverse-Proxy → Lastverteilung, im Formular
              als eigener Knopf). Ein Hinweis, der für eine von vier Karten
              gilt, steht an der falschen Stelle — er steht dort, wo der Knopf
              ist. */}
        </div>
      </div>
    </div>
  );
}
