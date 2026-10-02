// 按邮箱彻底删除一个用户及其全部关联数据（会话/消息/知识库/用量/个人设置）。
// 用法：node scripts/delete-user.mjs <邮箱>            # 预览模式，只显示将删除什么，不动数据
//       node scripts/delete-user.mjs <邮箱> --yes      # 先自动备份数据库，再真正删除
// 管理员账号不可删除。删除前先跑一次不带 --yes 的预览确认目标无误。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const defaultDataDir = fileURLToPath(new URL('../apps/api/data', import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || defaultDataDir);
const dbFile = path.join(dataDir, 'vireo.db');

const args = process.argv.slice(2).filter((a) => a !== '--yes');
const confirmed = process.argv.includes('--yes');
const email = (args[0] || '').trim().toLowerCase();

if (!email) {
  console.error('用法：node scripts/delete-user.mjs <邮箱> [--yes]');
  process.exit(1);
}
if (!fs.existsSync(dbFile)) {
  console.error(`[delete-user] 找不到数据库：${dbFile}（可用 DATA_DIR 环境变量指定）`);
  process.exit(1);
}

const db = new DatabaseSync(dbFile);
try {
  const like = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const user = one('SELECT * FROM users WHERE lower(email) = ?', email);
  if (!user) {
    console.error(`[delete-user] 用户不存在：${email}`);
    const all = like('SELECT email, name, role FROM users');
    if (all.length) console.error('现有用户：', all.map((u) => `${u.email}（${u.role}）`).join('、'));
    process.exit(1);
  }
  if (user.role === 'admin') {
    console.error(`[delete-user] ${email} 是管理员账号，拒绝删除。`);
    process.exit(1);
  }

  const chats = one('SELECT COUNT(*) n FROM chats WHERE user_id = ?', user.id).n;
  const messages = one('SELECT COUNT(*) n FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)', user.id).n;
  const files = one('SELECT COUNT(*) n FROM files WHERE user_id = ?', user.id).n;
  const chunks = one('SELECT COUNT(*) n FROM kb_chunks WHERE user_id = ?', user.id).n;
  const usages = one('SELECT COUNT(*) n FROM usage WHERE user_id = ?', user.id).n;
  const fileRows = like('SELECT id, path, name FROM files WHERE user_id = ?', user.id);

  console.log(`目标用户：${user.name} <${user.email}>（id: ${user.id}）`);
  console.log(`将删除：会话 ${chats} 个 / 消息 ${messages} 条 / 知识库文件 ${files} 个（分块 ${chunks} 条）/ 用量记录 ${usages} 条 / 个人设置 1 条`);

  if (!confirmed) {
    console.log('\n预览模式，未做任何修改。确认无误后追加 --yes 执行删除（删除前会自动备份数据库）。');
    process.exit(0);
  }

  // 先备份，再删除
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve('./backups');
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `vireo-before-del-${stamp}.db`);
  const buf = db.serialize ? db.serialize() : null;
  if (buf) fs.writeFileSync(dest, buf);
  // 与 backup.mjs 同口径：裸复制主库文件会漏掉 WAL 中未检查点的数据，用 VACUUM INTO 生成一致快照
  else db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  console.log(`[delete-user] 已备份到 ${dest}`);

  db.exec('BEGIN');
  try {
    for (const f of fileRows) {
      db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(f.id);
      const abs = path.join(dataDir, 'uploads', path.basename(String(f.path)));
      try { fs.unlinkSync(abs); } catch {}
    }
    db.prepare('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)').run(user.id);
    db.prepare('DELETE FROM chats WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM files WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM kb_chunks WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM usage WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM settings WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const remain = like('SELECT email, name, role FROM users');
  console.log(`[delete-user] 已删除 ${user.email}。剩余用户：${remain.map((u) => `${u.email}（${u.role}）`).join('、') || '（无）'}`);
} finally {
  db.close();
}
