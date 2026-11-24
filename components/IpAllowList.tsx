'use client';

import { Plus, X, Globe } from 'lucide-react';

/**
 * Die Adressliste eines Dienst-Tokens: eine Zeile je Adresse oder CIDR-Bereich.
 *
 * Dieselbe Form wie die Admin-IPs unter „Reverse-Proxy → Einstellungen", und
 * das ist Absicht — es ist dieselbe Sorte Liste, und zwei Schreibweisen für
 * dasselbe wären zwei Stellen, an denen man sich beim Format irrt. Eine
 * Komponente statt einer Kopie, weil sie hier an zwei Stellen steht: im Dialog
 * zum Anlegen und in dem zum Ändern.
 *
 * **Die leere Zeile am Ende gehört dazu.** Ohne sie müsste man erst auf
 * „hinzufügen" drücken, um überhaupt tippen zu können — ein Klick ohne
 * Entscheidung. Leere Zeilen fallen beim Speichern weg (`normaliseAllowedIps`).
 *
 * Geprüft wird hier NICHTS. Ein Feld, das beim Tippen schon rot wird, ist es
 * nach dem ersten Zeichen jeder gültigen Adresse; die Prüfung sitzt in der
 * Route, und sie lehnt ab, statt stillschweigend wegzulassen.
 */
export default function IpAllowList({
  value,
  onChange,
  disabled = false,
  heading = true,
  emptyHint = 'Ohne Eintrag gilt das Token von jeder Adresse aus. Für ein Skript auf einem festen ' +
    'Server ist eine Zeile hier der Unterschied zwischen „gestohlen und nutzbar“ und „gestohlen und wertlos“.',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /**
   * Ob die Komponente ihre eigene Überschrift mitbringt.
   *
   * Aus, wenn der Aufrufer schon eine hat — die TCP-Weiterleitung steht in
   * einem Abschnitt „Erreichbar von" und bekäme sonst zwei Überschriften
   * übereinander. Die LISTE bleibt in beiden Fällen dieselbe, und darum geht es:
   * zwei Schreibweisen für eine Adressliste wären zwei Stellen, an denen man
   * sich beim Format irrt.
   */
  heading?: boolean;
  /** Was dasteht, solange die Liste leer ist. Die Folge ist je Aufrufer eine
   *  andere: ein Token gilt dann überall, ein Port ist dann überall offen. */
  emptyHint?: string;
}) {
  const rows = value.length > 0 ? value : [''];
  const empty = rows.every((entry) => entry.trim() === '');

  return (
    <div className="form-group">
      {heading && (
        <div className="form-section-head">
          <span className="form-section-icon">
            <Globe size={17} />
          </span>
          <div>
            <div className="form-section-title">Erlaubte Adressen</div>
            <div className="form-section-sub">
              Von welchen Adressen dieses Token gelten darf. Einzelne Adresse oder CIDR-Bereich,
              IPv4 und IPv6. Leer heißt: von überall.
            </div>
          </div>
        </div>
      )}

      <div className="form-list">
        {rows.map((entry, index) => (
          <div className="form-list-row" key={index}>
            <input
              className="form-input"
              value={entry}
              onChange={(e) => onChange(rows.map((a, i) => (i === index ? e.target.value : a)))}
              placeholder="203.0.113.7 oder 10.0.0.0/8"
              autoComplete="off"
              disabled={disabled}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              data-tooltip="Zeile entfernen"
              disabled={disabled || rows.length === 1}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled}
          onClick={() => onChange([...rows, ''])}
        >
          <Plus size={14} />
          Adresse hinzufügen
        </button>
      </div>

      {empty && <span className="form-hint">{emptyHint}</span>}
    </div>
  );
}
