/**
 * API 集成测试：真实启动 Express + SQLite（临时目录），对本地 mock 上游走全链路。
 * 覆盖：健康检查、注册/登录/鉴权、限流、会话与流式对话、重新生成的旧回复保护、
 * 无 Key 失败不丢数据、上传类型白名单、文件下载鉴权（越权 404）、管理端权限。
 * 运行：npm test -w @vireo/api
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vireo-test-'));
const MOCK_PORT = 18097;
const API_PORT = 18098;
const BASE = `http://127.0.0.1:${API_PORT}`;

// ---- 环境必须在 import 被测代码之前设置 ----
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.DEFAULT_ADMIN_PASSWORD = 'Test-Admin#123';
process.env.PORT = String(API_PORT);

// mock 上游：标准 OpenAI 兼容 SSE + 简化 embeddings（含"猫"→[1,0]，否则[0,1]）
const mockServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url.endsWith('/embeddings') && req.method === 'POST') {
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      const inputs = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input || '')];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: parsed.model || 'mock-embedding',
        data: inputs.map((text, index) => ({ index, embedding: String(text).includes('猫') ? [1, 0] : [0, 1], object: 'embedding' })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
      return;
    }
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，Vireo' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' 在线' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.DEEPSEEK_API_KEY = 'mock-key';
// OPENAI 同样指向 mock：语义检索（embeddings）走本地假上游
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.OPENAI_API_KEY = 'mock-key';

const apiModule = await import('../src/index.js');

async function api(method, url, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined && !(body instanceof Buffer)) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function register(email) {
  const r = await api('POST', '/api/auth/register', { body: { email, password: 'Password#123', name: '测试员' } });
  assert.equal(r.status, 201, `注册应成功：${r.text}`);
  return r.json.token;
}

// ---------- 基础 ----------
test('健康检查无需登录', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('未带 token 访问受保护接口返回 401', async () => {
  const r = await api('GET', '/api/chats');
  assert.equal(r.status, 401);
});

test('登录：错误密码 401，正确密码可取回自身', async () => {
  const bad = await api('POST', '/api/auth/login', { body: { email: 'nope@test.local', password: 'whatever123' } });
  assert.equal(bad.status, 401);
  const admin = await api('POST', '/api/auth/login', { body: { email: 'admin@local', password: 'Test-Admin#123' } });
  assert.equal(admin.status, 200);
  const me = await api('GET', '/api/auth/me', { token: admin.json.token });
  assert.equal(me.json.user.role, 'admin');
});

let tokenA;
let chatId;
let firstAssistantId;

test('会话与流式对话全链路（mock 上游）', async () => {
  tokenA = await register('a@test.local');
  const created = await api('POST', '/api/chats', { token: tokenA, body: {} });
  assert.equal(created.status, 201);
  chatId = created.json.id;

  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ chatId, requestId: 'req-e2e-0001', model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(res.status, 200);
  const sse = await res.text();
  assert.match(sse, /"delta"/);
  assert.match(sse, /"done":true/);

  const msgs = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  assert.equal(msgs.json.length, 2);
  assert.equal(msgs.json[0].role, 'user');
  assert.equal(msgs.json[1].content, '你好，Vireo 在线');
  firstAssistantId = msgs.json[1].id;
});

test('重新生成：新回复成功后才删除旧回复', async () => {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ chatId, requestId: 'req-e2e-0002', model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] }),
  });
  const sse = await res.text();
  assert.match(sse, /"done":true/);
  assert.match(sse, new RegExp(firstAssistantId), '应返回被删除的旧回复 ID');

  const msgs = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  assert.equal(msgs.json.length, 2, '重新生成后仍是 user+assistant 各一条');
  assert.notEqual(msgs.json[1].id, firstAssistantId);
});

test('模型调用失败时，旧回复必须保留（P0 回归）', async () => {
  const keepId = (await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA })).json[1].id;
  // qwen-max 未配置任何 Key → 应报错，且不得删除已有回复
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ chatId, requestId: 'req-e2e-0003', model: 'qwen-max', messages: [{ role: 'user', content: '你好' }] }),
  });
  const sse = await res.text();
  assert.match(sse, /"error"/);

  const msgs = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  assert.equal(msgs.json.length, 2);
  assert.equal(msgs.json[1].id, keepId, '失败后旧助手回复原样保留');
});

test('登录限流：同一邮箱高频尝试返回 429', async () => {
  await register('rl@test.local');
  let got429 = false;
  for (let i = 0; i < 13; i += 1) {
    const r = await api('POST', '/api/auth/login', { body: { email: 'rl@test.local', password: 'bad-pass-000' } });
    if (r.status === 429) { got429 = true; break; }
  }
  assert.ok(got429, '连续错误登录应触发 429 限流');
});

// ---------- 上传 / 下载 ----------
function multipart(files) {
  const boundary = '----vireoTestBoundary';
  const parts = [];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(Buffer.from(f.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

let fileId;
test('上传：可渲染格式（html）被白名单拒绝', async () => {
  const mp = multipart([{ name: 'evil.html', type: 'text/html', data: '<script>alert(1)</script>' }]);
  const r = await api('POST', '/api/files', { token: tokenA, body: mp.body, headers: mp.headers });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不支持的文件类型/);
});

test('上传：文本文件成功并可下载', async () => {
  const mp = multipart([{ name: 'note.txt', type: 'text/plain', data: 'Vireo 知识库测试内容' }]);
  const r = await api('POST', '/api/files', { token: tokenA, body: mp.body, headers: mp.headers });
  assert.equal(r.status, 201);
  fileId = r.json[0].id;
  const dl = await api('GET', `/api/files/${fileId}/download`, { token: tokenA });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal(dl.text, 'Vireo 知识库测试内容');
});

test('下载：他人文件一律 404，无 token 401', async () => {
  const tokenB = await register('b@test.local');
  const other = await api('GET', `/api/files/${fileId}/download`, { token: tokenB });
  assert.equal(other.status, 404);
  const anon = await api('GET', `/api/files/${fileId}/download`);
  assert.equal(anon.status, 401);
});

test('旧的无鉴权 /uploads 路径已不存在', async () => {
  const r = await api('GET', '/uploads/anything.txt');
  assert.ok(r.status === 404 || r.status === 401, `不应可访问：${r.status}`);
});

// ---------- 语义检索（向量落库 + 混合召回） ----------
const waitFor = async (fn, ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

let catFileId;
let dogFileId;

test('上传后分块自动生成向量并落库', async () => {
  const { default: db } = await import('../src/db.js');
  const mp = multipart([
    { name: 'kb-cat.txt', type: 'text/plain', data: '猫喜欢在窗台上晒太阳，打呼噜的声音很治愈。' },
    { name: 'kb-dog.txt', type: 'text/plain', data: '狗每天早晨都要出门跑步，精力非常旺盛。' },
  ]);
  const r = await api('POST', '/api/files', { token: tokenA, body: mp.body, headers: mp.headers });
  assert.equal(r.status, 201);
  catFileId = r.json.find((f) => f.name === 'kb-cat.txt').id;
  dogFileId = r.json.find((f) => f.name === 'kb-dog.txt').id;

  const ok = await waitFor(async () => {
    const withVec = db.prepare('SELECT COUNT(*) n FROM kb_chunks WHERE file_id IN (?, ?) AND vec IS NOT NULL').get(catFileId, dogFileId).n;
    return withVec >= 2;
  });
  assert.ok(ok, 'chunk 应已写入向量');
  const dim = db.prepare('SELECT vec_dim d FROM kb_chunks WHERE vec IS NOT NULL LIMIT 1').get().d;
  assert.equal(dim, 2, 'mock 向量维度应为 2');
});

test('检索走混合模式：语义召回关键词命不中的表述', async () => {
  const { retrieveChunks } = await import('../src/kb.js');
  const uid = await userIdOf(tokenA);
  // 单字查询「猫」无法产生关键词 bigram，命中只能来自语义分支
  const hits = await retrieveChunks(uid, '猫', [catFileId, dogFileId], 5);
  assert.ok(hits.length >= 1, '语义检索应召回');
  assert.equal(hits[0].via, 'hybrid');
  assert.equal(hits[0].fileName, 'kb-cat.txt');
});

async function userIdOf(token) {
  const r = await api('GET', '/api/auth/me', { token });
  return r.json.user.id;
}

test('对话链路的 kb 引用标注为混合检索', async () => {
  await api('PUT', '/api/settings', { token: tokenA, body: { kbIds: [catFileId, dogFileId] } });
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ chatId, requestId: 'req-kb-0001', model: 'deepseek-chat', messages: [{ role: 'user', content: '猫' }] }),
  });
  const sse = await res.text();
  assert.match(sse, /"type":"kb"/);
  assert.match(sse, /"via":"hybrid"/);
  assert.match(sse, /kb-cat\.txt/);
});

test('未配置嵌入服务时回退关键词检索', async () => {
  const { retrieveChunks } = await import('../src/kb.js');
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY; // tokenA 无个人 Key，openai 环境变量清空后语义分支不可用
  try {
    const uid = await userIdOf(tokenA);
    const hits = await retrieveChunks(uid, '晒太阳 窗台', [catFileId, dogFileId], 5);
    assert.ok(hits.length >= 1, '关键词回退应仍能召回');
    assert.ok(hits.every((h) => h.via === 'keyword'), '回退结果必须全部为 keyword');
  } finally {
    if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  }
});

// ---------- 管理端 ----------
test('管理端：普通用户 403，管理员可读统计', async () => {
  const denied = await api('GET', '/api/admin/stats', { token: tokenA });
  assert.equal(denied.status, 403);
  const admin = await api('POST', '/api/auth/login', { body: { email: 'admin@local', password: 'Test-Admin#123' } });
  const stats = await api('GET', '/api/admin/stats', { token: admin.json.token });
  assert.equal(stats.status, 200);
  assert.ok(stats.json.totals.users >= 3);
});

test('cleanup', async () => {
  const { server } = await import('../src/index.js');
  server.close();
  mockServer.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
