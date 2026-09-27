// End-to-end walk-through on an emulated iPhone, against a running Worker.
//
//   npm run build && npm run db:migrate:local
//   npx wrangler dev --port 8787          (with .dev.vars: MARKET_DATA_MODE=fixture)
//   npm run verify:browser                 (BASE_URL, SETUP_TOKEN optional)
//
// Starts from an empty database (the owner account must not exist yet).
// Screenshots go to test-results/e2e/. The run fails on any console error,
// any 5xx answer, or any missing element.
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { chromiumPath } from '../../scripts/chromium-path.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const OUT = new URL('../../test-results/e2e/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  const file = new URL('../../.dev.vars', import.meta.url);
  if (!existsSync(file)) throw new Error('SETUP_TOKEN absent (variable ou .dev.vars)');
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('SETUP_TOKEN='));
  if (!line) throw new Error('SETUP_TOKEN absent de .dev.vars');
  return line.slice('SETUP_TOKEN='.length).trim();
}

const EMAIL = 'proprietaire@example.com';
const PASSWORD = 'une-phrase-de-passe-longue-2026';
const problems = [];
let step = 0;

const browser = await chromium.launch({ executablePath: chromiumPath() });
const context = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'fr-FR',
  timezoneId: 'Europe/Paris',
  colorScheme: 'dark',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('console', (m) => {
  // HTTP failures are checked on the responses themselves (below): the expected
  // 401 (wrong password) and 403 (LIVE refused) are answers, not errors.
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`page: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
});

async function shot(name, opts = {}) {
  step++;
  // No screen may be wider than the phone: a horizontal page scroll is a layout bug.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push(`${name} : la page déborde de ${overflow}px en largeur`);
  const file = `${OUT}${String(step).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  console.log(`✓ ${name}`);
}

async function go(hash) {
  await page.evaluate((h) => (window.location.hash = h), hash);
  await page.waitForTimeout(150);
}

try {
  // 1. Installation: the owner account is created with the setup token.
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Créer le compte propriétaire' }).waitFor();
  await shot('installation');
  await page.getByLabel('Jeton d’installation').fill(setupToken());
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirmer le mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Créer le compte' }).click();

  // 2. Dashboard: the four sections, demonstration-data banner, rules-only notice.
  await page.getByRole('heading', { name: 'Accueil', level: 1 }).waitFor();
  for (const s of ['Portefeuille', 'Marché', 'IA', 'Risque', 'Activité']) {
    await page.getByRole('heading', { name: s, level: 2 }).waitFor();
  }
  await page.getByText('Données de démonstration').first().waitFor();
  await page.getByText('Modèle d’IA non connecté').waitFor();
  await shot('accueil');
  await shot('accueil-complet', { fullPage: true });

  // 3. Market and asset chart.
  await go('#/market');
  for (const group of ['Crypto', 'Actions US', 'Actions Europe']) {
    await page.getByRole('heading', { name: group, level: 2 }).waitFor();
  }
  await shot('marche');
  // A European equity, quoted in EUR (recorded Euronext Paris data in demo mode).
  await go('#/asset/alphavantage%3AMC.PAR');
  await page.locator('.chart-canvas canvas').first().waitFor();
  await page.getByText('Euronext Paris').first().waitFor();
  await page.waitForTimeout(400);
  await shot('actif-europe');
  await go('#/asset/coinbase%3ABTC-USD');
  await page.locator('.chart-canvas canvas').first().waitFor();
  await page.getByText('MM50').first().waitFor();
  await page.waitForTimeout(400);
  await shot('actif-graphique');
  // Crosshair: a tap on the chart updates the legend.
  const box = await page.locator('.chart-canvas').boundingBox();
  if (box) await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.getByRole('radio', { name: 'Tableau' }).click();
  await page.locator('table.data-table').waitFor();
  await shot('actif-tableau');
  await page.getByRole('radio', { name: 'Graphique' }).click();

  // 4. First analysis: rule-based agents (no key), Risk Engine verdict, paper execution.
  await page.getByRole('button', { name: 'Lancer une analyse' }).click();
  await page.getByRole('heading', { name: 'Verdict du Risk Engine' }).waitFor({ timeout: 30_000 });
  await page.getByRole('heading', { name: 'Rapports des agents' }).waitFor();
  await page.getByText('Règles, sans IA').first().waitFor();
  await shot('analyse');
  await shot('analyse-complete', { fullPage: true });

  // 5. Portfolio, equity and positions.
  await go('#/portfolio');
  await page.getByText('Capital', { exact: true }).first().waitFor();
  // EUR account, USD-quoted crypto: the position shows the conversion it used.
  await page.getByText(/1 USD = [0-9,]+ EUR/).first().waitFor();
  await page.waitForTimeout(300);
  await shot('portefeuille', { fullPage: true });

  // 6. Kill switch: stop immediately, resume (step-up still valid after setup).
  await go('#/risk');
  await page.getByRole('heading', { name: 'Coupe-circuit' }).waitFor();
  await page.getByRole('button', { name: 'Arrêt d’urgence' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer' }).click();
  await page.locator('.ks-state', { hasText: 'Arrêté' }).first().waitFor();
  await shot('coupe-circuit-arrete');
  await page.getByRole('button', { name: 'Reprendre' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer' }).click();
  await page.locator('.ks-state', { hasText: 'Actif' }).first().waitFor();

  // 7. LIVE is locked: the server refuses and lists its conditions.
  await page.getByRole('radio', { name: /Réel/ }).click();
  await page.getByRole('dialog', { name: 'Mode réel verrouillé' }).waitFor();
  await page.getByText('LIVE_TRADING_ENABLED').waitFor();
  await shot('mode-reel-verrouille');
  await page.getByRole('button', { name: 'Fermer' }).click();

  // 8. Journal, activity, AI, settings, security, backtest, about.
  for (const [hash, heading] of [
    ['#/journal', 'Journal des décisions'],
    ['#/activity', 'Activité'],
    ['#/ai', 'IA'],
    ['#/settings', 'Réglages'],
    ['#/security', 'Sécurité'],
    ['#/backtest', 'Backtest'],
    ['#/about', 'À propos'],
    ['#/more', 'Plus'],
  ]) {
    await go(hash);
    await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
    await page.waitForTimeout(250);
    await shot(hash.slice(2));
  }

  // 9. Light theme.
  await go('#/settings');
  await page.getByRole('radio', { name: /Clair/ }).click();
  await go('#/');
  await page.getByRole('heading', { name: 'Accueil', level: 1 }).waitFor();
  await page.waitForTimeout(300);
  await shot('accueil-clair');
  await go('#/asset/coinbase%3AETH-USD');
  await page.locator('.chart-canvas canvas').first().waitFor();
  await page.waitForTimeout(400);
  await shot('actif-clair');

  // 10. Logout, then log in again.
  await go('#/more');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await page.getByRole('button', { name: 'Se connecter' }).waitFor();
  await shot('connexion');
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('E-mail ou mot de passe incorrect.').waitFor();
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  // Back where the owner was before logging out.
  await page.getByRole('heading', { name: 'Plus', level: 1 }).waitFor();
  console.log('✓ reconnexion');
} catch (err) {
  problems.push(`étape ${step + 1} : ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  await page.screenshot({ path: `${OUT}echec.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error('\nProblèmes :\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`\nParcours complet sans erreur. Captures : ${OUT}`);
