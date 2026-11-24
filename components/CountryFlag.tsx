import type { CSSProperties } from 'react';

/**
 * A country flag as an SVG (flag-icons), not an emoji.
 *
 * Emoji flags are built from regional-indicator symbol pairs, which Windows does
 * not render — it shows the bare letter pair ("US") instead. These SVGs render
 * everywhere. The flag-icons stylesheet is loaded globally in app/layout.tsx.
 *
 * Sizes relative to the surrounding font-size (flag-icons `.fi` is ~1.33em wide).
 */
export default function CountryFlag({
  code,
  className,
  style,
  title,
}: {
  code?: string | null;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  if (!code || !/^[a-zA-Z]{2}$/.test(code)) return null;
  return (
    <span
      className={`fi fi-${code.toLowerCase()}${className ? ` ${className}` : ''}`}
      style={style}
      data-tooltip={title || undefined}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
}
