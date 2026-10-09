/**
 * PORT NOTE (magick-agency): cusui's `src/types/auth.ts` @ ee5beb44 now lives in
 * `@magick-agency/contracts` (`api/platform/auth.ts`), the one wire contract the
 * server and the console compile against. This module re-exports it so every
 * ported import path stays unchanged. The contract's PORT NOTEs list what differs
 * from cusui's copy.
 */
export * from '@magick-agency/contracts/api/platform/auth';
