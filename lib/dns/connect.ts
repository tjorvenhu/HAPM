/**
 * Eine Zone einrichten und einen Adress-Eintrag sicherstellen: die zwei
 * Vorgänge, die außer dem Bereich „DNS" auch der Einrichtungsassistent braucht.
 *
 * ── Ein Weg, eine Zone einzurichten ──
 *
 * `/dns` (Route `app/api/dns/zones`) und der Assistent rufen beide
 * `connectZone`. Der Token wird dabei nicht geglaubt, sondern benutzt: die
 * Kennung der Zone kommt aus der Antwort des Anbieters und nicht aus einem
 * Formular. Ohne diesen Schritt stünde hier eine Zeile, die erst beim ersten
 * echten Eintrag auffliegt, also mitten in einem Proxy-Vorgang.
 *
 * Gesucht wird die Zone, in der die Domain LIEGT (längster Suffix,
 * `matchZone`), nicht eine Zone dieses Namens: der Assistent kennt
 * `hapm.example.org`, und wer unter `/dns` den Namen eines Dienstes eintippt,
 * meint dessen Zone.
 *
 * ── Eine Domain, eine Zeile ──
 *
 * Steht die Zone schon, wird ihr Zugang ersetzt (Token, Kennung, Anbieter) und
 * keine zweite angelegt. Mit zwei Zeilen für denselben Namen wüsste niemand, in
 * welche `sync.ts` schreibt. Ersetzt wird erst, nachdem der neue Token die Zone
 * gezeigt hat: ein falscher lässt den alten stehen.
 */

import { isIP } from 'node:net';
import { createDocument, updateDocument } from '../db';
import { COLLECTIONS, type DnsZone } from '../types';
import { encrypt } from '../crypto';
import { ApiError } from '../api';
import { msg, msgid, type Message } from '../i18n';
import { providerFor, type ProviderZone, type RecordWrite } from './provider';
import { dnsProviderLabel } from './provider-info';
import { PROVIDER_RULES, sameAddress, type DnsRecord } from './records';
import { findZoneRow, forClient, getZoneRow, withZone, type ZoneForClient } from './store';
import {
  dnsProviderForHook,
  matchZone,
  normalizeDomain,
  providerOf,
  zoneCovers,
  type DnsProviderId,
} from './zones';

export { dnsProviderForHook };
export type { DnsProviderId };

/** Wie viele Zonen die Meldung nennt, wenn keine passt. */
const HINT_ZONES = 8;

/**
 * Die Meldung, wenn der Token die Zone nicht sieht, samt der Zonen, die er
 * sieht. Je Fall ein ganzer Satz: ein angehängter Halbsatz ließe sich nicht
 * übersetzen.
 */
function notVisible(
  texts: { none: string; some: string; more: string },
  params: Record<string, string>,
  zones: ProviderZone[]
): Message {
  if (zones.length === 0) return msg(texts.none, params);
  const names = zones.slice(0, HINT_ZONES).map((zone) => zone.name);
  const more = zones.length - names.length;
  const seen = { ...params, zones: names.join(', ') };
  return more > 0 ? msg(texts.more, { ...seen, more }) : msg(texts.some, seen);
}

function access(provider: DnsProviderId, found: ProviderZone, token: string): Partial<DnsZone> {
  return {
    provider,
    zoneId: found.id,
    apiToken: encrypt(token),
    // Der Token hat gerade funktioniert. Das ist keine Annahme, sondern das
    // Ergebnis des Aufrufs davor.
    status: 'ok',
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
  };
}

export interface ConnectedZone {
  zone: ZoneForClient;
  created: boolean;
  /**
   * Ob die Nameserver der Domain auf den Anbieter zeigen. `false` heißt: die
   * Zone ist dort angelegt, aber Einträge darin wirken noch nicht. `null` heißt
   * unbekannt.
   */
  delegated: boolean | null;
}

/**
 * Richtet den Zugang zu der Zone ein, in der `domain` liegt (längster Suffix unter
 * den Zonen, die das Token sieht). Gibt es die Zone schon, wird ihr Token ersetzt.
 * Findet das Token keine passende Zone: ApiError mit den Zonen, die es sieht.
 */
export async function connectZone(input: {
  provider: DnsProviderId;
  domain: string;
  token: string;
}): Promise<ConnectedZone> {
  const domain = normalizeDomain(input.domain);
  if (domain === '') throw new ApiError(msg('Bitte eine Domain angeben.'));
  const token = input.token.trim();
  const label = dnsProviderLabel(input.provider);
  if (!token) throw new ApiError(msg('Bitte den API-Token von {provider} angeben.', { provider: label }));

  const visible = await providerFor(input.provider).listZones(token);
  const found = matchZone(domain, visible);
  if (!found) {
    // Der häufigste Fehler ist ein Token, der für eine andere Domain oder ein
    // anderes Projekt erzeugt wurde. „Nicht gefunden" schickt einen dabei in
    // die falsche Richtung, die Liste nicht.
    throw new ApiError(
      notVisible(
        {
          none: msgid('{provider} kennt unter diesem Token keine Zone für "{domain}". Der Token sieht überhaupt keine Zone.'),
          some: msgid('{provider} kennt unter diesem Token keine Zone für "{domain}". Der Token sieht: {zones}.'),
          more: msgid('{provider} kennt unter diesem Token keine Zone für "{domain}". Der Token sieht: {zones} und {more} weitere.'),
        },
        { provider: label, domain },
        visible
      ),
      404
    );
  }

  const name = normalizeDomain(found.name);
  const existing = await findZoneRow(name);
  const row = existing
    ? await updateDocument<DnsZone>(
        COLLECTIONS.DNS_ZONES,
        existing.$id,
        access(input.provider, found, token)
      )
    : await createDocument<DnsZone>(COLLECTIONS.DNS_ZONES, {
        name,
        ...access(input.provider, found, token),
      });

  return { zone: forClient(row), created: !existing, delegated: found.delegated };
}

/**
 * Den Token einer eingerichteten Zone austauschen.
 *
 * Anders als `connectZone` muss der neue Token genau DIESE Zone sehen. Der
 * längste Suffix wäre hier falsch: ein Token, der `intern.example.org` nicht
 * sieht, aber `example.org`, hätte sonst den Zugang einer anderen Zone ersetzt
 * und wäre als „gespeichert" zurückgekommen.
 */
export async function replaceZoneToken(zoneDocumentId: string, token: string): Promise<ZoneForClient> {
  const zone = await getZoneRow(zoneDocumentId);
  const provider = providerOf(zone);
  const secret = token.trim();
  if (!secret) {
    throw new ApiError(msg('Bitte den API-Token von {provider} angeben.', { provider: dnsProviderLabel(provider) }));
  }

  const visible = await providerFor(provider).listZones(secret);
  const found = visible.find((seen) => normalizeDomain(seen.name) === normalizeDomain(zone.name));
  if (!found) {
    throw new ApiError(
      notVisible(
        {
          none: msgid('Dieser Token sieht die Zone "{zone}" nicht. Der Token sieht überhaupt keine Zone.'),
          some: msgid('Dieser Token sieht die Zone "{zone}" nicht. Der Token sieht: {zones}.'),
          more: msgid('Dieser Token sieht die Zone "{zone}" nicht. Der Token sieht: {zones} und {more} weitere.'),
        },
        { zone: zone.name },
        visible
      ),
      404
    );
  }

  const updated = await updateDocument<DnsZone>(
    COLLECTIONS.DNS_ZONES,
    zone.$id,
    access(provider, found, secret)
  );
  return forClient(updated);
}

/**
 * Sorgt dafür, dass `name` als A (IPv4) bzw. AAAA (IPv6) genau auf `address` zeigt.
 * Bei Cloudflare ohne Proxy. Steht dort ein CNAME oder ein anderer Typ im Weg:
 * ApiError, der ihn nennt, nichts wird überschrieben. Ein vorhandener A/AAAA-Eintrag
 * mit anderem Wert wird ersetzt.
 *
 * `name` ist der volle Name (`hapm.example.org`) oder `@` für die Zone selbst.
 *
 * Ersetzt wird nur die eigene Art: ein AAAA-Eintrag bleibt stehen, wenn eine
 * IPv4-Adresse gesetzt wird, und umgekehrt. Sonst nähme der zweite Aufruf für
 * einen Server mit beiden Adressen den Eintrag des ersten wieder weg. Stehen
 * unter dem Namen mehrere Einträge der Art, bleibt genau einer.
 */
export async function ensureAddressRecord(
  zoneDocumentId: string,
  input: { name: string; address: string }
): Promise<{ outcome: 'created' | 'updated' | 'unchanged'; type: 'A' | 'AAAA' }> {
  const zone = await getZoneRow(zoneDocumentId);

  const address = input.address.trim();
  const family = isIP(address);
  if (family === 0) throw new ApiError(msg('Die Adresse muss eine IPv4- oder IPv6-Adresse sein.'));
  const type = family === 4 ? 'A' : 'AAAA';

  const fqdn = input.name.trim() === '@' ? normalizeDomain(zone.name) : normalizeDomain(input.name);
  if (!zoneCovers(zone.name, fqdn)) {
    throw new ApiError(
      fqdn
        ? msg('{name} liegt nicht in der Zone {zone}.', { name: fqdn, zone: zone.name })
        : msg('Dieser Name liegt nicht in der Zone {zone}.', { zone: zone.name })
    );
  }

  const provider = providerFor(zone);
  const rules = PROVIDER_RULES[provider.id];
  const direct = rules.proxy ? { proxied: false } : {};

  const records = await withZone(zone, (token, ref) => provider.listRecords(token, ref));
  const here = records.filter((record) => normalizeDomain(record.name) === fqdn);

  // Die zwei Absagen stehen außerhalb von `withZone`: ein Eintrag, der im Weg
  // steht, ist eine Auskunft über den Namen und kein Fehler der Zone. In
  // `withZone` stünde sie danach als Fehler an der Zeile.
  //
  // Ein CNAME verträgt keinen zweiten Eintrag unter seinem Namen. Ihn zu
  // ersetzen hieße, eine Weiterleitung zu löschen, von der dieser Aufruf
  // nichts weiß.
  const alias = here.find((record) => record.type === 'CNAME');
  if (alias) {
    throw new ApiError(
      msg(
        'Unter {name} steht ein CNAME-Eintrag auf {target}. Er wurde nicht angefasst. Ein {type}-Eintrag daneben ist nicht möglich: bitte den CNAME zuerst entfernen.',
        { name: fqdn, target: alias.content, type }
      ),
      409
    );
  }
  const same = here.filter((record) => record.type === type);
  const fixed = same.find((record) => record.locked);
  if (fixed) {
    throw new ApiError(
      msg('Unter {name} steht ein {type}-Eintrag auf {target}, der sich nicht ändern lässt. Er wurde nicht angefasst.', {
        name: fqdn,
        type,
        target: fixed.content,
      }),
      409
    );
  }

  const keep: DnsRecord | undefined =
    same.find((record) => sameAddress(record.content, address)) ?? same[0];
  if (keep && same.length === 1 && sameAddress(keep.content, address) && !keep.proxied) {
    return { outcome: 'unchanged', type };
  }

  return withZone(zone, async (token, ref) => {
    if (!keep) {
      await provider.createRecord(token, ref, {
        type,
        name: fqdn,
        content: address,
        ttl: rules.defaultTtl,
        comment: 'HAPM',
        ...direct,
      });
      return { outcome: 'created', type };
    }

    if (!sameAddress(keep.content, address) || keep.proxied) {
      const write: RecordWrite = {
        type,
        name: fqdn,
        content: address,
        ttl: keep.ttl,
        ...(keep.comment === null ? {} : { comment: keep.comment }),
        ...direct,
      };
      await provider.updateRecord(token, ref, keep, write);
    }
    for (const other of same) {
      if (other !== keep) await provider.deleteRecord(token, ref, other);
    }
    return { outcome: 'updated', type };
  });
}
