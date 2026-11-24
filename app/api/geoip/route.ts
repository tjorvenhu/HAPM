import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { GeoTableError } from '@/lib/geoip/format';
import { geoipOverview, setGeoipAutoRefresh } from '@/lib/geoip/fetch';
import { importGeoipFile } from '@/lib/geoip/import';
import { clearGeoipTable, readGeoipRefresh } from '@/lib/geoip/store';

/**
 * Die Länder-Tabelle der Reverse-Proxy-Statistik.
 *
 * Im Normalfall holt HAPM sie sich selbst (`lib/geoip/fetch.ts`, „jetzt holen"
 * liegt unter `./refresh`). Hier stehen der Zustand, der Schalter dafür und der
 * Nebenweg für Server ohne Zugang nach außen: der Upload von Hand. Beide Wege
 * legen die Fassung in der Datenbank ab, wo sie gegen die mitgelieferte gewinnt
 * (`lib/geoip/store.ts`).
 *
 * ── Warum die Datei roh im Body steht und nicht als FormData ──
 *
 * Es ist genau eine Datei und kein Formular. `request.arrayBuffer()` liest sie
 * ohne Zwischenschicht; ein `multipart`-Rahmen um 4,5 MB wäre eine Kodierung
 * mehr, die beide Seiten richtig treffen müssen, für kein zusätzliches Feld.
 * Der Stand kommt deshalb als Query-Parameter mit.
 *
 * ── Warum das Übersetzen HIER passiert und nicht im Browser ──
 *
 * Weil dieselbe Funktion auch der Abruf und `pnpm geoip:build` benutzen und die
 * Bedeutung dieselbe sein muss. Und weil die Antwort etwas ist, das der Browser
 * nicht wissen kann: ob aus der Datei überhaupt Bereiche geworden sind.
 */

export async function GET() {
  try {
    await requireSession();
    return ok(await geoipOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** Der Upload von Hand. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    // Der Stand kommt aus dem Dateinamen, den das Formular gelesen hat. Geprüft
    // wird er beim Import.
    const version = (new URL(request.url).searchParams.get('version') ?? '').trim();

    let imported;
    try {
      imported = await importGeoipFile({
        bytes: new Uint8Array(await request.arrayBuffer()),
        version,
        uploadedBy: session.email,
      });
    } catch (err) {
      // Eine unbrauchbare Datei ist eine Auskunft an den Benutzer und kein 500er.
      if (err instanceof GeoTableError) throw new ApiError(err);
      throw err;
    }

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'geoip_table_updated',
      resource: 'settings',
      resourceId: 'geoip',
      details:
        `Länder-Tabelle auf Stand ${imported.version} gehoben: ${imported.v4Count} IPv4- und ` +
        `${imported.v6Count} IPv6-Bereiche, ${imported.countryCount} Länder`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok(await geoipOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** Der Schalter „Selbsttätig erneuern". */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);

    if (typeof body.autoRefresh !== 'boolean') {
      throw new ApiError(msg('Der Schalter für das selbsttätige Erneuern kennt nur an und aus.'));
    }

    const before = await readGeoipRefresh();
    await setGeoipAutoRefresh(body.autoRefresh);

    if (before.autoRefresh !== body.autoRefresh) {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'settings_updated',
        resource: 'settings',
        resourceId: 'geoip',
        details: `Selbsttätiges Erneuern der Länder-Tabelle ${body.autoRefresh ? 'eingeschaltet' : 'abgeschaltet'}`,
        ip: getClientIP(request) ?? undefined,
      });
    }

    return ok(await geoipOverview());
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Zurück auf die mitgelieferte Fassung.
 *
 * Der Weg zurück, wenn jemand die falsche Datei hochgeladen hat. Er löscht
 * keine Zuordnung, sondern eine Übersteuerung — deshalb kein Bestätigungsdialog
 * mit Warnfarbe, sondern ein Knopf neben dem Stand. Schalter und letzter
 * Versuch bleiben stehen.
 */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    await clearGeoipTable();
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'geoip_table_reset',
      resource: 'settings',
      resourceId: 'geoip',
      details: 'Geholte oder hochgeladene Länder-Tabelle verworfen, es gilt wieder die mitgelieferte',
      ip: getClientIP(request) ?? undefined,
    });

    return ok(await geoipOverview());
  } catch (err) {
    return handleError(err);
  }
}
