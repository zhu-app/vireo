// 管理员按邮箱重置用户密码（用户忘记密码且无邮件找回通道时的兜底）。
// 用法：node scripts/reset-password.mjs <邮箱>              # 预览：确认账号存在，不改动数据
//       node scripts/reset-password.mjs <邮箱> --password <新密码>   # 生成可复制的命令示例
//       node scripts/reset-password.mjs <邮箱> <新密码> --yes        # 先自动备份，再真正重置
// 重置会同步更新 pwd_changed_at：该用户所有已登录设备的旧 token 立即失效，需用新密码重登。
// 管理员账号也可重置（与 delete-user.mjs 不同，后者拒绝删除管理员）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const defaultDataDir = fileURLToPath(new URL('../apps/api/data', import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || defaultDataDir);
const dbFile = path.join(dataDir, 'vireo.db');

const args = process.argv.slice(2).filter((a) => a !== '--yes');
const confirmed = process.argv.includes('--yes');
const email = String(args[0] || '').trim().toLowerCase();
const newPassword = args[1];

if (!email) {
  console.error('用法：node scripts/reset-password.mjs <邮箱> [新密码] [--yes]');
  console.error('  不带密码 = 预览模式；带密码但不带 --yes = 只校验不写入；带 --yes = 备份后执行重置');
  process.exit(1);
}
if (!fs.existsSync(dbFile)) {
  console.error(`[reset-password] 找不到数据库：${dbFile}（可用 DATA_DIR 环境变量指定）`);
  process.exit(1);
}

// 密码强度与后端注册/改密保持同一口径：≥8 位且含字母和数字
function strongEnough(p) {
  return p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
}
// scrypt 哈希格式与 apps/api/src/auth.js 的 hashPassword 完全一致（salt:64字节hex）
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const db = new DatabaseSync(dbFile);
try {
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  if (!user) {
    console.error(`[reset-password] 用户不存在：${email}`);
    const all = db.prepare('SELECT email, role FROM users').all();
    if (all.length) console.error('现有用户：', all.map((u) => `${u.email}（${u.role}）`).join('、'));
    process.exit(1);
  }

  console.log(`目标用户：${user.name} <${user.email}>（id: ${user.id}，角色: ${user.role}）`);
  if (!confirmed || !newPassword) {
    console.log('\n预览模式，未做任何修改。');
    console.log(`执行重置：node scripts/reset-password.mjs "${user.email}" '<新密码>' --yes`);
    console.log('（会先自动备份数据库；重置后该用户所有旧登录态立即失效）');
    process.exit(0);
  }
  if (!strongEnough(newPassword)) {
    console.error('[reset-password] 新密码需至少 8 位且同时包含字母和数字');
    process.exit(1);
  }

  // 先备份，再写入
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve('./backups');
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `vireo-before-pwdreset-${stamp}.db`);
  const buf = db.serialize ? db.serialize() : null;
  if (buf) fs.writeFileSync(dest, buf);
  // 与 backup.mjs 同口径：裸复制主库文件会漏掉 WAL 中未检查点的数据，用 VACUUM INTO 生成一致快照
  else db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  console.log(`[reset-password] 已备份到 ${dest}`);

  db.prepare('UPDATE users SET password_hash = ?, pwd_changed_at = ? WHERE id = ?')
    .run(hashPassword(newPassword), Date.now(), user.id);
  console.log(`[reset-password] 已重置 ${user.email} 的密码。请告知用户用新密码登录（旧设备登录态已全部失效）。`);
} finally {
  db.close();
}
