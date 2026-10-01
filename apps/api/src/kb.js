import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadDir } from './db.js';
import db from './db.js';
import { estimateTokens } from './gateway.js';

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml']);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 解析上限 5MB
const CHUNK_TARGET = 600; // 每块目标 token
const CHUNK_OVERLAP = 80;

function safeName(name) {
  return path.basename(String(name || '')).slice(0, 180) || 'file';
}

export function isSupported(name, mime) {
  const ext = path.extname(safeName(name)).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (mime && (mime.startsWith('text/') || mime === 'application/json')) return true;
  return false;
}

function decodeText(buffer) {
  // 简单 BOM 处理；GBK 等中文编码在浏览器保存的 txt 里少见，保留原文尽力解析
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  return buffer.toString('utf8');
}

function splitParagraphs(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}|\.\n|\?\n|!\n|\n(?=[#*-])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function packChunks(paragraphs) {
  const chunks = [];
  let current = [];
  let currentTokens = 0;
  const push = () => {
    if (!current.length) return;
    const text = current.join('\n\n').trim();
    if (text) chunks.push({ text, tokens: estimateTokens(text) });
  };
  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (paraTokens > CHUNK_TARGET * 1.6) {
      // 超长段落按句切
      const sentences = para.split(/(?<=[。！？.!?；;\n])/);
      let piece = '';
      for (const s of sentences) {
        if (estimateTokens(piece + s) > CHUNK_TARGET && piece) {
          chunks.push({ text: piece.trim(), tokens: estimateTokens(piece) });
          piece = piece.slice(-CHUNK_OVERLAP * 2) + s;
        } else {
          piece += s;
        }
      }
      if (piece.trim()) chunks.push({ text: piece.trim(), tokens: estimateTokens(piece) });
      continue;
    }
    if (currentTokens + paraTokens > CHUNK_TARGET && current.length) {
      push();
      const tail = current[current.length - 1] || '';
      current = [tail.slice(-CHUNK_OVERLAP * 4), para].filter(Boolean);
      currentTokens = current.reduce((a, t) => a + estimateTokens(t), 0);
    } else {
      current.push(para);
      currentTokens += paraTokens;
    }
  }
  push();
  return chunks;
}

const STOP = new Set('的 了 和 是 在 我 有 也 就 不 人 都 一 一个 上 也 to the of and in on for with is are was were'.split(' '));

export function tokenize(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  const cjk = [...String(text || '')].filter((ch) => /[\u3400-\u9fff]/.test(ch));
  const bigrams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...new Set([...words.filter((w) => w.length > 1 && !STOP.has(w)), ...bigrams])];
}

export async function ingestFile(fileRow) {
  try {
    const abs = path.join(uploadDir, path.basename(fileRow.path));
    if (!fs.existsSync(abs)) throw new Error('上传文件已丢失');
    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件过大，支持单文件 5MB 以内的文本类文档');
    const raw = decodeText(fs.readFileSync(abs));
    if (!raw.trim()) throw new Error('文件内容为空');
    const chunks = packChunks(splitParagraphs(raw));
    if (!chunks.length) throw new Error('未能从文件中提取到有效文本');
    const insert = db.prepare('INSERT INTO kb_chunks (file_id, user_id, idx, text, tokens) VALUES (?, ?, ?, ?, ?)');
    db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(fileRow.id);
    const tx = db.transaction(() => {
      chunks.forEach((c, i) => insert.run(fileRow.id, fileRow.user_id, i, c.text, c.tokens));
    });
    tx();
    db.prepare("UPDATE files SET status = 'ready', chunks = ?, note = NULL WHERE id = ?").run(chunks.length, fileRow.id);
    return { chunks: chunks.length };
  } catch (error) {
    db.prepare("UPDATE files SET status = 'failed', note = ? WHERE id = ?").run(String(error.message || error).slice(0, 300), fileRow.id);
    throw error;
  }
}

export function retrieveChunks(userId, query, fileIds, topK = 6) {
  if (!fileIds?.length) return [];
  const terms = tokenize(query);
  if (!terms.length) return [];
  const placeholders = fileIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT kc.id, kc.file_id, kc.text, kc.tokens, f.name
       FROM kb_chunks kc JOIN files f ON f.id = kc.file_id
       WHERE kc.user_id = ? AND kc.file_id IN (${placeholders})`
    )
    .all(userId, ...fileIds);
  const scored = rows.map((row) => {
    const hay = row.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let idx = -1;
      let hits = 0;
      while ((idx = hay.indexOf(term, idx + 1)) !== -1 && hits < 10) hits += 1;
      if (hits) score += hits * (term.length >= 2 ? 1.5 : 1);
    }
    return { ...row, score };
  });
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ id, file_id, name, text, tokens, score }) => ({ id, fileId: file_id, fileName: name, text, tokens, score }));
}

export function buildKbContext(chunks, budget = 2400) {
  if (!chunks.length) return '';
  let used = 0;
  const parts = [];
  for (const chunk of chunks) {
    if (used + chunk.tokens > budget) break;
    parts.push(`【${chunk.fileName}】\n${chunk.text}`);
    used += chunk.tokens;
  }
  if (!parts.length) return '';
  return `以下是用户知识库中的参考资料，请优先依据资料内容回答；资料没有覆盖的部分可结合你自身知识，但要说明哪些来自资料、哪些是你的补充。若资料与问题无关则忽略资料。\n\n${parts.join('\n\n---\n\n')}`;
}

export function deleteFileArtifacts(fileRow) {
  db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(fileRow.id);
  try {
    fs.unlinkSync(path.join(uploadDir, path.basename(fileRow.path)));
  } catch {}
}

export function newFileId() {
  return crypto.randomUUID();
}
