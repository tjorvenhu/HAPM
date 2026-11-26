# syntax=docker/dockerfile:1

# HAPM: die Oberfläche, acme.sh und das Kommando, mit dem der Container sein
# HAProxy erreicht. HAProxy selbst läuft im offiziellen Abbild daneben, siehe
# docker-compose.yml.

ARG NODE_IMAGE=node:24-bookworm-slim

# ── Bauen ────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN npm install -g pnpm@11.17.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# ── acme.sh ──────────────────────────────────────────────────────────────────
# Die Fassung, aus der beim ersten Start ins Volume installiert wird. Danach
# aktualisiert acme.sh sich über die Oberfläche selbst.
FROM ${NODE_IMAGE} AS acme
ARG ACME_VERSION=master
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/acme.sh \
    && curl -fsSL "https://github.com/acmesh-official/acme.sh/archive/${ACME_VERSION}.tar.gz" \
       | tar -xz -C /opt/acme.sh --strip-components=1

# ── Laufen ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner

# Was die Kommandos aus lib/haproxy/ auf der Maschine erwarten: bash, socat
# (Stats-Socket, ACME-Challenge), ss (belegte Ports), openssl und curl (acme.sh),
# dazu die üblichen Textwerkzeuge. gpg verschlüsselt die Sicherung (lib/backup/):
# nur das Paket `gpg`, ohne gpg-agent und dirmngr, die `gnupg` mitbrächte.
# bind9-dnsutils bringt nsupdate mit: acme.sh ruft es für DNS-01 über RFC 2136
# auf (Hook dns_nsupdate).
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl gawk grep iproute2 openssl procps sed socat tzdata \
      gpg \
      bind9-dnsutils \
    && rm -rf /var/lib/apt/lists/*

ARG HAPM_VERSION=dev
LABEL org.opencontainers.image.title="HAPM" \
      org.opencontainers.image.description="Weboberfläche für HAProxy mit automatischen Zertifikaten" \
      org.opencontainers.image.source="https://github.com/tjorvenhu/HAPM" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${HAPM_VERSION}"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=7080 \
    HOSTNAME=0.0.0.0 \
    HAPM_VERSION=${HAPM_VERSION} \
    HAPM_DATA_DIR=/data \
    HAPM_ACME_SOURCE=/opt/acme.sh

WORKDIR /app

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Zur Laufzeit gelesen und nicht importiert: die Länder-Tabelle, und die
# Docker-Anbindung, die auch bin/hapm-ctl.mjs benutzt.
COPY --from=builder /app/lib/geoip/data ./lib/geoip/data
COPY --from=builder /app/lib/docker/engine.mjs /app/lib/docker/replace.mjs ./lib/docker/
COPY --from=builder /app/bin ./bin
# bin/hapm-admin.mjs spricht ohne den Server mit Postgres und braucht dafür den
# Treiber unter einem Pfad, den Node von /app/bin aus findet. Im Standalone-Baum
# liegt er nur dort, wohin der Build ihn für den Server gelegt hat.
COPY --from=builder /app/node_modules/postgres ./bin/node_modules/postgres
COPY --from=acme /opt/acme.sh /opt/acme.sh
COPY docker/haproxy docker/hapm-reload docker/hapm-admin /usr/local/bin/
RUN chmod +x /usr/local/bin/haproxy /usr/local/bin/hapm-reload /usr/local/bin/hapm-admin

VOLUME ["/data", "/etc/haproxy", "/run/haproxy", "/var/log/haproxy", "/root/.acme.sh"]
EXPOSE 7080

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

# Der Vorlader trägt die echte Gegenstelle in jede Anfrage ein, siehe bin/remote-addr.mjs.
CMD ["node", "--import", "/app/bin/remote-addr.mjs", "server.js"]
