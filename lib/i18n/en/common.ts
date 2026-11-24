import type { Dictionary } from './index';

/** Was mehrere Bereiche brauchen: Knöpfe, Zustände, allgemeine Meldungen des Servers. */
export const common: Dictionary = {
  // Knöpfe und kurze Wörter
  'Abbrechen': 'Cancel',
  'Bestätigen': 'Confirm',
  'Speichern': 'Save',
  'Speichern…': 'Saving…',
  'Entfernen': 'Remove',
  'Umbenennen': 'Rename',
  'Kopieren': 'Copy',
  'Kopiert': 'Copied',
  'Weiter': 'Next',
  'Zurück': 'Back',
  'Einrichten': 'Set up',
  'Abschalten': 'Turn off',
  'Prüfen…': 'Checking…',
  'Dialog schließen': 'Close dialog',
  'oder': 'or',

  // Felder
  'Name': 'Name',
  'Passwort': 'Password',
  'E-Mail-Adresse': 'Email address',
  'Code': 'Code',

  // Zustände
  'Unbekannt': 'Unknown',
  'Eingerichtet': 'Set up',
  'Nicht eingerichtet': 'Not set up',
  'Läuft': 'Running',
  'Erfolgreich': 'Succeeded',
  'Mit Hinweisen': 'With warnings',
  'Fehlgeschlagen': 'Failed',
  'Abgebrochen': 'Cancelled',
  'Update': 'Update',

  // Meldungen, die jede Route geben kann (`lib/api.ts`)
  'Nicht authentifiziert': 'Not signed in',
  'Ungültiger CSRF-Token': 'Invalid CSRF token',
  '2FA-Verifizierung erforderlich': 'Second factor required',
  'Unerwarteter Fehler': 'Unexpected error',
  'Ungültiger Request-Body': 'Invalid request body',
  'Zu viele Versuche. Bitte warten Sie 15 Minuten.': 'Too many attempts. Please wait 15 minutes.',
  'Zu viele Versuche. Bitte warten Sie 5 Minuten.': 'Too many attempts. Please wait 5 minutes.',
  'Die Anfrage ist fehlgeschlagen.': 'The request failed.',
  'Der Vorgang ist fehlgeschlagen.': 'The operation failed.',
};
