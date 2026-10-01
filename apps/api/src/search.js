import { settingValue } from './db.js';

function provider() {
  const key = process.env.SEARCH_API_KEY || settingValue('platform_search_key');
  if (!key) return null;
  return { key, endpoint: process.env.SEARCH_ENDPOINT || 'https://api.tavily.com/search' };
}

export function searchStatus() {
  const configured = Boolean(process.env.SEARCH_API_KEY || settingValue('platform_search_key'));
  const name = String(process.env.SEARCH_ENDPOINT || 'https://api.tavily.com/search');
  return { configured, engine: name.includes('tavily') ? 'Tavily' : '自定义搜索接口' };
}

export class SearchError extends Error {}

/** 返回 [{ title, url, content, score }] */
export async function webSearch(query, { maxResults = 6 } = {}) {
  const cfg = provider();
  if (!cfg) throw new SearchError('联网搜索未配置。请设置环境变量 SEARCH_API_KEY，或由管理员在管理后台填入搜索服务 Key。');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        api_key: cfg.key,
        query: String(query).slice(0, 400),
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SearchError(`搜索服务返回错误（${res.status}）：${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const results = Array.isArray(json.results) ? json.results : [];
    return results
      .map((r) => ({
        title: String(r.title || '').slice(0, 200),
        url: String(r.url || '').slice(0, 500),
        content: String(r.content || '').slice(0, 1200),
        score: Number(r.score || 0),
      }))
      .filter((r) => r.content);
  } catch (error) {
    if (error instanceof SearchError) throw error;
    if (error.name === 'AbortError') throw new SearchError('搜索请求超时，请稍后再试');
    throw new SearchError(`搜索失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function buildSearchContext(results) {
  if (!results.length) return '';
  const body = results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`)
    .join('\n\n');
  return `以下是刚从互联网检索到的资料（检索时间：${new Date().toISOString()}），请基于这些资料回答，并在引用处用 [编号] 标注来源；若资料不足以回答，请明确说明。回答末尾请附上「参考资料」列表。\n\n${body}`;
}
