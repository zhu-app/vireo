const BASE = '';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function getToken() {
  return localStorage.getItem('vireo-token') || '';
}

export function setSession(token, user) {
  localStorage.setItem('vireo-token', token);
  localStorage.setItem('vireo-user', JSON.stringify(user));
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem('vireo-user') || 'null');
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem('vireo-token');
  localStorage.removeItem('vireo-user');
}

async function request(path, options = {}) {
  const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...options, headers });
  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new Event('vireo:logout'));
    throw new ApiError('登录已过期，请重新登录', 401);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || `请求失败（${res.status}）`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  register: (body) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () => request('/api/auth/me'),
  models: () => request('/api/models'),
  status: () => request('/api/status'),
  chats: () => request('/api/chats'),
  createChat: (body = {}) => request('/api/chats', { method: 'POST', body: JSON.stringify(body) }),
  messages: (chatId) => request(`/api/chats/${chatId}/messages`),
  renameChat: (chatId, title) => request(`/api/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: (chatId) => request(`/api/chats/${chatId}`, { method: 'DELETE' }),
  files: () => request('/api/files'),
  uploadFiles: (fileList) => {
    const form = new FormData();
    [...fileList].forEach((f) => form.append('files', f));
    return request('/api/files', { method: 'POST', body: form });
  },
  deleteFile: (id) => request(`/api/files/${id}`, { method: 'DELETE' }),
  reindexFile: (id) => request(`/api/files/${id}/reindex`, { method: 'POST' }),
  // 下载需要 Authorization，无法用裸链接，改为 fetch blob 后触发浏览器保存
  downloadFile: async (id, name) => {
    const res = await fetch(`/api/files/${id}/download`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data.error || `下载失败（${res.status}）`, res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  testSearch: (query) => request('/api/search', { method: 'POST', body: JSON.stringify({ query }) }),
  stop: (requestId) => request('/api/chat/stop', { method: 'POST', body: JSON.stringify({ requestId }) }),
  adminUsers: () => request('/api/admin/users'),
  adminPatchUser: (id, body) => request(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  adminKeys: () => request('/api/admin/keys'),
  adminSaveKeys: (body) => request('/api/admin/keys', { method: 'PUT', body: JSON.stringify(body) }),
  adminStats: () => request('/api/admin/stats'),
};

/**
 * 流式对话。回调：onMeta(meta)、onDelta({content,reasoning})、onDone(stats)、回调异常不中断读取。
 * 返回 { stop() 主动停止 }
 */
export function streamChat({ chatId, model, messages }, { onMeta, onDelta, onDone, onError }) {
  const requestId = `req-${crypto.randomUUID()}`;
  const controller = new AbortController();
  (async () => {
    try {
      // 与后端校验同口径的预检：超限直接本地报错，不发无望的请求
      const total = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      if (total > 200_000 || messages.length > 100) {
        throw new ApiError('对话内容过长，请开启新对话后重试', 413);
      }
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ chatId, requestId, model, messages }),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401) {
          clearSession();
          window.dispatchEvent(new Event('vireo:logout'));
          throw new ApiError('登录已过期，请重新登录', 401);
        }
        const data = await res.json().catch(() => ({}));
        const fallback = res.status === 413 ? '对话内容过长，请开启新对话后重试' : `请求失败（${res.status}）`;
        throw new ApiError(data.error || fallback, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let payload;
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (payload.meta) onMeta?.(payload.meta);
          else if (payload.delta) onDelta?.(payload.delta);
          else if (payload.error) { if (!completed) { completed = true; onError?.(new ApiError(payload.error, 502)); } }
          else if (payload.done && !completed) {
            completed = true;
            onDone?.({ aborted: Boolean(payload.aborted), usage: payload.usage || null });
          }
        }
      }
      if (!completed) onDone?.({ aborted: false, usage: null });
    } catch (error) {
      if (error.name === 'AbortError') return; // 主动停止，静默
      onError?.(error);
    }
  })();
  return {
    requestId,
    stop() {
      controller.abort();
      api.stop(requestId).catch(() => {});
    },
  };
}
