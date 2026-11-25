# Mitmachen · Contributing

**Deutsch** · [English](#english)

Danke für Ihr Interesse an HAPM. Fehler und Wünsche gehören in ein
[Issue](https://github.com/tjorvenhu/HAPM/issues), Änderungen in einen Pull
Request. Sicherheitslücken bitte nicht öffentlich melden, siehe
[`SECURITY.md`](SECURITY.md).

## Was Sie brauchen

- Node.js 24
- pnpm (die Fassung steht in `package.json` unter `packageManager`, `corepack enable` holt sie)
- Docker, für den ganzen Stack und die Tests gegen die Datenbank

## Lokal starten

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d --build
```

Das baut das Abbild und startet HAPM, HAProxy und Postgres, auch unter Docker
Desktop auf Mac und Windows:

| Was | Adresse |
|---|---|
| Oberfläche | `http://localhost:7080` |
| HAProxy | Ports `8080` (HTTP) und `8443` (HTTPS) |

Bauen braucht kein Token und kein Secret.

## Prüfen

Vor jedem Pull Request:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` braucht eine echte Bash im `PATH` (unter Windows aus Git Bash
starten). Einige Tests rufen GNU-Werkzeuge auf (`tar`, `head -n -N`) und laufen
deshalb nur unter Linux vollständig, etwa in der CI.

Die Tests gegen die Datenbank laufen nur mit einem Postgres, sonst werden sie
übersprungen und sagen das:

```bash
docker run -d --rm --name hapm-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
```

Was nur ein echtes HAProxy zeigen kann (Passwortsperre, Fehlerseiten), prüft:

```bash
pnpm haproxy:verify-pages
```

## Regeln für den Code

Die verbindlichen Regeln stehen in [`CLAUDE.md`](CLAUDE.md): wie Routen gebaut
sind, warum jedes Kommando über `lib/shell.ts` entsteht, wie Texte übersetzt
werden. Bevor Sie einen Bereich ändern, lesen Sie das passende Dokument in
[`docs/`](docs). Dort steht zu fast jeder Stelle, warum die naheliegende Lösung
einmal danebenging.

Kurz:

- TypeScript strict, pnpm, kein `npm` und kein `yarn`.
- Texte für Nutzer auf Deutsch über `t()` oder `msg()`, die englische Fassung in
  `lib/i18n/en/`. Siehe [`docs/i18n.md`](docs/i18n.md).
- Neue Logik mit Tests.

## Auf einem Server ausprobieren

Ein eigener Stand kommt als Abbild vom eigenen Rechner auf den Server:

```bash
docker build -t hapm:test .
docker save hapm:test | gzip | ssh root@<server> 'gunzip | docker load'
```

Das Abbild muss zur Architektur des Servers passen (auf einem ARM-Rechner für
einen gewöhnlichen Server mit `--platform linux/amd64` bauen). Dann:

```bash
scp install.sh docker-compose.yml root@<server>:/root/
ssh root@<server> 'HAPM_IMAGE=hapm:test HAPM_SOURCE=file:///root sh /root/install.sh'
```

`HAPM_SOURCE` sagt dem Skript, woher `docker-compose.yml` kommt. Unter „Updates“
steht für HAPM dann „Unbekannt“: ein lokal geladenes Abbild liegt in keiner
Registry.

## Das Abbild veröffentlichen

Das Abbild baut GitHub selbst ([`.github/workflows/image.yml`](.github/workflows/image.yml))
und legt es in die Registry von GitHub (GHCR). Es braucht dafür kein Secret.

1. Jeder Push auf `main` prüft den Code (Lint, Typen, Tests) und baut danach
   `ghcr.io/tjorvenhu/hapm:latest` für `amd64` und `arm64`. Jede Installation
   bekommt ihn unter „Updates“ angeboten.
2. Eine Fassung mit Nummer entsteht aus einem Tag:

   ```bash
   git tag v0.6.0 && git push origin v0.6.0
   ```

   Das ergibt zusätzlich `ghcr.io/tjorvenhu/hapm:0.6.0` und `:0.6`.
3. **Einmalig nach dem ersten Bau:** Ein neues Paket ist bei GitHub zuerst
   privat. Unter Profil, „Packages“, `hapm`, „Package settings“, „Change
   visibility“ auf „Public“ stellen.

---

## English

Thank you for your interest in HAPM. Bugs and ideas go into an
[issue](https://github.com/tjorvenhu/HAPM/issues), changes into a pull request.
Please do not report security issues publicly, see [`SECURITY.md`](SECURITY.md).

**Requirements:** Node.js 24, pnpm (`corepack enable`), Docker.

**Run locally:**

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d --build
```

The web interface is at `http://localhost:7080`, HAProxy on ports `8080` and
`8443`. This stack also runs on Docker Desktop.

**Check before every pull request:**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Some tests call GNU tools and only pass completely on Linux, for example in CI.
Database tests need `TEST_DATABASE_URL` pointing to a Postgres (see the German
section above for a one-line container). `pnpm haproxy:verify-pages` checks
what only a real HAProxy can show.

**Code rules:** see [`CLAUDE.md`](CLAUDE.md) and the documents in
[`docs/`](docs) (German). User-facing text is German in the code and translated
in `lib/i18n/en/`.

**Releases:** every push to `main` builds `ghcr.io/tjorvenhu/hapm:latest` for
`amd64` and `arm64`. A tag `vX.Y.Z` additionally builds `:X.Y.Z` and `:X.Y`.
