// SQLite 在线备份：用 node:sqlite 的 serialize() 生成一致性快照，不阻塞读写主库。
// 用法：node scripts/backup.mjs [输出目录] [--keep=N]   （默认目录 ./backups，保留最近 30 份；--keep=0 关闭清理）
// 建议用 cron / 宿主机定时器每日执行；恢复 = 用生成的 .db 覆盖 data/vireo.db（停机后替换）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const defaultDataDir = fileURLToPath(new URL('../apps/api/data', import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || defaultDataDir);
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keepArg = process.argv.slice(2).find((a) => a.startsWith('--keep='));
const KEEP = keepArg ? Math.max(0, Number(keepArg.slice('--keep='.length)) || 0) : 30;
const outDir = path.resolve(positional[0] || './backups');
const src = path.join(dataDir, 'vireo.db');

if (!fs.existsSync(src)) {
  console.error(`[backup] 找不到数据库：${src}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(outDir, `vireo-${stamp}.db`);
fs.mkdirSync(outDir, { recursive: true });

const db = new DatabaseSync(src, { readOnly: true });
try {
  const buf = db.serialize ? db.serialize() : null;
  if (buf) {
    fs.writeFileSync(dest, buf);
  } else {
    // 老版本 node:sqlite 无 serialize：直接复制主库文件会漏掉 WAL 中未检查点的数据，
    // 改用 VACUUM INTO 生成含 WAL 的一致快照（已在 Node 24 只读连接验证：含未落盘行）
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }
  const size = fs.statSync(dest).size;
  console.log(`[backup] 已生成 ${dest}（${(size / 1024).toFixed(1)} KB）`);
} finally {
  db.close();
}

// 保留策略：只清理"本脚本命名规则"的快照（vireo-<时间戳>.db），
// 不动 delete-user/reset-password 生成的 vireo-before-* 安全备份与目录内其他文件。
if (KEEP > 0) {
  const ownPattern = /^vireo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/;
  const snaps = fs.readdirSync(outDir)
    .filter((n) => ownPattern.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(outDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t); // 新→旧
  const stale = snaps.slice(KEEP);
  for (const { n } of stale) {
    try {
      fs.rmSync(path.join(outDir, n));
      console.log(`[backup] 按保留策略清理旧快照：${n}`);
    } catch (error) {
      console.warn(`[backup] 清理 ${n} 失败：`, error?.message || error);
    }
  }
  if (stale.length) console.log(`[backup] 保留最近 ${KEEP} 份，已清理 ${stale.length} 份旧快照`);
}
