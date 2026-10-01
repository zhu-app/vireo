// SQLite 在线备份：用 node:sqlite 的 serialize() 生成一致性快照，不阻塞读写主库。
// 用法：node scripts/backup.mjs [输出目录]   （默认 ./backups）
// 建议用 cron / 宿主机定时器每日执行；恢复 = 用生成的 .db 覆盖 data/vireo.db（停机后替换）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const defaultDataDir = fileURLToPath(new URL('../apps/api/data', import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || defaultDataDir);
const outDir = path.resolve(process.argv[2] || './backups');
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
    // 兜底：老版本 node:sqlite 无 serialize 时直接复制主库文件
    fs.copyFileSync(src, dest);
  }
  const size = fs.statSync(dest).size;
  console.log(`[backup] 已生成 ${dest}（${(size / 1024).toFixed(1)} KB）`);
} finally {
  db.close();
}
