/**
 * Country name from a 2-letter code (German). Falls back to the upper-cased code
 * for anything not in the table, so an unknown country still reads as a country.
 *
 * Flags are rendered separately as SVGs via components/CountryFlag.tsx — emoji
 * flags don't render on Windows.
 */
const COUNTRY_NAMES: Record<string, string> = {
  DE: 'Deutschland', US: 'USA', CN: 'China', RU: 'Russland', FR: 'Frankreich',
  GB: 'Großbritannien', NL: 'Niederlande', BR: 'Brasilien', IN: 'Indien', JP: 'Japan',
  KR: 'Südkorea', AU: 'Australien', CA: 'Kanada', IT: 'Italien', ES: 'Spanien',
  PL: 'Polen', SE: 'Schweden', CH: 'Schweiz', AT: 'Österreich', BE: 'Belgien',
  UA: 'Ukraine', RO: 'Rumänien', CZ: 'Tschechien', HU: 'Ungarn', FI: 'Finnland',
  NO: 'Norwegen', DK: 'Dänemark', PT: 'Portugal', IE: 'Irland', SG: 'Singapur',
  HK: 'Hongkong', TW: 'Taiwan', TH: 'Thailand', VN: 'Vietnam', ID: 'Indonesien',
  MY: 'Malaysia', PH: 'Philippinen', TR: 'Türkei', ZA: 'Südafrika', MX: 'Mexiko',
  AR: 'Argentinien', CL: 'Chile', CO: 'Kolumbien', EG: 'Ägypten', SA: 'Saudi-Arabien',
  AE: 'VAE', IL: 'Israel', IR: 'Iran', PK: 'Pakistan', BD: 'Bangladesch',
  NG: 'Nigeria', KE: 'Kenia', GH: 'Ghana', LT: 'Litauen', LV: 'Lettland',
  EE: 'Estland', BG: 'Bulgarien', HR: 'Kroatien', SK: 'Slowakei', SI: 'Slowenien',
  RS: 'Serbien', GR: 'Griechenland', IS: 'Island', LU: 'Luxemburg',
};

export function countryName(code: string | undefined | null): string {
  if (!code) return 'Unbekannt';
  return COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase();
}
