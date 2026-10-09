import { brand } from '../../brand';

interface LogoProps {
  /** Rendered height (and width) of the mark in pixels. */
  size?: number;
  className?: string;
  title?: string;
}

/**
 * Brand mark: a text tile in the brand accent with the brand's `shortName`.
 *
 * PORT NOTE (magick-agency, decision B17): cusui rendered `/logo.png` from the
 * active brand pack, which was the parent product's artwork. That asset is gone
 * and no replacement art exists, so the mark is a neutral wordmark tile — the
 * same one the super-admin app uses (`apps/super-admin/src/components/common/Logo.tsx`).
 */
export function Logo({ size = 28, className, title = brand.name }: LogoProps) {
  return (
    <span
      role="img"
      aria-label={title}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        height: size,
        width: size,
        borderRadius: Math.round(size / 4),
        background: 'var(--accent)',
        color: '#fff',
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
        letterSpacing: '-0.02em',
      }}
    >
      {brand.shortName}
    </span>
  );
}
