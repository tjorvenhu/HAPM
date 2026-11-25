/**
 * Platzhalter in der Form eines Formulars der Anmeldekarte: je Feld eine
 * Beschriftung und ein Eingabefeld, darunter der Knopf, mit denselben
 * Abständen wie `.auth-form`. Beim Neuladen springt die Karte so nicht, wenn
 * das Formular erscheint.
 */
export default function AuthFormSkeleton({ fields = 2 }: { fields?: number }) {
  return (
    <div className="auth-form" aria-busy="true" aria-hidden="true">
      {Array.from({ length: fields }, (_, i) => (
        <div className="auth-field" key={i}>
          <div className="skeleton auth-skeleton-label" />
          <div className="skeleton auth-skeleton-input" />
        </div>
      ))}
      <div className="skeleton auth-skeleton-submit" />
    </div>
  );
}
