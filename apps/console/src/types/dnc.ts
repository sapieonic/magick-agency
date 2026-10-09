/**
 * PORT NOTE (magick-agency): cusui's `src/types/dnc.ts` @ ee5beb44 now lives in
 * `@magick-agency/contracts` (`api/agency/dnc.ts`), the one wire contract the
 * server and the console compile against. This module re-exports it so every
 * ported import path stays unchanged. Differences from cusui's copy are listed in
 * `packages/contracts/src/api/agency/CONTRACT-DIFF.md` and the contract's own
 * PORT NOTEs.
 */
export * from '@magick-agency/contracts/api/agency/dnc';
