/**
 * The print stylesheet, inlined into every report. A4 with the margins set in `render-pdf.ts`
 * leaves a 182 mm (≈ 688 CSS px) column, which is the width every chart is drawn at, so one SVG
 * unit is one CSS pixel and chart text matches body text.
 */

/** The content column in CSS pixels (A4 210 mm − 2 × 14 mm margins, at 96 px per inch). */
export const CONTENT_WIDTH = 688;

/** The state colours (a categorical palette validated for colour-vision deficiency), in fixed order. */
export const STATE_COLOURS = {
  on_call: '#2a78d6',
  wrapup: '#eb6834',
  available: '#1baf7a',
  break: '#eda100',
  offline: '#e4e7ec',
} as const;

/** Ink, rules and the neutral used for "the rest" of a part-to-whole bar. */
export const INK = { ink: '#151a22', ink2: '#5a6372', ink3: '#7a8391', grid: '#e8ebf0', axis: '#b9c0cb', rest: '#c9d3e0', band: '#c3cbd7' } as const;

export const BASE_CSS = `
:root{--ink:${INK.ink};--ink2:${INK.ink2};--ink3:${INK.ink3};--rule:#e3e7ee;--rule2:#eef0f4;--head:#f1f3f6;--accent:#0b6b88}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:var(--ink);font:400 10.5px/1.45 'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.mono,code{font-family:'IBM Plex Mono',ui-monospace,'DejaVu Sans Mono',monospace}
.page{display:flex;flex-direction:column;gap:14px}
.page + .page{break-before:page}
.page.cont{break-before:auto;margin-top:18px}
.ph{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:9px}
.ph .tag{font:500 9px/1 'IBM Plex Mono',monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:5px}
.ph .nm{font:600 19px/1.15 'IBM Plex Sans',sans-serif}
.ph .sub{font-size:10.5px;color:var(--ink2);margin-top:3px}
.ph .meta{font:400 9.5px/1.55 'IBM Plex Mono',monospace;color:var(--ink2);text-align:right;white-space:nowrap}
.ph.compact .nm{font-size:15px}
h2{font:500 10px/1.2 'IBM Plex Mono',monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--ink2);margin:0 0 7px}
h2 .aside{text-transform:none;letter-spacing:0;font-family:'IBM Plex Sans',sans-serif;font-weight:400}
section{break-inside:avoid}
section.flow{break-inside:auto}
p{margin:0}
.muted{color:var(--ink2)}
.small{font-size:9.5px}
.notes{border-left:3px solid var(--accent);background:#f4f8fa;padding:7px 10px;color:#2c3440;font-size:10px}
.notes p + p{margin-top:3px}
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.kpis.four{grid-template-columns:repeat(4,minmax(0,1fr))}
.kpi{border:1px solid var(--rule);border-radius:6px;padding:8px 10px;min-width:0}
.kpi .v{font:600 17px/1.15 'IBM Plex Sans',sans-serif}
.kpi .v.words{font:500 11.5px/1.35 'IBM Plex Sans',sans-serif;color:var(--ink2);padding:2px 0}
.kpi .l{font-size:10px;color:var(--ink2);margin-top:2px}
.kpi .d{font:400 9px/1.4 'IBM Plex Mono',monospace;color:var(--ink2);margin-top:2px}
table{border-collapse:collapse;width:100%;font-size:9.5px}
thead{display:table-header-group}
tr{break-inside:avoid}
th{font:500 8.5px/1.2 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.05em;color:var(--ink2);background:var(--head);padding:5px 6px;text-align:left;vertical-align:bottom}
td{padding:4px 6px;border-bottom:1px solid var(--rule2);vertical-align:top}
table.tight td{padding:2.5px 6px}
th.num,td.num{text-align:right;white-space:nowrap}
tr.total td{border-top:1.5px solid var(--ink);font-weight:600;border-bottom:none}
tr.floor td{color:var(--ink2);background:#fafbfc;font-style:italic}
td .words,.words{color:var(--ink2);font-style:italic;font-size:9px;white-space:normal}
.tagok{font:500 8px/1 'IBM Plex Mono',monospace;color:#0e6b49;border:1px solid #b5dfcd;border-radius:3px;padding:1px 3px;margin-left:5px;vertical-align:1px}
.idref{font-family:'IBM Plex Mono',monospace;color:var(--ink2);font-size:9px;white-space:nowrap}
svg{display:block;width:100%;height:auto;overflow:visible}
.lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10px;color:#3d4554;margin-top:6px}
.lg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.lg b{font-weight:500;color:var(--ink)}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.facts{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:10px}
.facts dt{color:var(--ink2)}
.facts dd{margin:0}
dl.defs{margin:0;display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:10px}
dl.defs dt{font-weight:600}
dl.defs dd{margin:0;color:#2c3440}
.empty{color:var(--ink2);font-style:italic}
`;
