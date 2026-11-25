---
title: "HAPM: Datenordner statt Volumes (HAPM_STORAGE), install.sh mit Deinstallation und Umzug, Prüfen unter Docker Desktop"
summary: "Wo die Daten der Produktion liegen, was install.sh beim Installieren, Umziehen und Entfernen tut, welche Fehler dabei aufgefallen sind und wie man das Skript lokal unter Docker Desktop durchspielt."
tags: ["docker","entscheidung","stolperfalle","build"]
updated: "2026-11-25T17:48:28.888Z"
---

## Entscheidung (November 2026)
`docker-compose.yml` (Produktion) bindet keine benannten Volumes mehr ein, sondern Unterordner von `${HAPM_STORAGE:-./data}`: `hapm/` (→ `/data`), `haproxy/` (→ `/etc/haproxy`), `acme/` (→ `/root/.acme.sh`), `postgres/`, `log/`, `run/haproxy/`, `run/postgres/` (Sockets). Grund: man soll angeben können, wo alles liegt, und alles restlos entfernen können. Vorgabe ist ein Ordner für alles: `/opt/hapm` mit `docker-compose.yml`, `.env`, `install.sh` und `data/`.

`docker-compose.dev.yml` und `scripts/verify/compose.yml` bleiben bei benannten Volumes: unter Docker Desktop trägt ein eingebundener Windows-Ordner keinen Unix-Socket.

Der Code hängt an keinem Volume-Namen: Sicherung (`VolumesFrom` des eigenen Containers), Konfigurationsprüfung (`Binds`/`Mounts` des HAProxy-Containers) und Update (`recreateBody` reicht `HostConfig` durch) laufen mit Ordnern unverändert. Geprüft: Start, Sicherung, Zurückspielen.

## install.sh
- Angaben: `--dir`, `--storage`, `--port`, `--image`, `--force`, `--yes`, `--uninstall`, `--keep-data` (und `HAPM_DIR`, `HAPM_STORAGE`, …). Über die Pipe: `curl … | sh -s -- --uninstall`.
- Fragt nach dem Ordner der Installation über `/dev/tty` (geht auch bei `curl | sh`), und zwar vor der Installation von Docker. Ohne Terminal oder mit `--yes` gilt die Vorgabe.
- Eine vorhandene Installation findet es über das Label `com.docker.compose.project.working_dir` am Container `hapm`.
- Wo die Daten liegen, entscheidet die erste Installation. Ein zweiter Lauf mit anderem `--storage` bricht ab (HAPM stünde sonst leer da).
- Legt eine Kopie von sich in den Ordner der Installation (`sh /opt/hapm/install.sh --uninstall`).
- Umzug aus 0.2.0: findet es das Volume `hapm_postgres-data` und noch kein `postgres/PG_VERSION` im Ordner, hält es den Stack an und kopiert die Volumes mit einem Helfer-Container hinein. Die Volumes bleiben liegen.
- `--uninstall` entfernt Container (Label `com.docker.compose.project=hapm`, dazu `hapm-updater`, `hapm-backup-*`, `hapm-check-*`), Abbilder, alte Volumes, die Unterordner der Daten und die Dateien der Installation. Docker nie. Im Datenordner löscht es nur die bekannten Unterordner und nur, wenn die Kennung `.hapm-storage` oder `hapm/secrets.json` da ist. Fremdes daneben (etwa ein Ordner mit Sicherungen) bleibt.

## Stolperfallen
- **`docker image rm name` löst nur den Namen, wenn das Abbild einen zweiten trägt**, auch wenn ein fremder Container unter diesem Namen läuft. Im Test verschwand so `haproxy:lts` vom Entwicklungs-Stack (das Abbild hieß auch `haproxy:3.4`). Deshalb fragt das Skript vorher `docker ps -aq --filter ancestor=<abbild>` und lässt das Abbild stehen, wenn noch ein Container daraus läuft.
- **Die Namen im Sicherungsarchiv sind uneinheitlich**: `./database.sql` und `./data/…` mit `./`, `haproxy/…` und `.acme.sh/…` ohne. `tar … ./haproxy` findet nichts. Die Anleitung packt deshalb das ganze Archiv nach `/tmp/hapm-restore` aus und kopiert von dort.
- Die Unterordner auf dem Server heißen anders als die Ordner im Archiv (`hapm/` statt `data/`, `acme/` statt `.acme.sh/`).
- Ein Pfad mit Doppelpunkt oder Leerzeichen bricht die Einbindung bzw. `.env`: `check_path` erlaubt nur `A-Za-z0-9/_.-` und keine Ordner des Systems.

## Lokal durchspielen (Docker Desktop, Windows)
Der Produktions-Stack läuft im Netz der Docker-VM. Ein Debian-Container mit dem Docker-Socket spielt den Server (`<repo>` ist der Ordner des Repositorys, unter Windows mit Laufwerksbuchstaben und Schrägstrichen, etwa `C:/…/HAPM`):
```bash
export MSYS_NO_PATHCONV=1
docker tag hapm:dev hapm:itest
docker run -d --name hapm-itest-box --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/hapm-itest:/opt/hapm-itest \
  -v "<repo>:/src:ro" debian:13 sleep infinity
docker exec hapm-itest-box sh -c 'HAPM_SOURCE=file:///src sh /src/install.sh --dir /opt/hapm-itest/app --port 7180 --image hapm:itest'
```
- `/opt/hapm-itest` ohne Laufwerksbuchstaben ist ein Pfad in der VM. Er muss im Debian-Container unter demselben Pfad eingebunden sein, sonst sieht das Skript andere Ordner als die Container des Stacks.
- Port 7180, weil 7080 dem Entwicklungs-Stack gehört. Erreichbar ist er nur aus der VM: Aufrufe über `docker exec hapm node /tmp/v/api.mjs …` (`scripts/verify/api.mjs` hineinkopieren, `HAPM_URL=http://127.0.0.1:7180`).
- Die Rückfragen ohne Terminal prüfen: `printf 'ja\n' | script -qec "sh /src/install.sh --uninstall" /dev/null`.
- Danach aufräumen: Box entfernen, `/opt/hapm-itest` in der VM über einen Alpine-Container löschen, `hapm:itest` wieder lösen.
- shellcheck: `docker run --rm -v "<repo>:/mnt:ro" koalaman/shellcheck:stable -s sh /mnt/install.sh`.
