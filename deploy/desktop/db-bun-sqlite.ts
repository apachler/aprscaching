// D1-compatible DB adapter backed by Bun's built-in bun:sqlite — no native module.
// Implements the subset the gateway uses: prepare().bind().first()/all()/run() + db.batch()/exec().
// TODO: align method shapes exactly with your existing better-sqlite3 / D1 adapter interface.
import { Database } from "bun:sqlite";

class Stmt {
  constructor(private db: Database, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Stmt(this.db, this.sql, args); }
  async first<T = any>(col?: string): Promise<T | null> {
    const row = this.db.query(this.sql).get(...(this.args as any)) as any;
    if (row == null) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...(this.args as any)) as T[] };
  }
  async run(): Promise<{ success: boolean }> {
    this.db.query(this.sql).run(...(this.args as any));
    return { success: true };
  }
  _runSync() { this.db.query(this.sql).run(...(this.args as any)); }
}

export class BunD1 {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }
  prepare(sql: string) { return new Stmt(this.db, sql); }
  exec(sql: string) { this.db.exec(sql); }
  async batch(stmts: Stmt[]) {
    const tx = this.db.transaction((ss: Stmt[]) => ss.forEach((s) => s._runSync()));
    tx(stmts);
    return stmts.map(() => ({ success: true }));
  }
  raw() { return this.db; }
}
