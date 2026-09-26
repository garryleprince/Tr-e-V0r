import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A D1-compatible database over Node's built-in SQLite, for tests.
 *
 * It implements the subset of the D1 API the server uses (prepare/bind/first/
 * all/run and batch) with D1's semantics: foreign keys on, batch atomic. The
 * real migrations in /migrations are applied, so tests run against the actual
 * schema.
 */

type Param = string | number | bigint | null | Uint8Array;

function normalise(params: unknown[]): Param[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' && !Number.isFinite(p)) return null;
    return p as Param;
  });
}

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...normalise(this.params)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.db.prepare(this.sql).all(...normalise(this.params)) as Record<string, unknown>[];
    return { results: rows.map((r) => ({ ...r }) as T), success: true, meta: {} };
  }

  runSync(): { success: true; meta: { changes: number; last_row_id: number } } {
    const r = this.db.prepare(this.sql).run(...normalise(this.params));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async run() {
    return this.runSync();
  }
}

export class TestD1 {
  readonly raw: DatabaseSync;

  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    const dir = join(process.cwd(), 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      this.raw.exec(readFileSync(join(dir, file), 'utf8'));
    }
  }

  prepare(sql: string): Statement {
    return new Statement(this.raw, sql);
  }

  async batch(statements: Statement[]) {
    this.raw.exec('BEGIN');
    try {
      const results = statements.map((s) => s.runSync());
      this.raw.exec('COMMIT');
      return results;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 1, duration: 0 };
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
