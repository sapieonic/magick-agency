/**
 * There is no whitelabel brand system here (the console injects its brand at
 * build time from `brands/<id>/brand.config.json`). Magick Agency has one
 * brand, so this is a constant. `logo` and `favicon` are served from `public/`,
 * copies of the console's `brands/magick-agency/public/` files.
 */
export const brand = {
  id: 'magick-agency',
  name: 'Magick Agency',
  shortName: 'MA',
  logo: '/logo.png',
  favicon: '/favicon.png',
} as const;
