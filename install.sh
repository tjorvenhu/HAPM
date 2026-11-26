#!/bin/sh
# HAPM auf einem Server installieren oder wieder entfernen.
#
#   curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh -s -- --dir /srv/hapm
#   curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh -s -- --uninstall
#
# Installiert Docker, wenn es fehlt (Debian und Ubuntu), dann HAPM. Das Skript
# lässt sich wiederholen: ein zweiter Lauf holt die neuen Abbilder und startet
# neu, ohne Daten anzufassen. `--uninstall` entfernt alles, was zu HAPM gehört.
# Docker selbst und andere Container bleiben.
#
# Aufbau der Datei:
#   1. Ausgabe        Farben, Überschriften, Schritte mit Fortschritt
#   2. Angaben        Optionen, Umgebung, Prüfung der Pfade
#   3. Docker         vorhanden oder aus der Paketquelle von Docker
#   4. Entfernen      --uninstall
#   5. Installieren   Ordner, Docker, Ports, Dateien, Umzug, Start

set -eu

SOURCE="${HAPM_SOURCE:-https://raw.githubusercontent.com/tjorvenhu/HAPM/main}"
DEFAULT_DIR=/opt/hapm
DEFAULT_PORT=7080
PROJECT=hapm
MARKER=.hapm-storage

# ══ 1. Ausgabe ════════════════════════════════════════════════════════════════

# Farben nur im Terminal. In einer Datei oder einem Protokoll stünden sonst
# Steuerzeichen.
BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  BLUE="$(printf '\033[34m')"
  RESET="$(printf '\033[0m')"
fi

# Überschrift des ganzen Laufs.
title() {
  printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"
}

# Überschrift eines Abschnitts.
step() {
  printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$1" "$RESET"
}

# Eine Zeile unter einem Abschnitt.
note() {
  printf '    %s\n' "$1"
}

# Etwas, das der Leser wissen sollte, das den Lauf aber nicht aufhält.
warn() {
  printf '    %sHinweis:%s %s\n' "$YELLOW" "$RESET" "$1"
}

# Die erste Zeile ist die Meldung, jede weitere steht eingerückt darunter.
fail() {
  printf '\n%s%sFehler:%s %s\n' "$RED" "$BOLD" "$RESET" "$1" >&2
  shift
  for line in "$@"; do
    printf '        %s\n' "$line" >&2
  done
  exit 1
}

# Eine Zeile je Eintrag, die Bezeichnung steht nur vor dem ersten:
#     Container     hapm
#                   hapm-haproxy
rows() {
  row_label="$1"
  printf '%s\n' "$2" | while IFS= read -r row_item; do
    [ -n "$row_item" ] || continue
    printf '    %-14s%s\n' "$row_label" "$row_item"
    row_label=""
  done
}

# Führt ein Kommando aus, das eine Weile braucht, und zeigt statt seiner Ausgabe
# einen Punkt je Sekunde. Die Ausgabe landet in $LOG und erscheint nur, wenn
# der Aufrufer sie nach einem Fehlschlag zeigt (`show_log`).
LOG=""
progress() {
  progress_label="$1"
  shift
  printf '    %s ' "$progress_label"
  "$@" >"$LOG" 2>&1 &
  progress_pid=$!
  while kill -0 "$progress_pid" 2>/dev/null; do
    printf '.'
    sleep 1
  done
  if wait "$progress_pid"; then
    printf ' %sfertig%s\n' "$GREEN" "$RESET"
    return 0
  fi
  printf ' %sfehlgeschlagen%s\n' "$RED" "$RESET"
  return 1
}

show_log() {
  tail -n 30 "$LOG" | sed 's/^/      /' >&2
}

usage() {
  cat <<'EOF'
HAPM installieren oder entfernen.

  sh install.sh [Optionen]

Installieren:
  --dir ORDNER       Ordner der Installation (Vorgabe /opt/hapm). Dort liegen
                     docker-compose.yml, .env und unter data/ alle Daten.
  --storage ORDNER   Ordner der Daten, wenn sie woanders liegen sollen als unter
                     <dir>/data: Konfiguration, Zertifikate, Datenbank.
  --port PORT        Port der Oberfläche (Vorgabe 7080)
  --image ABBILD     ein anderes Abbild von HAPM
  --no-crowdsec      CrowdSec (WAF) nicht mitinstallieren. Ohne die Angabe gehört
                     es zum Stack, prüft aber nichts, bis es in der Oberfläche
                     eingeschaltet wird.
  --crowdsec         CrowdSec wieder dazunehmen, wenn es abgewählt war
  --force            auch starten, wenn Port 80 oder 443 schon belegt ist
  --yes              nichts nachfragen, die Vorgaben nehmen

Entfernen:
  --uninstall        Container, Abbilder, Daten und Installation von HAPM
                     entfernen. Docker und andere Container bleiben.
  --keep-data        beim Entfernen die Daten liegen lassen
  --yes              ohne Rückfrage entfernen

Dieselben Angaben über die Umgebung: HAPM_DIR, HAPM_STORAGE, HAPM_PORT,
HAPM_IMAGE, HAPM_CROWDSEC=0 (wie --no-crowdsec), HAPM_FORCE=1, HAPM_YES=1. HAPM_SOURCE nennt, woher
docker-compose.yml kommt (Vorgabe das Repository auf GitHub).
EOF
}

# ══ 2. Angaben ════════════════════════════════════════════════════════════════

MODE=install
DIR="${HAPM_DIR:-}"
STORAGE="${HAPM_STORAGE:-}"
PORT="${HAPM_PORT:-}"
IMAGE="${HAPM_IMAGE:-}"
FORCE="${HAPM_FORCE:-0}"
YES="${HAPM_YES:-0}"
KEEP_DATA=0
# Leer heißt: nicht angegeben. Dann bleibt, was in .env steht, und eine neue
# .env bekommt CrowdSec.
CROWDSEC="${HAPM_CROWDSEC:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir | --storage | --port | --image)
      [ $# -ge 2 ] || fail "Nach $1 fehlt die Angabe."
      case "$1" in
        --dir)     DIR="$2" ;;
        --storage) STORAGE="$2" ;;
        --port)    PORT="$2" ;;
        --image)   IMAGE="$2" ;;
      esac
      shift 2
      ;;
    --dir=*)     DIR="${1#*=}";     shift ;;
    --storage=*) STORAGE="${1#*=}"; shift ;;
    --port=*)    PORT="${1#*=}";    shift ;;
    --image=*)   IMAGE="${1#*=}";   shift ;;
    --force)     FORCE=1;           shift ;;
    --yes | -y)  YES=1;             shift ;;
    --keep-data) KEEP_DATA=1;       shift ;;
    --no-crowdsec) CROWDSEC=0;      shift ;;
    --crowdsec)  CROWDSEC=1;        shift ;;
    --uninstall | --remove)
      MODE=uninstall
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      fail "Unbekannte Angabe: $1" "Alle Angaben zeigt: sh install.sh --help"
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (oder mit sudo)."

# Gefragt wird am Terminal, auch wenn das Skript über eine Pipe kommt
# (`curl … | sh`): die Standardeingabe ist dann das Skript selbst.
can_ask() {
  [ "$YES" != 1 ] && (: </dev/tty) 2>/dev/null
}

# Die Antwort steht danach in $ANSWER. Eine leere Eingabe nimmt die Vorgabe.
ask() {
  printf '%s%s%s [%s]: ' "$BOLD" "$1" "$RESET" "$2" >/dev/tty
  IFS= read -r ANSWER </dev/tty || ANSWER=""
  [ -n "$ANSWER" ] || ANSWER="$2"
}

# Das Ergebnis steht in $TRIMMED.
trim_slashes() {
  TRIMMED="$1"
  while [ "$TRIMMED" != / ] && [ "${TRIMMED%/}" != "$TRIMMED" ]; do
    TRIMMED="${TRIMMED%/}"
  done
}

# Der Pfad landet in .env und als Einbindung bei Docker, das den Doppelpunkt als
# Trenner liest. Und er wird beim Entfernen gelöscht: ein Ordner des Systems
# darf es nicht sein.
check_path() {
  case "$2" in
    /*) ;;
    *) fail "$1 muss ein Pfad sein, der mit / beginnt: $2" ;;
  esac

  case "$2" in
    *[!A-Za-z0-9/_.-]*)
      fail "$1 darf nur Buchstaben, Ziffern und / _ . - enthalten: $2"
      ;;
  esac

  case "$2/" in
    */../* | */./* | *//*)
      fail "$1 darf kein . oder .. und keinen doppelten Schrägstrich enthalten: $2"
      ;;
  esac

  case "$2" in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | \
    /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var | \
    /var/lib | /var/lib/docker | /var/log | /var/run | \
    /dev/* | /proc/* | /sys/* | /run/* | /var/run/* | /var/lib/docker/*)
      fail "$1 muss ein eigener Ordner sein, nicht $2." "Zum Beispiel ${2%/}/hapm."
      ;;
  esac
}

# Der Wert einer Zeile `NAME=wert` aus einer .env-Datei, leer, wenn sie fehlt.
env_value() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1
}

# Was angegeben ist, wird geprüft, bevor irgendetwas installiert wird.
if [ -n "$DIR" ]; then
  trim_slashes "$DIR"
  DIR="$TRIMMED"
  check_path "Der Ordner der Installation" "$DIR"
fi
if [ -n "$STORAGE" ]; then
  trim_slashes "$STORAGE"
  STORAGE="$TRIMMED"
  check_path "Der Ordner der Daten" "$STORAGE"
fi
case "${PORT:-$DEFAULT_PORT}" in
  *[!0-9]* | "") fail "Der Port muss eine Zahl sein: $PORT" ;;
esac

# ══ 3. Docker ═════════════════════════════════════════════════════════════════

OS_ID=""
OS_CODENAME=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
fi

have_docker() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

# Die Schritte aus der Anleitung von Docker für Debian und Ubuntu.
#
# Jeder Schritt bricht ausdrücklich ab (`|| return 1`): die Funktion läuft
# hinter `if ! progress …`, und dort gilt `set -e` nicht.
docker_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || return 1
  apt-get install -y -qq ca-certificates curl || return 1

  install -m 0755 -d /etc/apt/keyrings || return 1
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc || return 1
  chmod a+r /etc/apt/keyrings/docker.asc || return 1
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" \
    >/etc/apt/sources.list.d/docker.list || return 1

  apt-get update -qq || return 1
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker || true
  fi
}

install_docker() {
  case "$OS_ID" in
    debian | ubuntu) ;;
    *)
      fail "Docker fehlt, und dieses Skript installiert es nur unter Debian und Ubuntu." \
        "Bitte Docker samt Compose-Plugin von Hand installieren:" \
        "https://docs.docker.com/engine/install/" \
        "Danach das Skript noch einmal starten."
      ;;
  esac
  [ -n "$OS_CODENAME" ] \
    || fail "Die Fassung des Betriebssystems ließ sich nicht bestimmen (/etc/os-release)."

  if ! progress "Docker wird installiert" docker_packages; then
    show_log
    fail "Docker ließ sich nicht installieren."
  fi
  have_docker \
    || fail "Docker ist installiert, antwortet aber nicht." "Läuft der Dienst? systemctl status docker"
}

# Wo eine laufende Installation liegt, steht an ihrem Container.
installed_dir() {
  docker inspect \
    -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
    hapm 2>/dev/null || true
}

# ══ 4. Entfernen ══════════════════════════════════════════════════════════════

project_containers() {
  {
    docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"
    # Helfer, die HAPM für Updates, Prüfungen und Sicherungen selbst startet.
    docker ps -aq --filter 'name=^/?hapm-updater$'
    docker ps -aq --filter 'name=^/?hapm-(backup|check)-[0-9]+$'
  } 2>/dev/null | sort -u
}

container_names() {
  # shellcheck disable=SC2086
  docker inspect -f '{{.Name}}' $1 2>/dev/null | sed 's|^/||'
}

# Die Abbilder der Container, dazu die aus docker-compose.yml: ein Abbild kann
# geholt sein, ohne dass sein Container noch steht.
project_images() {
  {
    for id in $1; do
      docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true
    done
    if [ -f "$DIR/docker-compose.yml" ]; then
      (cd "$DIR" && docker compose config --images 2>/dev/null) || true
    fi
  } | sort -u
}

storage_is_ours() {
  [ -f "$1/$MARKER" ] || [ -f "$1/hapm/secrets.json" ]
}

remove_dir_if_empty() {
  [ -d "$1" ] || return 0
  if rmdir "$1" 2>/dev/null; then
    note "$1 entfernt."
    return 0
  fi
  note "$1 bleibt liegen, dort liegt noch etwas anderes:"
  # shellcheck disable=SC2012
  ls -A "$1" | head -n 10 | sed 's/^/      /'
}

uninstall() {
  title "HAPM entfernen"

  DOCKER=0
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    DOCKER=1
  fi

  # ── Wo liegt die Installation? ──
  if [ -z "$DIR" ] && [ "$DOCKER" = 1 ]; then
    DIR="$(installed_dir)"
  fi
  DIR="${DIR:-$DEFAULT_DIR}"
  trim_slashes "$DIR"
  DIR="$TRIMMED"
  check_path "Der Ordner der Installation" "$DIR"

  [ -n "$STORAGE" ] || STORAGE="$(env_value HAPM_STORAGE "$DIR/.env")"
  STORAGE="${STORAGE:-$DIR/data}"
  trim_slashes "$STORAGE"
  STORAGE="$TRIMMED"
  check_path "Der Ordner der Daten" "$STORAGE"

  # ── Was gehört dazu? ──
  CONTAINERS=""
  IMAGES=""
  VOLUMES=""
  NETWORKS=""
  if [ "$DOCKER" = 1 ]; then
    CONTAINERS="$(project_containers)"
    IMAGES="$(project_images "$CONTAINERS")"
    VOLUMES="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)"
    NETWORKS="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)"
  fi

  HAS_STORAGE=0
  if [ -d "$STORAGE" ] && storage_is_ours "$STORAGE"; then
    HAS_STORAGE=1
  fi
  HAS_DIR=0
  if [ -f "$DIR/docker-compose.yml" ] || [ -f "$DIR/.env" ]; then
    HAS_DIR=1
  fi

  if [ -z "$CONTAINERS$VOLUMES" ] && [ "$HAS_STORAGE" = 0 ] && [ "$HAS_DIR" = 0 ]; then
    printf '\nVon HAPM ist auf diesem Server nichts zu finden (gesucht in %s).\n' "$DIR"
    printf 'Liegt die Installation woanders: sh install.sh --uninstall --dir ORDNER\n'
    exit 0
  fi

  # ── Zeigen, was geschieht ──
  printf '\n  %sEntfernt wird%s\n' "$BOLD" "$RESET"
  if [ -n "$CONTAINERS" ]; then
    rows "Container" "$(container_names "$CONTAINERS")"
  fi
  if [ -n "$IMAGES" ]; then
    rows "Abbilder" "$IMAGES"
    printf '    %-14s%s(nur die, die kein anderer Container braucht)%s\n' "" "$DIM" "$RESET"
  fi
  if [ "$KEEP_DATA" != 1 ]; then
    if [ "$HAS_STORAGE" = 1 ]; then
      rows "Daten" "$STORAGE"
      printf '    %-14s%s(Konfiguration, Zertifikate, Datenbank)%s\n' "" "$DIM" "$RESET"
    fi
    if [ -n "$VOLUMES" ]; then
      rows "Volumes" "$VOLUMES"
    fi
  fi
  if [ "$HAS_DIR" = 1 ]; then
    rows "Installation" "$DIR"
    printf '    %-14s%s(docker-compose.yml, .env)%s\n' "" "$DIM" "$RESET"
  fi

  printf '\n  %sEs bleibt%s\n' "$BOLD" "$RESET"
  note "Docker und alle anderen Container"
  note "Sicherungen, die HAPM in einen eigenen Ordner geschrieben hat"
  if [ "$KEEP_DATA" = 1 ]; then
    if [ "$HAS_STORAGE" = 1 ]; then
      note "Die Daten in $STORAGE (--keep-data)"
    fi
    if [ -n "$VOLUMES" ]; then
      note "Die alten Docker-Volumes (--keep-data)"
    fi
  elif [ -d "$STORAGE" ] && [ "$HAS_STORAGE" = 0 ]; then
    note "$STORAGE: der Ordner trägt keine Kennung von HAPM. Bitte von Hand löschen."
  fi

  # ── Rückfrage ──
  if [ "$YES" != 1 ]; then
    can_ask || fail "Zum Entfernen ohne Rückfrage --yes angeben."
    printf '\n%sZum Entfernen "ja" eingeben:%s ' "$BOLD" "$RESET" >/dev/tty
    IFS= read -r ANSWER </dev/tty || ANSWER=""
    case "$ANSWER" in
      ja | Ja | JA) ;;
      *)
        printf 'Abgebrochen. Es wurde nichts entfernt.\n'
        exit 0
        ;;
    esac
  fi

  # ── Entfernen ──
  if [ -n "$CONTAINERS" ]; then
    step "Container"
    # Erst anhalten, damit Postgres sauber schließt. Wichtig mit --keep-data.
    # shellcheck disable=SC2086
    docker stop $CONTAINERS >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    docker rm -f $CONTAINERS >/dev/null 2>&1 || true
    note "Angehalten und entfernt."
  fi
  for network in $NETWORKS; do
    docker network rm "$network" >/dev/null 2>&1 || true
  done

  if [ -n "$IMAGES" ]; then
    step "Abbilder"
    for image in $IMAGES; do
      docker image inspect "$image" >/dev/null 2>&1 || continue
      # Vorher fragen statt es darauf ankommen zu lassen: trägt das Abbild noch
      # einen zweiten Namen, löst `docker image rm` diesen hier, auch wenn ein
      # fremder Container unter ihm läuft.
      if [ -n "$(docker ps -aq --filter "ancestor=$image" 2>/dev/null)" ]; then
        note "$image bleibt, ein anderer Container braucht es."
      elif docker image rm "$image" >/dev/null 2>&1; then
        note "$image entfernt."
      else
        note "$image ließ sich nicht entfernen und bleibt."
      fi
    done
  fi

  if [ "$KEEP_DATA" != 1 ] && { [ "$HAS_STORAGE" = 1 ] || [ -n "$VOLUMES" ]; }; then
    step "Daten"
    if [ "$HAS_STORAGE" = 1 ]; then
      # Nur die Ordner, die HAPM angelegt hat. Liegt daneben etwas anderes,
      # etwa ein Ordner mit Sicherungen, bleibt es liegen.
      for part in hapm haproxy acme postgres log run crowdsec; do
        rm -rf "${STORAGE:?}/$part"
      done
      rm -f "$STORAGE/$MARKER"
      remove_dir_if_empty "$STORAGE"
    fi
    for volume in $VOLUMES; do
      if docker volume rm "$volume" >/dev/null 2>&1; then
        note "Volume $volume entfernt."
      fi
    done
  fi

  if [ "$HAS_DIR" = 1 ]; then
    step "Installation"
    rm -f \
      "$DIR/docker-compose.yml" "$DIR/docker-compose.yml.neu" \
      "$DIR/.env" "$DIR/install.sh"
    remove_dir_if_empty "$DIR"
  fi

  printf '\n%s%sHAPM ist entfernt.%s Docker läuft weiter.\n\n' "$GREEN" "$BOLD" "$RESET"
  exit 0
}

[ "$MODE" = install ] || uninstall

# ══ 5. Installieren ═══════════════════════════════════════════════════════════

title "HAPM installieren"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# ── Der Ordner ────────────────────────────────────────────────────────────────
# Ohne Angabe: dort, wo HAPM schon läuft. Sonst die Vorgabe, auf Nachfrage.
# Gefragt wird als Erstes, nicht erst nach der Installation von Docker.
if [ -z "$DIR" ]; then
  DIR="$(installed_dir)"
fi
if [ -z "$DIR" ]; then
  DIR="$DEFAULT_DIR"
  if [ ! -f "$DIR/docker-compose.yml" ] && can_ask; then
    {
      printf '\nWohin soll HAPM installiert werden?\n'
      printf '%sDort liegen docker-compose.yml, .env und unter data/ alle Daten:%s\n' "$DIM" "$RESET"
      printf '%sKonfiguration, Zertifikate, Datenbank.%s\n\n' "$DIM" "$RESET"
    } >/dev/tty
    ask "Ordner" "$DIR"
    DIR="$ANSWER"
  fi
fi
trim_slashes "$DIR"
DIR="$TRIMMED"
check_path "Der Ordner der Installation" "$DIR"

EXISTING=0
if [ -f "$DIR/docker-compose.yml" ]; then
  EXISTING=1
fi

# Wo die Daten einer vorhandenen Installation liegen, ändert kein zweiter Lauf:
# HAPM fände sie sonst nicht wieder und sähe aus wie frisch installiert.
if [ "$EXISTING" = 1 ]; then
  CURRENT="$(env_value HAPM_STORAGE "$DIR/.env")"
  CURRENT="${CURRENT:-$DIR/data}"
  if [ -n "$STORAGE" ] && [ "$STORAGE" != "$CURRENT" ]; then
    fail "Die Daten dieser Installation liegen in $CURRENT." \
      "Zum Umziehen:" \
      "  cd $DIR && docker compose down" \
      "  den Ordner verschieben" \
      "  HAPM_STORAGE in $DIR/.env ändern" \
      "  docker compose up -d"
  fi
  STORAGE="$CURRENT"
fi
STORAGE="${STORAGE:-$DIR/data}"
trim_slashes "$STORAGE"
STORAGE="$TRIMMED"
check_path "Der Ordner der Daten" "$STORAGE"

# ── Docker ────────────────────────────────────────────────────────────────────
step "Docker"

HAD_CURL=1
command -v curl >/dev/null 2>&1 || HAD_CURL=0

if have_docker; then
  note "Vorhanden: $(docker --version)"
else
  install_docker
  note "$(docker --version)"
fi

if [ "$HAD_CURL" = 0 ] && ! command -v curl >/dev/null 2>&1; then
  apt-get install -y -qq curl >/dev/null 2>&1 \
    || fail "curl fehlt und ließ sich nicht installieren."
fi

docker info >/dev/null 2>&1 || fail "Der Docker-Dienst ist nicht erreichbar."

# ── Ports 80 und 443 ──────────────────────────────────────────────────────────
# HAProxy läuft im Netz des Servers und braucht beide. Lauscht dort schon ein
# anderer Webserver, startet HAProxy nicht, und das sähe aus wie ein Fehler von
# HAPM.
own_haproxy_running() {
  [ "$(docker inspect -f '{{.State.Running}}' hapm-haproxy 2>/dev/null || true)" = "true" ]
}

busy_ports() {
  for port in 80 443; do
    if ss -Hltn "sport = :$port" 2>/dev/null | grep -q .; then
      printf '%s ' "$port"
    fi
  done
}

if ! own_haproxy_running && command -v ss >/dev/null 2>&1; then
  BUSY="$(busy_ports)"
  if [ -n "$BUSY" ]; then
    step "Ports 80 und 443"
    warn "Auf diesem Server lauscht schon etwas auf Port ${BUSY% }:"
    for port in $BUSY; do
      ss -Hltnp "sport = :$port" 2>/dev/null | sed 's/^/      /'
    done
    if [ "$FORCE" != 1 ]; then
      fail "HAProxy braucht die Ports 80 und 443." \
        "Bitte den anderen Dienst anhalten (etwa nginx, Apache oder Caddy)" \
        "und das Skript noch einmal starten." \
        "Mit --force läuft es trotzdem weiter."
    fi
  fi
fi

# ── Dateien ───────────────────────────────────────────────────────────────────
step "Dateien in $DIR"
mkdir -p "$DIR"
cd "$DIR"

curl -fsSL "$SOURCE/docker-compose.yml" -o docker-compose.yml.neu \
  || fail "docker-compose.yml ließ sich nicht von $SOURCE holen."
mv docker-compose.yml.neu docker-compose.yml
note "docker-compose.yml geholt."

# Eine Kopie des Skripts, damit es zum Entfernen nicht noch einmal geholt
# werden muss.
if curl -fsSL "$SOURCE/install.sh" -o install.sh.neu 2>/dev/null; then
  mv install.sh.neu install.sh
else
  rm -f install.sh.neu
fi

server_timezone() {
  if [ -r /etc/timezone ]; then
    cat /etc/timezone
  else
    timedatectl show -p Timezone --value 2>/dev/null || true
  fi
}

# Die Einstellungen entstehen einmal. Ein späterer Lauf ändert sie nicht.
if [ ! -f .env ]; then
  PORT="${PORT:-$DEFAULT_PORT}"
  ZONE="$(server_timezone)"
  {
    printf 'HAPM_PORT=%s\n' "$PORT"
    printf 'HAPM_STORAGE=%s\n' "$STORAGE"
    [ -z "$ZONE" ] || printf 'TZ=%s\n' "$ZONE"
    [ -z "$IMAGE" ] || printf 'HAPM_IMAGE=%s\n' "$IMAGE"
    [ "$CROWDSEC" != 0 ] || printf 'HAPM_CROWDSEC_OFF=1\n'
  } >.env
  note ".env angelegt."
else
  note ".env gibt es schon und bleibt, wie sie ist."
  WANTED="$PORT"
  PORT="$(env_value HAPM_PORT .env)"
  PORT="${PORT:-$DEFAULT_PORT}"
  if [ -n "$WANTED" ] && [ "$WANTED" != "$PORT" ]; then
    warn "Der Port bleibt $PORT. Ändern: HAPM_PORT in $DIR/.env, dann docker compose up -d."
  fi
  if [ -z "$(env_value HAPM_STORAGE .env)" ]; then
    printf 'HAPM_STORAGE=%s\n' "$STORAGE" >>.env
    note "Der Ordner der Daten steht jetzt in .env."
  fi
fi

# CrowdSec an- oder abwählen. Abgewählt steht HAPM_CROWDSEC_OFF=1 in .env: dann
# sieht Compose die beiden Dienste gar nicht, holt ihre Abbilder nicht und legt
# keine Container an. Ohne Angabe bleibt .env, wie sie ist.
case "$CROWDSEC" in
  "" | 0 | 1) ;;
  *) fail "HAPM_CROWDSEC ist 0 oder 1, nicht $CROWDSEC." ;;
esac
# Eine Zeile HAPM_CROWDSEC=… aus einer früheren Fassung dieses Skripts.
if grep -q '^HAPM_CROWDSEC=' .env; then
  [ -n "$CROWDSEC" ] || CROWDSEC="$(env_value HAPM_CROWDSEC .env)"
  sed -i '/^HAPM_CROWDSEC=/d' .env
fi
if [ "$CROWDSEC" = 0 ] && ! grep -q '^HAPM_CROWDSEC_OFF=' .env; then
  printf 'HAPM_CROWDSEC_OFF=1\n' >>.env
elif [ "$CROWDSEC" = 1 ]; then
  sed -i '/^HAPM_CROWDSEC_OFF=/d' .env
fi
if [ -n "$(env_value HAPM_CROWDSEC_OFF .env)" ]; then
  CROWDSEC_OFF=1
  note "CrowdSec (WAF) ist abgewählt: weder Abbilder noch Container. Dazunehmen: sh install.sh --crowdsec"
else
  CROWDSEC_OFF=0
  note "CrowdSec (WAF) gehört dazu. Es prüft nichts, bis es in der Oberfläche eingeschaltet wird."
fi

mkdir -p "$STORAGE"
# Dort liegen private Schlüssel. Die Container bekommen ihre Unterordner
# einzeln eingebunden und brauchen den Zugang von außen nicht.
chmod 700 "$STORAGE"
# An dieser Kennung erkennt --uninstall, dass der Ordner HAPM gehört.
if [ ! -f "$STORAGE/$MARKER" ]; then
  printf 'Daten von HAPM. Angelegt von install.sh.\n' >"$STORAGE/$MARKER"
fi
note "Daten liegen in $STORAGE."

# ── Umzug aus den Volumes ─────────────────────────────────────────────────────
# Bis 0.2.0 lagen die Daten in Docker-Volumes. Die neue docker-compose.yml liest
# sie aus dem Ordner: ohne Umzug stünde HAPM leer da.
copy_volume() {
  docker run --rm --network none --entrypoint sh \
    -v "$1:/from:ro" -v "$2:/to" \
    "$3" -c 'cp -a /from/. /to/'
}

migrate_volumes() {
  docker volume inspect "${PROJECT}_postgres-data" >/dev/null 2>&1 || return 0
  [ ! -e "$STORAGE/postgres/PG_VERSION" ] || return 0

  step "Umzug aus den Docker-Volumes"
  HELPER="$(docker inspect -f '{{.Config.Image}}' hapm-postgres 2>/dev/null || true)"
  HELPER="${HELPER:-postgres:17-alpine}"
  docker stop hapm-haproxy hapm hapm-postgres >/dev/null 2>&1 || true

  for pair in data:hapm haproxy-etc:haproxy haproxy-log:log acme:acme postgres-data:postgres; do
    volume="${PROJECT}_${pair%%:*}"
    target="$STORAGE/${pair##*:}"
    docker volume inspect "$volume" >/dev/null 2>&1 || continue
    mkdir -p "$target"
    if ! copy_volume "$volume" "$target" "$HELPER" >"$LOG" 2>&1; then
      rm -rf "$target"
      show_log
      fail "Das Volume $volume ließ sich nicht nach $target kopieren." \
        "Die Volumes sind unverändert."
    fi
    note "$volume nach $target"
  done

  warn "Die alten Volumes bleiben liegen. Läuft HAPM danach wie gewohnt, räumt sie weg:"
  note "  docker volume ls -q --filter label=com.docker.compose.project=$PROJECT | xargs docker volume rm"
}
migrate_volumes

# ── Starten ───────────────────────────────────────────────────────────────────
step "HAPM starten"

if ! progress "Abbilder werden geholt" docker compose pull; then
  # Ein lokal gebautes Abbild (--image) liegt in keiner Registry.
  warn "Nicht alle Abbilder ließen sich holen. Es geht mit den vorhandenen weiter."
fi

# Abgewählt, aber von früher noch da: Compose sieht die Dienste nicht mehr und
# räumt ihre Container deshalb auch nicht weg. Nennt man sie ausdrücklich, geht es.
if [ "$CROWDSEC_OFF" = 1 ] && { docker inspect hapm-crowdsec >/dev/null 2>&1 || docker inspect hapm-crowdsec-bouncer >/dev/null 2>&1; }; then
  progress "CrowdSec wird entfernt" docker compose rm -sf crowdsec crowdsec-bouncer \
    || warn "Die Container von CrowdSec ließen sich nicht entfernen."
fi

if ! progress "Container werden gestartet" docker compose up -d --remove-orphans; then
  show_log
  fail "Die Container ließen sich nicht starten." \
    "Mehr sagt: cd $DIR && docker compose logs"
fi

# Bis zu drei Minuten: beim ersten Start richtet HAPM HAProxy und acme.sh ein.
wait_until_healthy() {
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! progress "Warte auf die Oberfläche" wait_until_healthy; then
  docker compose ps >&2 || true
  fail "HAPM antwortet nach drei Minuten nicht." \
    "Mehr sagt: cd $DIR && docker compose logs hapm"
fi

# ── Fertig ────────────────────────────────────────────────────────────────────
ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$ADDRESS" ] || ADDRESS="<adresse-des-servers>"

if [ -f "$DIR/install.sh" ]; then
  REMOVE="sh $DIR/install.sh --uninstall"
else
  REMOVE="curl -fsSL $SOURCE/install.sh | sh -s -- --uninstall"
fi

cat <<EOF

${GREEN}${BOLD}HAPM läuft.${RESET}

    Oberfläche    ${BOLD}http://$ADDRESS:$PORT${RESET}
    Installation  $DIR
    Daten         $STORAGE

  ${BOLD}Nächste Schritte${RESET}
    1. Die Oberfläche öffnen. Die Einrichtung fragt nach dem ersten Konto
       und danach, wie der Server erreichbar ist.
    2. Port $PORT in der Firewall nur für die eigene Adresse öffnen.
       Von außen braucht der Server die Ports 80 und 443 (TCP)
       und für HTTP/3 443 (UDP).

  ${BOLD}Befehle${RESET}
    Aktualisieren ${DIM}cd $DIR && docker compose pull && docker compose up -d${RESET}
    Entfernen     ${DIM}$REMOVE${RESET}

EOF
