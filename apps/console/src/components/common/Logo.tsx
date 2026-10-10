import { brand } from '../../brand';

interface LogoProps {
  /** Rendered height (and width) of the mark in pixels. */
  size?: number;
  className?: string;
  title?: string;
}

/**
 * Brand mark. The brand pack's `logo` image when it has one (the default
 * `magick-agency` pack does), otherwise a text tile in the brand accent with the
 * brand's `shortName`, so a pack without artwork still has a mark. The
 * super-admin app draws the same mark (`apps/super-admin/src/components/common/Logo.tsx`).
 */
export function Logo({ size = 28, className, title = brand.name }: LogoProps) {
  if (brand.logo) {
    return (
      <img
        src={brand.logo}
        alt={title}
        width={size}
        height={size}
        className={className}
        draggable={false}
        style={{ flexShrink: 0, objectFit: 'contain' }}
      />
    );
  }
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
