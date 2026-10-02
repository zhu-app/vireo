/**
 * Embedding 适配器（向量检索用）。
 * - 走 OpenAI 兼容 /embeddings 接口，复用 gateway 的密钥解析（个人 Key > 平台 Key > 环境变量）。
 * - 未配置 embedding 模型/Key 时，embedTexts 返回 null —— 调用方安全跳过，检索退化为纯关键词。
 * - 配置项：
 *     EMBEDDING_PROVIDER = qwen | 自定义供应商 id   （留空自动探测：qwen → 已配置的自定义供应商）
 *     EMBEDDING_MODEL    = text-embedding-v3（qwen 默认）/ text-embedding-3-small（其他默认）
 *     UPSTREAM_TIMEOUT_MS 复用 gateway 超时口径
 */
import { resolveApiKey, getProviderMeta, listProviders } from './gateway.js';

const QWEN_MODEL_DEFAULT = 'text-embedding-v3';
const FALLBACK_MODEL = 'text-embedding-3-small';

export class EmbedError extends Error {}

/** 选择供应商：显式配置优先，否则取第一个有 Key 的（qwen 优先，其次自定义） */
export function embeddingProvider(userId) {
  const explicit = (process.env.EMBEDDING_PROVIDER || '').trim().toLowerCase();
  const candidates = explicit ? [explicit] : ['qwen', ...listProviders().filter((p) => p.custom).map((p) => p.id)];
  for (const provider of candidates) {
    const meta = getProviderMeta(provider);
    if (!meta) continue;
    const { key } = resolveApiKey(userId, provider);
    if (key) {
      const defaultModel = provider === 'qwen' ? QWEN_MODEL_DEFAULT : FALLBACK_MODEL;
      return { provider, key, model: (process.env.EMBEDDING_MODEL || '').trim() || defaultModel, baseUrl: meta.baseUrl };
    }
  }
  return null;
}

export function embeddingStatus(userId) {
  const picked = embeddingProvider(userId);
  return picked
    ? { configured: true, provider: picked.provider, model: picked.model }
    : { configured: false, provider: null, model: null };
}

function embeddingsUrl(baseUrl) {
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/embeddings`;
  return `${baseUrl.replace(/\/$/, '')}/v1/embeddings`;
}

/**
 * 批量向量化。返回 { vectors: number[][], model, dim, provider }（vectors 与输入顺序一致）；
 * 供应商未配置时返回 null —— 调用方据此跳过向量生成。失败抛 EmbedError。
 */
export async function embedTexts(texts, userId) {
  const picked = embeddingProvider(userId);
  if (!picked) return null;
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '').slice(0, 8000));
  if (!list.length) return { vectors: [], model: picked.model, dim: 0, provider: picked.provider };

  const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000);
  const out = new Array(list.length);
  const BATCH = 10; // 多数兼容接口单次上限，稳妥取小值
  for (let start = 0; start < list.length; start += BATCH) {
    const slice = list.slice(start, start + BATCH);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(embeddingsUrl(picked.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${picked.key}` },
        body: JSON.stringify({ model: picked.model, input: slice, encoding_format: 'float' }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new EmbedError(`Embedding 服务返回错误（${res.status}）：${detail}`);
      }
      const json = await res.json();
      const items = Array.isArray(json.data) ? json.data : [];
      if (items.length !== slice.length) throw new EmbedError('Embedding 返回数量与请求不一致');
      for (const item of items) {
        const idx = Number(item.index);
        if (!Array.isArray(item.embedding) || !item.embedding.length) throw new EmbedError('Embedding 返回格式不正确');
        if (!Number.isInteger(idx) || idx < 0 || idx >= slice.length) throw new EmbedError('Embedding 返回索引越界');
        if (out[start + idx]) throw new EmbedError('Embedding 返回索引重复');
        out[start + idx] = item.embedding;
      }
    } catch (error) {
      if (error instanceof EmbedError) throw error;
      if (error.name === 'AbortError') throw new EmbedError(`Embedding 请求超时（${Math.round(timeoutMs / 1000)}s）`);
      throw new EmbedError(`Embedding 调用失败：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const dim = out[0]?.length || 0;
  if (out.some((v) => v?.length !== dim)) throw new EmbedError('Embedding 维度不一致');
  return { vectors: out, model: picked.model, dim, provider: picked.provider };
}

/** Float32 二进制 <-> 数组，供 SQLite BLOB 存取 */
export function packVector(vector) {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function unpackVector(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** 余弦相似度 */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
