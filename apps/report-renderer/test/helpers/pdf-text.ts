import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Page count and the text of every page of a PDF (pdf.js legacy build, no worker). */
export async function pdfText(buf: Buffer): Promise<{ pages: number; text: string[] }> {
  const task = getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, disableFontFace: true });
  const doc = await task.promise;
  const text: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' '));
  }
  const pages = doc.numPages;
  await task.destroy();
  return { pages, text };
}
