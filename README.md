# HAPM

Eine Weboberfläche für HAProxy. Ein Server, ein `docker compose up -d`, danach
legt man Domains im Browser an. HAProxy, die Grundkonfiguration und die
Zertifikate von Let's Encrypt richtet HAPM selbst ein.

## Was es kann

- **Reverse-Proxy:** eine oder mehrere Domains auf ein Ziel, mit Zertifikat,
  Healthcheck und Pfad-Regeln (dieselbe Domain, ein anderer Port).
- **Lastverteilung:** mehrere Ziele, Verteilverfahren, Gewichtung,
  Sitzungsbindung.
- **HTTP-Weiterleitung:** eine Domain antwortet mit 301 oder 302.
- **TCP-Weiterleitung:** ein Port des Servers, durchgereicht an ein Ziel
  dahinter, auf Wunsch nur für bestimmte Absender.
- **Gruppen:** Ziele stehen in Gruppen, etwa „Websites" und „Intern". Jede
  Gruppe hat ihre eigene Seite.
- **Import:** eine bestehende haproxy.cfg einlesen, in einer Vorschau
  auswählen und die Einträge übernehmen. Was sich nicht genauso abbilden lässt,
  steht mit Zeile und Grund daneben.
- **Einrichtung mit Assistent:** Konto, Art der Installation, DNS-Anbieter und
  die Adresse der Oberfläche. Am Ende ist HAPM selbst per HTTPS erreichbar.
- **Zertifikate:** Let's Encrypt über acme.sh, automatisch erneuert. Wildcards
  über DNS-01 (Hetzner oder Cloudflare). Für Server, die nur im eigenen Netz
  stehen, läuft jedes Zertifikat über DNS-01.
- **Sperren:** einzelne Domains nur für bestimmte Adressen oder hinter einer
  Passwortabfrage, die HAProxy selbst ausliefert.
- **Fehlerseiten:** Farben, Logo, Name, Fußzeile und Texte der Fehlerseiten und
  der Passwortabfrage einstellen, mit Vorschau der Seite, wie HAProxy sie
  ausliefert.
- **DNS:** Zonen bei Cloudflare und Hetzner anbinden. HAPM legt damit den
  Eintrag zu einem Ziel gleich mit an. Alle übrigen Einträge verwaltet man beim
  Anbieter.
- **Statistik:** Anfragen, Statusklassen, Antwortzeiten und Datenmenge aus
  HAProxy selbst, Herkunft und Pfade aus dem Zugriffsprotokoll. Die Länder
  werden auf dem Server bestimmt, keine Adresse geht an einen Dritten.
- **Updates:** HAPM meldet neue Abbilder von HAProxy und von sich selbst sowie
  ein neues acme.sh und spielt sie auf Klick ein. Vor dem Tausch prüft das neue
  HAProxy die vorhandene Konfiguration. Startet es nicht, läuft das alte weiter.
- **Benachrichtigungen:** Mails über ein eigenes SMTP-Konto, wenn HAProxy nicht
  läuft, ein Ziel nicht mehr antwortet, ein Zertifikat abläuft oder sich nicht
  erneuern lässt, ein Vorgang, ein Update oder eine Sicherung scheitert. Jedes
  Ereignis lässt sich abschalten.
- **Anmeldung:** Konten mit Passwort, auf Wunsch mit zweitem Faktor (Code aus
  einer Authenticator-App) und mit Passkeys. Passkeys setzen voraus, dass die
  Adresse von HAPM und ein SMTP-Konto eingerichtet sind.
- **Sprache:** Oberfläche auf Deutsch und Englisch, je Konto wählbar. Ohne
  Wahl gilt die Sprache des Browsers.
- **Historie:** jeder Vorgang mit seinen Schritten, wer ihn ausgelöst hat und
  wie er ausging.
- **API:** dieselben Vorgänge für Skripte und andere Dienste, mit Token.

Die Wahrheit ist immer `haproxy.cfg`. HAPM liest die Datei bei jedem Aufruf und
schreibt nur zwischen seine Marker. Wer von Hand etwas daneben einträgt, behält
es: Einträge, die HAPM nicht vollständig versteht, zeigt es an und fasst sie
nicht an.

## Installation

Voraussetzung: ein Linux-Server, auf dem die Ports 80 und 443 frei und von außen
erreichbar sind. Für HTTP/3 zusätzlich 443 über UDP.

### Mit dem Installationsskript

Auf einem frischen Debian oder Ubuntu, als root:

```bash
curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh
```

Das Skript installiert Docker samt Compose-Plugin, wenn es fehlt, fragt nach dem
Ordner der Installation (Vorgabe `/opt/hapm`), holt `docker-compose.yml`,
startet HAPM und nennt am Ende die Adresse der Oberfläche. Lauscht auf Port 80
oder 443 schon ein anderer Webserver, bricht es ab und nennt ihn. Ein zweiter
Lauf holt neue Abbilder und startet neu, ohne Daten oder Einstellungen
anzufassen.

Alles liegt in einem Ordner: `docker-compose.yml` und `.env` in `/opt/hapm`,
die Daten (Konfiguration, Zertifikate, Datenbank) darunter in `data/`. Beides
lässt sich angeben:

| Angabe | Variable | Vorgabe | Bedeutung |
|---|---|---|---|
| `--dir ORDNER` | `HAPM_DIR` | `/opt/hapm` | Ordner der Installation |
| `--storage ORDNER` | `HAPM_STORAGE` | `<dir>/data` | Ordner der Daten, wenn sie woanders liegen sollen, etwa auf einer eigenen Platte |
| `--port PORT` | `HAPM_PORT` | `7080` | Port der Oberfläche |
| `--image ABBILD` | `HAPM_IMAGE` | siehe `docker-compose.yml` | ein anderes Abbild von HAPM |
| `--force` | `HAPM_FORCE=1` | | auch starten, wenn Port 80 oder 443 belegt ist |
| `--yes` | `HAPM_YES=1` | | nichts nachfragen, die Vorgaben nehmen |

Mit einer Angabe:

```bash
curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh -s -- --dir /srv/hapm --port 9000
```

Wo die Daten liegen, entscheidet die erste Installation. Ein späterer Lauf
ändert das nicht. Zum Umziehen: `docker compose down`, den Ordner verschieben,
`HAPM_STORAGE` in `.env` ändern, `docker compose up -d`.

### Wieder entfernen

```bash
sh /opt/hapm/install.sh --uninstall
```

Das entfernt alles, was zu HAPM gehört: die Container, ihre Abbilder, die Daten
und den Ordner der Installation. Vorher zeigt das Skript, was es entfernt, und
fragt nach. Docker und alle anderen Container bleiben. Ein Abbild, das ein
anderer Container braucht, bleibt ebenfalls, und Sicherungen in einem eigenen
Ordner fasst das Skript nicht an. Mit `--keep-data` bleiben die Daten liegen,
mit `--yes` entfällt die Rückfrage.

### Von Hand auf einem frischen Debian

Dieselben Schritte einzeln, als root. Zuerst Docker aus der Paketquelle von
Docker:

```bash
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Unter Ubuntu steht in beiden Adressen `ubuntu` statt `debian`. Dann HAPM:

```bash
mkdir -p /opt/hapm && cd /opt/hapm
curl -fsSLO https://raw.githubusercontent.com/tjorvenhu/HAPM/main/docker-compose.yml
docker compose up -d
```

Die Daten liegen dann in `/opt/hapm/data`. Ein anderer Ordner: vor dem Start
`HAPM_STORAGE=/pfad` in eine Datei `.env` daneben schreiben.

### Nach der Installation

`http://<adresse-des-servers>:7080` öffnen. Ein Assistent führt in fünf
Schritten durch die Einrichtung:

1. **Konto.** Das erste Konto, mit dem HAPM verwaltet wird.
2. **Erreichbarkeit.** Steht der Server nur im eigenen Netz, oder ist er aus dem
   Internet erreichbar? Davon hängt ab, wie Zertifikate ausgestellt werden: aus
   dem Internet prüft Let's Encrypt jede Domain über Port 80. Im eigenen Netz
   erreicht Let's Encrypt den Server nicht, dort läuft jedes Zertifikat über den
   DNS-Anbieter.
3. **DNS-Anbieter.** Hetzner oder Cloudflare, mit einem API-Token. Im eigenen
   Netz ist der Schritt Pflicht. Bei einem Server im Internet lässt er sich
   überspringen: er wird nur für Wildcard-Zertifikate gebraucht.
4. **Adresse der Oberfläche.** Die Domain, unter der HAPM erreichbar sein soll,
   etwa `hapm.example.org`. HAPM zeigt den DNS-Eintrag dafür und legt ihn auf
   Knopfdruck beim DNS-Anbieter an. Die Zone erscheint danach auch unter „DNS".
   Steht der Server nur im eigenen Netz, gehört der Eintrag in den DNS-Server
   dieses Netzes (Router, Pi-hole, AdGuard Home). Mit einem DNS-Anbieter gibt es
   auf Wunsch gleich ein Wildcard-Zertifikat für `*.example.org`: weitere Ziele
   unter dieser Domain brauchen dann kein eigenes.
5. **Einrichten.** HAPM legt die Gruppe „HAPM" an, stellt das Zertifikat aus und
   trägt sich selbst als Ziel ein. Danach ist die Oberfläche per HTTPS
   erreichbar.

Scheitert ein Schritt, etwa an einem falschen Token oder einem fehlenden
DNS-Eintrag, bleibt das Konto bestehen. Die Eingaben lassen sich ändern und der
Schritt wiederholen, oder die Einrichtung wird später fortgesetzt: die Übersicht
erinnert daran. Ist die Einrichtung abgeschlossen oder übersprungen, ist sie
fertig. Art der Installation und Adresse lassen sich danach unter „Allgemein"
ändern.

Solange keine Adresse eingerichtet ist, spricht die Oberfläche unverschlüsselt
auf Port 7080. In jedem Fall sinnvoll:

1. Port 7080 in der Firewall nur für die eigene Adresse öffnen.
2. Sobald die Oberfläche über ihre Domain erreichbar ist: `HAPM_BIND=127.0.0.1`
   in `.env` setzen und `docker compose up -d` ausführen. Port 7080 ist danach
   von außen nicht mehr erreichbar.

Weitere Ziele entstehen unter „Reverse-Proxy". Jedes Ziel gehört in eine Gruppe,
etwa „Websites" oder „Intern". Wer die Einrichtung überspringt, legt dort zuerst
eine Gruppe an: eine frische Installation hat keine.

### Einstellungen in `.env`

Alle Angaben sind freiwillig, siehe [`.env.example`](.env.example).

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `HAPM_PORT` | `7080` | Port der Oberfläche |
| `HAPM_BIND` | `0.0.0.0` | Adresse, auf der die Oberfläche lauscht. Mit `127.0.0.1` ist sie nur noch über HAProxy erreichbar |
| `HAPM_STORAGE` | `./data` | Ordner der Daten auf dem Server: Konfiguration, Zertifikate, Datenbank |
| `TZ` | `Europe/Berlin` | Zeitzone |
| `HAPM_ACME_SERVER` | `letsencrypt` | Zertifizierungsstelle. `letsencrypt_test` stellt Testzertifikate aus und schont das Kontingent |
| `HAPROXY_IMAGE` | `haproxy:lts` | Abbild von HAProxy. `haproxy:latest` folgt dem neuesten Zweig |
| `HAPM_IMAGE` | `ghcr.io/tjorvenhu/hapm:latest` | Abbild von HAPM |

## Was man wissen sollte

- **HAPM und HAProxy laufen im Netz des Hosts.** Das braucht HAProxy für
  TCP-Weiterleitungen auf beliebigen Ports. Es geht nur unter Linux.
- **Die Datenbank ist ein dritter Container** (`postgres:17-alpine`). Er hat
  kein Netz und keinen Port: HAPM erreicht ihn über einen Unix-Socket in einem
  geteilten Ordner. Die Hauptversion steht fest, ein Wechsel auf die nächste
  braucht einen Umzug der Daten.
- **Alle Daten liegen in einem Ordner auf dem Server** (`data/` neben
  `docker-compose.yml`, oder `HAPM_STORAGE`). Dort liegen private Schlüssel.
  Das Installationsskript legt den Ordner so an, dass nur root ihn lesen kann.
- **HAPM bindet den Docker-Socket ein.** Darüber prüft es die Konfiguration im
  HAProxy-Container, liest dessen Log und spielt Updates ein. Der Socket gibt
  vollen Zugriff auf Docker. Wer sich an HAPM anmelden kann, hat damit Zugriff
  auf den Server.
- **Eine Firewall öffnet HAPM nicht.** Eine TCP-Weiterleitung auf Port 5432 ist
  von außen erst erreichbar, wenn die Firewall des Servers und die des Anbieters
  den Port durchlassen.
- **Gesichert wird erst, wenn ein Ordner eingestellt ist** (unter „Sicherung"),
  täglich oder von Hand über „Jetzt sichern". Das Archiv enthält private
  Schlüssel und ist nicht verschlüsselt.
- **Passwort vergessen:** Sind die Adresse von HAPM und ein SMTP-Konto
  eingerichtet, schickt die Anmeldeseite einen Link per Mail. Sonst, und wenn
  der zweite Faktor verloren ist, setzt auf dem Server
  `docker exec -it hapm hapm-admin reset-password <e-mail>` ein neues Passwort,
  schaltet den zweiten Faktor des Kontos ab und entfernt seine Passkeys.

## Sicherung zurückspielen

Unter „Sicherung" schreibt HAPM täglich oder auf Knopfdruck ein Archiv in einen
Ordner auf dem Server: Datenbank, Schlüssel, `/etc/haproxy` mit Zertifikaten,
acme.sh.

**Über die Oberfläche:** auf derselben Seite, Karte „Sicherung zurückspielen".
Ein Archiv aus dem Ordner wählen oder eines hochladen (etwa beim Umzug von
einem anderen Server, auf ein frisch installiertes HAPM). HAPM prüft es und
zeigt Zeitpunkt, Fassung und Inhalt. Nach Passwort und Bestätigung sichert es
zuerst den aktuellen Stand (in den Ordner als `…-vor-ruecksicherung.tar.gz`,
ohne Ordner nach `data/hapm/hapm-before-restore.tar.gz`), hält sich an,
spielt Datenbank, Schlüssel, HAProxy und acme.sh ein, lässt HAProxy die
Konfiguration prüfen und neu laden und startet wieder. Scheitert ein Schritt,
kommt der alte Stand zurück. Danach melden Sie sich mit einem Konto aus der
Sicherung an. Der Ablauf im Einzelnen steht in
[`docs/betrieb.md`](docs/betrieb.md), Abschnitt „Zurückspielen".

**Von Hand**, wenn HAPM nicht läuft: auf einem Server mit Docker, auf dem HAPM
noch nicht läuft. In einem leeren Ordner mit `docker-compose.yml` (hier
`/opt/hapm`, mit `/srv/hapm-backup` als Ordner der Sicherungen):

```bash
cd /opt/hapm

# 1. Das Archiv auspacken
mkdir /tmp/hapm-restore
tar -xzf /srv/hapm-backup/hapm-backup-JJJJMMTT-HHMMSS.tar.gz -C /tmp/hapm-restore

# 2. Nur die Datenbank starten und einspielen
docker compose up -d --wait postgres
docker exec -i hapm-postgres psql -U hapm -d hapm -q -v ON_ERROR_STOP=1 < /tmp/hapm-restore/database.sql

# 3. Schlüssel, HAProxy und acme.sh in den Ordner der Daten legen
mkdir -p data/hapm data/haproxy data/acme
cp -a /tmp/hapm-restore/data/. data/hapm/
cp -a /tmp/hapm-restore/haproxy/. data/haproxy/
cp -a /tmp/hapm-restore/.acme.sh/. data/acme/
rm -rf /tmp/hapm-restore

# 4. Starten
docker compose up -d
```

Danach sind Konten, Einstellungen, Ziele und Zertifikate wieder da.

## Aktualisieren

Unter „Updates" in der Oberfläche, oder von Hand:

```bash
docker compose pull && docker compose up -d
```

## Entwickeln

Gebraucht werden Node.js 24, pnpm und Docker.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
docker compose -f docker-compose.dev.yml up -d --build
```

Die Tests gegen die Datenbank laufen nur mit einem Postgres, sonst werden sie
übersprungen:

```bash
docker run -d --rm --name hapm-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
```

Die dritte Zeile baut das Abbild und startet den ganzen Stack lokal, auch unter
Docker Desktop: Oberfläche auf `http://localhost:7080`, HAProxy auf den Ports
8080 und 8443. Bauen braucht kein Token und kein Secret.

Wie die Teile zusammenhängen, steht in [`docs/betrieb.md`](docs/betrieb.md). Die
Regeln des Reverse-Proxy-Teils und ihre Begründungen stehen in
[`docs/reverse-proxy.md`](docs/reverse-proxy.md), die API in
[`docs/reverse-proxy-api.md`](docs/reverse-proxy-api.md).

## Auf einem Server ausprobieren, bevor es ein Abbild gibt

Solange kein Abbild veröffentlicht ist (oder um einen eigenen Stand zu testen),
kommt das Abbild vom eigenen Rechner. Dort bauen und über SSH auf den Server
legen:

```bash
docker build -t hapm:test .
docker save hapm:test | gzip | ssh root@<server> 'gunzip | docker load'
```

Das Abbild muss zur Architektur des Servers passen (auf einem ARM-Rechner für
einen gewöhnlichen Server mit `--platform linux/amd64` bauen). Dann auf dem
Server, mit `install.sh` und `docker-compose.yml` aus dem Repository daneben:

```bash
scp install.sh docker-compose.yml root@<server>:/root/
ssh root@<server> 'HAPM_IMAGE=hapm:test HAPM_SOURCE=file:///root sh /root/install.sh'
```

`HAPM_SOURCE` sagt dem Skript, woher `docker-compose.yml` kommt, hier aus dem
Ordner `/root`. Unter „Updates" steht für HAPM dann „Unbekannt": ein lokal
geladenes Abbild liegt in keiner Registry.

## Das Abbild veröffentlichen

Das Abbild baut GitHub selbst (`.github/workflows/image.yml`) und legt es in die
Registry von GitHub (GHCR). Es braucht dafür kein Secret.

1. Das Repository zu GitHub pushen. Jeder Push auf `main` prüft den Code (Lint,
   Typen, Tests) und baut danach `ghcr.io/tjorvenhu/hapm:latest` für amd64 und
   arm64.
2. **Einmalig:** Ein neues Paket ist bei GitHub zuerst privat. Unter
   github.com → Profil → „Packages" → `hapm` → „Package settings" → „Change
   visibility" auf „Public" stellen. Danach kann jeder das Abbild ohne Anmeldung
   holen.
3. Eine Fassung mit Nummer entsteht aus einem Tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

   Das ergibt zusätzlich `ghcr.io/tjorvenhu/hapm:0.2.0` und `:0.2`.

Wer HAPM installiert hat, bekommt ein neues Abbild unter „Updates" angezeigt.
## Lizenz

Copyright (C) 2026 Tjorven Hüther

HAPM ist freie Software unter der GNU Affero General Public License, Version 3
(AGPL-3.0). Der Text steht in [`LICENSE`](LICENSE). Das heißt in Kürze: jeder darf
HAPM benutzen, ändern und weitergeben. Wer eine geänderte Fassung weitergibt oder
anderen über ein Netz zur Benutzung anbietet, muss ihnen den Quelltext dieser
Fassung unter derselben Lizenz zugänglich machen. Eine Gewährleistung gibt es
nicht.

## Lizenzen Dritter

- Die mitgelieferte Länder-Tabelle stammt von [DB-IP](https://db-ip.com)
  („IP to Country Lite", CC BY 4.0). Neue Stände holt HAPM selbst von dort.
- Die Flaggen stammen aus [`flag-icons`](https://github.com/lipis/flag-icons)
  (MIT).
- Die Zeichen von Hetzner und Cloudflare stammen aus
  [Simple Icons](https://simpleicons.org) (CC0). Die Marken gehören ihren
  Inhabern, HAPM steht mit keinem der beiden in Verbindung.
