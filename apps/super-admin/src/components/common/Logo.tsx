import { brand } from '../../brand';

interface LogoProps {
  /** Rendered height of the mark in pixels. */
  size?: number;
  className?: string;
  title?: string;
}

/**
 * Agency has no brand pack and no logo asset yet, so the mark is a
 * wordmark tile in the accent colour.
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
