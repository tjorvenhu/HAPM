# Den ganzen Stack lokal prüfen

Was Tests nicht zeigen können: ob HAPM mit einem echten HAProxy, einem echten
acme.sh und der Docker-Engine zusammen funktioniert. Die Dateien hier bauen den
Stack unter Docker Desktop auf, mit einer Test-Zertifizierungsstelle (Pebble) und
einer lokalen Registry für die Updates. Alle Befehle aus Git Bash, im
Projektordner, mit `export MSYS_NO_PATHCONV=1`.

## Bauen

```bash
docker build -t hapm:verify --build-arg HAPM_VERSION=0.0.1-verify .
```

## Starten

```bash
docker compose -f scripts/verify/compose.yml up -d
```

Oberfläche: http://localhost:7080. HAProxy: Port 8080 (HTTP) und 8443 (HTTPS).
`node scripts/verify/api.mjs POST /api/haproxy/streams '{…}'` ruft Routen mit
Anmeldung und CSRF-Token auf (Zugangsdaten über `HAPM_EMAIL`, `HAPM_PASSWORD`).
Jede Anmeldung zählt gegen die Sperre (fünf in 15 Minuten je Adresse): die
gespeicherte Sitzung `.session.json` nicht ohne Not löschen.

Ein Aufruf über Port 8443 trägt den Port im Host-Header und trifft deshalb kein
Ziel. So stimmt beides, Name und Kopfzeile:

```bash
curl -sk --connect-to demo.hapmtest.example:443:127.0.0.1:8443 https://demo.hapmtest.example/
```

## Zertifikate: Pebble

```bash
docker run -d --name hapm-pebble --network hapm-verify_default --network-alias pebble \
  -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 \
  -v "$(pwd -W)/scripts/verify:/cfg:ro" ghcr.io/letsencrypt/pebble:latest -config /cfg/pebble.json
docker cp hapm-pebble:/test/certs/pebble.minica.pem .data/minica.pem
docker cp .data/minica.pem hapm-verify:/root/.acme.sh/pebble.minica.pem
docker exec hapm-verify sh -c "echo \"CA_BUNDLE='/root/.acme.sh/pebble.minica.pem'\" >> /root/.acme.sh/account.conf"
```

Dazu den Stack mit `HAPM_ACME_SERVER=https://pebble:14000/dir` starten (vor dem
ersten Start, die Vorgabe wird bei der Installation von acme.sh gesetzt). Pebble
prüft wirklich: es löst die Domain über das DNS von Docker auf und ruft Port 80
auf. Die Domains `demo.hapmtest.example` und `www.hapmtest.example` sind in `compose.yml`
als Aliase des HAPM-Containers eingetragen, `/etc/hosts` liest Pebble nicht.
`HTTPS_INSECURE` in `account.conf` ignoriert acme.sh, es braucht `CA_BUNDLE`.

## Updates

- **HAProxy:** ein altes Abbild unter den Tag legen, den der Container benutzt
  (`docker tag haproxy:3.0.11 haproxy:3.0`), Container darauf setzen
  (`docker exec hapm-verify node /app/bin/hapm-ctl.mjs replace hapm-verify-haproxy haproxy:3.0`),
  dann in der Oberfläche prüfen und aktualisieren. Der Lauf entfernt danach das
  alte Abbild vom Rechner.
- **HAPM selbst:** braucht eine Registry, aus der die Engine holen kann.
  `docker run -d --name hapm-registry -p 5000:5000 registry:2`, das Abbild als
  `localhost:5000/hapm:verify` bauen und schieben, den Stack mit
  `HAPM_VERIFY_IMAGE=localhost:5000/hapm:verify` starten. Die neue Fassung unter
  einem ANDEREN Tag bauen und schieben (`…:next`) und in der Registry umhängen:
  `node scripts/verify/retag.mjs hapm next verify`. Baut man sie lokal unter
  demselben Tag, verschwindet das alte Abbild sofort vom Rechner, und der Test
  prüft nicht mehr den Ablauf, den es im Betrieb gibt.

## Aufräumen

```bash
docker compose -f scripts/verify/compose.yml down -v
docker rm -f hapm-pebble hapm-registry
```
