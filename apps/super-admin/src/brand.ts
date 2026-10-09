/**
 * PORT NOTE (magick-agency): cusui's whitelabel brand system (`src/brand/*`,
 * injected at build time from `brands/<id>/brand.config.json`) is not carried.
 * Magick Agency has one brand, so this is a constant.
 */
export const brand = {
  id: 'magick-agency',
  name: 'Magick Agency',
  shortName: 'MA',
} as const;
