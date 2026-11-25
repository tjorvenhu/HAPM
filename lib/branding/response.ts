/**
 * Die Antwort mit einem Bild des eigenen Aussehens.
 *
 * ── Cache ──
 *
 * Die Seiten verweisen mit `?v=<Fingerabdruck>`. Passt er zum Bild, darf der
 * Browser es ein Jahr behalten: ein neues Bild hat eine neue Adresse. Ohne
 * oder mit altem Fingerabdruck fragt er jedes Mal nach (`no-cache` mit ETag),
 * damit niemand ein ersetztes Logo weiter sieht.
 *
 * ── Ein SVG unter eigener Adresse ──
 *
 * Als `<img>` führt ein SVG nichts aus. Öffnet jemand die Adresse direkt, ist
 * es ein Dokument der Oberfläche. Die Prüfung beim Hochladen lehnt Skripte ab
 * (`checkImageBytes`), `sandbox` hält zusätzlich alles an, was sie übersähe.
 * Die Kopfzeile steht in `next.config.ts`: die allgemeine CSP von dort
 * überschriebe eine, die die Route selbst setzt.
 */
export function imageResponse(request: Request, mime: string, body: Buffer, hash: string): Response {
  const etag = `"${hash}"`;
  const versioned = new URL(request.url).searchParams.get('v') === hash;
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(body), { status: 200, headers });
}
