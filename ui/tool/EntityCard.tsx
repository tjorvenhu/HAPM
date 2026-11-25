'use client';

import type { ReactNode } from 'react';

/**
 * Card primitive for entity lists (targets, zones, tokens, users ...).
 *
 * Assembled inline per page, the same grid wrapper, icon tile and action row
 * get copy-pasted from file to file, and copies of a look drift. This is the
 * same reason Select exists, so the classes live in `css/tool-vocabulary.css`
 * and the assembly lives here.
 *
 * `actions` is a ReactNode, not a list of descriptors: pages need spinners on a
 * busy button, conditional buttons and the odd toggle switch in that row. The
 * part worth pinning down is the styling, not the buttons.
 */

interface EntityCardProps {
  /** lucide icon, size 17 to match the 34px tile. */
  icon: ReactNode;
  name: ReactNode;
  /** Secondary line under the name. */
  subtitle?: ReactNode;
  /** Top right, next to the name. Usually a .badge-status. */
  badge?: ReactNode;
  /** Fields, tags, whatever the entity needs. */
  children?: ReactNode;
  /** Buttons for the footer row. Omit for a card without actions. */
  actions?: ReactNode;
  /**
   * Tints the card. The one case so far is a row that is on its way out — the
   * delete is running and the card is about to disappear. Not for warnings: a
   * card that merely needs attention says so with a badge, and a tinted card
   * among twenty plain ones reads as broken rather than busy.
   *
   * `system`: an entry HAPM set up for itself (the group of its own surface).
   * It stays tinted for good, because it behaves differently for good: it
   * cannot be removed.
   */
  tone?: 'danger' | 'system';
  /**
   * Sprungziel für einen Verweis von einer anderen Seite.
   *
   * Führt ein Name auf einer anderen Seite zu dieser Karte, landet man ohne
   * Kennung auf einer Seite mit zwölf Karten und sucht die richtige selbst.
   */
  anchorId?: string;
  /** Kurz hervorgehoben, weil gerade hierher verwiesen wurde. */
  highlighted?: boolean;
}

export default function EntityCard({
  icon,
  name,
  subtitle,
  badge,
  children,
  actions,
  tone,
  anchorId,
  highlighted,
}: EntityCardProps) {
  return (
    <div
      id={anchorId}
      className={[
        'entity-card',
        tone === 'danger' ? 'is-danger' : '',
        tone === 'system' ? 'is-system' : '',
        highlighted ? 'is-highlighted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="entity-card-head">
        <span className="entity-card-icon">{icon}</span>
        {/* Eigene Zeile für Überschrift und Pille: wird es eng, rutscht die
            Pille unter den Namen, statt ihn auf Wortbreite zusammenzudrücken. */}
        <div className="entity-card-title">
          <span className="entity-card-heading">
            <span className="entity-card-name">{name}</span>
            {subtitle && <span className="entity-card-subtitle">{subtitle}</span>}
          </span>
          {badge}
        </div>
      </div>
      {children && <div className="entity-card-body">{children}</div>}
      {actions && <div className="entity-card-actions">{actions}</div>}
    </div>
  );
}

/**
 * `align="start"` lets a card grow (an inline-expanded edit form) without
 * stretching its row neighbours to match. Default `stretch` keeps equal-height
 * cards for the usual read-only lists.
 */
export function EntityGrid({
  children,
  align = 'stretch',
  size = 'regular',
}: {
  children: ReactNode;
  align?: 'stretch' | 'start';
  /** `compact`: schmalere Spalten, mehr Karten je Reihe (die Karten der Ziele). */
  size?: 'regular' | 'compact';
}) {
  const classes = ['entity-grid', align === 'start' ? 'align-start' : '', size === 'compact' ? 'is-compact' : '']
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}

/**
 * A wrap row of pill tags. The clean, dense alternative to a stack of labelled
 * `EntityField`s: categorical facts (source, repository, scope) read faster as
 * tags than as label-over-value blocks, and they never push the layout around
 * when one of them wraps. Use for the two or three defining attributes of a card.
 */
export function EntityTags({ children }: { children: ReactNode }) {
  return <div className="entity-card-tags">{children}</div>;
}

/**
 * One pill inside `EntityTags`. `mono` for addresses and paths (IP, host, repo
 * path); `danger` tints a broken reference (deleted server).
 */
export function EntityTag({
  icon,
  children,
  tooltip,
  mono = false,
  danger = false,
}: {
  icon?: ReactNode;
  children: ReactNode;
  tooltip?: string;
  mono?: boolean;
  danger?: boolean;
}) {
  return (
    <span
      className={`entity-card-tag${mono ? ' mono' : ''}${danger ? ' danger' : ''}`}
      data-tooltip={tooltip}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * A compact inline row: a lead element (cron pill, status badge) followed by a
 * muted note (the human phrase, a date). Replaces the "Letzter Lauf" / "Zeitplan"
 * field blocks where a label adds nothing the value doesn't already say.
 */
export function EntityMeta({ children }: { children: ReactNode }) {
  return <div className="entity-card-meta">{children}</div>;
}

/** Muted trailing text inside an `EntityMeta` (a schedule phrase, a timestamp). */
export function EntityNote({ children }: { children: ReactNode }) {
  return <span className="entity-card-note">{children}</span>;
}

/** A labelled value inside a card. Long values wrap; use `mono` for paths and IDs. */
export function EntityField({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="entity-card-field">
      <span className="entity-card-label">{label}</span>
      <span className={mono ? 'entity-card-mono' : 'entity-card-value'}>{children}</span>
    </div>
  );
}
