/**
 * There is no whitelabel brand system here (the console injects its brand at
 * build time from `brands/<id>/brand.config.json`). Magick Agency has one
 * brand, so this is a constant.
 */
export const brand = {
  id: 'magick-agency',
  name: 'Magick Agency',
  shortName: 'MA',
} as const;
