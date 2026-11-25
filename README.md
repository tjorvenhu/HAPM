<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/hapm-logo-white.svg">
  <img src="public/hapm-logo.svg" alt="HAPM" width="280">
</picture>

### HAProxy mit Weboberfläche. Ein Server, ein Befehl, fertig.

Domains, Zertifikate und Weiterleitungen im Browser anlegen.<br>
HAProxy, Let's Encrypt und die Grundkonfiguration richtet HAPM selbst ein.

[![Build](https://github.com/tjorvenhu/HAPM/actions/workflows/image.yml/badge.svg?branch=main)](https://github.com/tjorvenhu/HAPM/actions/workflows/image.yml)
[![Lizenz: AGPL-3.0](https://img.shields.io/badge/Lizenz-AGPL--3.0-blue.svg)](LICENSE)
[![Abbild](https://img.shields.io/badge/ghcr.io-tjorvenhu%2Fhapm-2a7d5f?logo=docker&logoColor=white)](https://github.com/tjorvenhu/HAPM/pkgs/container/hapm)
![Plattformen](https://img.shields.io/badge/Plattform-linux%2Famd64%20%7C%20linux%2Farm64-555)
![HAProxy](https://img.shields.io/badge/HAProxy-LTS-1f6feb)

**Deutsch** · [English](README.en.md)

</div>

---

<p align="center">
  <img src="docs/images/einrichtung-zertifikate.jpg" alt="Der Einrichtungsassistent von HAPM, Schritt Zertifikate" width="49%">
  <img src="docs/images/fehlerseiten.jpg" alt="Die Fehlerseiten in HAPM mit Vorschau" width="49%">
</p>

## Inhalt

- [Was ist HAPM?](#was-ist-hapm)
- [Funktionen](#funktionen)
- [Schnellstart](#schnellstart)
- [Installation](#installation)
  - [Voraussetzungen](#voraussetzungen)
  - [Weg 1: Nur mit Docker Compose](#weg-1-nur-mit-docker-compose)
  - [Weg 2: Mit dem Installationsskript](#weg-2-mit-dem-installationsskript)
  - [Weg 3: Portainer, Dockge und andere Oberflächen](#weg-3-portainer-dockge-und-andere-oberflächen)
- [Erste Schritte](#erste-schritte)
- [Einstellungen](#einstellungen)
- [Mit Claude steuern (MCP)](#mit-claude-steuern-mcp)
- [Aufbau](#aufbau)
- [Betrieb](#betrieb)
- [Sicherheit](#sicherheit)
- [Fehlerbehebung](#fehlerbehebung)
- [Dokumentation](#dokumentation)
- [Mitmachen](#mitmachen)
- [Lizenz](#lizenz)

## Was ist HAPM?

HAPM ist eine Weboberfläche für [HAProxy](https://www.haproxy.org). Es läuft
als kleiner Docker-Stack auf dem Server, der Ihr Reverse-Proxy sein soll. Sie
legen dort im Browser fest, welche Domain wohin zeigt. HAPM schreibt die
Konfiguration, prüft sie mit HAProxy, lädt neu und holt die Zertifikate.

- **Kein Konfigurationswissen nötig.** Ein Assistent führt durch die
  Einrichtung. Am Ende ist HAPM selbst per HTTPS erreichbar.
- **`haproxy.cfg` bleibt die Wahrheit.** HAPM liest die Datei bei jedem Aufruf
  und schreibt nur zwischen seine eigenen Markierungen. Was Sie von Hand daneben
  eintragen, bleibt unangetastet.
- **Sicher geändert.** Jede Änderung prüft HAProxy, bevor sie gilt. Lehnt
  HAProxy sie ab, bleibt die alte Konfiguration aktiv.

## Funktionen

<table>
<tr>
<td width="50%" valign="top">

**Reverse-Proxy**
- Domains auf ein Ziel im Netz, mit Zertifikat
- Lastverteilung auf mehrere Ziele, mit Gewichtung und Sitzungsbindung
- HTTP-Weiterleitungen (301, 302)
- TCP-Weiterleitungen für beliebige Ports, etwa Datenbanken
- Pfad-Regeln: ein Pfad derselben Domain auf einen anderen Port
- Gruppen, etwa „Websites“ und „Intern“
- Backend-Server einmal hinterlegen und in jedem Ziel auswählen
- Import einer bestehenden `haproxy.cfg` mit Vorschau

</td>
<td width="50%" valign="top">

**Zertifikate und DNS**
- Let's Encrypt über acme.sh, automatisch erneuert
- Wildcard-Zertifikate über DNS-01
- Zonen bei Cloudflare und Hetzner anbinden
- DNS-Eintrag zu einem Ziel auf Wunsch gleich mit anlegen
- Im Dialog sehen, worauf eine Domain gerade zeigt
- Server nur im eigenen Netz: jedes Zertifikat über DNS-01
- Eigener ACME-Server, etwa step-ca im eigenen Netz
- Zertifikate hochladen, wenn HAPM nichts beantragen soll
- Eigener DNS-Server: HAPM nennt die Einträge, statt sie anzulegen

</td>
</tr>
<tr>
<td valign="top">

**Schutz und Darstellung**
- Domains nur für bestimmte IP-Adressen freigeben
- Passwortabfrage vor einer Domain, ausgeliefert von HAProxy selbst
- Fehlerseiten: Standard, selbst gestaltet oder eine eigene HTML-Datei
- Konten mit Passwort, zweitem Faktor und Passkeys

</td>
<td valign="top">

**Betrieb**
- Statistik: Anfragen, Statuscodes, Antwortzeiten, Länder
- Historie jedes Vorgangs mit seinen Schritten
- Das Log von HAProxy im Browser, mit Suche und Filter nach Statuscode
- Updates von HAPM, HAProxy und acme.sh auf Klick
- Tägliche Sicherung und Zurückspielen über die Oberfläche
- Mails bei Ausfällen, ablaufenden Zertifikaten und Fehlern
- API mit Token für Skripte und andere Dienste
- MCP-Server: HAPM aus Claude und anderen KI-Clients steuern
- Oberfläche auf Deutsch und Englisch

</td>
</tr>
</table>

## Schnellstart

Auf einem Linux-Server mit Docker, als root:

```bash
mkdir -p /opt/hapm && cd /opt/hapm
curl -fsSLO https://raw.githubusercontent.com/tjorvenhu/HAPM/main/docker-compose.yml
docker compose up -d
```

Dann im Browser `http://<IP-des-Servers>:7080` öffnen. Der Assistent führt
durch den Rest.

> [!TIP]
> Docker fehlt noch? Dann nehmen Sie das [Installationsskript](#weg-2-mit-dem-installationsskript).
> Es installiert Docker gleich mit.

## Installation

### Voraussetzungen

| Was | Warum |
|---|---|
| Ein **Linux**-Server, `amd64` oder `arm64` | HAPM und HAProxy laufen im Netz des Hosts. Das geht nur unter Linux, nicht mit Docker Desktop auf Mac oder Windows |
| **Docker** mit dem **Compose-Plugin** | `docker compose version` zeigt, ob es da ist |
| Ports **80** und **443** frei | Dort lauscht HAProxy. Für HTTP/3 zusätzlich 443 über UDP |
| Port **7080** erreichbar | Für die Einrichtung. Danach lässt er sich schließen, siehe [Sicherheit](#sicherheit) |
| Für Zertifikate von Let's Encrypt: Port 80 aus dem Internet erreichbar | Let's Encrypt prüft jede Domain über Port 80. Steht der Server nur im eigenen Netz, geht es über DNS-01 |

### Weg 1: Nur mit Docker Compose

Ohne Skript, mit genau einer Datei. Diese Anleitung passt auf jedes Linux mit
Docker.

**1. Docker installieren**, falls es fehlt. Die Anleitung für Ihre Distribution
steht unter [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).
Auf Debian und Ubuntu geht es auch mit dem offiziellen Skript von Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

**2. Einen Ordner für HAPM anlegen** und hineinwechseln:

```bash
mkdir -p /opt/hapm && cd /opt/hapm
```

**3. Die Datei `docker-compose.yml` holen:**

```bash
curl -fsSLO https://raw.githubusercontent.com/tjorvenhu/HAPM/main/docker-compose.yml
```

<details>
<summary><b>Ohne Download:</b> die Datei zum Einfügen</summary>

Legen Sie mit `nano docker-compose.yml` eine Datei an und fügen Sie das ein.
Die Kommentare der vollständigen Fassung stehen in
[`docker-compose.yml`](docker-compose.yml).

```yaml
name: hapm

services:
  hapm:
    image: ${HAPM_IMAGE:-ghcr.io/tjorvenhu/hapm:latest}
    container_name: hapm
    restart: unless-stopped
    network_mode: host
    environment:
      PORT: ${HAPM_PORT:-7080}
      HOSTNAME: ${HAPM_BIND:-0.0.0.0}
      TZ: ${TZ:-Europe/Berlin}
      HAPM_ACME_SERVER: ${HAPM_ACME_SERVER:-letsencrypt}
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ${HAPM_STORAGE:-./data}/hapm:/data
      - ${HAPM_STORAGE:-./data}/haproxy:/etc/haproxy
      - ${HAPM_STORAGE:-./data}/run/haproxy:/run/haproxy
      - ${HAPM_STORAGE:-./data}/log:/var/log/haproxy
      - ${HAPM_STORAGE:-./data}/acme:/root/.acme.sh
      - ${HAPM_STORAGE:-./data}/run/postgres:/var/run/postgresql
      - /var/run/docker.sock:/var/run/docker.sock

  postgres:
    image: postgres:17-alpine
    container_name: hapm-postgres
    restart: unless-stopped
    network_mode: none
    command: >-
      postgres -c listen_addresses='' -c shared_buffers=32MB -c max_connections=20
      -c max_worker_processes=4 -c max_parallel_workers=0 -c autovacuum_max_workers=1 -c jit=off
    environment:
      POSTGRES_DB: hapm
      POSTGRES_USER: hapm
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - ${HAPM_STORAGE:-./data}/postgres:/var/lib/postgresql/data
      - ${HAPM_STORAGE:-./data}/run/postgres:/var/run/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hapm -d hapm"]
      interval: 5s
      timeout: 5s
      retries: 12
      start_period: 20s

  haproxy:
    image: ${HAPROXY_IMAGE:-haproxy:lts}
    container_name: hapm-haproxy
    restart: unless-stopped
    network_mode: host
    user: root
    command: ["haproxy", "-f", "/etc/haproxy/haproxy.cfg", "-S", "/run/haproxy/master.sock"]
    depends_on:
      hapm:
        condition: service_healthy
    volumes:
      - ${HAPM_STORAGE:-./data}/haproxy:/etc/haproxy:ro
      - ${HAPM_STORAGE:-./data}/run/haproxy:/run/haproxy
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"
```

</details>

**4. Optional: Einstellungen in `.env`.** Ohne diese Datei gelten die
Vorgaben. Ein anderer Port der Oberfläche etwa:

```bash
echo "HAPM_PORT=9000" > .env
```

Alle Werte stehen unter [Einstellungen](#einstellungen).

**5. Starten:**

```bash
docker compose up -d
```

Beim ersten Start lädt Docker drei Abbilder und HAPM richtet HAProxy ein. Das
dauert etwa eine Minute. Ob alles läuft:

```bash
docker compose ps
```

Alle drei Container sollten `running` zeigen, `hapm` zusätzlich `healthy`.

**6. Im Browser öffnen:** `http://<IP-des-Servers>:7080`. Weiter geht es unter
[Erste Schritte](#erste-schritte).

> [!NOTE]
> Alle Daten liegen danach in `/opt/hapm/data`: Konfiguration, Zertifikate und
> Datenbank. Wer diesen Ordner sichert, hat alles.

### Weg 2: Mit dem Installationsskript

Für einen frischen Debian- oder Ubuntu-Server. Das Skript installiert Docker,
wenn es fehlt, prüft die Ports 80 und 443, holt `docker-compose.yml` und
startet HAPM. Als root:

```bash
curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh
```

Am Ende nennt es die Adresse der Oberfläche. Ein zweiter Lauf aktualisiert
HAPM, ohne Daten oder Einstellungen anzufassen.

<details>
<summary><b>Optionen des Skripts</b></summary>

| Option | Variable | Vorgabe | Bedeutung |
|---|---|---|---|
| `--dir ORDNER` | `HAPM_DIR` | `/opt/hapm` | Ordner der Installation |
| `--storage ORDNER` | `HAPM_STORAGE` | `<dir>/data` | Ordner der Daten, etwa auf einer eigenen Platte |
| `--port PORT` | `HAPM_PORT` | `7080` | Port der Oberfläche |
| `--image ABBILD` | `HAPM_IMAGE` | `ghcr.io/tjorvenhu/hapm:latest` | Ein anderes Abbild von HAPM |
| `--force` | `HAPM_FORCE=1` | | Auch starten, wenn Port 80 oder 443 belegt ist |
| `--yes` | `HAPM_YES=1` | | Nichts nachfragen, Vorgaben nehmen |
| `--uninstall` | | | HAPM wieder entfernen, siehe [Entfernen](#entfernen) |

Beispiel mit Optionen:

```bash
curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh -s -- --dir /srv/hapm --port 9000
```

Wo die Daten liegen, entscheidet die erste Installation. Ein späterer Lauf
ändert das nicht.

</details>

### Weg 3: Portainer, Dockge und andere Oberflächen

HAPM ist ein gewöhnlicher Compose-Stack. Legen Sie in Ihrer Oberfläche einen
neuen Stack an und fügen Sie den Inhalt von
[`docker-compose.yml`](docker-compose.yml) ein.

> [!IMPORTANT]
> Setzen Sie dabei die Variable `HAPM_STORAGE` auf einen festen Pfad, etwa
> `/opt/hapm/data`. Ohne sie legt die Oberfläche die Daten relativ zu ihrem
> eigenen Arbeitsordner ab, und dort sind sie schwer zu finden und zu sichern.

## Erste Schritte

Nach dem Start öffnet `http://<IP-des-Servers>:7080` den Assistenten. Er hat
sechs Schritte:

| Schritt | Was passiert |
|---|---|
| **1. Konto** | Sie legen das erste Konto an, mit dem Sie HAPM verwalten, und richten auf Wunsch gleich den zweiten Faktor ein. Passkeys kommen nach der Einrichtung unter „Konto“ dazu |
| **2. Erreichbarkeit** | Aus dem Internet erreichbar oder nur im eigenen Netz? Davon hängt ab, wie Zertifikate entstehen |
| **3. DNS** | Cloudflare oder Hetzner mit einem API-Token, dann legt HAPM DNS-Einträge selbst an. Oder **eigener DNS-Server**: HAPM nennt Ihnen jeden Eintrag, den Sie selbst setzen |
| **4. Zertifikate** | **Let's Encrypt** (Vorgabe), ein **eigener ACME-Server** mit Directory-URL, etwa step-ca im eigenen Netz, oder **hochladen**: HAPM beantragt nichts, Sie laden Zertifikat und Schlüssel hoch |
| **5. Adresse der Oberfläche** | Die Domain für HAPM selbst, etwa `hapm.example.org`. HAPM zeigt den nötigen DNS-Eintrag und legt ihn beim Anbieter an, wenn einer verbunden ist |
| **6. Einrichten** | HAPM stellt das Zertifikat aus und trägt sich selbst als Ziel ein. Danach ist die Oberfläche per HTTPS erreichbar |

<p align="center">
  <img src="docs/images/einrichtung-fertig.jpg" alt="Der letzte Schritt des Assistenten: HAPM ist eingerichtet" width="70%">
</p>

Scheitert ein Schritt, bleibt das Konto bestehen. Sie können die Eingaben
ändern und es erneut versuchen, oder später weitermachen: die Übersicht erinnert
daran.

**Danach:** Unter „Ziele“ legen Sie weitere Domains an. Jedes Ziel gehört in
eine Gruppe. Wer den Assistenten übersprungen hat, legt dort zuerst eine Gruppe
an.

> [!TIP]
> Zum Ausprobieren ohne das Kontingent von Let's Encrypt: `HAPM_ACME_SERVER=letsencrypt_test`
> in `.env` setzen. Die Zertifikate sind dann nicht gültig, aber jeder Ablauf
> lässt sich testen.

## Einstellungen

Alle Angaben in `.env` neben `docker-compose.yml` sind freiwillig. Eine Vorlage
mit Erklärungen steht in [`.env.example`](.env.example). Nach einer Änderung:
`docker compose up -d`.

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `HAPM_PORT` | `7080` | Port der Oberfläche |
| `HAPM_BIND` | `0.0.0.0` | Adresse, auf der die Oberfläche lauscht. Mit `127.0.0.1` ist sie nur noch über ihre Domain erreichbar |
| `HAPM_STORAGE` | `./data` | Ordner aller Daten auf dem Server |
| `TZ` | `Europe/Berlin` | Zeitzone für Anzeigen und geplante Updates |
| `HAPM_ACME_SERVER` | `letsencrypt` | Vorgabe der Zertifizierungsstelle: `letsencrypt`, `letsencrypt_test`, `zerossl` oder die Adresse eines ACME-Verzeichnisses. Ein eigener ACME-Server unter „Allgemein“ geht vor |
| `HAPROXY_IMAGE` | `haproxy:lts` | Abbild von HAProxy. `haproxy:latest` folgt dem neuesten Zweig |
| `HAPM_IMAGE` | `ghcr.io/tjorvenhu/hapm:latest` | Abbild von HAPM |

Alles andere stellen Sie in der Oberfläche ein, unter „Allgemein“ und
„Reverse-Proxy, Einstellungen“.

## Mit Claude steuern (MCP)

HAPM bringt einen MCP-Server mit. Damit lässt es sich aus Claude (Claude Code,
Claude Desktop, claude.ai) und anderen MCP-Clients steuern: Ziele,
TCP-Weiterleitungen und Gruppen lesen, anlegen, ändern und entfernen, dazu
Zertifikate, Systemstatus, Statistik und DNS-Zonen lesen.

1. In HAPM unter **„API und MCP“** einen API-Key anlegen. Es sind dieselben Keys
   wie für die API.
2. Den Client verbinden, für Claude Code etwa:

   ```bash
   claude mcp add --transport http hapm https://hapm.example.org/api/mcp \
     --header "Authorization: Bearer hapm_…"
   ```

Fertige Konfigurationen für weitere Clients stehen in HAPM auf derselben Seite
zum Kopieren, Einzelheiten in [`docs/mcp.md`](docs/mcp.md).

> [!WARNING]
> Jedes Werkzeug läuft mit allen Rechten des Keys und kann Ziele löschen.
> Geben Sie einen Key nur an Clients, denen Sie das zutrauen.

> [!NOTE]
> Claude Desktop und claude.ai verbinden sich aus der Cloud von Anthropic. HAPM
> muss dafür über HTTPS aus dem Internet erreichbar sein. Claude Code verbindet
> sich vom eigenen Rechner aus und reicht im eigenen Netz.

## Aufbau

Drei Container, ein Ordner für die Daten:

```mermaid
flowchart LR
    Besucher([Besucher]) -->|80, 443| HAProxy
    Admin([Sie im Browser]) -->|7080 oder über die eigene Domain| HAPM

    subgraph Server["Ihr Server"]
        HAProxy["hapm-haproxy<br/>offizielles HAProxy-Abbild"]
        HAPM["hapm<br/>Oberfläche, acme.sh"]
        Postgres[("hapm-postgres<br/>ohne Netz")]
        Daten[("data/")]
    end

    HAPM -->|Docker-Socket: prüfen, neu laden, Updates| HAProxy
    HAPM -->|Unix-Socket| Postgres
    HAProxy --> Ziele([Ihre Dienste])
    HAPM --- Daten
    HAProxy --- Daten
```

| Container | Aufgabe |
|---|---|
| `hapm` | Die Oberfläche. Schreibt `haproxy.cfg`, holt Zertifikate mit acme.sh, sammelt die Statistik |
| `hapm-haproxy` | Das offizielle HAProxy-Abbild. Nimmt den Verkehr auf Port 80 und 443 an |
| `hapm-postgres` | Die Datenbank: Konten, Einstellungen, Historie. Ohne Netz, nur über einen Unix-Socket erreichbar |

<details>
<summary><b>Was im Ordner <code>data/</code> liegt</b></summary>

| Unterordner | Inhalt |
|---|---|
| `hapm/` | Schlüssel und Geheimnisse von HAPM. Der Schlüssel darin darf sich nie ändern |
| `haproxy/` | `haproxy.cfg`, Zertifikate, Fehlerseiten |
| `acme/` | acme.sh mit Konto und Erneuerungseinträgen |
| `postgres/` | Die Datenbank |
| `log/` | Das Log von HAProxy, Quelle der Statistik |
| `run/` | Sockets von HAProxy und Postgres |

</details>

## Betrieb

### Aktualisieren

In der Oberfläche unter **„Updates“**. HAPM meldet neue Abbilder von sich
selbst, von HAProxy und ein neues acme.sh. Ein neues HAProxy prüft vor dem
Tausch die vorhandene Konfiguration. Startet es nicht, läuft das alte weiter.

Von Hand:

```bash
cd /opt/hapm
docker compose pull && docker compose up -d
```

### Sichern

Unter **„Sicherung“** einen Ordner auf dem Server einstellen. HAPM sichert dann
täglich oder auf Knopfdruck: Datenbank, Schlüssel, HAProxy mit Zertifikaten und
acme.sh.

> [!WARNING]
> Das Archiv enthält private Schlüssel und ist nicht verschlüsselt. Legen Sie
> es nur an einen Ort, auf den außer Ihnen niemand zugreift.

### Zurückspielen

**Über die Oberfläche:** Unter „Sicherung“, Karte „Sicherung zurückspielen“.
Ein Archiv auswählen oder hochladen, etwa beim Umzug auf einen neuen Server.
HAPM sichert vorher den aktuellen Stand und stellt ihn wieder her, wenn ein
Schritt scheitert.

<details>
<summary><b>Von Hand</b>, wenn HAPM nicht läuft</summary>

Auf einem Server mit Docker, in einem Ordner mit `docker-compose.yml`, in dem
HAPM noch nicht läuft. Hier `/opt/hapm`, die Sicherung liegt in
`/srv/hapm-backup`:

```bash
cd /opt/hapm

# 1. Archiv auspacken
mkdir /tmp/hapm-restore
tar -xzf /srv/hapm-backup/hapm-backup-JJJJMMTT-HHMMSS.tar.gz -C /tmp/hapm-restore

# 2. Nur die Datenbank starten und einspielen
docker compose up -d --wait postgres
docker exec -i hapm-postgres psql -U hapm -d hapm -q -v ON_ERROR_STOP=1 < /tmp/hapm-restore/database.sql

# 3. Schlüssel, HAProxy und acme.sh in den Datenordner legen
mkdir -p data/hapm data/haproxy data/acme
cp -a /tmp/hapm-restore/data/. data/hapm/
cp -a /tmp/hapm-restore/haproxy/. data/haproxy/
cp -a /tmp/hapm-restore/.acme.sh/. data/acme/
rm -rf /tmp/hapm-restore

# 4. Starten
docker compose up -d
```

Danach sind Konten, Einstellungen, Ziele und Zertifikate wieder da.

</details>

### Umziehen

Den Datenordner an einen anderen Ort legen:

```bash
cd /opt/hapm
docker compose down
mv data /srv/hapm-data
echo "HAPM_STORAGE=/srv/hapm-data" >> .env
docker compose up -d
```

Auf einen anderen Server geht es am einfachsten über eine Sicherung: dort HAPM
installieren und das Archiv unter „Sicherung“ hochladen.

### Passwort vergessen

Sind die Adresse von HAPM und ein SMTP-Konto eingerichtet, schickt die
Anmeldeseite einen Link per Mail. Sonst, und auch wenn der zweite Faktor
verloren ist, auf dem Server:

```bash
docker exec -it hapm hapm-admin reset-password admin@example.org
```

Das setzt ein neues Passwort, schaltet den zweiten Faktor des Kontos ab und
entfernt seine Passkeys. Alle Konten zeigt `docker exec -it hapm hapm-admin users`.

### Entfernen

**Mit dem Skript:** zeigt vorher, was es entfernt, und fragt nach. Mit
`--keep-data` bleiben die Daten liegen.

```bash
sh /opt/hapm/install.sh --uninstall
```

**Nur mit Compose:**

```bash
cd /opt/hapm
docker compose down
cd / && rm -rf /opt/hapm   # löscht auch alle Daten und Zertifikate
docker image prune -a      # optional: nicht mehr benutzte Abbilder entfernen
```

Docker selbst und andere Container bleiben in beiden Fällen unberührt.

## Sicherheit

Was Sie wissen sollten, bevor HAPM produktiv läuft:

1. **Port 7080 schließen.** Solange die Oberfläche keine eigene Domain hat,
   spricht sie unverschlüsselt auf Port 7080. Öffnen Sie ihn in der Firewall nur
   für Ihre eigene Adresse. Sobald HAPM über seine Domain erreichbar ist:

   ```bash
   echo "HAPM_BIND=127.0.0.1" >> .env && docker compose up -d
   ```

   Danach ist Port 7080 von außen nicht mehr erreichbar.
2. **Der Docker-Socket ist eingebunden.** Darüber prüft HAPM die Konfiguration,
   liest Logs und spielt Updates ein. Wer sich an HAPM anmelden kann, hat damit
   Zugriff auf den Server. Vergeben Sie Konten entsprechend und schalten Sie den
   zweiten Faktor ein.
3. **Der Datenordner enthält private Schlüssel.** Das Installationsskript legt
   ihn so an, dass nur root ihn lesen kann. Bei Weg 1 und 3 erledigt das ein
   Befehl nach dem ersten Start:

   ```bash
   chmod 700 /opt/hapm/data
   ```
4. **HAPM öffnet keine Firewall.** Eine TCP-Weiterleitung ist von außen erst
   erreichbar, wenn die Firewall des Servers und die Ihres Anbieters den Port
   durchlassen.

Eine Sicherheitslücke gefunden? Bitte nicht als öffentliches Issue melden,
sondern wie in [`SECURITY.md`](SECURITY.md) beschrieben.

## Fehlerbehebung

<details>
<summary><b>Port 80 oder 443 ist belegt</b></summary>

Ein anderer Webserver lauscht schon. Wer es ist:

```bash
ss -tlnp | grep -E ':(80|443)\s'
```

Häufig ist es ein vorinstalliertes Apache oder nginx. Beenden und abschalten,
etwa mit `systemctl disable --now apache2`. Danach `docker compose up -d`.

</details>

<details>
<summary><b>Die Oberfläche öffnet sich nicht</b></summary>

1. Laufen die Container? `docker compose ps`
2. Was sagt HAPM? `docker compose logs --tail 100 hapm`
3. Lässt die Firewall Port 7080 durch? Bei vielen Anbietern gibt es zusätzlich
   eine Firewall in deren Konsole.
4. Haben Sie `HAPM_BIND=127.0.0.1` gesetzt und die Domain geht nicht mehr?
   Dann die Zeile aus `.env` entfernen und `docker compose up -d`. Die
   Oberfläche ist danach wieder auf Port 7080 erreichbar.

</details>

<details>
<summary><b>Ein Zertifikat lässt sich nicht ausstellen</b></summary>

- **Zeigt die Domain auf diesen Server?** Der Dialog eines Ziels zeigt, worauf
  sie auflöst. Ein neuer DNS-Eintrag braucht manchmal einige Minuten.
- **Ist Port 80 aus dem Internet erreichbar?** Let's Encrypt prüft darüber.
  Steht der Server nur im eigenen Netz, gibt es drei Wege: einen DNS-Anbieter
  mit API (Cloudflare, Hetzner), einen eigenen ACME-Server im Netz oder
  hochgeladene Zertifikate. Den DNS-Anbieter tragen Sie unter „Reverse-Proxy,
  Einstellungen“ ein, ACME-Server und Herkunft der Zertifikate unter
  „Allgemein“, hochgeladen wird unter „Zertifikate“.
- **Zu viele Versuche?** Let's Encrypt begrenzt fehlgeschlagene Anträge. Zum
  Testen `HAPM_ACME_SERVER=letsencrypt_test` verwenden.
- Die Schritte jedes Vorgangs mit der genauen Meldung stehen unter „Logs“.

</details>

<details>
<summary><b>Läuft HAPM unter Docker Desktop auf Mac oder Windows?</b></summary>

Nein. HAPM und HAProxy brauchen das Netz des Hosts (`network_mode: host`), und
das gibt es nur unter Linux. Für die Entwicklung gibt es einen eigenen Stack,
der auch unter Docker Desktop läuft, siehe [`CONTRIBUTING.md`](CONTRIBUTING.md).

</details>

<details>
<summary><b>Ich habe schon eine <code>haproxy.cfg</code></b></summary>

Unter „Ziele“, „Konfiguration importieren“ lesen Sie sie ein. Eine Vorschau
zeigt, was übernommen wird. Was sich nicht genau abbilden lässt, steht mit Zeile
und Grund daneben.

</details>

## Dokumentation

Die ausführliche Dokumentation steht in [`docs/`](docs). Sie erklärt zu fast
jeder Entscheidung, warum sie so getroffen wurde.

| Dokument | Inhalt |
|---|---|
| [`docs/betrieb.md`](docs/betrieb.md) | Container, Volumes, Updates, Datenbank, Ersteinrichtung, Sicherung |
| [`docs/reverse-proxy.md`](docs/reverse-proxy.md) | Ziele, Gruppen, Zertifikate, Wildcards, Sperren, Fehlerseiten, Statistik, Import |
| [`docs/reverse-proxy-api.md`](docs/reverse-proxy-api.md) | Die API für Skripte und andere Dienste |
| [`docs/mcp.md`](docs/mcp.md) | Der MCP-Server für Claude und andere Clients |
| [`docs/dns.md`](docs/dns.md) | DNS bei Cloudflare und Hetzner |
| [`docs/i18n.md`](docs/i18n.md) | Übersetzungen der Oberfläche |

## Mitmachen

Fehler und Wünsche gerne als [Issue](https://github.com/tjorvenhu/HAPM/issues).
Wie man HAPM lokal entwickelt, testet und das Abbild baut, steht in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Lizenz

Copyright (C) 2026 Tjorven Hüther

HAPM ist freie Software unter der [GNU Affero General Public License,
Version 3](LICENSE) (AGPL-3.0). Jeder darf HAPM benutzen, ändern und
weitergeben. Wer eine geänderte Fassung weitergibt oder anderen über ein Netz
zur Benutzung anbietet, muss ihnen den Quelltext dieser Fassung unter derselben
Lizenz zugänglich machen. Eine Gewährleistung gibt es nicht.

<details>
<summary><b>Lizenzen Dritter</b></summary>

- Die mitgelieferte Länder-Tabelle stammt von [DB-IP](https://db-ip.com)
  („IP to Country Lite“, CC BY 4.0). Neue Stände holt HAPM selbst von dort.
- Die Flaggen stammen aus [`flag-icons`](https://github.com/lipis/flag-icons) (MIT).
- Die Zeichen von Hetzner und Cloudflare stammen aus
  [Simple Icons](https://simpleicons.org) (CC0). Die Marken gehören ihren
  Inhabern. HAPM steht mit keinem der beiden in Verbindung.

</details>
