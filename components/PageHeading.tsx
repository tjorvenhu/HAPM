'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

/**
 * Der Kopf einer Unterseite: Zeichen, Titel, darunter der Rückweg als Pille
 * und ein kurzer Satz. Eine Komponente und nicht dreimal Markup: der Rückweg
 * sah auf einigen Seiten aus wie eine Pille, auf anderen wie ein kleiner Link
 * über dem Titel. Die Klassen stehen in `ui/css/tool-vocabulary.css`
 * (`page-heading`, `page-crumbs`, `page-back`).
 */
export default function PageHeading({
  icon,
  title,
  back,
  note,
}: {
  icon?: ReactNode;
  title: ReactNode;
  /** Ein Link oder, wo der Rückweg ein Zustand der Seite ist, ein Klick. */
  back?: { label: string; href: string } | { label: string; onClick: () => void };
  /** Ein kurzer Satz neben dem Rückweg. Lange Erklärungen gehören nicht hierher. */
  note?: ReactNode;
}) {
  return (
    <div className="page-heading">
      {icon && <span className="page-heading-icon">{icon}</span>}
      <div>
        <h1 className="page-title">{title}</h1>
        {(back || note) && (
          <div className="page-crumbs">
            {back &&
              ('href' in back ? (
                <Link className="page-back" href={back.href}>
                  <ArrowLeft size={14} />
                  {back.label}
                </Link>
              ) : (
                <button type="button" className="page-back" onClick={back.onClick}>
                  <ArrowLeft size={14} />
                  {back.label}
                </button>
              ))}
            {note && <span>{note}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
