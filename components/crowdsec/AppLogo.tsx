import Image from 'next/image';
import { AppWindow } from 'lucide-react';

/**
 * Das Logo einer Anwendung aus `APP_RULES` (`public/apps/<id>.png`, siehe
 * `appLogo`). Ohne Logo ein neutrales Zeichen in derselben Größe, damit die
 * Namen in einer Liste untereinander stehen.
 */
export default function AppLogo({ logo, size = 28 }: { logo: string | null; size?: number }) {
  if (logo) {
    return <Image src={logo} alt="" width={size} height={size} className="cs-app-logo" style={{ width: size, height: size }} unoptimized />;
  }
  return (
    <span className="cs-app-logo cs-app-logo-none" style={{ width: size, height: size }}>
      <AppWindow size={Math.round(size * 0.6)} />
    </span>
  );
}
