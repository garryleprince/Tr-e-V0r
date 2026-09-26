import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Architecture rules, enforced as tests (after TradingAgents' test_layering.py):
 * - `core/` is pure: no I/O, no server, no UI, no vendor SDK;
 * - only the Risk Engine may produce an ApprovedOrder;
 * - `web/` imports from `core/` only as types or pure helpers, never from `server/`;
 * - no secret-looking literal in the source.
 */

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const root = process.cwd();
const src = (p: string) => files(join(root, 'src', p));

describe('règles d’architecture', () => {
  it('le cœur est pur : aucune I/O, aucun import du serveur, de l’interface ou d’un SDK', () => {
    const offenders = src('core').filter((f) => {
      const code = readFileSync(f, 'utf8');
      return (
        /from '\.\.\/(\.\.\/)?(server|web)\//.test(code) ||
        /from '(react|hono|@anthropic-ai\/sdk|cloudflare:workers)'/.test(code) ||
        /\bfetch\(/.test(code) ||
        /\bD1Database\b/.test(code) ||
        /Date\.now\(\)/.test(code)
      );
    });
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it('seul le Risk Engine fabrique un ApprovedOrder', () => {
    const offenders = [...src('core'), ...src('server'), ...src('web')].filter((f) => {
      if (f.endsWith(join('core', 'risk', 'engine.ts'))) return false;
      return /as\s+(unknown\s+as\s+)?ApprovedOrder\b/.test(readFileSync(f, 'utf8'));
    });
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it('l’interface ne dépend jamais du serveur', () => {
    const offenders = src('web').filter((f) => /from '(\.\.\/)+server\/|from '@server/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it('aucune clé ou secret en dur dans les sources', () => {
    const offenders = [...src('core'), ...src('server'), ...src('web')].filter((f) =>
      /sk-ant-[A-Za-z0-9]|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
