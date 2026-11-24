#!/bin/sh
# HAPM auf einem frischen Server installieren: Docker, wenn es fehlt, dann HAPM.
#
#   curl -fsSL https://raw.githubusercontent.com/tjorvenhu/HAPM/main/install.sh | sh
#
# Für Debian und Ubuntu. Das Skript lässt sich wiederholen: ein zweiter Lauf holt
# die neuen Abbilder und startet neu, ohne Daten anzufassen.
#
# Einstellbar über die Umgebung:
#   HAPM_DIR      Ordner der Installation            (Vorgabe /opt/hapm)
#   HAPM_PORT     Port der Oberfläche                (Vorgabe 7080)
#   HAPM_IMAGE    ein anderes Abbild von HAPM        (Vorgabe siehe docker-compose.yml)
#   HAPM_SOURCE   woher docker-compose.yml kommt     (Vorgabe das Repository auf GitHub)
#   HAPM_FORCE=1  auch starten, wenn Port 80 oder 443 schon belegt ist

set -eu

SOURCE="${HAPM_SOURCE:-https://raw.githubusercontent.com/tjorvenhu/HAPM/main}"
DIR="${HAPM_DIR:-/opt/hapm}"
PORT="${HAPM_PORT:-7080}"

say() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\nFehler: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (oder mit sudo)."
command -v curl >/dev/null 2>&1 || NEED_CURL=1

# ── Betriebssystem ────────────────────────────────────────────────────────────
OS_ID=""
OS_CODENAME=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
fi

# ── Docker ────────────────────────────────────────────────────────────────────
have_docker() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

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
    if [ "${HAPM_FORCE:-0}" != 1 ]; then
      fail "HAProxy braucht die Ports 80 und 443. Bitte den anderen Dienst anhalten (etwa nginx, Apache oder Caddy) und das Skript noch einmal starten. Mit HAPM_FORCE=1 läuft es trotzdem weiter."
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

# Die Einstellungen entstehen einmal. Ein späterer Lauf fasst sie nicht an.
if [ ! -f .env ]; then
  {
    printf 'HAPM_PORT=%s\n' "$PORT"
    ZONE=""
    [ -r /etc/timezone ] && ZONE="$(cat /etc/timezone)"
    [ -n "$ZONE" ] || ZONE="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
    [ -n "$ZONE" ] && printf 'TZ=%s\n' "$ZONE"
    [ -n "${HAPM_IMAGE:-}" ] && printf 'HAPM_IMAGE=%s\n' "$HAPM_IMAGE"
    true
  } >.env
  note "Einstellungen in $DIR/.env angelegt."
else
  note "$DIR/.env gibt es schon und bleibt unverändert."
  PORT="$(sed -n 's/^HAPM_PORT=//p' .env | tail -n 1)"
  PORT="${PORT:-7080}"
fi

# ── Starten ───────────────────────────────────────────────────────────────────
say "Abbilder werden geholt"
if ! docker compose pull; then
  # Ein lokal gebautes Abbild (HAPM_IMAGE) liegt in keiner Registry.
  note "Nicht alle Abbilder ließen sich holen. Es geht mit den vorhandenen weiter."
fi

say "HAPM wird gestartet"
docker compose up -d

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

cat <<EOF

HAPM läuft.

  Oberfläche:   http://$ADDRESS:$PORT
  Installation: $DIR

Nächste Schritte:
  1. Die Oberfläche öffnen und das erste Konto anlegen.
  2. Eine Gruppe anlegen, dann das erste Ziel.
  3. Port $PORT in der Firewall nur für die eigene Adresse öffnen. Von außen
     braucht der Server die Ports 80 und 443 (TCP) und für HTTP/3 443 (UDP).

Aktualisieren:  cd $DIR && docker compose pull && docker compose up -d
Entfernen:      cd $DIR && docker compose down     (mit -v auch alle Daten)
EOF
