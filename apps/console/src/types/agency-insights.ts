/**
 * The wire types for the campaign Insights tab live in `@magick-agency/contracts`
 * (`api/agency/insights.ts`), the one contract the server and the console compile
 * against. This module re-exports it so the console imports one path, like every
 * other area under `src/types/`.
 */
export * from '@magick-agency/contracts/api/agency/insights';
