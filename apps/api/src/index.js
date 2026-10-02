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
  discoverModels,
  addManualModel,
  removeDynamicModel,
  listProviders,
  getProviderMeta,
  addProvider,
  updateProvider,
  deleteProvider,
  ProviderError,
  migrateStaleModelRefs,
  PROVIDER_DEFAULTS,
} from './gateway.js';
import { isSupported, ingestFile, retrieveChunks, buildKbContext, deleteFileArtifacts } from './kb.js';
import { webSearch, searchStatus, SearchError, buildSearchContext } from './search.js';
import { embeddingStatus } from './embedding.js';
import { rateLimit } from './ratelimit.js';

const app = express();
const port = Number(process.env.PORT || 8080);
seedAdmin(hashPassword);
migrateStaleModelRefs();

// 仅在明确部署于反代之后时开启：默认信任 X-Forwarded-For 会让直连方伪造头绕过按 IP 的限流
if (['1', 'true'].includes(String(process.env.TRUST_PROXY || '').toLowerCase())) {
  app.set('trust proxy', 1); // Nginx 反代下取真实 IP，供限流与日志使用
}

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
      // 仅「重新生成」时替换上一条助手回复；普通发消息一律追加，绝不删除历史
      regenerate: z.boolean().optional(),
    })
    .refine((b) => b.messages.some((m) => m.role === 'user' && m.content.trim()), {
      message: '缺少用户消息',
    }),
  settings: z.object({
    model: z.string().max(60).optional(),
    searchEnabled: z.boolean().optional(),
    kbIds: z.array(z.string()).max(50).optional(),
    // 供应商 id 合法性在路由内用 getProviderMeta 校验（内置 + 自定义动态变化，不用枚举）
    apiKeys: z.record(z.string().min(1).max(40), z.string().max(200)).optional(),
  }),
  provider: z.object({ name: z.string().trim().min(1).max(40), baseUrl: z.string().trim().min(10).max(300), key: z.string().max(200).optional() }),
  manualModel: z.object({ provider: z.string().trim().min(1).max(40), modelId: z.string().trim().min(1).max(60) }),
  providerUpdate: z.object({ name: z.string().trim().min(1).max(40).optional(), baseUrl: z.string().trim().min(10).max(300).optional(), key: z.string().max(200).optional() }),
  adminUser: z.object({ disabled: z.boolean().optional(), dailyLimit: z.number().int().min(0).max(1000000).optional(), name: z.string().trim().min(1).max(40).optional() }),
  adminKeys: z.record(z.string().min(1).max(40), z.string().max(200)).optional(),
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
api.get('/models', auth, (req, res) => res.json(listModels().map((m) => ({ ...m, available: Boolean(resolveApiKey(req.user.id, m.provider).key) }))));

// 供应商列表（内置 + 自定义），前端渲染密钥行与下拉分组
api.get('/providers', auth, (_, res) => res.json(listProviders()));

function handleProviderError(res, error) {
  if (error instanceof ProviderError) return res.status(error.status).json({ error: error.message });
  console.error('[providers] unexpected error:', error?.message || error);
  res.status(500).json({ error: '供应商操作失败，请稍后再试' });
}

// 自定义供应商仅管理员可增删改（其平台 Key 全用户共享）
api.post('/providers', auth, adminOnly, (req, res) => {
  const body = validate(Z.provider, req.body || {}, res);
  if (!body) return;
  try {
    res.status(201).json(addProvider(body));
  } catch (error) {
    handleProviderError(res, error);
  }
});

api.patch('/providers/:id', auth, adminOnly, (req, res) => {
  const body = validate(Z.providerUpdate, req.body || {}, res);
  if (!body) return;
  try {
    res.json(updateProvider(req.params.id, body));
  } catch (error) {
    handleProviderError(res, error);
  }
});

api.delete('/providers/:id', auth, adminOnly, (req, res) => {
  if (PROVIDER_DEFAULTS[req.params.id]) return res.status(400).json({ error: '内置供应商不可删除' });
  try {
    deleteProvider(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    handleProviderError(res, error);
  }
});

// 从上游拉取真实模型列表（过滤非对话类），持久化后全平台共享
api.post('/models/discover', auth, rateLimit({ windowMs: 60_000, max: 5, message: '获取模型列表过于频繁，请稍后再试' }), async (req, res) => {
  const provider = z.string().min(1).max(40).safeParse(req.body?.provider);
  if (!provider.success || !getProviderMeta(provider.data)) return res.status(400).json({ error: '请指定有效的供应商' });
  try {
    const discovered = await discoverModels(req.user.id, provider.data);
    res.json({ count: discovered.length, models: discovered });
  } catch (error) {
    if (error instanceof GatewayError) return res.status(error.status === 499 ? 502 : error.status).json({ error: error.message });
    res.status(500).json({ error: '获取模型列表失败，请稍后再试' });
  }
});

// 手动添加模型：适用于不提供 /v1/models 列表接口的上游（如微信 Coding Plan），管理员操作，全平台共享
api.post('/models/manual', auth, adminOnly, rateLimit({ windowMs: 60_000, max: 10, message: '添加模型过于频繁，请稍后再试' }), (req, res) => {
  const body = validate(Z.manualModel, req.body || {}, res);
  if (!body) return;
  try {
    res.status(201).json(addManualModel(body.provider, body.modelId));
  } catch (error) {
    if (error instanceof GatewayError) return res.status(error.status).json({ error: error.message });
    console.error('[models/manual] unexpected error:', error?.message || error);
    res.status(500).json({ error: '添加模型失败，请稍后再试' });
  }
});

// 移除一个动态发现的模型（内置模型不可删）
api.delete('/models/:id', auth, (req, res) => {
  const removed = removeDynamicModel(req.params.id);
  if (!removed) return res.status(400).json({ error: '内置模型不可移除，或该动态模型不存在' });
  res.json({ ok: true, removed });
});

api.get('/status', auth, (req, res) => {
  const settings = getSettings(req.user.id);
  res.json({
    keys: keyStatus(req.user.id),
    providers: listProviders(),
    search: searchStatus(),
    embedding: embeddingStatus(req.user.id),
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
    model: body.model || settings.model || '',
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
  // 会话附件随对话删除（不进知识库，离开本对话即无意义）
  const attachments = db.prepare('SELECT * FROM files WHERE user_id = ? AND chat_id = ?').all(req.user.id, chat.id);
  for (const f of attachments) deleteFileArtifacts(f);
  db.prepare('DELETE FROM files WHERE user_id = ? AND chat_id = ?').run(req.user.id, chat.id);
  res.status(204).end();
});

// ---------- 文件 / 知识库 ----------
const ALLOWED_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml']);
// 上传中途断连/异常可能让文件永久留在 tmp；每次启动先清空该目录回收残留
const uploadTmpDir = path.join(dataDir, 'tmp');
try {
  if (fs.existsSync(uploadTmpDir)) {
    for (const name of fs.readdirSync(uploadTmpDir)) {
      try { fs.rmSync(path.join(uploadTmpDir, name), { force: true }); } catch {}
    }
  }
} catch (error) {
  console.warn('[upload] 启动清理 tmp 目录失败：', error?.message || error);
}
const upload = multer({
  dest: uploadTmpDir,
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
  // chatId 为空 → 知识库长期文件；有值且属于当前用户 → 会话级附件（只在该对话中被引用）
  const rawChatId = String(req.body?.chatId || '').trim();
  let attachedChatId = null;
  if (rawChatId) {
    const owner = db.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?').get(rawChatId, req.user.id);
    if (!owner) {
      // multer 的临时文件在 dataDir/tmp 下，直接按 f.path 清理
      for (const f of req.files || []) {
        try { fs.unlinkSync(f.path); } catch {}
      }
      return res.status(404).json({ error: '会话不存在，无法作为附件上传' });
    }
    attachedChatId = owner.id;
  }
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
    try {
      db.prepare('INSERT INTO files (id, user_id, name, mime, size, path, status, created_at, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.user_id, row.name, row.mime, row.size, row.path, row.status, row.created_at, attachedChatId);
    } catch (error) {
      // 落库失败：回滚本轮已 rename 的文件与仍在 tmp 的剩余文件，避免残留占满磁盘
      for (const done of rows) {
        try { fs.unlinkSync(path.join(uploadDir, path.basename(done.path))); } catch {}
      }
      const remaining = [f, ...(req.files || []).slice((req.files || []).indexOf(f) + 1)];
      for (const rest of remaining) {
        try { if (fs.existsSync(rest.path)) fs.unlinkSync(rest.path); } catch {}
      }
      console.error('[upload] 落库失败，已回滚：', error?.message || error);
      return res.status(500).json({ error: '上传失败，请重试' });
    }
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
  res.json(db.prepare('SELECT * FROM files WHERE user_id = ? AND chat_id IS NULL ORDER BY created_at DESC').all(req.user.id).map(toFileDto));
});

// 会话级附件：只属于当前对话，不进知识库列表
api.get('/chats/:id/attachments', auth, (req, res) => {
  const chat = db.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: '会话不存在' });
  res.json(db.prepare('SELECT * FROM files WHERE user_id = ? AND chat_id = ? ORDER BY created_at DESC').all(req.user.id, chat.id).map(toFileDto));
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
  const file = db.prepare("SELECT * FROM files WHERE id = ? AND user_id = ? AND status != 'unsupported'").get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在或该格式无法解析重建' });
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
      if (!getProviderMeta(provider)) return res.status(400).json({ error: `供应商不存在：${provider}` });
      const trimmed = String(key || '').trim();
      if (trimmed === '') delete next[provider];
      else if (trimmed.includes('*')) continue; // 前端回显的掩码，忽略
      else next[provider] = trimmed;
    }
    // 清理指向已删除自定义供应商的旧 Key
    for (const provider of Object.keys(next)) {
      if (!getProviderMeta(provider)) delete next[provider];
    }
    patch.apiKeys = JSON.stringify(next);
  }
  if (Array.isArray(body.kbIds)) {
    // 只保留确实属于当前用户的知识库文件，防止把他人 id 存进设置形成脏引用
    const owned = new Set(db.prepare('SELECT id FROM files WHERE user_id = ? AND chat_id IS NULL').all(req.user.id).map((r) => r.id));
    patch.kbIds = JSON.stringify(body.kbIds.filter((id) => owned.has(id)));
  }
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
  // 与 /chat/stream 同口径：键绑定用户，防止猜测他人 requestId 跨账号打断
  const controller = activeStreams.get(`${req.user.id}:${requestId}`);
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

  // 仅「重新生成」才定位上一条助手回复（且保留到成功落库后再删除）；
  // 普通发消息一律追加，绝不删除历史——旧版无条件顶掉上一条回复，导致刷新后记录丢失。
  const isRegenerate = body.regenerate === true;
  const priorAssistant = isRegenerate
    ? db.prepare("SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1").get(chat.id)
    : null;

  // 幂等：若最后一条用户消息尚未落库（首次发送场景），先保存
  const lastSaved = db.prepare("SELECT * FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1").get(chat.id);
  const userMessage = { id: newId(), chatId: chat.id, content: lastUser?.content ?? '' };
  if (lastUser && (!lastSaved || lastSaved.content !== lastUser.content)) {
    db.prepare('INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(userMessage.id, chat.id, 'user', userMessage.content, Date.now());
  }

  const settings = getSettings(req.user.id);
  const now = new Date();
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const todayStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（星期${weekday}）`;
  const llmMessages = [{ role: 'system', content: `你是 Vireo，一个乐于助人的 AI 助手。请使用与用户提问相同的语言回答。Markdown 格式良好，代码用围栏标注语言。\n当前日期（服务器本地时间）：${todayStr}。涉及"今天/现在/最近"等时间问题时以此为准；若网络搜索结果与此日期冲突，以当前日期为准并提醒用户结果可能来自缓存页面。` }];

  const notices = [];

  // 知识库检索注入
  const kbIds = parseJsonSafe(settings.kb_ids, []);
  if (kbIds.length && lastUser) {
    const ready = db.prepare(`SELECT id FROM files WHERE id IN (${kbIds.map(() => '?').join(',')}) AND user_id = ? AND status = 'ready' AND chat_id IS NULL`).all(...kbIds, req.user.id).map((r) => r.id);
    if (ready.length) {
      const chunks = await retrieveChunks(req.user.id, lastUser.content, ready, 6);
      const context = buildKbContext(chunks);
      if (context) {
        llmMessages.push({ role: 'system', content: context });
        notices.push({ type: 'kb', count: chunks.length, via: chunks[0]?.via || 'keyword', files: [...new Set(chunks.map((c) => c.fileName))] });
      }
    }
  }

  // 会话附件注入：小文件全文直注（总结类问题不依赖检索召回），大文件走分块检索；解析失败时明确告知
  if (lastUser) {
    const attRows = db.prepare("SELECT id, name, status, size FROM files WHERE user_id = ? AND chat_id = ? AND status != 'pending' ORDER BY created_at ASC").all(req.user.id, chat.id);
    const failed = attRows.filter((f) => f.status === 'failed' || f.status === 'unsupported').map((f) => f.name);
    if (failed.length) notices.push({ type: 'attachment-error', files: failed });
    const readyFiles = attRows.filter((f) => f.status === 'ready');
    const FULL_TEXT_LIMIT = 48 * 1024; // ≤48KB 的文本按全文注入
    const totalSize = readyFiles.reduce((s, f) => s + (f.size || 0), 0);
    if (readyFiles.length && totalSize <= FULL_TEXT_LIMIT) {
      const parts = [];
      let budget = 24_000; // 全部附件的注入预算（字符），超限的文件退回检索
      const fallbackIds = [];
      for (const f of readyFiles) {
        const rows = db.prepare('SELECT text FROM kb_chunks WHERE file_id = ? ORDER BY idx ASC').all(f.id);
        const text = rows.map((r) => r.text).join('\n');
        if (text && budget >= text.length + f.name.length + 8) {
          parts.push(`【${f.name}】\n${text}`);
          budget -= text.length + f.name.length + 8;
        } else if (f.id) {
          fallbackIds.push(f.id);
        }
      }
      if (parts.length) {
        llmMessages.push({ role: 'system', content: `以下是用户上传到本对话的附件全文，请优先依据附件内容回答；提问涉及附件的任何部分（包括总结、"里面有什么"这类开放问题）都应引用附件。附件没有覆盖的可结合你自身知识，但要说明哪些来自附件。\n\n${parts.join('\n\n---\n\n')}` });
        notices.push({ type: 'attachment', count: parts.length, via: 'fulltext', files: readyFiles.filter((f) => parts.some((p) => p.startsWith(`【${f.name}】`))).map((f) => f.name) });
      }
      const bigIds = readyFiles.map((f) => f.id).filter((id) => fallbackIds.includes(id));
      if (bigIds.length) {
        const chunks = await retrieveChunks(req.user.id, lastUser.content, bigIds, 8);
        const context = buildKbContext(chunks);
        if (context) {
          llmMessages.push({ role: 'system', content: context });
          notices.push({ type: 'attachment', count: chunks.length, via: chunks[0]?.via || 'keyword', files: [...new Set(chunks.map((c) => c.fileName))] });
        }
      }
    } else if (readyFiles.length) {
      const chunks = await retrieveChunks(req.user.id, lastUser.content, readyFiles.map((f) => f.id), 8);
      const context = buildKbContext(chunks);
      if (context) {
        llmMessages.push({ role: 'system', content: context });
        notices.push({ type: 'attachment', count: chunks.length, via: chunks[0]?.via || 'keyword', files: [...new Set(chunks.map((c) => c.fileName))] });
      }
    }
  }

  // 联网搜索注入
  if (settings.search_enabled && lastUser) {
    if (searchStatus().configured) {
      try {
        const results = await webSearch(lastUser.content, { maxResults: 6 });
        if (results.length) {
          const context = buildSearchContext(results);
          if (context) {
            llmMessages.push({ role: 'system', content: context });
            notices.push({ type: 'search', count: results.length, sources: results.slice(0, 6).map((r) => ({ title: r.title, url: r.url })) });
          }
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
  // 键绑定用户：防止他人猜测 requestId 后跨账号打断别人的流
  const streamKey = `${req.user.id}:${body.requestId}`;
  activeStreams.set(streamKey, controller);
  // 注意：不能监听 req 的 close —— body 解析完后即触发，会误判为客户端断开
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  // 安全写：客户端断连（关页面/反代超时）后 res.write 会抛错，统一吞掉并返回 false，
  // 保证外层 try/finally 正常收尾（心跳清理、activeStreams 删除），进程不因写失败崩溃。
  const safeWrite = (payload) => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  // 声明在 try 外，保证 finally 一定能清理（writeSseHead 抛错时 heartbeat 仍为 null）
  let heartbeat = null;
  try {
    writeSseHead(res);
    safeWrite({ meta: { notices } });
    // 心跳注释帧：让 Nginx 等中间层在有 Key 未配置、上游首包慢等静默期不切断连接；
    // 写失败说明客户端已断开，顺带 abort 上游请求，避免无谓的流量与额度消耗。
    heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        controller.abort();
        return;
      }
      try {
        res.write(': ping\n\n');
      } catch {
        controller.abort();
      }
    }, 15_000);
    heartbeat.unref?.();
  } catch (error) {
    // 建连/写头阶段失败（客户端已断开等）：直接中止，不再无谓调用上游，走统一收尾
    console.error('[chat/stream] SSE 建连失败：', error?.message || error);
    controller.abort();
  }

  // 新回复落库 + 会话更新 + 用量记录：同一事务，避免「回复已入库但记账失败」导致额度统计不一致
  const persistAssistant = (content, reasoning, usageStats) => {
    const id = newId();
    let deletedId = null;
    db.transaction(() => {
      db.prepare('INSERT INTO messages (id, chat_id, role, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, chat.id, 'assistant', content, reasoning || null, Date.now());
      if (priorAssistant && priorAssistant.id !== id) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(priorAssistant.id);
        deletedId = priorAssistant.id;
      }
      db.prepare('UPDATE chats SET model = ?, updated_at = ? WHERE id = ?').run(model, Date.now(), chat.id);
      // 首条消息自动取标题
      if (chat.title === '新对话' && lastUser) {
        const t = lastUser.content.replace(/\s+/g, ' ').slice(0, 24);
        db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(t || chat.title, chat.id);
      }
      recordUsage({ userId: req.user.id, chatId: chat.id, model, promptTokens: usageStats.promptTokens, completionTokens: usageStats.completionTokens, ok: true });
    })();
    return { id, deletedId };
  };

  let finished = false;
  try {
    const result = await streamChat({
      userId: req.user.id,
      model,
      messages: llmMessages,
      signal: controller.signal,
      onDelta: (piece) => safeWrite({ delta: piece }),
    });

    if (result.aborted && !result.content.trim()) {
      // 用户一开始生成就停止：不落空回复，旧回复原样保留
      recordUsage({ userId: req.user.id, chatId: chat.id, model, promptTokens: result.promptTokens, completionTokens: 0, ok: true });
      safeWrite({ done: true, aborted: true, deletedMessageId: null });
      finished = true;
    } else {
      const saved = persistAssistant(result.content, result.reasoning, result);
      safeWrite({ done: true, aborted: result.aborted, savedMessageId: saved.id, deletedMessageId: saved.deletedId, usage: { prompt: result.promptTokens, completion: result.completionTokens } });
      finished = true;
    }
  } catch (error) {
    const isAbort = error?.name === 'AbortError' || error?.message === '已停止生成';
    if (isAbort) {
      safeWrite({ done: true, aborted: true, deletedMessageId: null });
      finished = true;
    } else {
      // 回复尚未落库才记 ok:false，避免与事务内成功记账重复
      recordUsage({ userId: req.user.id, chatId: chat.id, model, promptTokens: 0, completionTokens: 0, ok: false });
      safeWrite({ error: error instanceof GatewayError ? error.message : '模型服务暂时不可用，请稍后再试', userMessageId: userMessage.id });
    }
  } finally {
    clearInterval(heartbeat);
    activeStreams.delete(streamKey);
    try {
      res.end();
    } catch {}
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

// 删除用户：连带清理其会话、消息、知识库（分块+原文件）、用量与设置。管理员账号不可删除。
admin.delete('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'admin') return res.status(400).json({ error: '不能删除管理员账号' });
  const fileRows = db.prepare('SELECT * FROM files WHERE user_id = ?').all(user.id);
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)').run(user.id);
    db.prepare('DELETE FROM chats WHERE user_id = ?').run(user.id);
    for (const f of fileRows) deleteFileArtifacts(f);
    db.prepare('DELETE FROM kb_chunks WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM files WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM usage WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM settings WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  })();
  res.json({ ok: true, deletedUser: publicUser(user) });
});

admin.get('/keys', (_, res) => {
  const out = {};
  for (const meta of listProviders()) {
    const value = settingValue(meta.keySetting);
    out[meta.id] = value ? { configured: true, masked: maskKey(value) } : { configured: false, masked: '' };
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
    if (provider === 'search') {
      setSettingValue('platform_search_key', trimmed || null);
      continue;
    }
    const meta = getProviderMeta(provider);
    if (!meta) return res.status(400).json({ error: `供应商不存在：${provider}` });
    setSettingValue(meta.keySetting, trimmed || null);
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
      files: db.prepare('SELECT COUNT(*) n FROM files WHERE chat_id IS NULL').get().n,
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

// ---------- 进程兜底：SSE/定时器残余异常只记录不上抛，避免整个 API 进程被一次写失败带崩 ----------
process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandledRejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (error) => {
  console.error('[api] uncaughtException:', error?.message || error);
});

// 导出 server：测试结束后关闭监听，避免进程无法退出；直接 `node src/index.js` 时行为不变
export const server = app.listen(port, () => {
  console.log(`Vireo API listening on :${port} (data: ${dataDir})`);
});
