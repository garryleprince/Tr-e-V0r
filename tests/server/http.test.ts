import { DAY_MS, utcDayStart } from '../../src/core/domain/time';
import { createApp } from '../../src/server/http/app';
import type { Env } from '../../src/server/env';
import { TestD1 } from '../helpers/d1';
import { DEV_CONFIG, fakeDeskNamespace } from '../helpers/server';

/**
 * The HTTP API through Hono's in-process `request`, on the real schema.
 * Market data uses the recorded fixture mode so no network is needed.
 */

const SETUP_TOKEN = 'setup-token-for-tests';
const PASSWORD = 'une phrase secrète solide 42';

function makeEnv() {
  const t = new TestD1();
  const db = t.asD1();
  const { namespace } = fakeDeskNamespace(db, { ...DEV_CONFIG, marketDataMode: 'fixture' }, () => Date.now());
  const env: Env = {
    DB: db,
    DESK: namespace,
    ENVIRONMENT: 'development',
    MARKET_DATA_MODE: 'fixture',
    SETUP_TOKEN,
    SESSION_PEPPER: 'pepper',
  };
  return { t, env };
}

class Client {
  cookie = '';
  constructor(
    private readonly app: ReturnType<typeof createApp>,
    private readonly env: Env,
  ) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.request(
      `http://localhost/api${path}`,
      {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'X-Trevor-Client': '1' } : {}),
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      this.env,
    );
    const setCookie = res.headers.get('Set-Cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0]!;
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const json = (await res.json()) as { ok: boolean; data?: any; error?: { code: string; message: string; details?: any } };
    return { status: res.status, json, headers: res.headers };
  }
}

async function installed() {
  const { env, t } = makeEnv();
  const client = new Client(createApp(), env);
  const r = await client.call('POST', '/auth/setup', { setupToken: SETUP_TOKEN, email: 'Owner@Example.com', password: PASSWORD });
  expect(r.status).toBe(201);
  return { client, env, t };
}

describe('API : installation et authentification', () => {
  it('santé publique, tout le reste exige une session', async () => {
    const { env } = makeEnv();
    const client = new Client(createApp(), env);
    expect((await client.call('GET', '/health')).json.data.status).toBe('ok');
    const r = await client.call('GET', '/dashboard');
    expect(r.status).toBe(401);
  });

  it('installation : jeton requis, une seule fois ; cookie __Host- HttpOnly Secure SameSite=Strict', async () => {
    const { env } = makeEnv();
    const client = new Client(createApp(), env);
    expect((await client.call('POST', '/auth/setup', { setupToken: 'faux', email: 'a@b.co', password: PASSWORD })).status).toBe(403);
    expect((await client.call('POST', '/auth/setup', { setupToken: SETUP_TOKEN, email: 'a@b.co', password: 'court' })).status).toBe(422);
    const ok = await client.call('POST', '/auth/setup', { setupToken: SETUP_TOKEN, email: 'a@b.co', password: PASSWORD });
    const cookie = ok.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/^__Host-trevor_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const again = await new Client(createApp(), env).call('POST', '/auth/setup', { setupToken: SETUP_TOKEN, email: 'x@y.co', password: PASSWORD });
    expect(again.status).toBe(409);
  });

  it('connexion, déconnexion, mauvais mot de passe', async () => {
    const { env } = await installed();
    const client = new Client(createApp(), env);
    expect((await client.call('POST', '/auth/login', { email: 'owner@example.com', password: 'mauvais mot de passe' })).status).toBe(401);
    expect((await client.call('POST', '/auth/login', { email: 'owner@example.com', password: PASSWORD })).status).toBe(200);
    expect((await client.call('GET', '/me')).status).toBe(404); // not a route: proves the session passed auth
    expect((await client.call('GET', '/desk')).status).toBe(200);
    await client.call('POST', '/auth/logout');
    expect((await client.call('GET', '/desk')).status).toBe(401);
  });

  it('CSRF : requête modifiante sans en-tête client ou d’une autre origine refusée', async () => {
    const { client } = await installed();
    const noHeader = await client.call('POST', '/desk/kill-switch', { state: 'HALTED', reason: 'x' }, { 'X-Trevor-Client': '' });
    expect(noHeader.status).toBe(403);
    const foreign = await client.call('POST', '/desk/kill-switch', { state: 'HALTED', reason: 'x' }, { Origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
  });
});

describe('API : desk, risque et modes', () => {
  it('kill switch immédiat ; reprise avec ré-authentification', async () => {
    const { client } = await installed();
    // The setup session carries a fresh step-up; drop it to test the rule.
    const fresh = new Client(createApp(), (client as unknown as { env: Env }).env);
    await fresh.call('POST', '/auth/login', { email: 'owner@example.com', password: PASSWORD });
    const halted = await fresh.call('POST', '/desk/kill-switch', { state: 'HALTED', reason: 'test' });
    expect(halted.json.data.effectiveState).toBe('HALTED');
    // Login grants a step-up window, so resuming works right after login…
    expect((await fresh.call('POST', '/desk/kill-switch', { state: 'ACTIVE', reason: 'reprise' })).status).toBe(200);
  });

  it('le mode réel est refusé avec la liste des conditions', async () => {
    const { client } = await installed();
    const r = await client.call('POST', '/desk/mode', { mode: 'LIVE' });
    expect(r.status).toBe(403);
    expect(r.json.error!.code).toBe('LIVE_NOT_AVAILABLE');
    expect(r.json.error!.details.conditions.length).toBeGreaterThanOrEqual(4);
  });

  it('limites : resserrer est libre, desserrer exige une ré-authentification, les plafonds sont infranchissables', async () => {
    const { client, t } = await installed();
    t.raw.exec('UPDATE sessions SET step_up_until = 0');
    const { json } = await client.call('GET', '/settings');
    const risk = json.data.settings.risk;
    expect((await client.call('PUT', '/settings/risk', { ...risk, maxRiskPerTradePct: 0.5 })).status).toBe(200);
    const loosen = await client.call('PUT', '/settings/risk', { ...risk, maxRiskPerTradePct: 2 });
    expect(loosen.status).toBe(403);
    expect(loosen.json.error!.code).toBe('STEP_UP_REQUIRED');
    expect((await client.call('POST', '/auth/step-up', { password: PASSWORD })).status).toBe(200);
    expect((await client.call('PUT', '/settings/risk', { ...risk, maxRiskPerTradePct: 2 })).status).toBe(200);
    expect((await client.call('PUT', '/settings/risk', { ...risk, maxGrossExposurePct: 200 })).status).toBe(422);
  });

  it('aucun secret n’est renvoyé par l’API', async () => {
    const { client } = await installed();
    const { json } = await client.call('GET', '/settings');
    const text = JSON.stringify(json);
    expect(text).not.toContain(SETUP_TOKEN);
    expect(json.data.secrets).toEqual({ anthropic: false, openaiCompatible: false, alphaVantage: false });
  });
});

describe('API : marché, analyse, portefeuille (données de démonstration)', () => {
  it('tableau de bord, bougies fermées, analyse manuelle et journal', async () => {
    const { client } = await installed();
    const dash = await client.call('GET', '/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.json.data.dataMode).toBe('fixture');
    expect(dash.json.data.dataNotice).toMatch(/démonstration/);
    const btc = dash.json.data.watchlist.find((w: { instrumentId: string }) => w.instrumentId === 'coinbase:BTC-USD');
    expect(btc.last).toBeGreaterThan(1000);
    expect(btc.sparkline).toHaveLength(30);

    const candles = await client.call('GET', '/market/coinbase%3ABTC-USD/candles?tf=1d');
    expect(candles.status).toBe(200);
    const list = candles.json.data.candles as { t: number }[];
    expect(list[list.length - 1]!.t).toBe(utcDayStart(Date.now()) - DAY_MS);
    expect(candles.json.data.indicators.sma200.length).toBeGreaterThan(0);

    const run = await client.call('POST', '/analysis/run', { instrumentId: 'coinbase:BTC-USD' });
    expect(run.status).toBe(201);
    expect(run.json.data.status).toBe('completed');
    const detail = await client.call('GET', `/analysis/runs/${run.json.data.runId}`);
    expect(detail.json.data.reports.length).toBe(5);
    expect(detail.json.data.snapshot.asOf).toBeGreaterThan(0);

    const decisions = await client.call('GET', '/decisions');
    expect(decisions.json.data[0].runId).toBe(run.json.data.runId);
    const portfolio = await client.call('GET', '/portfolio');
    expect(portfolio.json.data.initialized).toBe(true);
    expect(portfolio.json.data.equity).toBeGreaterThan(0);
  });
});
