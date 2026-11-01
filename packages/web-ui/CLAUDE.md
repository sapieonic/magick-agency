# packages/web-ui

Components, the toast context, hooks, the stylesheet (`src/global.css`) and helpers used by both
web UIs (B23). Both apps import from it by path. Put code here only when both SPAs use it; code
for one app stays in that app.

- Colour tokens are defined in both theme blocks of `global.css`; `test/themeTokenParity.test.ts`
  fails a token missing from one. The mobile app mirrors these tokens by hand
  (`apps/mobile/lib/app/`), so a token change may need the same change there.
- It has its own branding guard (`test/noParentBrand.test.ts`), since the apps' guards scan only
  their own `src/`.
- `pnpm test` from this directory.
