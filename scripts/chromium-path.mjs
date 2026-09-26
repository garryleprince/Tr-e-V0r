import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Finds a Chromium binary without downloading anything: CHROMIUM_PATH first,
 * then the Playwright browsers directory (PLAYWRIGHT_BROWSERS_PATH or
 * /opt/pw-browsers). Returns undefined to let Playwright use its own default.
 */
export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const candidate = join(root, d, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
