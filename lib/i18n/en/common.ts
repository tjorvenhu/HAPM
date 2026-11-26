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
  'Abgebrochen': 'Canceled',
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
  'Kopieren nicht möglich. Bitte von Hand markieren.': 'Copying is not possible. Please select the text by hand.',
  'Hochladen fehlgeschlagen': 'Upload failed',
  // Von mehreren Bereichen gebraucht
  'Die Passwörter stimmen nicht überein.': 'The passwords do not match.',
  'Passwort wiederholen': 'Repeat password',
  'Die Einrichtung ließ sich nicht starten.': 'Setup could not be started.',
  'Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.': 'At least 10 characters with uppercase and lowercase letters and a digit.',
  'Wert': 'Value',
  'Erneut versuchen': 'Try again',
  // Zertifikate: hochladen, eigener ACME-Server, eigener DNS-Server
  "hochgeladen": "uploaded",
};
