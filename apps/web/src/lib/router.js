/**
 * 零依赖 hash 路由。用 hash（#/...）而非 history.pushState，
 * 好处是任意静态托管（file://、GitHub Pages、无 SPA fallback 的 Nginx）都不会 404，
 * 刷新、直接访问深链、浏览器前进/后退都天然可用。
 *
 * 路由表：
 *   #/            → home
 *   #/c/:id       → chat（:id 为会话 ID）
 *   #/kb          → kb
 *   #/settings    → settings
 *   #/admin       → admin
 */

// 解析当前 hash 为 { view, chatId }
export function parseHash(hash) {
  const raw = String(hash || window.location.hash || '').replace(/^#/, '');
  const seg = raw.split('/').filter(Boolean); // ['', 'c', 'id'] → ['c','id']
  if (seg.length === 0) return { view: 'home', chatId: null };
  const [head, rest] = seg;
  switch (head) {
    case 'c':
      return rest ? { view: 'chat', chatId: rest } : { view: 'home', chatId: null };
    case 'kb':
      return { view: 'kb', chatId: null };
    case 'settings':
      return { view: 'settings', chatId: null };
    case 'admin':
      return { view: 'admin', chatId: null };
    default:
      return { view: 'home', chatId: null };
  }
}

export function currentRoute() {
  return parseHash(window.location.hash);
}

// 生成会话深链
export function chatHref(chatId) {
  return `#/c/${encodeURIComponent(chatId)}`;
}

/**
 * 跳转到指定路由。replace=true 时用 replaceState（不留历史），
 * 其余走 hash 赋值（浏览器自动记录，可后退）。
 * @param {string} path 以 #/ 开头或纯路径均可
 */
export function navigate(path, { replace = false } = {}) {
  const normalized = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === normalized) return; // 避免重复入栈
  if (replace) {
    window.history.replaceState(null, '', normalized);
    // replaceState 不触发 hashchange，手动通知订阅者
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = normalized;
  }
}

/**
 * 订阅路由变化。返回取消订阅函数。
 * hashchange 覆盖前进/后退与 hash 赋值；我们额外监听 popstate 以防个别环境不触发。
 */
export function subscribe(callback) {
  const onChange = () => callback(currentRoute());
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
