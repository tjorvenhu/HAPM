import type { Dictionary } from './index';

/** Konto: Seite, Routen unter `/api/account`, Passkeys (`lib/auth/passkey*.ts`). */
export const account: Dictionary = {
  // Seite
  'Angemeldet als {name} ({email}).': 'Signed in as {name} ({email}).',
  'Das Konto konnte nicht geladen werden.': 'The account could not be loaded.',
  'Sprache der Oberfläche': 'Interface language',
  'Gilt für dieses Konto, auf jedem Gerät.': 'Applies to this account on every device.',
  'Die Sprache ließ sich nicht speichern.': 'The language could not be saved.',
  'Diese Sprache gibt es nicht.': 'This language does not exist.',

  // Passwort
  'Passwort ändern': 'Change password',
  'Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.':
    'At least 10 characters with uppercase and lowercase letters and a digit.',
  'Aktuelles Passwort': 'Current password',
  'Neues Passwort': 'New password',
  'Neues Passwort wiederholen': 'Repeat new password',
  'Alle anderen Sitzungen dieses Kontos werden dabei beendet.': 'All other sessions of this account will end.',
  'Die neuen Passwörter stimmen nicht überein.': 'The new passwords do not match.',
  'Das Passwort ließ sich nicht ändern.': 'The password could not be changed.',
  'Das Passwort ist geändert. Alle anderen Sitzungen dieses Kontos sind beendet.':
    'The password is changed. All other sessions of this account have ended.',
  'Das aktuelle Passwort stimmt nicht.': 'The current password is wrong.',
  'Das aktuelle und das neue Passwort sind erforderlich.': 'The current and the new password are required.',
  'Das Passwort ist erforderlich.': 'The password is required.',

  // Zweiter Faktor
  'Zweiter Faktor': 'Second factor',
  'Nach dem Passwort verlangt die Anmeldung einen Code aus einer App.': 'After the password, sign-in asks for a code from an app.',
  'Es gibt keine Wiederherstellungscodes. Geht die Authenticator-App verloren, hilft nur noch der Zugang zum Server: dort setzt {command} mit der E-Mail-Adresse dahinter ein neues Passwort, schaltet den zweiten Faktor ab und entfernt die Passkeys.':
    'There are no recovery codes. If the authenticator app is lost, only access to the server helps: there, {command} followed by the email address sets a new password, turns off the second factor and removes the passkeys.',
  'Zweiten Faktor abschalten': 'Turn off second factor',
  'Danach reicht für die Anmeldung das Passwort. Das hinterlegte Geheimnis wird gelöscht.':
    'After that, the password is enough to sign in. The stored secret is deleted.',
  'Der zweite Faktor ist eingerichtet. Alle anderen Sitzungen dieses Kontos sind beendet.':
    'The second factor is set up. All other sessions of this account have ended.',
  'Der zweite Faktor ließ sich nicht abschalten.': 'The second factor could not be turned off.',
  'Der zweite Faktor ist abgeschaltet.': 'The second factor is turned off.',
  'Der zweite Faktor ist nicht eingerichtet.': 'The second factor is not set up.',
  'Der zweite Faktor ist schon eingerichtet.': 'The second factor is already set up.',
  'Die Einrichtung wurde noch nicht gestartet.': 'Setup has not been started yet.',

  // Passkeys
  'Passkeys': 'Passkeys',
  'Anmelden ohne Passwort und ohne Code, per Fingerabdruck, Gesicht oder PIN.':
    'Sign in without password or code, by fingerprint, face or PIN.',
  'Passkey hinzufügen': 'Add passkey',
  'Passkey anlegen': 'Create passkey',
  'Passkey umbenennen': 'Rename passkey',
  'Passkey entfernen': 'Remove passkey',
  '{name} umbenennen': 'Rename {name}',
  '{name} entfernen': 'Remove {name}',
  'Ablage': 'Storage',
  'Hinterlegt am': 'Added on',
  'z. B. MacBook oder iPhone': 'e.g. MacBook or iPhone',
  'Erst einrichten, was unten steht': 'Set up what is listed below first',
  'Mehr als {max} Passkeys je Konto sind nicht möglich': 'No more than {max} passkeys per account',
  'Mehr als {max} Passkeys je Konto sind nicht möglich. Bitte entfernen Sie zuerst einen.':
    'No more than {max} passkeys per account. Please remove one first.',
  'Passkeys lassen sich erst benutzen, wenn das eingerichtet ist:': 'Passkeys can only be used once this is set up:',
  'Adresse von HAPM': 'HAPM address',
  'An ihrer Domain hängt jeder Passkey.': 'Every passkey is bound to its domain.',
  'SMTP-Konto': 'SMTP account',
  'HAPM meldet per Mail, wenn an Ihrem Konto ein Passkey dazukommt oder wegfällt.':
    'HAPM sends an email when a passkey is added to or removed from your account.',
  'Noch kein Passkey hinterlegt. Ein Passkey liegt auf Ihrem Gerät oder in Ihrem Passwortmanager. Geht das Gerät verloren, melden Sie sich wie bisher mit dem Passwort an.':
    'No passkey added yet. A passkey lives on your device or in your password manager. If the device is lost, sign in with your password as before.',
  'Ihr Gerät fragt gleich nach Fingerabdruck, Gesicht oder PIN.': 'Your device will ask for your fingerprint, face or PIN.',
  'Der Name steht nur in dieser Liste. Auf dem Gerät ändert sich nichts.':
    'The name only appears in this list. Nothing changes on the device.',
  'Dieser Browser unterstützt keine Passkeys.': 'This browser does not support passkeys.',
  'Der Passkey kann gerade nicht hinterlegt werden.': 'The passkey cannot be added right now.',
  'Der Passkey konnte nicht hinterlegt werden.': 'The passkey could not be added.',
  'Der Passkey konnte nicht hinterlegt werden. Bitte versuchen Sie es noch einmal.':
    'The passkey could not be added. Please try again.',
  'Der Passkey ist hinterlegt. Bei der nächsten Anmeldung können Sie ihn benutzen.':
    'The passkey is added. You can use it the next time you sign in.',
  'Der Name konnte nicht gespeichert werden.': 'The name could not be saved.',
  'Der Name ist gespeichert.': 'The name is saved.',
  'Mit "{name}" ist danach keine Anmeldung mehr möglich. Ihr Passwort bleibt bestehen. Auf dem Gerät selbst löschen Sie den Passkey in dessen Einstellungen.':
    'Signing in with "{name}" will no longer be possible. Your password stays. To delete the passkey on the device itself, use its settings.',
  'Der Passkey ließ sich nicht entfernen.': 'The passkey could not be removed.',
  'Der Passkey ist entfernt.': 'The passkey is removed.',
  'Diesen Passkey gibt es nicht mehr.': 'This passkey no longer exists.',
  'Zu Ihrer Sicherheit melden Sie sich bitte einmal neu an. Danach können Sie den Passkey hinterlegen.':
    'For your security, please sign in again. After that you can add the passkey.',
  'Dieses Gerät hat Sie nicht per Fingerabdruck, Gesicht oder PIN bestätigt. Ein solcher Passkey ersetzt keinen zweiten Faktor und wird nicht gespeichert.':
    'This device did not verify you by fingerprint, face or PIN. Such a passkey does not replace a second factor and is not saved.',
  'Passkeys stehen erst zur Verfügung, wenn die Adresse von HAPM und ein SMTP-Konto eingerichtet sind.':
    'Passkeys are only available once the HAPM address and an SMTP account are set up.',
  'Passkeys stehen erst zur Verfügung, wenn die Adresse von HAPM eingerichtet ist.':
    'Passkeys are only available once the HAPM address is set up.',
  'Passkeys stehen erst zur Verfügung, wenn ein SMTP-Konto eingerichtet ist.':
    'Passkeys are only available once an SMTP account is set up.',

  // `lib/auth/passkey-rules.ts`
  'Android-Gerät': 'Android device',
  'Windows-PC': 'Windows PC',
  'Linux-PC': 'Linux PC',
  'Auf Ihren Geräten abgeglichen': 'Synced across your devices',
  'Abgleich möglich, noch nicht gesichert': 'Can sync, not backed up yet',
  'Nur auf einem Gerät': 'On one device only',
  'Das Anlegen wurde abgebrochen.': 'Creating the passkey was cancelled.',
  'Dieses Gerät hat für Ihr Konto schon einen Passkey.': 'This device already has a passkey for your account.',
  'Dieses Gerät kann keinen Passkey anlegen, der Sie per Fingerabdruck, Gesicht oder PIN bestätigt.':
    'This device cannot create a passkey that verifies you by fingerprint, face or PIN.',
  'Passkeys funktionieren nur unter der eingerichteten Adresse von HAPM und über eine sichere Verbindung.':
    'Passkeys only work at the configured HAPM address and over a secure connection.',
  'Der Passkey konnte nicht angelegt werden.': 'The passkey could not be created.',
};
