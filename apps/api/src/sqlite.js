import { DatabaseSync } from 'node:sqlite';

/**
 * 兼容 better-sqlite3 常用 API 的轻量适配器，底层用 Node 内置 node:sqlite。
 * 免去本机原生模块编译，行为对齐：prepare().run/get/all、exec、pragma、transaction。
 */
export default class Database {
  constructor(file) {
    this._db = new DatabaseSync(file);
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  pragma(phrase) {
    this._db.exec(`PRAGMA ${phrase}`);
    return this;
  }

  prepare(sql) {
    const stmt = this._db.prepare(sql);
    return {
      run(...params) {
        const r = stmt.run(...normalize(params));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      get(...params) {
        const r = stmt.get(...normalize(params));
        return r === undefined ? undefined : { ...r };
      },
      all(...params) {
        return stmt.all(...normalize(params)).map((r) => ({ ...r }));
      },
    };
  }

  transaction(fn) {
    return (...args) => {
      // 嵌套事务：内层直接执行，由最外层统一 COMMIT/ROLLBACK
      if (this._inTx) return fn(...args);
      this._inTx = true;
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this._db.exec('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        this._inTx = false;
      }
    };
  }

  close() {
    this._db.close();
  }
}

function normalize(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    return p;
  });
}
