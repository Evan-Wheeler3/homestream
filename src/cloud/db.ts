import type { D1Database, D1PreparedStatement } from './env.js';

/** Small helpers so queries read like the Mac version's `prepare().get/all/run`. */
export class Sql {
  constructor(readonly db: D1Database) {}

  stmt(sql: string, ...args: unknown[]): D1PreparedStatement {
    // D1 rejects `undefined`; treat it as NULL like node:sqlite does.
    return this.db.prepare(sql).bind(...args.map((a) => (a === undefined ? null : a)));
  }

  async get<T>(sql: string, ...args: unknown[]): Promise<T | null> {
    return this.stmt(sql, ...args).first<T>();
  }

  async all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return (await this.stmt(sql, ...args).all<T>()).results;
  }

  /** Runs a write; returns the number of changed rows. */
  async run(sql: string, ...args: unknown[]): Promise<number> {
    return (await this.stmt(sql, ...args).run()).meta.changes ?? 0;
  }

  /** Several writes in one transaction (all or nothing). */
  async batch(statements: D1PreparedStatement[]) {
    if (statements.length === 0) return [];
    return this.db.batch(statements);
  }
}

export const nowIso = () => new Date().toISOString();

export const randomId = () => crypto.randomUUID();
