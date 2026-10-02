import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from './sqlite.js';

export const dataDir = path.resolve(process.env.DATA_DIR || './data');
export const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, 'vireo.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  daily_limit INTEGER NOT NULL DEFAULT 50,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  vec BLOB,
  vec_dim INTEGER,
  embedding_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON kb_chunks(user_id, file_id);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  model TEXT NOT NULL DEFAULT '',
  search_enabled INTEGER NOT NULL DEFAULT 0,
  kb_ids TEXT NOT NULL DEFAULT '[]',
  api_keys TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chat_id TEXT,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage(user_id, created_at);
`);

// 幂等迁移：老库的 kb_chunks 没有向量列，逐列尝试 ALTER（列已存在则忽略）
for (const ddl of [
  'ALTER TABLE kb_chunks ADD COLUMN vec BLOB',
  'ALTER TABLE kb_chunks ADD COLUMN vec_dim INTEGER',
  'ALTER TABLE kb_chunks ADD COLUMN embedding_model TEXT',
  'ALTER TABLE files ADD COLUMN chat_id TEXT',
]) {
  try {
    db.exec(ddl);
  } catch (error) {
    if (!String(error.message).includes('duplicate column')) throw error;
  }
}

const defaultSettings = {
  model: '',
  search_enabled: 0,
  kb_ids: '[]',
  api_keys: '{}',
};

export function getSettings(userId) {
  let row = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);
  if (!row) {
    // 原子 upsert：并发首访同一用户不会撞 user_id 主键
    db.prepare(
      `INSERT INTO settings (user_id, model, search_enabled, kb_ids, api_keys, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`
    ).run(userId, defaultSettings.model, defaultSettings.search_enabled, defaultSettings.kb_ids, defaultSettings.api_keys, Date.now());
    row = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);
  }
  return row;
}

export function saveSettings(userId, patch) {
  const current = getSettings(userId);
  const next = {
    user_id: userId,
    model: patch.model ?? current.model,
    search_enabled: patch.searchEnabled ?? patch.search_enabled ?? current.search_enabled,
    kb_ids: patch.kbIds ?? patch.kb_ids ?? current.kb_ids,
    api_keys: patch.apiKeys ?? patch.api_keys ?? current.api_keys,
    updated_at: Date.now(),
  };
  if (typeof next.kb_ids !== 'string') next.kb_ids = JSON.stringify(next.kb_ids);
  if (typeof next.api_keys !== 'string') next.api_keys = JSON.stringify(next.api_keys);
  db.prepare(
    `UPDATE settings SET model = ?, search_enabled = ?, kb_ids = ?, api_keys = ?, updated_at = ? WHERE user_id = ?`
  ).run(next.model, next.search_enabled, next.kb_ids, next.api_keys, next.updated_at, userId);
  return next;
}

export function parseJsonSafe(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function settingValue(key, fallback = null) {
  const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSettingValue(key, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM platform_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO platform_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

export function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function seedAdmin(hashPassword) {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[db] 生产环境未设置 DEFAULT_ADMIN_PASSWORD，本次不创建默认管理员。请设置后重启，或自行插入管理员账号。');
      return;
    }
    console.warn('[db] 未设置 DEFAULT_ADMIN_PASSWORD，本地开发使用临时随机管理员密码（见下方一次性输出）。');
  }
  const finalPassword = password || crypto.randomBytes(12).toString('base64url');
  db.prepare(
    `INSERT INTO users (id, username, name, email, password_hash, role, daily_limit, disabled, created_at)
     VALUES (?, 'admin', 'Administrator', 'admin@local', ?, 'admin', 100000, 0, ?)`
  ).run(crypto.randomUUID(), hashPassword(finalPassword), Date.now());
  if (!password) console.warn(`[db] 临时管理员账号 admin@local 密码：${finalPassword}（仅本次输出，请登录后修改）`);
}

export default db;
