// Renders the PNG icons of the PWA from public/icons/icon.svg.
//
//   node scripts/icons.mjs
//
// - icon-192.png, icon-512.png: the rounded icon, transparent corners ("any");
// - icon-maskable-512.png: full-bleed background, artwork inside the 80 % safe zone;
// - apple-touch-icon.png (180 px): full-bleed and opaque — iOS applies its own mask.
//
// Uses playwright-core with a locally installed Chromium (CHROMIUM_PATH, or the
// Playwright browsers directory). Nothing is downloaded.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { chromiumPath } from './chromium-path.mjs';

const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const artwork = inner.replace(/<rect width="512" height="512"[^>]*\/>/, '');

const variants = [
  { file: 'icon-192.png', size: 192, markup: svg },
  { file: 'icon-512.png', size: 512, markup: svg },
  {
    file: 'icon-maskable-512.png',
    size: 512,
    markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0e1014"/><g transform="translate(51.2 51.2) scale(0.8)">${artwork}</g></svg>`,
  },
  {
    file: 'apple-touch-icon.png',
    size: 180,
    markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0e1014"/>${artwork}</svg>`,
  },
];

const browser = await chromium.launch({ executablePath: chromiumPath() });
try {
  for (const v of variants) {
    const page = await browser.newPage({ viewport: { width: v.size, height: v.size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${v.markup.replace('<svg ', `<svg width="${v.size}" height="${v.size}" `)}</body></html>`,
    );
    await page.screenshot({ path: new URL(`../public/icons/${v.file}`, import.meta.url).pathname, omitBackground: true });
    await page.close();
    console.log(`public/icons/${v.file} (${v.size}×${v.size})`);
  }
} finally {
  await browser.close();
}
