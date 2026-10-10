import { brand } from '../../brand';

interface LogoProps {
  /** Rendered height (and width) of the mark in pixels. */
  size?: number;
  className?: string;
  title?: string;
}

/**
 * Brand mark: the Magick Agency logo (`public/logo.png`), the same image the
 * console's default brand pack shows.
 */
export function Logo({ size = 28, className, title = brand.name }: LogoProps) {
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
