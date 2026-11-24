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

set -eu

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
  --force            auch starten, wenn Port 80 oder 443 schon belegt ist
  --yes              nichts nachfragen, die Vorgaben nehmen

Entfernen:
  --uninstall        Container, Abbilder, Daten und Installation von HAPM
                     entfernen. Docker und andere Container bleiben.
  --keep-data        beim Entfernen die Daten liegen lassen
  --yes              ohne Rückfrage entfernen

Dieselben Angaben über die Umgebung: HAPM_DIR, HAPM_STORAGE, HAPM_PORT,
HAPM_IMAGE, HAPM_FORCE=1, HAPM_YES=1. HAPM_SOURCE nennt, woher
docker-compose.yml kommt (Vorgabe das Repository auf GitHub).
EOF
}

say() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\nFehler: %s\n' "$1" >&2; exit 1; }

SOURCE="${HAPM_SOURCE:-https://raw.githubusercontent.com/tjorvenhu/HAPM/main}"
DEFAULT_DIR=/opt/hapm
PROJECT=hapm
MARKER=.hapm-storage

MODE=install
DIR="${HAPM_DIR:-}"
STORAGE="${HAPM_STORAGE:-}"
PORT="${HAPM_PORT:-}"
IMAGE="${HAPM_IMAGE:-}"
FORCE="${HAPM_FORCE:-0}"
YES="${HAPM_YES:-0}"
KEEP_DATA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir | --storage | --port | --image)
      [ $# -ge 2 ] || fail "Nach $1 fehlt die Angabe."
      case "$1" in
        --dir) DIR="$2" ;;
        --storage) STORAGE="$2" ;;
        --port) PORT="$2" ;;
        --image) IMAGE="$2" ;;
      esac
      shift 2
      ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --storage=*) STORAGE="${1#*=}"; shift ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --image=*) IMAGE="${1#*=}"; shift ;;
    --force) FORCE=1; shift ;;
    --yes | -y) YES=1; shift ;;
    --uninstall | --remove) MODE=uninstall; shift ;;
    --keep-data) KEEP_DATA=1; shift ;;
    --help | -h) usage; exit 0 ;;
    *) fail "Unbekannte Angabe: $1 (sh install.sh --help zeigt alle)." ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (oder mit sudo)."

# ── Eingaben ──────────────────────────────────────────────────────────────────
can_ask() {
  [ "$YES" != 1 ] && (: </dev/tty) 2>/dev/null
}

ask() {
  printf '%s [%s]: ' "$1" "$2" >/dev/tty
  IFS= read -r ANSWER </dev/tty || ANSWER=""
  [ -n "$ANSWER" ] || ANSWER="$2"
}

trim_slashes() {
  TRIMMED="$1"
  while [ "$TRIMMED" != / ] && [ "${TRIMMED%/}" != "$TRIMMED" ]; do TRIMMED="${TRIMMED%/}"; done
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
    *[!A-Za-z0-9/_.-]*) fail "$1 darf nur Buchstaben, Ziffern und / _ . - enthalten: $2" ;;
  esac
  case "$2/" in
    */../* | */./* | *//*) fail "$1 darf kein . oder .. und keinen doppelten Schrägstrich enthalten: $2" ;;
  esac
  case "$2" in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var | /var/lib | /var/lib/docker | /var/log | /var/run | /dev/* | /proc/* | /sys/* | /run/* | /var/run/* | /var/lib/docker/*)
      fail "$1 muss ein eigener Ordner sein, nicht $2. Zum Beispiel ${2%/}/hapm."
      ;;
  esac
}

# Was angegeben ist, wird geprüft, bevor irgendetwas installiert wird.
if [ -n "$DIR" ]; then trim_slashes "$DIR"; DIR="$TRIMMED"; check_path "Der Ordner der Installation" "$DIR"; fi
if [ -n "$STORAGE" ]; then trim_slashes "$STORAGE"; STORAGE="$TRIMMED"; check_path "Der Ordner der Daten" "$STORAGE"; fi

env_value() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1
}

# ── Docker: vorhanden, sonst aus der Paketquelle von Docker ───────────────────
have_docker() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

OS_ID=""
OS_CODENAME=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
fi

install_docker() {
  case "$OS_ID" in
    debian | ubuntu) ;;
    *)
      fail "Docker fehlt, und dieses Skript installiert es nur unter Debian und Ubuntu. Bitte Docker samt Compose-Plugin von Hand installieren (https://docs.docker.com/engine/install/) und das Skript noch einmal starten."
      ;;
  esac
  [ -n "$OS_CODENAME" ] || fail "Die Fassung des Betriebssystems ließ sich nicht bestimmen (/etc/os-release)."

  say "Docker wird installiert"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  have_docker || fail "Docker ist installiert, antwortet aber nicht. Läuft der Dienst (systemctl status docker)?"
  note "$(docker --version)"
}

# Wo eine laufende Installation liegt, steht an ihrem Container.
installed_dir() {
  docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' hapm 2>/dev/null || true
}

# ── Entfernen ─────────────────────────────────────────────────────────────────
project_containers() {
  {
    docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"
    # Helfer, die HAPM für Updates, Prüfungen und Sicherungen selbst startet.
    docker ps -aq --filter 'name=^/?hapm-updater$'
    docker ps -aq --filter 'name=^/?hapm-(backup|check)-[0-9]+$'
  } 2>/dev/null | sort -u
}

storage_is_ours() {
  [ -f "$1/$MARKER" ] || [ -f "$1/hapm/secrets.json" ]
}

remove_dir_if_empty() {
  [ -d "$1" ] || return 0
  if rmdir "$1" 2>/dev/null; then
    note "$1 entfernt."
  else
    note "$1 bleibt liegen, dort liegt noch etwas anderes:"
    # shellcheck disable=SC2012
    ls -A "$1" | head -n 10 | sed 's/^/      /'
  fi
}

uninstall() {
  DOCKER=0
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then DOCKER=1; fi

  if [ -z "$DIR" ] && [ "$DOCKER" = 1 ]; then DIR="$(installed_dir)"; fi
  DIR="${DIR:-$DEFAULT_DIR}"
  trim_slashes "$DIR"; DIR="$TRIMMED"
  check_path "Der Ordner der Installation" "$DIR"

  [ -n "$STORAGE" ] || STORAGE="$(env_value HAPM_STORAGE "$DIR/.env")"
  STORAGE="${STORAGE:-$DIR/data}"
  trim_slashes "$STORAGE"; STORAGE="$TRIMMED"
  check_path "Der Ordner der Daten" "$STORAGE"

  CONTAINERS=""
  IMAGES=""
  VOLUMES=""
  NETWORKS=""
  if [ "$DOCKER" = 1 ]; then
    CONTAINERS="$(project_containers)"
    IMAGES="$(
      {
        for id in $CONTAINERS; do docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true; done
        if [ -f "$DIR/docker-compose.yml" ]; then (cd "$DIR" && docker compose config --images 2>/dev/null) || true; fi
      } | sort -u
    )"
    VOLUMES="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)"
    NETWORKS="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)"
  fi

  HAS_STORAGE=0
  if [ -d "$STORAGE" ] && storage_is_ours "$STORAGE"; then HAS_STORAGE=1; fi
  HAS_DIR=0
  if [ -f "$DIR/docker-compose.yml" ] || [ -f "$DIR/.env" ]; then HAS_DIR=1; fi

  if [ -z "$CONTAINERS$VOLUMES" ] && [ "$HAS_STORAGE" = 0 ] && [ "$HAS_DIR" = 0 ]; then
    printf '\nVon HAPM ist auf diesem Server nichts zu finden (gesucht in %s).\n' "$DIR"
    printf 'Liegt die Installation woanders: sh install.sh --uninstall --dir ORDNER\n'
    exit 0
  fi

  printf '\nEntfernt wird:\n'
  if [ -n "$CONTAINERS" ]; then
    # shellcheck disable=SC2086
    printf '  Container:    %s\n' "$(docker inspect -f '{{.Name}}' $CONTAINERS | sed 's|^/||' | tr '\n' ' ')"
  fi
  if [ -n "$IMAGES" ]; then
    printf '  Abbilder:     %s\n' "$(printf '%s' "$IMAGES" | tr '\n' ' ')"
    printf '                (nur die, die kein anderer Container braucht)\n'
  fi
  if [ "$KEEP_DATA" != 1 ]; then
    [ "$HAS_STORAGE" = 0 ] || printf '  Daten:        %s (Konfiguration, Zertifikate, Datenbank)\n' "$STORAGE"
    [ -z "$VOLUMES" ] || printf '  Volumes:      %s\n' "$(printf '%s' "$VOLUMES" | tr '\n' ' ')"
  fi
  [ "$HAS_DIR" = 0 ] || printf '  Installation: %s (docker-compose.yml, .env)\n' "$DIR"

  printf '\nEs bleibt:\n'
  printf '  Docker und alle anderen Container\n'
  printf '  Sicherungen, die HAPM in einen eigenen Ordner geschrieben hat\n'
  if [ "$KEEP_DATA" = 1 ]; then
    [ "$HAS_STORAGE" = 0 ] || printf '  Die Daten in %s (--keep-data)\n' "$STORAGE"
    [ -z "$VOLUMES" ] || printf '  Die Volumes %s (--keep-data)\n' "$(printf '%s' "$VOLUMES" | tr '\n' ' ')"
  elif [ -d "$STORAGE" ] && [ "$HAS_STORAGE" = 0 ]; then
    printf '  %s: der Ordner trägt keine Kennung von HAPM. Bitte von Hand löschen.\n' "$STORAGE"
  fi

  if [ "$YES" != 1 ]; then
    can_ask || fail "Zum Entfernen ohne Rückfrage --yes angeben."
    printf '\nZum Entfernen "ja" eingeben: ' >/dev/tty
    IFS= read -r ANSWER </dev/tty || ANSWER=""
    case "$ANSWER" in
      ja | Ja | JA) ;;
      *) printf 'Abgebrochen. Es wurde nichts entfernt.\n'; exit 0 ;;
    esac
  fi

  if [ -n "$CONTAINERS" ]; then
    say "Container werden entfernt"
    # shellcheck disable=SC2086
    docker stop $CONTAINERS >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    docker rm -f $CONTAINERS >/dev/null 2>&1 || true
  fi
  for network in $NETWORKS; do docker network rm "$network" >/dev/null 2>&1 || true; done

  if [ -n "$IMAGES" ]; then
    say "Abbilder werden entfernt"
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

  if [ "$KEEP_DATA" != 1 ]; then
    if [ "$HAS_STORAGE" = 1 ]; then
      say "Daten werden entfernt"
      # Nur die Ordner, die HAPM angelegt hat. Liegt daneben etwas anderes,
      # etwa ein Ordner mit Sicherungen, bleibt es liegen.
      for part in hapm haproxy acme postgres log run; do rm -rf "${STORAGE:?}/$part"; done
      rm -f "$STORAGE/$MARKER"
      remove_dir_if_empty "$STORAGE"
    fi
    for volume in $VOLUMES; do
      if docker volume rm "$volume" >/dev/null 2>&1; then note "Volume $volume entfernt."; fi
    done
  fi

  if [ "$HAS_DIR" = 1 ]; then
    say "Installation wird entfernt"
    rm -f "$DIR/docker-compose.yml" "$DIR/docker-compose.yml.neu" "$DIR/.env" "$DIR/install.sh"
    remove_dir_if_empty "$DIR"
  fi

  printf '\nHAPM ist entfernt. Docker läuft weiter.\n'
  exit 0
}

[ "$MODE" = install ] || uninstall

# ── Installieren: der Ordner ──────────────────────────────────────────────────
# Ohne Angabe: dort, wo HAPM schon läuft. Sonst die Vorgabe, auf Nachfrage.
# Gefragt wird als Erstes, nicht erst nach der Installation von Docker.
if [ -z "$DIR" ]; then
  DIR="$(installed_dir)"
  if [ -z "$DIR" ]; then
    DIR="$DEFAULT_DIR"
    if [ ! -f "$DIR/docker-compose.yml" ] && can_ask; then
      printf '\nWohin soll HAPM installiert werden? Dort liegen docker-compose.yml, .env\n' >/dev/tty
      printf 'und unter data/ alle Daten: Konfiguration, Zertifikate, Datenbank.\n' >/dev/tty
      ask "Ordner" "$DIR"
      DIR="$ANSWER"
    fi
  fi
fi
trim_slashes "$DIR"; DIR="$TRIMMED"
check_path "Der Ordner der Installation" "$DIR"

EXISTING=0
if [ -f "$DIR/docker-compose.yml" ]; then EXISTING=1; fi

# Wo die Daten einer vorhandenen Installation liegen, ändert kein zweiter Lauf:
# HAPM fände sie sonst nicht wieder und sähe aus wie frisch installiert.
if [ "$EXISTING" = 1 ]; then
  CURRENT="$(env_value HAPM_STORAGE "$DIR/.env")"
  CURRENT="${CURRENT:-$DIR/data}"
  if [ -n "$STORAGE" ]; then
    trim_slashes "$STORAGE"
    if [ "$TRIMMED" != "$CURRENT" ]; then
      fail "Die Daten dieser Installation liegen in $CURRENT. Zum Umziehen: cd $DIR && docker compose down, den Ordner verschieben, HAPM_STORAGE in $DIR/.env ändern, docker compose up -d."
    fi
  fi
  STORAGE="$CURRENT"
fi
STORAGE="${STORAGE:-$DIR/data}"
trim_slashes "$STORAGE"; STORAGE="$TRIMMED"
check_path "Der Ordner der Daten" "$STORAGE"

case "${PORT:-7080}" in
  *[!0-9]* | "") fail "Der Port muss eine Zahl sein: $PORT" ;;
esac

# ── Docker ────────────────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || NEED_CURL=1

if have_docker; then
  say "Docker ist vorhanden"
  note "$(docker --version)"
else
  install_docker
fi

if [ "${NEED_CURL:-0}" = 1 ] && ! command -v curl >/dev/null 2>&1; then
  apt-get install -y -qq curl >/dev/null 2>&1 || fail "curl fehlt und ließ sich nicht installieren."
fi

docker info >/dev/null 2>&1 || fail "Der Docker-Dienst ist nicht erreichbar."

# ── Ports 80 und 443 ──────────────────────────────────────────────────────────
# HAProxy läuft im Netz des Servers und braucht beide. Lauscht dort schon ein
# anderer Webserver, startet HAProxy nicht, und das sähe aus wie ein Fehler von HAPM.
own_haproxy_running() {
  [ "$(docker inspect -f '{{.State.Running}}' hapm-haproxy 2>/dev/null || true)" = "true" ]
}

if ! own_haproxy_running && command -v ss >/dev/null 2>&1; then
  BUSY=""
  for port in 80 443; do
    if ss -Hltn "sport = :$port" 2>/dev/null | grep -q .; then BUSY="$BUSY $port"; fi
  done
  if [ -n "$BUSY" ]; then
    printf '\nAuf diesem Server lauscht schon etwas auf Port%s:\n' "$BUSY" >&2
    for port in $BUSY; do ss -Hltnp "sport = :$port" 2>/dev/null | sed 's/^/    /' >&2; done
    if [ "$FORCE" != 1 ]; then
      fail "HAProxy braucht die Ports 80 und 443. Bitte den anderen Dienst anhalten (etwa nginx, Apache oder Caddy) und das Skript noch einmal starten. Mit --force läuft es trotzdem weiter."
    fi
  fi
fi

# ── Dateien ───────────────────────────────────────────────────────────────────
say "HAPM wird nach $DIR installiert"
mkdir -p "$DIR"
cd "$DIR"

curl -fsSL "$SOURCE/docker-compose.yml" -o docker-compose.yml.neu \
  || fail "docker-compose.yml ließ sich nicht von $SOURCE holen."
mv docker-compose.yml.neu docker-compose.yml

# Eine Kopie des Skripts, damit es zum Entfernen nicht noch einmal geholt werden muss.
if curl -fsSL "$SOURCE/install.sh" -o install.sh.neu 2>/dev/null; then
  mv install.sh.neu install.sh
else
  rm -f install.sh.neu
fi

# Die Einstellungen entstehen einmal. Ein späterer Lauf ändert sie nicht.
if [ ! -f .env ]; then
  {
    printf 'HAPM_PORT=%s\n' "${PORT:-7080}"
    printf 'HAPM_STORAGE=%s\n' "$STORAGE"
    ZONE=""
    if [ -r /etc/timezone ]; then ZONE="$(cat /etc/timezone)"; fi
    [ -n "$ZONE" ] || ZONE="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
    [ -z "$ZONE" ] || printf 'TZ=%s\n' "$ZONE"
    [ -z "$IMAGE" ] || printf 'HAPM_IMAGE=%s\n' "$IMAGE"
  } >.env
  PORT="${PORT:-7080}"
  note "Einstellungen in $DIR/.env angelegt."
else
  note "$DIR/.env gibt es schon und bleibt, wie sie ist."
  WANTED="$PORT"
  PORT="$(env_value HAPM_PORT .env)"
  PORT="${PORT:-7080}"
  if [ -n "$WANTED" ] && [ "$WANTED" != "$PORT" ]; then
    note "Der Port bleibt $PORT. Ändern: HAPM_PORT in $DIR/.env, dann docker compose up -d."
  fi
  if [ -z "$(env_value HAPM_STORAGE .env)" ]; then
    printf 'HAPM_STORAGE=%s\n' "$STORAGE" >>.env
    note "Der Ordner der Daten steht jetzt in $DIR/.env."
  fi
fi

mkdir -p "$STORAGE"
# Dort liegen private Schlüssel. Die Container bekommen ihre Unterordner
# einzeln eingebunden und brauchen den Zugang von außen nicht.
chmod 700 "$STORAGE"
# An dieser Kennung erkennt --uninstall, dass der Ordner HAPM gehört.
[ -f "$STORAGE/$MARKER" ] || printf 'Daten von HAPM. Angelegt von install.sh.\n' >"$STORAGE/$MARKER"
note "Daten: $STORAGE"

# ── Umzug aus den Volumes ─────────────────────────────────────────────────────
# Bis 0.2.0 lagen die Daten in Docker-Volumes. Die neue docker-compose.yml liest
# sie aus dem Ordner: ohne Umzug stünde HAPM leer da.
migrate_volumes() {
  docker volume inspect "${PROJECT}_postgres-data" >/dev/null 2>&1 || return 0
  [ ! -e "$STORAGE/postgres/PG_VERSION" ] || return 0

  say "Die Daten ziehen aus den Docker-Volumes nach $STORAGE um"
  HELPER="$(docker inspect -f '{{.Config.Image}}' hapm-postgres 2>/dev/null || true)"
  HELPER="${HELPER:-postgres:17-alpine}"
  docker stop hapm-haproxy hapm hapm-postgres >/dev/null 2>&1 || true

  for pair in data:hapm haproxy-etc:haproxy haproxy-log:log acme:acme postgres-data:postgres; do
    volume="${PROJECT}_${pair%%:*}"
    target="$STORAGE/${pair##*:}"
    docker volume inspect "$volume" >/dev/null 2>&1 || continue
    mkdir -p "$target"
    if ! docker run --rm --network none --entrypoint sh -v "$volume:/from:ro" -v "$target:/to" "$HELPER" -c 'cp -a /from/. /to/'; then
      rm -rf "$target"
      fail "Das Volume $volume ließ sich nicht nach $target kopieren. Die Volumes sind unverändert."
    fi
    note "$volume nach $target"
  done
  note "Die alten Volumes bleiben liegen. Läuft HAPM danach wie gewohnt, räumt sie weg:"
  note "docker volume ls -q --filter label=com.docker.compose.project=$PROJECT | xargs docker volume rm"
}
migrate_volumes

# ── Starten ───────────────────────────────────────────────────────────────────
say "Abbilder werden geholt"
if ! docker compose pull; then
  # Ein lokal gebautes Abbild (--image) liegt in keiner Registry.
  note "Nicht alle Abbilder ließen sich holen. Es geht mit den vorhandenen weiter."
fi

say "HAPM wird gestartet"
docker compose up -d --remove-orphans

printf '    Warte auf HAPM '
READY=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'
if [ "$READY" != 1 ]; then
  docker compose ps >&2 || true
  fail "HAPM antwortet nach drei Minuten nicht. Mehr sagt: cd $DIR && docker compose logs hapm"
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

HAPM läuft.

  Oberfläche:   http://$ADDRESS:$PORT
  Installation: $DIR
  Daten:        $STORAGE

Nächste Schritte:
  1. Die Oberfläche öffnen. Die Einrichtung fragt nach dem ersten Konto und
     danach, wie der Server erreichbar ist.
  2. Port $PORT in der Firewall nur für die eigene Adresse öffnen. Von außen
     braucht der Server die Ports 80 und 443 (TCP) und für HTTP/3 443 (UDP).

Aktualisieren:  cd $DIR && docker compose pull && docker compose up -d
Entfernen:      $REMOVE
EOF
