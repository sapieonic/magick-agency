/**
 * The account's listening history's wire types (`docs/listening.md` §12, LS19) live in
 * `@magick-agency/contracts` (`api/agency/listen-history.ts`), the one contract the server and the
 * console compile against. This module re-exports it so the console imports them from one place,
 * like every other area under `types/`.
 */
export * from '@magick-agency/contracts/api/agency/listen-history';
