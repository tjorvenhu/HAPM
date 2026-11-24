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
- **Zertifikate:** Let's Encrypt über acme.sh, automatisch erneuert. Wildcards
  über DNS-01 (Zugangsdaten des DNS-Anbieters in den Einstellungen).
- **Sperren:** einzelne Domains nur für bestimmte Adressen oder hinter einer
  Passwortabfrage, die HAProxy selbst ausliefert.
- **DNS:** Zonen bei Cloudflare anbinden und den Eintrag zu einem Ziel gleich
  mit anlegen.
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

Das Skript installiert Docker samt Compose-Plugin, wenn es fehlt, legt
`/opt/hapm` an, holt `docker-compose.yml`, startet HAPM und nennt am Ende die
Adresse der Oberfläche. Lauscht auf Port 80 oder 443 schon ein anderer
Webserver, bricht es ab und nennt ihn. Ein zweiter Lauf holt neue Abbilder und
startet neu, ohne Daten oder Einstellungen anzufassen.

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `HAPM_DIR` | `/opt/hapm` | Ordner der Installation |
| `HAPM_PORT` | `7080` | Port der Oberfläche |
| `HAPM_IMAGE` | siehe `docker-compose.yml` | ein anderes Abbild von HAPM |
| `HAPM_FORCE` | | mit `1` auch starten, wenn Port 80 oder 443 belegt ist |

Mit einer Variable: `curl -fsSL … | HAPM_PORT=9000 sh`.

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

### Nach der Installation
Danach `http://<adresse-des-servers>:7080` öffnen. Die ersten Schritte:

1. Das erste Konto anlegen.
2. Unter „Reverse-Proxy" eine Gruppe anlegen. Eine Gruppe fasst Ziele zusammen,
   etwa „Websites" oder „Intern". Jedes Ziel gehört in eine Gruppe, eine frische
   Installation hat noch keine.
3. In der Gruppe das erste Ziel anlegen: die Domain und die Adresse des Dienstes
   dahinter. Das Zertifikat stellt HAPM dabei aus. Die Domain muss dafür schon
   auf den Server zeigen.

Die Oberfläche spricht zunächst unverschlüsselt auf Port 7080. Zwei Dinge sind
deshalb als Erstes sinnvoll:

1. Port 7080 in der Firewall nur für die eigene Adresse öffnen.
2. HAPM selbst als Ziel anlegen: eine Domain auf `127.0.0.1:7080`. Dann gibt es
   die Oberfläche über HTTPS mit Zertifikat, und sie lässt sich auf bestimmte
   Adressen beschränken. Mit `HAPM_BIND=127.0.0.1` in `.env` ist Port 7080 danach
   von außen nicht mehr erreichbar.

### Einstellungen in `.env`

Alle Angaben sind freiwillig, siehe [`.env.example`](.env.example).

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `HAPM_PORT` | `7080` | Port der Oberfläche |
| `HAPM_BIND` | `0.0.0.0` | Adresse, auf der die Oberfläche lauscht. Mit `127.0.0.1` ist sie nur noch über HAProxy erreichbar |
| `TZ` | `Europe/Berlin` | Zeitzone |
| `HAPM_ACME_SERVER` | `letsencrypt` | Zertifizierungsstelle. `letsencrypt_test` stellt Testzertifikate aus und schont das Kontingent |
| `HAPROXY_IMAGE` | `haproxy:lts` | Abbild von HAProxy. `haproxy:latest` folgt dem neuesten Zweig |
| `HAPM_IMAGE` | `ghcr.io/tjorvenhu/hapm:latest` | Abbild von HAPM |

## Was man wissen sollte

- **HAPM und HAProxy laufen im Netz des Hosts.** Das braucht HAProxy für
  TCP-Weiterleitungen auf beliebigen Ports. Es geht nur unter Linux.
- **Die Datenbank ist ein dritter Container** (`postgres:17-alpine`). Er hat
  kein Netz und keinen Port: HAPM erreicht ihn über einen Unix-Socket in einem
  geteilten Volume. Die Hauptversion steht fest, ein Wechsel auf die nächste
  braucht einen Umzug der Daten.
- **HAPM bindet den Docker-Socket ein.** Darüber prüft es die Konfiguration im
  HAProxy-Container, liest dessen Log und spielt Updates ein. Der Socket gibt
  vollen Zugriff auf Docker. Wer sich an HAPM anmelden kann, hat damit Zugriff
  auf den Server.
- **Eine Firewall öffnet HAPM nicht.** Eine TCP-Weiterleitung auf Port 5432 ist
  von außen erst erreichbar, wenn die Firewall des Servers und die des Anbieters
  den Port durchlassen.
- **Gesichert wird erst, wenn ein Ordner eingestellt ist** (unter „Sicherung").
  Das Archiv enthält private Schlüssel und ist nicht verschlüsselt.
- **Passwort vergessen:** Sind die Adresse von HAPM und ein SMTP-Konto
  eingerichtet, schickt die Anmeldeseite einen Link per Mail. Sonst, und wenn
  der zweite Faktor verloren ist, setzt auf dem Server
  `docker exec -it hapm hapm-admin reset-password <e-mail>` ein neues Passwort,
  schaltet den zweiten Faktor des Kontos ab und entfernt seine Passkeys.

## Sicherung zurückspielen

Unter „Sicherung" schreibt HAPM täglich oder auf Knopfdruck ein Archiv in einen
Ordner auf dem Server: Datenbank, Schlüssel, `/etc/haproxy` mit Zertifikaten,
acme.sh. Zurückgespielt wird von Hand, auf einem leeren Server mit
`docker-compose.yml` im Ordner `hapm` (hier mit `/srv/hapm-backup` als Ordner der
Sicherungen):

```bash
# 1. Alles anlegen, aber nur die Datenbank starten
docker compose up --no-start
docker compose start postgres

# 2. Die Datenbank einspielen
docker run --rm -v /srv/hapm-backup:/b:ro alpine tar -xzOf /b/hapm-backup-JJJJMMTT-HHMMSS.tar.gz ./database.sql \
  | docker exec -i hapm-postgres psql -U hapm -d hapm -q -v ON_ERROR_STOP=1

# 3. Schlüssel, HAProxy und acme.sh in die Volumes legen
docker run --rm -v /srv/hapm-backup:/b:ro \
  -v hapm_data:/data -v hapm_haproxy-etc:/etc/haproxy -v hapm_acme:/root/.acme.sh alpine sh -c \
  'mkdir /r && tar -xzf /b/hapm-backup-JJJJMMTT-HHMMSS.tar.gz -C /r && cp -a /r/data/. /data/ && cp -a /r/haproxy/. /etc/haproxy/ && cp -a /r/.acme.sh/. /root/.acme.sh/'

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
