# Sicherheit · Security

**Deutsch** · [English](#english)

## Eine Lücke melden

Bitte melden Sie Sicherheitslücken **nicht** als öffentliches Issue. Nutzen Sie
stattdessen die vertrauliche Meldung bei GitHub:

1. Im Repository auf **„Security“** gehen.
2. **„Report a vulnerability“** wählen.
3. Beschreiben, was passiert, wie es sich auslösen lässt und welche Fassung von
   HAPM betroffen ist (steht unter „Updates“).

Die Meldung sieht nur der Betreuer des Projekts. Sie bekommen eine Antwort, und
nach der Behebung wird die Lücke gemeinsam veröffentlicht.

## Unterstützte Fassungen

Behoben wird in der jeweils neuesten Fassung (`ghcr.io/tjorvenhu/hapm:latest`
und das neueste Tag). Ältere Fassungen bekommen keine eigenen Korrekturen.
Aktualisieren lässt sich HAPM unter „Updates“ mit einem Klick.

## Was zum Aufbau gehört

Einige Eigenschaften sind gewollt und keine Lücke. Sie stehen in der
[README](README.md#sicherheit):

- HAPM bindet den Docker-Socket ein. Wer sich an HAPM anmelden kann, hat damit
  Zugriff auf den Server.
- Sicherungen enthalten private Schlüssel und sind in der Vorgabe nicht
  verschlüsselt. Mit einem Sicherungsschlüssel (unter „Sicherung“) verschlüsselt
  HAPM sie mit gpg.
- Bis eine Domain eingerichtet ist, spricht die Oberfläche unverschlüsselt auf
  Port 7080.

---

## English

### Reporting a vulnerability

Please do **not** report security issues as a public issue. Use GitHub's
private reporting instead: open the **"Security"** tab of this repository and
choose **"Report a vulnerability"**. Describe what happens, how to trigger it
and which HAPM version is affected (shown under "Updates").

Only the project maintainer sees the report. You will get an answer, and the
issue will be disclosed together once it is fixed.

### Supported versions

Fixes go into the latest version (`ghcr.io/tjorvenhu/hapm:latest` and the
newest tag). Older versions do not receive separate fixes.

### By design

Some properties are intended and not a vulnerability, see the
[README](README.en.md#security): HAPM mounts the Docker socket, so anyone who
can log in to HAPM has access to the server. Backups contain private keys and
are not encrypted by default; with a backup passphrase (set under "Backup"),
HAPM encrypts them with gpg. Until a domain is set up, the web interface speaks
plain HTTP on port 7080.
