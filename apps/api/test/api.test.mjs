/**
 * API 集成测试：真实启动 Express + SQLite（临时目录），对本地 mock 上游走全链路。
 * 覆盖：健康检查、注册/登录/鉴权、限流、模型发现（无内置模型）、自定义供应商 CRUD、
 * 会话与流式对话、重新生成的旧回复保护、无 Key 失败不丢数据、上传类型白名单、
 * 文件下载鉴权（越权 404）、语义检索与关键词回退、管理端权限。
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
// 测试进程内多个用例反复登录，放宽按 IP 的全局阈值；
// loginLimiter（按 ip+邮箱，10/分钟）保持默认，供限流用例验证
process.env.AUTH_RATE_MAX = '1000';

// mock 上游：标准 OpenAI 兼容 SSE + embeddings + 模型列表（含"猫"→[1,0]，否则[0,1]）
const mockServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model' },
        { id: 'deepseek-reasoner', object: 'model' },
        { id: 'deepseek-v4-flash', object: 'model' },
        { id: 'text-embedding-3-small', object: 'model' },
        { id: 'dall-e-3', object: 'model' },
        { id: 'whisper-1', object: 'model' },
      ],
    }));
    return;
  }
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

// deepseek 供对话；qwen 供 embeddings（语义检索自动探测 qwen）；均指向本地 mock
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.DEEPSEEK_API_KEY = 'mock-key';
process.env.QWEN_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.DASHSCOPE_API_KEY = 'mock-key';

await import('../src/index.js');

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

async function streamOnce({ token, chatId, requestId, model, messages, regenerate }) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ chatId, requestId, model, messages, regenerate: regenerate || undefined }),
  });
  return res.text();
}

async function userIdOf(token) {
  const r = await api('GET', '/api/auth/me', { token });
  return r.json.user.id;
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

// ---------- 模型发现（无内置模型，全部来自发现） ----------
test('模型列表初始为空（已移除内置默认模型）', async () => {
  tokenA = await register('a@test.local');
  const r = await api('GET', '/api/models', { token: tokenA });
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 0);
});

test('未获取模型时创建会话：model 为空，发消息报未知模型', async () => {
  const created = await api('POST', '/api/chats', { token: tokenA, body: {} });
  assert.equal(created.status, 201);
  assert.equal(created.json.model, '');
  chatId = created.json.id;
  const sse = await streamOnce({ token: tokenA, chatId, requestId: 'req-empty-01', model: '', messages: [{ role: 'user', content: '你好' }] });
  assert.match(sse, /"error"/);
});

test('发现上游模型：过滤非对话类，显示名美化', async () => {
  const r = await api('POST', '/api/models/discover', { token: tokenA, body: { provider: 'deepseek' } });
  assert.equal(r.status, 200);
  // mock 返回 6 个：embedding/dall-e/whisper 被过滤，剩 3 个对话模型
  assert.equal(r.json.count, 3);
  assert.deepEqual(r.json.models.map((m) => m.id).sort(), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash']);
  const flash = r.json.models.find((m) => m.id === 'deepseek-v4-flash');
  assert.equal(flash.name, 'DeepSeek V4 Flash', '应美化为友好显示名');

  const list = await api('GET', '/api/models', { token: tokenA });
  assert.equal(list.json.length, 3);
  assert.ok(list.json.every((m) => m.dynamic && m.provider === 'deepseek'));
  assert.ok(list.json.every((m) => m.available), 'deepseek 有 env Key 应可用');
});

test('会话与流式对话全链路（发现后的模型）', async () => {
  const sse = await streamOnce({ token: tokenA, chatId, requestId: 'req-e2e-0001', model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] });
  assert.match(sse, /"delta"/);
  assert.match(sse, /"done":true/);

  const msgs = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  assert.equal(msgs.json.length, 2);
  assert.equal(msgs.json[0].role, 'user');
  assert.equal(msgs.json[1].content, '你好，Vireo 在线');
  firstAssistantId = msgs.json[1].id;
});

test('重新生成：携带标志且新回复成功后才删除旧回复', async () => {
  const sse = await streamOnce({ token: tokenA, chatId, requestId: 'req-e2e-0002', model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }], regenerate: true });
  assert.match(sse, /"done":true/);
  assert.match(sse, new RegExp(firstAssistantId), '应返回被删除的旧回复 ID');

  const msgs = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  assert.equal(msgs.json.length, 2, '重新生成后仍是 user+assistant 各一条');
  assert.notEqual(msgs.json[1].id, firstAssistantId);
});

test('普通连续发消息不删除上一条 AI 回复（丢记录回归）', async () => {
  const before = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  const prevAssistantId = before.json[before.json.length - 1].id;
  const sse = await streamOnce({ token: tokenA, chatId, requestId: 'req-e2e-0004', model: 'deepseek-chat', messages: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，Vireo 在线' },
    { role: 'user', content: '再答一次' },
  ] });
  assert.match(sse, /"done":true/);
  const after = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  assert.equal(after.json.length, before.json.length + 2, '普通发送应追加 user+assistant，不删除任何历史');
  assert.ok(after.json.some((m) => m.id === prevAssistantId), '上一条 AI 回复必须仍在库中');
});

test('模型调用失败时，旧回复必须保留（P0 回归）', async () => {
  const before = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  const beforeLen = before.json.length;
  const keepId = before.json.at(-1).id;
  // 未发现的模型 → 报错，且不得删除已有回复
  const sse = await streamOnce({ token: tokenA, chatId, requestId: 'req-e2e-0003', model: 'ghost-model-x', messages: [{ role: 'user', content: '你好' }] });
  assert.match(sse, /"error"/);

  const msgs = await api('GET', `/api/chats/${chatId}/messages`, { token: tokenA });
  // 未知模型在落库前即被拒绝：消息数不变，历史原样保留
  assert.equal(msgs.json.length, beforeLen, '无效模型请求不应改动任何消息');
  assert.ok(msgs.json.some((m) => m.id === keepId), '失败后旧助手回复原样保留');
});

// ---------- 自定义供应商 ----------
test('自定义供应商：普通用户不可增删，管理员可以', async () => {
  const denied = await api('POST', '/api/providers', { token: tokenA, body: { name: 'Kimi', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` } });
  assert.equal(denied.status, 403);

  const admin = await api('POST', '/api/auth/login', { body: { email: 'admin@local', password: 'Test-Admin#123' } });
  const created = await api('POST', '/api/providers', { token: admin.json.token, body: { name: 'Kimi Mock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, key: 'mock-shared-key' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, 'Kimi Mock');
  assert.match(created.json.id, /^kimi-mock/);

  const providers = await api('GET', '/api/providers', { token: tokenA });
  assert.equal(providers.json.length, 3, 'deepseek + qwen + 自定义');
  assert.ok(providers.json.some((p) => p.custom && p.name === 'Kimi Mock'));
});

test('自定义供应商：非法地址与内置同名被拒绝', async () => {
  const admin = await api('POST', '/api/auth/login', { body: { email: 'admin@local', password: 'Test-Admin#123' } });
  const badUrl = await api('POST', '/api/providers', { token: admin.json.token, body: { name: 'Bad', baseUrl: 'ftp://nope' } });
  assert.equal(badUrl.status, 400);
  const dup = await api('POST', '/api/providers', { token: admin.json.token, body: { name: 'deepseek', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` } });
  assert.equal(dup.status, 400);
});

test('自定义供应商：发现模型并按调用者 Key 标记可用', async () => {
  const r = await api('POST', '/api/models/discover', { token: tokenA, body: { provider: 'kimi-mock' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 3, '同一 mock 上游返回 3 个对话模型');

  // tokenA 无个人 kimi Key、也无平台 Key 生效路径？平台 Key 已随供应商创建写入 → 应可用
  const list = await api('GET', '/api/models', { token: tokenA });
  // 跨供应商同 id 去重：kimi 的 3 个与 deepseek 的 id 相同，列表仍 3 个
  assert.equal(list.json.length, 3);
  const status = await api('GET', '/api/status', { token: tokenA });
  assert.equal(status.json.keys['kimi-mock'].configured, true, '平台 Key 对所有用户生效');
});

test('自定义供应商：删除后模型与 Key 一并清理', async () => {
  const admin = await api('POST', '/api/auth/login', { body: { email: 'admin@local', password: 'Test-Admin#123' } });
  const del = await api('DELETE', '/api/providers/kimi-mock', { token: admin.json.token });
  assert.equal(del.status, 200);
  const providers = await api('GET', '/api/providers', { token: tokenA });
  assert.equal(providers.json.length, 2);
  const status = await api('GET', '/api/status', { token: tokenA });
  assert.equal(status.json.keys['kimi-mock'], undefined);
  // 指向已删除供应商的个人 Key 被拒绝
  const badKey = await api('PUT', '/api/settings', { token: tokenA, body: { apiKeys: { 'kimi-mock': 'sk-x' } } });
  assert.equal(badKey.status, 400);
});

test('内置供应商不可删除', async () => {
  const admin = await api('POST', '/api/auth/login', { body: { email: 'admin@local', password: 'Test-Admin#123' } });
  const del = await api('DELETE', '/api/providers/deepseek', { token: admin.json.token });
  assert.equal(del.status, 400);
});

test('模型可移除（现无内置模型，全部来自发现）', async () => {
  const removed = await api('DELETE', '/api/models/deepseek-v4-flash', { token: tokenA });
  assert.equal(removed.status, 200);
  const list = await api('GET', '/api/models', { token: tokenA });
  assert.equal(list.json.length, 2, '移除后剩 chat 与 reasoner');
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
function multipart(files, extraFields = {}) {
  const boundary = '----vireoTestBoundary';
  const parts = [];
  for (const [k, v] of Object.entries(extraFields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
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

// ---------- 语义检索（向量落库 + 混合召回，embeddings 走 qwen→mock） ----------
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

test('对话链路的 kb 引用标注为混合检索', async () => {
  await api('PUT', '/api/settings', { token: tokenA, body: { kbIds: [catFileId, dogFileId] } });
  const sse = await streamOnce({ token: tokenA, chatId, requestId: 'req-kb-0001', model: 'deepseek-chat', messages: [{ role: 'user', content: '猫' }] });
  assert.match(sse, /"type":"kb"/);
  assert.match(sse, /"via":"hybrid"/);
  assert.match(sse, /kb-cat\.txt/);
});

test('未配置嵌入服务时回退关键词检索', async () => {
  const { retrieveChunks } = await import('../src/kb.js');
  const savedKey = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY; // qwen 无 Key 且无自定义供应商 → 语义分支不可用
  try {
    const uid = await userIdOf(tokenA);
    const hits = await retrieveChunks(uid, '晒太阳 窗台', [catFileId, dogFileId], 5);
    assert.ok(hits.length >= 1, '关键词回退应仍能召回');
    assert.ok(hits.every((h) => h.via === 'keyword'), '回退结果必须全部为 keyword');
  } finally {
    if (savedKey) process.env.DASHSCOPE_API_KEY = savedKey;
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

// ---------- 会话附件（方案二：只进当前对话，不进知识库） ----------
let attChatId;
let attFileId;

test('附件上传：chatId 归属会话，知识库列表不含附件', async () => {
  const c = await api('POST', '/api/chats', { token: tokenA, body: { title: '附件测试' } });
  assert.equal(c.status, 201);
  attChatId = c.json.id;
  const mp = multipart([{ name: 'att-note.txt', type: 'text/plain', data: '附件里的秘密代号是紫罗兰。' }], { chatId: attChatId });
  const r = await api('POST', '/api/files', { token: tokenA, body: mp.body, headers: mp.headers });
  assert.equal(r.status, 201, `附件上传应成功：${r.text}`);
  attFileId = r.json[0].id;
  const kbList = await api('GET', '/api/files', { token: tokenA });
  assert.ok(!kbList.json.some((f) => f.id === attFileId), '知识库列表不应包含会话附件');
  const attList = await api('GET', `/api/chats/${attChatId}/attachments`, { token: tokenA });
  assert.ok(attList.json.some((f) => f.id === attFileId), '附件接口应返回该文件');
});

test('附件上传：非法 chatId 拒绝', async () => {
  const mp = multipart([{ name: 'bad.txt', type: 'text/plain', data: 'x'.repeat(8) }], { chatId: 'no-such-chat' });
  const r = await api('POST', '/api/files', { token: tokenA, body: mp.body, headers: mp.headers });
  assert.equal(r.status, 404);
});

test('附件检索注入：对话回答引用本会话附件（attachment notice）', async () => {
  const ok = await waitFor(async () => {
    const f = await api('GET', `/api/chats/${attChatId}/attachments`, { token: tokenA });
    return f.json.find((x) => x.id === attFileId)?.status === 'ready';
  });
  assert.ok(ok, '附件应解析完成');
  const sse = await streamOnce({ token: tokenA, chatId: attChatId, requestId: 'req-att-0001', model: 'deepseek-chat', messages: [{ role: 'user', content: '秘密代号是什么' }] });
  assert.match(sse, /"type":"attachment"/);
  assert.match(sse, /att-note\.txt/);
});

test('小附件全文直注：开放问题（无共同关键词）也引用附件', async () => {
  const sse = await streamOnce({ token: tokenA, chatId: attChatId, requestId: 'req-att-0002', model: 'deepseek-chat', messages: [{ role: 'user', content: '这个文件大概讲了什么' }] });
  assert.match(sse, /"type":"attachment"/);
  assert.match(sse, /"via":"fulltext"/);
  assert.match(sse, /att-note\.txt/);
});

test('可用状态的文件可重新解析（补语义向量）', async () => {
  const r = await api('POST', `/api/files/${attFileId}/reindex`, { token: tokenA });
  assert.equal(r.status, 200, `ready 文件应可重建：${r.text}`);
  const ok = await waitFor(async () => {
    const f = await api('GET', `/api/chats/${attChatId}/attachments`, { token: tokenA });
    return f.json.find((x) => x.id === attFileId)?.status === 'ready';
  });
  assert.ok(ok, '重建后应回到 ready');
  const { default: db } = await import('../src/db.js');
  const withVec = db.prepare('SELECT COUNT(*) n FROM kb_chunks WHERE file_id = ? AND vec IS NOT NULL').get(attFileId).n;
  assert.ok(withVec >= 1, '重建后应补齐向量');
  const missing = await api('POST', '/api/files/no-such-file/reindex', { token: tokenA });
  assert.equal(missing.status, 404);
});

test('删除会话：附件及其分块连带清理', async () => {
  const del = await api('DELETE', `/api/chats/${attChatId}`, { token: tokenA });
  assert.equal(del.status, 204);
  const { default: db } = await import('../src/db.js');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM files WHERE id = ?').get(attFileId).n, 0, '附件行应删除');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM kb_chunks WHERE file_id = ?').get(attFileId).n, 0, '附件分块应删除');
});

test('cleanup', async () => {
  const { server } = await import('../src/index.js');
  server.close();
  mockServer.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
