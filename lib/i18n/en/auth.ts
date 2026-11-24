import type { Dictionary } from './index';

/** Anmeldung und alles davor: Seiten, Routen unter `/api/auth`, Meldungen von `lib/auth`. */
export const auth: Dictionary = {
  // Anmeldung
  'Anmeldung': 'Sign in',
  'Anmelden': 'Sign in',
  'Anmelden…': 'Signing in…',
  'Anmeldung bestätigen': 'Confirm sign-in',
  'Code aus der Authenticator-App': 'Code from the authenticator app',
  'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.': 'Enter the 6-digit code from your authenticator app.',
  'Die Anmeldung ist fehlgeschlagen.': 'Sign-in failed.',
  'Der Code ließ sich nicht prüfen.': 'The code could not be checked.',
  'Passwort vergessen?': 'Forgot password?',
  'Zurück zur Anmeldung': 'Back to sign-in',
  'Zur Anmeldung': 'Go to sign-in',

  // Passkey bei der Anmeldung
  'Mit Passkey anmelden': 'Sign in with passkey',
  'Dieser Browser unterstützt keine Passkeys. Bitte melden Sie sich mit E-Mail und Passwort an.':
    'This browser does not support passkeys. Please sign in with email and password.',
  'Die Anmeldung mit Passkey ist gerade nicht möglich.': 'Signing in with a passkey is not possible right now.',
  'Die Anmeldung mit Passkey ist fehlgeschlagen.': 'Signing in with a passkey failed.',
  'Die Anmeldung mit diesem Passkey war nicht möglich.': 'Signing in with this passkey was not possible.',
  'Die Anmeldung wurde abgebrochen.': 'Sign-in was cancelled.',
  'Dieser Passkey bestätigt Sie nicht per Fingerabdruck, Gesicht oder PIN und wird deshalb nicht angenommen.':
    'This passkey does not verify you by fingerprint, face or PIN and is therefore not accepted.',
  'Die Antwort des Geräts war unvollständig.': 'The response from the device was incomplete.',

  // Passwort vergessen und neu festlegen
  'Passwort vergessen': 'Forgot password',
  'Auf dieser Installation ist das Zurücksetzen per E-Mail nicht eingerichtet.':
    'Resetting by email is not set up on this installation.',
  'Geben Sie die E-Mail-Adresse Ihres Kontos ein. Sie erhalten einen Link, über den Sie ein neues Passwort festlegen.':
    'Enter the email address of your account. You will receive a link to set a new password.',
  'Ein neues Passwort setzt dieses Kommando auf dem Server:': 'This command on the server sets a new password:',
  'e-mail': 'email',
  'Es schaltet auch den zweiten Faktor des Kontos ab, entfernt seine Passkeys und beendet seine Sitzungen.':
    'It also turns off the second factor of the account, removes its passkeys and ends its sessions.',
  'Senden…': 'Sending…',
  'Link senden': 'Send link',
  'Gibt es zu dieser Adresse ein Konto, ist jetzt ein Link dorthin unterwegs. Er gilt eine Stunde.':
    'If an account exists for this address, a link is on its way. It is valid for one hour.',
  'Passwort festlegen': 'Set password',
  'Geben Sie Ihr neues Passwort ein.': 'Enter your new password.',
  'Passwort wiederholen': 'Repeat password',
  'Passwort speichern': 'Save password',
  'Die Passwörter stimmen nicht überein.': 'The passwords do not match.',
  'Das Passwort ließ sich nicht speichern.': 'The password could not be saved.',
  'Der Link ist unvollständig. Bitte fordern Sie einen neuen an.': 'The link is incomplete. Please request a new one.',
  'Neuen Link anfordern': 'Request a new link',
  'Ihr Passwort ist gespeichert. Alle Sitzungen dieses Kontos sind beendet.':
    'Your password is saved. All sessions of this account have ended.',

  // Meldungen der Routen unter `/api/auth`
  'Zu viele Anmeldeversuche. Bitte warten Sie 15 Minuten.': 'Too many sign-in attempts. Please wait 15 minutes.',
  'Zu viele Anfragen. Bitte warten Sie 15 Minuten.': 'Too many requests. Please wait 15 minutes.',
  'E-Mail und Passwort sind erforderlich.': 'Email and password are required.',
  'Ungültige Anmeldedaten.': 'Invalid credentials.',
  'Bitte geben Sie eine gültige E-Mail-Adresse ein.': 'Please enter a valid email address.',
  'Das Zurücksetzen per E-Mail ist auf dieser Installation nicht eingerichtet. Ein neues Passwort setzt auf dem Server: docker exec -it hapm hapm-admin reset-password <e-mail>':
    'Resetting by email is not set up on this installation. To set a new password on the server, run: docker exec -it hapm hapm-admin reset-password <email>',
  'Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.':
    'The link is invalid or has expired. Please request a new one.',
  'Der Link und das neue Passwort sind erforderlich.': 'The link and the new password are required.',
  'Der zweite Faktor ist in dieser Sitzung schon bestätigt.': 'The second factor is already confirmed in this session.',
  'Bitte geben Sie den 6-stelligen Code ein.': 'Please enter the 6-digit code.',
  'Der Code stimmt nicht. Bitte versuchen Sie es erneut.': 'The code is wrong. Please try again.',

  // Regeln für Passwörter und Konten (`lib/validation.ts`, `lib/auth/users.ts`)
  'Das Passwort muss mindestens 10 Zeichen lang sein.': 'The password must be at least 10 characters long.',
  'Das Passwort muss mindestens einen Großbuchstaben enthalten.': 'The password must contain at least one uppercase letter.',
  'Das Passwort muss mindestens einen Kleinbuchstaben enthalten.': 'The password must contain at least one lowercase letter.',
  'Das Passwort muss mindestens eine Zahl enthalten.': 'The password must contain at least one digit.',
  'Das Passwort ist zu lang.': 'The password is too long.',
  'Das Passwort stimmt nicht.': 'The password is wrong.',
  'Die E-Mail-Adresse ist ungültig.': 'The email address is invalid.',
  'Der Name fehlt oder ist zu lang.': 'The name is missing or too long.',
  'Für diese E-Mail-Adresse gibt es schon ein Konto.': 'An account with this email address already exists.',
  'Das eigene Konto lässt sich nicht löschen.': 'You cannot delete your own account.',
  'Das letzte Konto lässt sich nicht löschen.': 'The last account cannot be deleted.',
  'Dieses Konto gibt es nicht mehr.': 'This account no longer exists.',

  // Fehler des Anmeldedienstes (`lib/auth/errors.ts`)
  'Die Sitzung ist abgelaufen. Bitte melden Sie sich neu an.': 'The session has expired. Please sign in again.',
  'Die Anfrage an das Gerät ist abgelaufen. Bitte versuchen Sie es noch einmal.':
    'The request to the device has expired. Please try again.',
  'Der Anmeldedienst hat die Anfrage abgelehnt.': 'The sign-in service rejected the request.',

  // Einrichtung des zweiten Faktors (`ui/auth/TwoFactorSetup.tsx`)
  'Zwei-Faktor-Authentifizierung einrichten': 'Set up two-factor authentication',
  'Zur Sicherheit Ihres Kontos ist die Zwei-Faktor-Authentifizierung (2FA) erforderlich.':
    'Two-factor authentication (2FA) is required to secure your account.',
  'Mit der Zwei-Faktor-Authentifizierung (2FA) braucht die Anmeldung zusätzlich einen Code von Ihrem Handy.':
    'With two-factor authentication (2FA), signing in also requires a code from your phone.',
  'Sie benötigen eine Authenticator-App wie:': 'You need an authenticator app such as:',
  'Einrichtung starten': 'Start setup',
  'QR-Code wird generiert...': 'Generating QR code...',
  'Scannen Sie den QR-Code mit Ihrer Authenticator-App oder geben Sie den Code manuell ein.':
    'Scan the QR code with your authenticator app or enter the code manually.',
  '2FA QR-Code': '2FA QR code',
  'Code kopieren': 'Copy code',
  'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein, um die Einrichtung abzuschließen.':
    'Enter the 6-digit code from your authenticator app to finish setup.',
  'Aktivieren': 'Activate',
  'Wiederherstellungscodes speichern': 'Save recovery codes',
  'Mit diesen Codes können Sie sich anmelden, falls Sie den Zugriff auf Ihre Authenticator-App verlieren. Jeder Code ist einmal verwendbar und wird {onlyNow} angezeigt.':
    'Use these codes to sign in if you lose access to your authenticator app. Each code works once and is shown {onlyNow}.',
  'nur jetzt': 'only now',
  'Codes gespeichert': 'Codes saved',
  '2FA erfolgreich aktiviert!': '2FA activated!',
  'Sie werden weitergeleitet...': 'Redirecting...',
  'Fehler bei der Einrichtung': 'Setup failed',
  'Verifizierung fehlgeschlagen': 'Verification failed',
  'Die Einrichtung ließ sich nicht starten.': 'Setup could not be started.',
};
