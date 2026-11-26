import Image from 'next/image';

/**
 * Das Zeichen eines Produkts, das HAPM mitbringt: HAProxy und CrowdSec. Die
 * Dateien liegen unter `public/brands/` (die Bildmarken der Projekte, 64 px),
 * gezeigt klein neben dem Namen. `unoptimized`: die Dateien sind schon klein.
 */
export type Brand = 'haproxy' | 'crowdsec';

export default function BrandLogo({ brand, size = 16 }: { brand: Brand; size?: number }) {
  return (
    <Image src={`/brands/${brand}.png`} alt="" width={size} height={size} className="hapm-brand-logo" unoptimized />
  );
}

/** Zeichen und Name nebeneinander. */
export function BrandName({ brand, children, size = 16 }: { brand: Brand; children: React.ReactNode; size?: number }) {
  return (
    <span className="hapm-brand">
      <BrandLogo brand={brand} size={size} />
      {children}
    </span>
  );
}
