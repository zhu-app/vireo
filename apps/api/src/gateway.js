import crypto from 'node:crypto';
import db, { getSettings, parseJsonSafe, settingValue, setSettingValue, todayStart } from './db.js';

// 内置供应商只保留 DeepSeek 与通义千问；其他一律走「自定义供应商」（OpenAI 兼容接口）
const PROVIDER_DEFAULTS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
    keySetting: 'platform_deepseek_key',
  },
  qwen: {
    name: '通义千问',
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY',
    keySetting: 'platform_qwen_key',
  },
};

// 不再内置任何默认模型：所有模型都来自「填入 Key → 获取模型列表」的发现结果
const MODELS = [];

/**
 * 动态模型（上游 /models 接口发现后持久化在 platform_settings，全平台共享）
 * 存储结构：{ [provider]: [{ id, name, reasoning, discovered_at }] }
 */
const DYNAMIC_KEY = 'dynamic_models';

/** 自定义供应商存储：{ [id]: { id, name, baseUrl, createdAt } }，平台级共享 */
const CUSTOM_PROVIDERS_KEY = 'custom_providers';
const MAX_CUSTOM_PROVIDERS = 20;

function loadCustomProviders() {
  const stored = parseJsonSafe(settingValue(CUSTOM_PROVIDERS_KEY), {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function saveCustomProviders(map) {
  setSettingValue(CUSTOM_PROVIDERS_KEY, JSON.stringify(map));
}

function customKeySetting(id) {
  return `platform_custom_key:${id}`;
}

/** 统一供应商元信息入口：内置优先，其次自定义 */
export function getProviderMeta(provider) {
  if (PROVIDER_DEFAULTS[provider]) return { id: provider, ...PROVIDER_DEFAULTS[provider], custom: false };
  const custom = loadCustomProviders()[provider];
  if (custom) return { id: provider, name: custom.name, baseUrl: custom.baseUrl, keySetting: customKeySetting(provider), custom: true };
  return null;
}

/** 全部供应商（内置 + 自定义），供前端展示与分组；含 keySetting 供管理后台读取平台 Key */
export function listProviders() {
  const custom = Object.keys(loadCustomProviders())
    .map((id) => getProviderMeta(id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const builtin = Object.keys(PROVIDER_DEFAULTS).map((id) => getProviderMeta(id));
  return [...builtin, ...custom];
}

function slugify(text) {
  const ascii = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.slice(0, 24) || `cp-${crypto.randomBytes(3).toString('hex')}`;
}

export class ProviderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 新增自定义供应商；key 可选（平台级共享 Key） */
export function addProvider({ name, baseUrl, key }) {
  const trimmedName = String(name || '').trim();
  const url = String(baseUrl || '').trim();
  if (!trimmedName || trimmedName.length > 40) throw new ProviderError('供应商名称需为 1-40 个字符');
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new ProviderError('接口地址需以 http:// 或 https:// 开头');
  const map = loadCustomProviders();
  if (Object.keys(map).length >= MAX_CUSTOM_PROVIDERS) throw new ProviderError(`自定义供应商数量已达上限（${MAX_CUSTOM_PROVIDERS}）`);
  if (PROVIDER_DEFAULTS[trimmedName.toLowerCase()]) throw new ProviderError('该名称与内置供应商冲突');
  let id = slugify(trimmedName);
  while (map[id] || PROVIDER_DEFAULTS[id]) id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
  map[id] = { id, name: trimmedName, baseUrl: url.replace(/\/+$/, ''), createdAt: Date.now() };
  saveCustomProviders(map);
  if (key) setSettingValue(customKeySetting(id), String(key).trim());
  return map[id];
}

/** 更新自定义供应商（名称/地址/平台 Key） */
export function updateProvider(id, { name, baseUrl, key }) {
  const map = loadCustomProviders();
  if (!map[id]) throw new ProviderError('自定义供应商不存在', 404);
  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName || trimmedName.length > 40) throw new ProviderError('供应商名称需为 1-40 个字符');
    map[id].name = trimmedName;
  }
  if (baseUrl !== undefined) {
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new ProviderError('接口地址需以 http:// 或 https:// 开头');
    const normalized = String(baseUrl).trim().replace(/\/+$/, '');
    if (normalized !== map[id].baseUrl) {
      // 地址变更：旧发现结果属于原上游，一并清理，需重新「获取模型列表」
      map[id].baseUrl = normalized;
      const dyn = parseJsonSafe(settingValue(DYNAMIC_KEY), {});
      if (dyn[id]) {
        delete dyn[id];
        setSettingValue(DYNAMIC_KEY, JSON.stringify(dyn));
      }
    }
  }
  if (key !== undefined) {
    const trimmed = String(key).trim();
    if (trimmed && !trimmed.includes('*')) setSettingValue(customKeySetting(id), trimmed);
  }
  saveCustomProviders(map);
  return map[id];
}

/** 删除自定义供应商，连带清理其平台 Key 与已发现的模型 */
export function deleteProvider(id) {
  const map = loadCustomProviders();
  if (!map[id]) throw new ProviderError('自定义供应商不存在', 404);
  delete map[id];
  saveCustomProviders(map);
  setSettingValue(customKeySetting(id), null);
  const dyn = parseJsonSafe(settingValue(DYNAMIC_KEY), {});
  if (dyn[id]) {
    delete dyn[id];
    setSettingValue(DYNAMIC_KEY, JSON.stringify(dyn));
  }
  return true;
}

/** 常见模型品牌词：美化显示名时映射为官方写法 */
const BRAND_MAP = {
  deepseek: 'DeepSeek', qwen: 'Qwen', glm: 'GLM', kimi: 'Kimi', llama: 'Llama',
  claude: 'Claude', gemini: 'Gemini', ernie: 'ERNIE', doubao: 'Doubao', moonshot: 'Moonshot',
};

/**
 * 把模型 id 美化为可读显示名：deepseek-v4-pro → DeepSeek V4 Pro；gpt-4o → GPT 4o。
 * 未识别的片段仅首字母大写；纯数字保留；4o/4.1 这类带小写后缀的规格保留原样。
 */
export function prettifyModelName(id) {
  const tokens = String(id || '').split(/[-_.]+/).filter(Boolean);
  return tokens
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === 'gpt') return 'GPT';
      if (BRAND_MAP[lower]) return BRAND_MAP[lower];
      if (/^\d+[a-z]$/.test(lower)) return lower; // 4o 这类规格后缀
      if (/^v\d+(\.\d+)?$/.test(lower)) return lower.toUpperCase(); // v4 → V4
      if (/^\d+$/.test(lower)) return lower; // 日期/版本号数字
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** 明显不是对话模型的 id 特征（embedding、语音、图像、视频、审核等；whisper/sora 等专名单独列出） */
const NON_CHAT_PATTERN = /(embedding|moderation|audio|realtime|transcribe|translate|tts|whisper|speech|voice|dall[\w-]*e|sora|image|video|rerank|ocr|asr)/i;

function loadDynamicModels() {
  const stored = parseJsonSafe(settingValue(DYNAMIC_KEY), {});
  const out = [];
  const seen = new Set(); // 同一 id 可能被多个供应商发现，仅保留首个
  for (const [provider, list] of Object.entries(stored)) {
    if (!getProviderMeta(provider) || !Array.isArray(list)) continue;
    for (const m of list) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({
        id: m.id,
        provider,
        name: m.name && m.name !== m.id ? m.name : prettifyModelName(m.id),
        reasoning: Boolean(m.reasoning),
        vision: false,
        desc: m.manual ? '手动添加' : '上游发现',
        manual: Boolean(m.manual),
        dynamic: true,
      });
    }
  }
  return out;
}

/** 内置 + 动态合并视图；动态模型若与内置同 id 则忽略（内置定义信息更全） */
function allModels() {
  const builtinIds = new Set(MODELS.map((m) => m.id));
  return [...MODELS, ...loadDynamicModels().filter((m) => !builtinIds.has(m.id))];
}

export function listModels() {
  return allModels();
}

export function getModel(modelId) {
  return allModels().find((m) => m.id === modelId) || null;
}

/** 启动时一次性迁移：把指向不存在模型（如旧版内置 deepseek-chat）的默认值清空，由用户重新选择 */
export function migrateStaleModelRefs() {
  const valid = new Set(allModels().map((m) => m.id));
  let cleared = 0;
  for (const row of db.prepare("SELECT user_id, model FROM settings WHERE model <> ''").all()) {
    if (!valid.has(row.model)) {
      db.prepare("UPDATE settings SET model = '' WHERE user_id = ?").run(row.user_id);
      cleared += 1;
    }
  }
  // 历史会话的 model 保留（usage 统计需要），仅新会话与发送时校验兜底
  if (cleared) console.log(`[gateway] 已清理 ${cleared} 个用户的失效默认模型引用`);
  return cleared;
}

/**
 * 从供应商上游拉取模型列表，过滤非对话类后持久化（同供应商整体替换）。
 * 返回新增的模型数组；失败抛 GatewayError。
 */
export async function discoverModels(userId, provider) {
  const meta = getProviderMeta(provider);
  if (!meta) throw new GatewayError(`不支持的供应商：${provider}`, 400);
  const { key } = resolveApiKey(userId, provider);
  if (!key) throw new GatewayError(`${meta.name} 的 API Key 未配置，无法获取模型列表`, 400);

  const base = /\/v\d+$/.test(meta.baseUrl) ? meta.baseUrl : `${meta.baseUrl.replace(/\/$/, '')}/v1`;
  const controller = new AbortController();
  // 发现接口是秒级小响应，用独立超时；不要与流式对话共用的 UPSTREAM_TIMEOUT_MS 混用
  const timer = setTimeout(() => controller.abort(), Number(process.env.DISCOVER_TIMEOUT_MS || 30_000));
  let upstream;
  try {
    upstream = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
  } catch (error) {
    throw new GatewayError(`无法连接 ${meta.name} 模型列表接口：${error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    // 上游响应体可能含敏感信息：只进日志，用户侧只给状态码
    console.error(`[gateway] ${meta.name} 模型列表错误（${upstream.status}）：${detail}`);
    throw new GatewayError(`${meta.name} 模型列表接口返回错误（${upstream.status}），请检查接口地址与 API Key`, 502);
  }
  const json = await upstream.json().catch(() => null);
  const items = Array.isArray(json?.data) ? json.data : [];
  const builtinIds = new Set(MODELS.filter((m) => m.provider === provider).map((m) => m.id));
  const discovered = [];
  for (const item of items) {
    const id = String(item?.id || '');
    if (!id || id.length > 60 || NON_CHAT_PATTERN.test(id) || builtinIds.has(id)) continue;
    discovered.push({ id, name: prettifyModelName(id), reasoning: /(reason|r1|thinking)/i.test(id), discovered_at: Date.now() });
  }
  if (!discovered.length) throw new GatewayError(`${meta.name} 未发现可对话的新模型（列表为空或均已存在）`, 502);

  const stored = parseJsonSafe(settingValue(DYNAMIC_KEY), {});
  // 整体替换时保留该供应商下手动添加且未被重复发现的模型
  const prevManual = (Array.isArray(stored[provider]) ? stored[provider] : []).filter(
    (m) => m?.manual && m?.id && !discovered.some((d) => d.id === m.id)
  );
  stored[provider] = [...prevManual, ...discovered].slice(0, 100); // 防异常响应撑爆设置表
  setSettingValue(DYNAMIC_KEY, JSON.stringify(stored));
  return discovered;
}

/**
 * 手动添加模型：适用于不实现 GET /v1/models 列表接口的上游（如微信 Coding Plan），
 * 直接写入与「获取模型列表」相同的 dynamic_models 存储，全平台共享。
 */
export function addManualModel(providerId, modelId) {
  const meta = getProviderMeta(providerId);
  if (!meta) throw new GatewayError(`不支持的供应商：${providerId}`, 400);
  const id = String(modelId || '').trim();
  if (!id || id.length > 60 || !/^[A-Za-z0-9._:[-]+$/.test(id)) {
    throw new GatewayError('模型 ID 需为 1-60 个字符，仅允许字母、数字及 . _ : - 符号（请从平台页面原样复制，勿手打）', 400);
  }
  if (getModel(id)) throw new GatewayError(`模型「${id}」已存在，无需重复添加`, 400);

  const stored = parseJsonSafe(settingValue(DYNAMIC_KEY), {});
  const list = Array.isArray(stored[providerId]) ? stored[providerId] : [];
  list.push({ id, name: prettifyModelName(id), reasoning: /(reason|r1|thinking)/i.test(id), manual: true, discovered_at: Date.now() });
  stored[providerId] = list.slice(0, 100);
  setSettingValue(DYNAMIC_KEY, JSON.stringify(stored));
  return { id, name: prettifyModelName(id), provider: providerId, manual: true };
}

/** 删除某个动态模型（内置不可删） */
export function removeDynamicModel(modelId) {
  const stored = parseJsonSafe(settingValue(DYNAMIC_KEY), {});
  let removed = null;
  for (const [provider, list] of Object.entries(stored)) {
    if (!Array.isArray(list)) continue;
    const keep = list.filter((m) => m?.id !== modelId);
    if (keep.length !== list.length) {
      removed = modelId;
      if (keep.length) stored[provider] = keep;
      else delete stored[provider];
    }
  }
  if (removed) setSettingValue(DYNAMIC_KEY, JSON.stringify(stored));
  return removed;
}

function maskKey(key) {
  if (!key || key.length < 8) return key ? '***' : '';
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export function resolveApiKey(userId, provider) {
  const settings = getSettings(userId);
  const userKeys = parseJsonSafe(settings.api_keys, {});
  const fromUser = userKeys[provider];
  if (fromUser) return { key: fromUser, source: 'user' };
  const meta = getProviderMeta(provider);
  if (!meta) return { key: null, source: null };
  const fromPlatform = settingValue(meta.keySetting);
  if (fromPlatform) return { key: fromPlatform, source: 'platform' };
  if (!meta.custom && meta.keyEnv && process.env[meta.keyEnv]) return { key: process.env[meta.keyEnv], source: 'env' };
  return { key: null, source: null };
}

export function keyStatus(userId) {
  const out = {};
  for (const meta of listProviders()) {
    const { key, source } = resolveApiKey(userId, meta.id);
    out[meta.id] = key ? { configured: true, source, masked: maskKey(key) } : { configured: false, source: null, masked: '' };
  }
  return out;
}

export class GatewayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function estimateTokens(text) {
  const chars = [...String(text || '')];
  let cjk = 0;
  for (const ch of chars) if (/[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]/.test(ch)) cjk += 1;
  const rest = chars.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.75 + rest / 4));
}

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function writeSseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * 流式调用上游模型。回调回调形式抛出增量，结束后返回统计。
 * onDelta({ content?, reasoning? })
 */
export async function streamChat({ userId, model, messages, signal, onDelta }) {
  const modelInfo = getModel(model);
  if (!modelInfo) throw new GatewayError(`未知模型：${model}。请先在「设置」页为对应供应商「获取模型列表」`, 400);
  const meta = getProviderMeta(modelInfo.provider);
  if (!meta) throw new GatewayError(`模型「${model}」所属供应商已被移除，请重新选择模型`, 400);
  const { key } = resolveApiKey(userId, modelInfo.provider);
  if (!key) {
    throw new GatewayError(
      `${meta.name} 的 API Key 未配置。请到「设置」页填入你自己的 Key，或让管理员配置平台级 Key。`,
      400
    );
  }

  const body = { model: modelInfo.id, messages, stream: true, stream_options: { include_usage: true } };
  if (modelInfo.reasoning) body.response_format = undefined;

  const url = /\/v\d+$/.test(meta.baseUrl) ? `${meta.baseUrl}/chat/completions` : `${meta.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  // 上游整体超时（默认 120s）：连接或响应挂死时主动断开，避免请求与内存长期占用
  const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const abortBoth = () => timeout.abort();
  signal?.addEventListener('abort', abortBoth);
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortBoth);
  };
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
  } catch (error) {
    cleanup();
    if (signal?.aborted) throw new GatewayError('已停止生成', 499);
    if (error?.name === 'AbortError') throw new GatewayError(`${meta.name} 响应超时（${Math.round(timeoutMs / 1000)}s），请稍后重试`, 504);
    throw new GatewayError(`无法连接 ${meta.name} 服务：${error.message}`, 502);
  }
  // 超时保护延续到流式读取结束，避免首个分片后挂死的上游不被断开

  if (!upstream.ok || !upstream.body) {
    cleanup();
    const text = await upstream.text().catch(() => '');
    // 上游响应体可能夹带 Key、内部地址等信息：只进服务端日志，不回显给用户
    console.error(`[gateway] ${meta.name} 上游错误（${upstream.status}）：${text.slice(0, 300)}`);
    let summary = '';
    try {
      const json = JSON.parse(text);
      summary = String(json.error?.message || '');
    } catch {}
    const friendly =
      upstream.status === 401 ? `${meta.name} 拒绝了该 API Key，请检查是否有效` :
      upstream.status === 429 ? `${meta.name} 请求过于频繁或余额不足，请稍后再试` :
      summary ? `${meta.name} 返回错误（${upstream.status}）：${summary.slice(0, 120)}` :
      `${meta.name} 返回错误（${upstream.status}），请稍后再试`;
    throw new GatewayError(friendly, 502);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        const piece = { content: undefined, reasoning: undefined };
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          piece.reasoning = delta.reasoning_content;
        }
        if (delta.content) {
          content += delta.content;
          piece.content = delta.content;
        }
        if (piece.content || piece.reasoning) onDelta(piece);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      // 用户主动停止，或超时前已产出部分内容：按中断返回，已生成内容照常落库
      if (signal?.aborted || content.trim()) {
        return { content, reasoning, usage, promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)), completionTokens: usage?.completion_tokens ?? estimateTokens(content), aborted: true };
      }
      throw new GatewayError(`${meta.name} 响应超时（${Math.round(timeoutMs / 1000)}s），请稍后重试`, 504);
    }
    throw new GatewayError(`模型响应中断：${error.message}`, 502);
  } finally {
    cleanup();
    reader.releaseLock?.();
  }

  return {
    content,
    reasoning,
    usage,
    promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
    completionTokens: usage?.completion_tokens ?? estimateTokens(content),
    aborted: false,
  };
}

export function checkQuota(user) {
  const limit = Number(user.daily_limit || 0);
  if (!Number.isFinite(limit) || limit <= 0) return { allowed: true, used: 0, limit: null };
  const used = db
    .prepare('SELECT COUNT(*) AS n FROM usage WHERE user_id = ? AND created_at >= ? AND ok = 1')
    .get(user.id, todayStart()).n;
  return { allowed: used < limit, used, limit };
}

export function recordUsage({ userId, chatId, model, promptTokens, completionTokens, ok }) {
  db.prepare(
    `INSERT INTO usage (user_id, chat_id, model, prompt_tokens, completion_tokens, ok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, chatId || null, model || null, promptTokens || 0, completionTokens || 0, ok ? 1 : 0, Date.now());
}

export { maskKey, PROVIDER_DEFAULTS, loadCustomProviders };
export const newAbortError = () => Object.assign(new Error('aborted'), { name: 'AbortError', id: crypto.randomUUID() });
