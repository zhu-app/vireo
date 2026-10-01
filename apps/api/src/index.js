import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import db, {
  dataDir,
  uploadDir,
  getSettings,
  saveSettings,
  parseJsonSafe,
  settingValue,
  setSettingValue,
  seedAdmin,
  todayStart,
} from './db.js';
import { auth, adminOnly, hashPassword, verifyPassword, signToken, publicUser } from './auth.js';
import {
  listModels,
  getModel,
  keyStatus,
  resolveApiKey,
  streamChat,
  checkQuota,
  recordUsage,
  writeSseHead,
  GatewayError,
  maskKey,
  PROVIDER_DEFAULTS,
} from './gateway.js';
import { isSupported, ingestFile, retrieveChunks, buildKbContext, deleteFileArtifacts } from './kb.js';
import { webSearch, searchStatus, SearchError } from './search.js';
import { rateLimit } from './ratelimit.js';

const app = express();
const port = Number(process.env.PORT || 8080);
seedAdmin(hashPassword);

app.set('trust proxy', 1); // Nginx 反代下取真实 IP，供限流与日志使用

const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(corsOrigins.length ? cors({ origin: corsOrigins, credentials: true }) : cors({ origin: false }));
app.use(express.json({ limit: '2mb' }));

// 全局安全响应头
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const Z = {
  register: z.object({ name: z.string().trim().max(40).optional(), email: z.string().email('邮箱格式不正确'), password: z.string().min(8, '密码至少 8 位').max(128) }),
  login: z.object({ email: z.string().min(3), password: z.string().min(1) }),
  chat: z.object({ title: z.string().trim().max(80).optional(), model: z.string().max(60).optional() }),
  stream: z
    .object({
      chatId: z.string(),
      requestId: z.string().min(8).max(64),
      model: z.string().max(60),
      messages: z
        .array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string().max(50000) }))
        .min(1)
        .max(100)
        // 总字符数上限：确保 JSON 请求体一定落在 express.json 的 2mb 之内，
        // 否则「校验允许、请求体先拒」会让长对话静默变成 413。
        .refine((list) => list.reduce((sum, m) => sum + m.content.length, 0) <= 200_000, {
          message: '对话内容过长，请开启新对话或精简上下文后重试',
        }),
    })
    .refine((b) => b.messages.some((m) => m.role === 'user' && m.content.trim()), {
      message: '缺少用户消息',
    }),
  settings: z.object({
    model: z.string().max(60).optional(),
    searchEnabled: z.boolean().optional(),
    kbIds: z.array(z.string()).max(50).optional(),
    apiKeys: z.record(z.enum(['deepseek', 'openai', 'qwen']), z.string().max(200)).optional(),
  }),
  adminUser: z.object({ disabled: z.boolean().optional(), dailyLimit: z.number().int().min(0).max(1000000).optional(), name: z.string().trim().min(1).max(40).optional() }),
  adminKeys: z.record(z.enum(Object.keys(PROVIDER_DEFAULTS).concat(['search'])), z.string().max(200)).optional(),
};

function validate(schema, data, res) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || '参数不正确' });
    return null;
  }
  return parsed.data;
}

const newId = () => crypto.randomUUID();
const api = express.Router();
app.use('/api', api);

api.get('/health', (_, res) => res.json({ ok: true, service: 'vireo-api', time: Date.now() }));

// ---------- 认证（注册/登录均限流，防暴力破解与批量注册） ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: Number(process.env.AUTH_RATE_MAX || 20),
  message: '操作过于频繁，请稍后再试',
});
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.LOGIN_RATE_MAX || 10),
  keyFn: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}`,
  message: '登录尝试过于频繁，请 1 分钟后再试',
});

api.post('/auth/register', authLimiter, (req, res) => {
  const body = validate(Z.register, req.body, res);
  if (!body) return;
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)) {
    return res.status(409).json({ error: '邮箱已注册' });
  }
  const user = {
    id: newId(),
    name: body.name || body.email.split('@')[0],
    email: body.email,
    password: hashPassword(body.password),
    role: 'user',
  };
  db.prepare(
    `INSERT INTO users (id, name, email, password_hash, role, daily_limit, disabled, created_at)
     VALUES (?, ?, ?, ?, 'user', 50, 0, ?)`
  ).run(user.id, user.name, user.email, user.password, Date.now());
  res.status(201).json({ token: signToken({ id: user.id, role: 'user' }), user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

api.post('/auth/login', authLimiter, loginLimiter, (req, res) => {
  const body = validate(Z.login, req.body, res);
  if (!body) return;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email);
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    return res.status(401).json({ error: '邮箱或密码不正确' });
  }
  if (user.disabled) return res.status(403).json({ error: '该账号已被停用' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

api.get('/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- 模型与状态 ----------
api.get('/models', auth, (_, res) => res.json(listModels()));

api.get('/status', auth, (req, res) => {
  const settings = getSettings(req.user.id);
  res.json({
    keys: keyStatus(req.user.id),
    search: searchStatus(),
    models: listModels().map((m) => ({ ...m, available: Boolean(resolveApiKey(req.user.id, m.provider).key) })),
    kbIds: parseJsonSafe(settings.kb_ids, []),
    quota: checkQuota(req.user),
  });
});

// ---------- 会话 ----------
api.get('/chats', auth, (req, res) => {
  res.json(
    db
      .prepare('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messageCount FROM chats c WHERE c.user_id = ? ORDER BY c.updated_at DESC')
      .all(req.user.id)
      .map((c) => ({ id: c.id, title: c.title, model: c.model, messageCount: c.messageCount, createdAt: c.created_at, updatedAt: c.updated_at }))
  );
});

api.post('/chats', auth, (req, res) => {
  const body = validate(Z.chat, req.body || {}, res);
  if (!body) return;
  const settings = getSettings(req.user.id);
  const chat = {
    id: newId(),
    user_id: req.user.id,
    title: body.title?.trim() || '新对话',
    model: body.model || settings.model || 'deepseek-chat',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  db.prepare('INSERT INTO chats (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(chat.id, chat.user_id, chat.title, chat.model, chat.created_at, chat.updated_at);
  res.status(201).json({ id: chat.id, title: chat.title, model: chat.model, messageCount: 0, createdAt: chat.created_at, updatedAt: chat.updated_at });
});

api.get('/chats/:id/messages', auth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: '会话不存在' });
  res.json(
    db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
      .all(chat.id)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, reasoning: m.reasoning || '', createdAt: m.created_at }))
  );
});

api.patch('/chats/:id', auth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: '会话不存在' });
  const title = z.string().trim().min(1).max(80).safeParse(req.body?.title);
  if (title.success) db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?').run(title.data, Date.now(), chat.id);
  res.json({ id: chat.id, title: title.success ? title.data : chat.title });
});

api.delete('/chats/:id', auth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: '会话不存在' });
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
  res.status(204).end();
});

// ---------- 文件 / 知识库 ----------
const ALLOWED_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml']);
const upload = multer({
  dest: path.join(dataDir, 'tmp'),
  limits: { fileSize: 20 * 1024 * 1024, files: 8 },
  fileFilter(_, file, cb) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(name).toLowerCase();
    // 白名单只放文本类：html/xhtml/svg/js 等会被浏览器渲染的格式一律拒收
    if (ALLOWED_EXT.has(ext) && (file.mimetype.startsWith('text/') || file.mimetype === 'application/json' || file.mimetype === 'application/octet-stream')) {
      return cb(null, true);
    }
    cb(new Error(`不支持的文件类型：${name}（仅支持 txt/md/csv/json 等文本文件）`));
  },
});

api.post('/files', auth, (req, res) => {
  upload.array('files', 8)(req, res, async (uploadError) => {
    if (uploadError) {
      // 清理 multer 已落盘的临时文件，避免残留占满磁盘
      for (const f of req.files || []) {
        try { fs.unlinkSync(f.path); } catch {}
      }
      const message = String(uploadError?.message || '').includes('File too large')
        ? '单个文件不能超过 20MB'
        : uploadError?.message || '上传失败';
      return res.status(400).json({ error: message });
    }
  const rows = [];
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8') || f.filename;
    const finalName = `${req.user.id}-${f.filename}`;
    const finalPath = path.join(uploadDir, finalName);
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.renameSync(f.path, finalPath);
    const row = {
      id: newId(),
      user_id: req.user.id,
      name,
      mime: f.mimetype,
      size: f.size,
      path: `/uploads/${finalName}`,
      status: 'pending',
      note: null,
      chunks: 0,
      created_at: Date.now(),
    };
    db.prepare('INSERT INTO files (id, user_id, name, mime, size, path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.user_id, row.name, row.mime, row.size, row.path, row.status, row.created_at);
    rows.push(row);
  }
  res.status(201).json(rows.map(toFileDto));
  for (const row of rows) {
    if (isSupported(row.name, row.mime)) {
      ingestFile(row).catch(() => {});
    } else {
      db.prepare("UPDATE files SET status = 'unsupported', note = '暂不支持该格式的知识库解析（当前支持 txt/md/csv/json 等文本文件）', chunks = 0 WHERE id = ?").run(row.id);
    }
  }
  });
});

function toFileDto(f) {
  return { id: f.id, name: f.name, mime: f.mime, size: f.size, status: f.status, note: f.note, chunks: f.chunks, createdAt: f.created_at };
}

api.get('/files', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id).map(toFileDto));
});

api.delete('/files/:id', auth, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  deleteFileArtifacts(file);
  db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
  const settings = getSettings(req.user.id);
  const kbIds = parseJsonSafe(settings.kb_ids, []).filter((x) => x !== file.id);
  saveSettings(req.user.id, { kbIds });
  res.status(204).end();
});

api.post('/files/:id/reindex', auth, async (req, res) => {
  const file = db.prepare("SELECT * FROM files WHERE id = ? AND user_id = ? AND status IN ('failed','pending')").get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在或无需重建' });
  db.prepare("UPDATE files SET status = 'pending', note = NULL WHERE id = ?").run(file.id);
  ingestFile(file)
    .then(() => {})
    .catch(() => {});
  res.json({ ok: true });
});

// ---------- 设置 ----------
api.get('/settings', auth, (req, res) => {
  const s = getSettings(req.user.id);
  res.json({
    model: s.model,
    searchEnabled: Boolean(s.search_enabled),
    kbIds: parseJsonSafe(s.kb_ids, []),
    apiKeysMasked: Object.fromEntries(Object.entries(parseJsonSafe(s.api_keys, {})).map(([k, v]) => [k, maskKey(v)])),
  });
});

api.put('/settings', auth, (req, res) => {
  const body = validate(Z.settings, req.body || {}, res);
  if (!body) return;
  const patch = { ...body };
  if (body.model && !getModel(body.model)) return res.status(400).json({ error: '不支持的模型' });
  if (body.apiKeys) {
    const current = parseJsonSafe(getSettings(req.user.id).api_keys, {});
    const next = { ...current };
    for (const [provider, key] of Object.entries(body.apiKeys)) {
      const trimmed = String(key || '').trim();
      if (trimmed === '') delete next[provider];
      else if (trimmed.includes('*')) continue; // 前端回显的掩码，忽略
      else next[provider] = trimmed;
    }
    patch.apiKeys = JSON.stringify(next);
  }
  if (body.kbIds) patch.kbIds = JSON.stringify(body.kbIds);
  if (typeof body.searchEnabled === 'boolean') patch.search_enabled = body.searchEnabled ? 1 : 0;
  const s = saveSettings(req.user.id, patch);
  res.json({ model: s.model, searchEnabled: Boolean(s.search_enabled), kbIds: parseJsonSafe(s.kb_ids, []) });
});

// ---------- 联网搜索（独立测试接口） ----------
api.post('/search', auth, async (req, res) => {
  const query = z.string().trim().min(1).max(400).safeParse(req.body?.query);
  if (!query.success) return res.status(400).json({ error: '请输入搜索内容' });
  try {
    const results = await webSearch(query.data, { maxResults: 6 });
    res.json({ results });
  } catch (error) {
    if (error instanceof SearchError) return res.status(503).json({ error: error.message });
    res.status(500).json({ error: '搜索失败，请稍后再试' });
  }
});

// ---------- 流式聊天 ----------
const activeStreams = new Map();

api.post('/chat/stop', auth, (req, res) => {
  const requestId = String(req.body?.requestId || '');
  const controller = activeStreams.get(requestId);
  if (controller) controller.abort();
  res.json({ stopped: Boolean(controller) });
});

api.post('/chat/stream', auth, async (req, res) => {
  const body = validate(Z.stream, req.body || {}, res);
  if (!body) return;

  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(body.chatId, req.user.id);
  if (!chat) return res.status(404).json({ error: '会话不存在' });
  const model = body.model || chat.model;
  if (!getModel(model)) return res.status(400).json({ error: `不支持的模型：${model}` });

  const quota = checkQuota(req.user);
  if (!quota.allowed) {
    return res.status(429).json({ error: `今日消息额度已用完（${quota.used}/${quota.limit} 条）。明天恢复，或联系管理员调整额度。` });
  }

  const history = body.messages.filter((m) => m.role !== 'system');
  const lastUser = [...history].reverse().find((m) => m.role === 'user');

  // 重新生成时，旧助手回复先保留在库里，等新回复成功落库后再删除；
  // 否则上游一旦报错，用户既丢旧答案又拿不到新答案。
  const priorAssistant = db
    .prepare("SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(chat.id);

  // 幂等：若最后一条用户消息尚未落库（首次发送场景），先保存
  const lastSaved = db.prepare("SELECT * FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1").get(chat.id);
  const userMessage = { id: newId(), chatId: chat.id, content: lastUser?.content ?? '' };
  if (lastUser && (!lastSaved || lastSaved.content !== lastUser.content)) {
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(userMessage.id, chat.id, 'user', userMessage.content, Date.now());
  }

  const settings = getSettings(req.user.id);
  const llmMessages = [{ role: 'system', content: '你是 Vireo，一个乐于助人的 AI 助手。请使用与用户提问相同的语言回答。Markdown 格式良好，代码用围栏标注语言。' }];

  const notices = [];

  // 知识库检索注入
  const kbIds = parseJsonSafe(settings.kb_ids, []);
  if (kbIds.length && lastUser) {
    const ready = db.prepare(`SELECT id FROM files WHERE id IN (${kbIds.map(() => '?').join(',')}) AND user_id = ? AND status = 'ready'`).all(...kbIds, req.user.id).map((r) => r.id);
    if (ready.length) {
      const chunks = retrieveChunks(req.user.id, lastUser.content, ready, 6);
      const context = buildKbContext(chunks);
      if (context) {
        llmMessages.push({ role: 'system', content: context });
        notices.push({ type: 'kb', count: chunks.length, files: [...new Set(chunks.map((c) => c.fileName))] });
      }
    }
  }

  // 联网搜索注入
  if (settings.search_enabled && lastUser) {
    if (searchStatus().configured) {
      try {
        const results = await webSearch(lastUser.content, { maxResults: 6 });
        if (results.length) {
          llmMessages.push({
            role: 'system',
            content: `以下是关于用户问题的最新网络搜索结果，请优先参考并在回答末尾列出来源链接。\n\n${results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`).join('\n\n')}`,
          });
          notices.push({ type: 'search', count: results.length, sources: results.slice(0, 6).map((r) => ({ title: r.title, url: r.url })) });
        }
      } catch (error) {
        notices.push({ type: 'search-error', message: error.message });
      }
    } else {
      notices.push({ type: 'search-error', message: '联网搜索已开启，但尚未配置搜索服务 Key，本次未执行搜索。' });
    }
  }

  llmMessages.push(...history.map((m) => ({ role: m.role, content: m.content })));

  const controller = new AbortController();
  activeStreams.set(body.requestId, controller);
  // 注意：不能监听 req 的 close —— body 解析完后即触发，会误判为客户端断开
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  writeSseHead(res);
  res.write(`data: ${JSON.stringify({ meta: { notices } })}\n\n`);
  // 心跳注释帧：让 Nginx 等中间层在有 Key 未配置、上游首包慢等静默期不切断连接
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  heartbeat.unref?.();

  // 新回复落库；若是重新生成，成功后才移除旧回复
  const persistAssistant = (content, reasoning) => {
    const id = newId();
    db.prepare('INSERT INTO messages (id, chat_id, role, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, chat.id, 'assistant', content, reasoning || null, Date.now());
    let deletedId = null;
    if (priorAssistant && priorAssistant.id !== id) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(priorAssistant.id);
      deletedId = priorAssistant.id;
    }
    return { id, deletedId };
  };

  let finished = false;
  try {
    const result = await streamChat({
      userId: req.user.id,
      model,
      messages: llmMessages,
      signal: controller.signal,
      onDelta: (piece) => res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`),
    });

    if (result.aborted && !result.content.trim()) {
      // 用户一开始生成就停止：不落空回复，旧回复原样保留
      recordUsage({ userId: req.user.id, chatId: chat.id, model, promptTokens: result.promptTokens, completionTokens: 0, ok: true });
      res.write(`data: ${JSON.stringify({ done: true, aborted: true, deletedMessageId: null })}\n\n`);
      finished = true;
    } else {
      const saved = persistAssistant(result.content, result.reasoning);
      db.prepare('UPDATE chats SET model = ?, updated_at = ? WHERE id = ?').run(model, Date.now(), chat.id);
      // 首条消息自动取标题
      if (chat.title === '新对话' && lastUser) {
        const t = lastUser.content.replace(/\s+/g, ' ').slice(0, 24);
        db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(t || chat.title, chat.id);
      }
      recordUsage({ userId: req.user.id, chatId: chat.id, model, promptTokens: result.promptTokens, completionTokens: result.completionTokens, ok: true });
      res.write(`data: ${JSON.stringify({ done: true, aborted: result.aborted, savedMessageId: saved.id, deletedMessageId: saved.deletedId, usage: { prompt: result.promptTokens, completion: result.completionTokens } })}\n\n`);
      finished = true;
    }
  } catch (error) {
    const isAbort = error?.name === 'AbortError' || error?.message === '已停止生成';
    if (isAbort) {
      res.write(`data: ${JSON.stringify({ done: true, aborted: true, deletedMessageId: null })}\n\n`);
      finished = true;
    } else {
      recordUsage({ userId: req.user.id, chatId: chat.id, model, promptTokens: 0, completionTokens: 0, ok: false });
      res.write(`data: ${JSON.stringify({ error: error instanceof GatewayError ? error.message : '模型服务暂时不可用，请稍后再试', userMessageId: userMessage.id })}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    activeStreams.delete(body.requestId);
    res.end();
  }
});

// ---------- 管理端 ----------
const admin = express.Router();
admin.use(auth, adminOnly);

admin.get('/users', (_, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json(
    rows.map((u) => ({
      ...publicUser(u),
      disabled: Boolean(u.disabled),
      messageCount: db.prepare('SELECT COUNT(*) n FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.user_id = ?').get(u.id).n,
      tokens: db.prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) t FROM usage WHERE user_id = ?').get(u.id).t,
      todayUsage: db.prepare('SELECT COUNT(*) n FROM usage WHERE user_id = ? AND created_at >= ? AND ok = 1').get(u.id, todayStart()).n,
    }))
  );
});

admin.patch('/users/:id', (req, res) => {
  const body = validate(Z.adminUser, req.body || {}, res);
  if (!body) return;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'admin' && body.disabled) return res.status(400).json({ error: '不能停用管理员账号' });
  if (typeof body.disabled === 'boolean') db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, user.id);
  if (typeof body.dailyLimit === 'number') db.prepare('UPDATE users SET daily_limit = ? WHERE id = ?').run(body.dailyLimit, user.id);
  if (body.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(body.name, user.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
});

admin.get('/keys', (_, res) => {
  const out = {};
  for (const [provider, meta] of Object.entries(PROVIDER_DEFAULTS)) {
    const value = settingValue(meta.keySetting);
    out[provider] = value ? { configured: true, masked: maskKey(value) } : { configured: false, masked: '' };
  }
  const searchKey = settingValue('platform_search_key') || process.env.SEARCH_API_KEY;
  out.search = searchKey ? { configured: true, masked: maskKey(searchKey) } : { configured: false, masked: '' };
  res.json(out);
});

admin.put('/keys', (req, res) => {
  const body = validate(Z.adminKeys, req.body || {}, res);
  if (!body) return;
  for (const [provider, key] of Object.entries(body)) {
    const trimmed = String(key || '').trim();
    if (trimmed.includes('*')) continue;
    if (trimmed === '') {
      if (provider === 'search') setSettingValue('platform_search_key', null);
      else setSettingValue(PROVIDER_DEFAULTS[provider].keySetting, null);
    } else if (provider === 'search') {
      setSettingValue('platform_search_key', trimmed);
    } else {
      setSettingValue(PROVIDER_DEFAULTS[provider].keySetting, trimmed);
    }
  }
  res.json({ ok: true });
});

admin.get('/stats', (_, res) => {
  const since7 = Date.now() - 7 * 86400000;
  const daily = db
    .prepare('SELECT strftime(\'%Y-%m-%d\', created_at/1000, \'unixepoch\', \'localtime\') day, COUNT(*) requests, SUM(prompt_tokens + completion_tokens) tokens FROM usage WHERE created_at >= ? GROUP BY day ORDER BY day')
    .all(since7);
  const byModel = db
    .prepare('SELECT model, COUNT(*) requests, SUM(prompt_tokens + completion_tokens) tokens FROM usage WHERE created_at >= ? GROUP BY model ORDER BY tokens DESC')
    .all(since7);
  res.json({
    totals: {
      users: db.prepare('SELECT COUNT(*) n FROM users WHERE role = ?').get('user').n,
      chats: db.prepare('SELECT COUNT(*) n FROM chats').get().n,
      messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
      todayRequests: db.prepare('SELECT COUNT(*) n FROM usage WHERE created_at >= ? AND ok = 1').get(todayStart()).n,
      tokens7d: db.prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) t FROM usage WHERE created_at >= ?').get(since7).t,
      files: db.prepare('SELECT COUNT(*) n FROM files').get().n,
    },
    daily,
    byModel,
  });
});

api.use('/admin', admin);

// ---------- 知识库原文件下载（必须鉴权，且只能取回自己的文件） ----------
// 早期版本用 express.static 直接暴露 /uploads，任何知道 URL 的人都能拿到他人文档，
// 且上传的 html 会以同源返回造成存储型 XSS。现改为按文件 ID 鉴权下发。
api.get('/files/:id/download', auth, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const abs = path.join(uploadDir, path.basename(file.path));
  if (!fs.existsSync(abs)) return res.status(410).json({ error: '文件已删除' });
  // 一律以附件形式下发并禁用 MIME 嗅探，避免浏览器内联渲染用户内容
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(abs).on('error', () => res.status(500).end()).pipe(res);
});

// ---------- 统一错误处理（请求体超限、解析失败等一律回 JSON，不外泄堆栈） ----------
app.use((err, _req, res, _next) => {
  if (res.headersSent) return res.end();
  const type = err?.type || '';
  if (err?.status === 413 || type === 'entity.too.large') {
    return res.status(413).json({ error: '对话内容过长，请开启新对话后重试' });
  }
  if (type === 'entity.parse.failed') return res.status(400).json({ error: '请求格式不正确' });
  console.error('[api] unhandled error:', err?.message || err);
  res.status(500).json({ error: '服务内部错误，请稍后再试' });
});

// 导出 server：测试结束后关闭监听，避免进程无法退出；直接 `node src/index.js` 时行为不变
export const server = app.listen(port, () => {
  console.log(`Vireo API listening on :${port} (data: ${dataDir})`);
});
