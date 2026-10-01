import crypto from 'node:crypto';
import db, { getSettings, parseJsonSafe, settingValue, setSettingValue, todayStart } from './db.js';

const PROVIDER_DEFAULTS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
    keySetting: 'platform_deepseek_key',
  },
  openai: {
    name: 'OpenAI',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    keySetting: 'platform_openai_key',
  },
  qwen: {
    name: '通义千问',
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY',
    keySetting: 'platform_qwen_key',
  },
};

const MODELS = [
  { id: 'deepseek-chat', provider: 'deepseek', name: 'DeepSeek Chat', reasoning: false, vision: false, desc: '通用对话，响应快' },
  { id: 'deepseek-reasoner', provider: 'deepseek', name: 'DeepSeek Reasoner', reasoning: true, vision: false, desc: '深度思考，适合复杂推理' },
  { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', reasoning: false, vision: true, desc: '多模态旗舰模型' },
  { id: 'qwen-max', provider: 'qwen', name: '通义千问 Max', reasoning: false, vision: false, desc: '中文能力突出' },
];

/**
 * 动态模型（上游 /models 接口发现后持久化在 platform_settings，全平台共享）
 * 存储结构：{ [provider]: [{ id, name, reasoning, discovered_at }] }
 */
const DYNAMIC_KEY = 'dynamic_models';

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
  for (const [provider, list] of Object.entries(stored)) {
    if (!PROVIDER_DEFAULTS[provider] || !Array.isArray(list)) continue;
    for (const m of list) {
      if (!m?.id) continue;
      out.push({
        id: m.id,
        provider,
        name: m.name && m.name !== m.id ? m.name : prettifyModelName(m.id),
        reasoning: Boolean(m.reasoning),
        vision: false,
        desc: '上游发现',
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

/**
 * 从供应商上游拉取模型列表，过滤非对话类后持久化（同供应商整体替换）。
 * 返回新增的模型数组；失败抛 GatewayError。
 */
export async function discoverModels(userId, provider) {
  const meta = PROVIDER_DEFAULTS[provider];
  if (!meta) throw new GatewayError(`不支持的供应商：${provider}`, 400);
  const { key } = resolveApiKey(userId, provider);
  if (!key) throw new GatewayError(`${meta.name} 的 API Key 未配置，无法获取模型列表`, 400);

  const base = /\/v\d+$/.test(meta.baseUrl) ? meta.baseUrl : `${meta.baseUrl.replace(/\/$/, '')}/v1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.UPSTREAM_TIMEOUT_MS || 30_000));
  let upstream;
  try {
    upstream = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
  } catch (error) {
    throw new GatewayError(`无法连接 ${meta.name} 模型列表接口：${error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 200);
    throw new GatewayError(`${meta.name} 模型列表接口返回错误（${upstream.status}）：${detail}`, 502);
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
  if (!discovered.length) throw new GatewayError(`${meta.name} 未发现可对话的新模型（列表为空或全部已内置）`, 502);

  const stored = parseJsonSafe(settingValue(DYNAMIC_KEY), {});
  stored[provider] = discovered.slice(0, 100); // 防异常响应撑爆设置表
  setSettingValue(DYNAMIC_KEY, JSON.stringify(stored));
  return discovered;
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
  const meta = PROVIDER_DEFAULTS[provider];
  if (!meta) return { key: null, source: null };
  const fromPlatform = settingValue(meta.keySetting);
  if (fromPlatform) return { key: fromPlatform, source: 'platform' };
  const fromEnv = process.env[meta.keyEnv];
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { key: null, source: null };
}

export function keyStatus(userId) {
  const out = {};
  for (const [provider, meta] of Object.entries(PROVIDER_DEFAULTS)) {
    const { key, source } = resolveApiKey(userId, provider);
    out[provider] = key ? { configured: true, source, masked: maskKey(key) } : { configured: false, source: null, masked: '' };
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
  if (!modelInfo) throw new GatewayError(`未知模型：${model}`, 400);
  const meta = PROVIDER_DEFAULTS[modelInfo.provider];
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
    let detail = text.slice(0, 300);
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || detail;
    } catch {}
    const friendly =
      upstream.status === 401 ? `${meta.name} 拒绝了该 API Key，请检查是否有效` :
      upstream.status === 429 ? `${meta.name} 请求过于频繁或余额不足，请稍后再试` :
      `${meta.name} 返回错误（${upstream.status}）：${detail}`;
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

export { maskKey, PROVIDER_DEFAULTS };
export const newAbortError = () => Object.assign(new Error('aborted'), { name: 'AbortError', id: crypto.randomUUID() });
