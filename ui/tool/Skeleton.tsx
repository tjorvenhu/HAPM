'use client';

import { EntityGrid } from './EntityCard';

/**
 * Platzhalter für Inhalt, der noch geladen wird.
 *
 * Die CSS-Klassen (`.skeleton`, `.skeleton-card`) stehen in
 * `css/tool-vocabulary.css`. Zusammengesetzt werden sie hier und nicht je Seite
 * neu: sonst zeigt die nächste Seite doch wieder einen Spinner, und der Inhalt
 * springt beim Eintreffen der Daten von 0 auf volle Höhe.
 *
 * Der Grund für Platzhalter statt Spinner ist nicht Optik: ein Spinner sagt
 * „irgendetwas passiert", ein Platzhalter sagt, WAS gleich dasteht und wie viel
 * davon. Und er hält die Höhe, sodass nach dem Laden nichts unter dem Mauszeiger
 * wegspringt.
 *
 * Wichtig dabei: **kein Platzhalter zeigt einen erratenen Wert.** Eine
 * Überschrift, die erst den Adressteil zeigt und dann die echte Bezeichnung,
 * flackert sichtbar (bei den Reverse-Proxy-Gruppen etwa `kunden` → `Kunden`).
 * Ein grauer Balken behauptet nichts und wird deshalb auch nicht korrigiert.
 */

interface SkeletonProps {
  /** Zahl = Pixel, String = beliebige CSS-Breite (`'40%'`). */
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}

/** Ein einzelner grauer Balken. `span`, damit er auch in einer Überschrift
 *  stehen darf — ein `div` in einem `h1` ist ungültiges HTML. */
export default function Skeleton({ width, height, radius }: SkeletonProps) {
  return (
    <span className="skeleton" style={{ display: 'block', width, height, borderRadius: radius }} />
  );
}

/**
 * Die Überschrift einer Detailseite, deren Name aus den Daten kommt.
 *
 * Höhe und Breite sind an `.page-title` angelehnt, damit der Seitenkopf beim
 * Eintreffen der Daten nicht die Höhe wechselt.
 */
export function SkeletonTitle({ width = 220 }: { width?: number | string }) {
  return <Skeleton width={width} height={28} radius={6} />;
}

/**
 * Der Satz unter dem Platzhalter.
 *
 * Nur dort, wo er mehr sagt als „Laden…": ein Satz, der nennt, worauf gewartet
 * wird, erklärt eine Wartezeit von Sekunden. „Laden…" erklärt gar nichts und
 * steht deshalb nirgends.
 */
function Caption({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p className="form-hint" style={{ marginTop: 12, textAlign: 'center' }}>
      {text}
    </p>
  );
}

/**
 * Eine Liste aus `EntityCard`-Karten, solange sie noch nicht da ist.
 *
 * `count` ist bewusst klein voreingestellt: der Platzhalter soll die Seite füllen,
 * nicht eine Menge behaupten, die es vielleicht gar nicht gibt.
 */
export function SkeletonCards({
  count = 3,
  actions = 3,
  caption,
}: {
  count?: number;
  actions?: number;
  caption?: string;
}) {
  return (
    <>
      <EntityGrid>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="skeleton-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Skeleton width={34} height={34} radius="var(--radius)" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                <div className="skeleton skeleton-text" style={{ width: '55%' }} />
                <div className="skeleton skeleton-text-sm" style={{ width: '35%' }} />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="skeleton skeleton-text-sm" style={{ width: '80%' }} />
              <div className="skeleton skeleton-text-sm" style={{ width: '65%' }} />
            </div>
            {actions > 0 && (
              <div style={{ display: 'flex', gap: 6 }}>
                {Array.from({ length: actions }, (_, j) => (
                  <Skeleton key={j} width={30} height={30} radius="var(--radius)" />
                ))}
              </div>
            )}
          </div>
        ))}
      </EntityGrid>
      <Caption text={caption} />
    </>
  );
}

/** Zeilen einer Tabelle oder einer gestapelten Liste. */
export function SkeletonRows({ count = 4, caption }: { count?: number; caption?: string }) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            className="skeleton-card"
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <div className="skeleton skeleton-text" style={{ width: '40%' }} />
              <div className="skeleton skeleton-text-sm" style={{ width: '55%' }} />
            </div>
            <Skeleton width={90} height={22} radius={6} />
          </div>
        ))}
      </div>
      <Caption text={caption} />
    </>
  );
}

/**
 * Eine ganze Detailseite, solange noch nichts von ihr da ist.
 *
 * Für die Seiten, die beim Laden mit `return` aussteigen — dort ist auch der
 * Seitenkopf noch nicht gerendert, und ein Platzhalter, der nur den Inhalt
 * andeutet, ließe die Seite oben leer beginnen und dann nach unten springen.
 */
export function SkeletonDetail({ caption }: { caption?: string }) {
  return (
    <>
      <div className="page-header">
        <div className="page-heading">
          <Skeleton width={44} height={44} radius="var(--radius-lg)" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SkeletonTitle />
            <Skeleton width={140} height={13} radius={4} />
          </div>
        </div>
      </div>
      <SkeletonRows count={3} caption={caption} />
    </>
  );
}
