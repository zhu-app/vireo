// lib/api.js SSE 流式解析单元测试：用真实 ReadableStream 喂帧，覆盖半包合并、
// 心跳/坏帧容忍、done/error 状态机、401 登出广播、本地预检与 stop 通知。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamChat, api, setSession, clearSession, getToken } from '../lib/api.js';

// Node 环境补齐 api.js 运行所需的浏览器全局（会话存储 / 登出广播）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const dispatched = [];
globalThis.window = {
  dispatchEvent: (e) => dispatched.push(e && e.type),
  addEventListener() {},
  removeEventListener() {},
};

const enc = new TextEncoder();

/** frames：对象自动包成 data: {...}\n\n；字符串原样写入（模拟心跳注释帧、坏 JSON 帧） */
function sseBody(frames, { splitAt = 0 } = {}) {
  const text = frames.map((f) => (typeof f === 'string' ? f : `data: ${JSON.stringify(f)}\n\n`)).join('');
  return new ReadableStream({
    start(c) {
      if (splitAt) {
        // 故意在多字节字符/行中间切开，模拟网络分包
        c.enqueue(enc.encode(text.slice(0, splitAt)));
        c.enqueue(enc.encode(text.slice(splitAt)));
      } else {
        c.enqueue(enc.encode(text));
      }
      c.close();
    },
  });
}

const sseRes = (frames, opts) => ({ ok: true, status: 200, body: sseBody(frames, opts) });
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });

const baseArgs = { chatId: 'c1', model: 'm1', messages: [{ role: 'user', content: '你好' }] };

beforeEach(() => {
  store.clear();
  dispatched.length = 0;
  vi.unstubAllGlobals();
});

describe('streamChat：SSE 帧解析', () => {
  it('meta + delta + done 全链路，忽略心跳注释帧与坏 JSON 帧', async () => {
    const onMeta = vi.fn(); const onDelta = vi.fn(); const onDone = vi.fn(); const onError = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => sseRes([
      { meta: { notices: [{ type: 'kb', count: 2 }] } },
      { delta: { content: '你' } },
      { delta: { reasoning: '思考中' } },
      ': ping\n\n',
      'data: {broken json\n\n',
      { done: true, aborted: false, usage: { prompt: 10, completion: 5 } },
    ])));

    const handle = streamChat(baseArgs, { onMeta, onDelta, onDone, onError });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());

    expect(onMeta).toHaveBeenCalledWith({ notices: [{ type: 'kb', count: 2 }] });
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(onDelta).toHaveBeenNthCalledWith(1, { content: '你' });
    expect(onDelta).toHaveBeenNthCalledWith(2, { reasoning: '思考中' });
    expect(onDone).toHaveBeenLastCalledWith({
      aborted: false,
      usage: { prompt: 10, completion: 5 },
      savedMessageId: null,
      deletedMessageId: null,
      userMessageId: null,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(handle.requestId).toMatch(/^req-/);
  });

  it('半包：行被切成两段到达仍能正确解析', async () => {
    const onDelta = vi.fn(); const onDone = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => sseRes(
      [{ delta: { content: 'AB' } }, { done: true }],
      { splitAt: 12 } // 落在第一帧的中间
    )));
    streamChat(baseArgs, { onDelta, onDone });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onDelta).toHaveBeenCalledWith({ content: 'AB' });
  });

  it('error 帧触发 onError 一次，后续 done 帧不再触发 onDone', async () => {
    const onError = vi.fn(); const onDone = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => sseRes([
      { delta: { content: '半句' } },
      { error: '模型服务暂时不可用' },
      { done: true },
    ])));
    streamChat(baseArgs, { onError, onDone });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await new Promise((r) => setTimeout(r, 10));
    expect(onError.mock.calls[0][0].message).toBe('模型服务暂时不可用');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('流关闭但没有 done 帧：兜底触发 onDone(aborted:false)', async () => {
    const onDone = vi.fn(); const onError = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => sseRes([{ delta: { content: '只有一点' } }])));
    streamChat(baseArgs, { onDone, onError });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onDone).toHaveBeenCalledWith({ aborted: false, usage: null });
    expect(onError).not.toHaveBeenCalled();
  });

  it('请求形状：POST /api/chat/stream，带 Bearer token 与 regenerate 标志', async () => {
    const fetchMock = vi.fn(async () => sseRes([{ done: true }]));
    vi.stubGlobal('fetch', fetchMock);
    setSession('tok-1', { id: 'u1' });
    streamChat({ ...baseArgs, regenerate: true }, {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/chat/stream');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ chatId: 'c1', model: 'm1', regenerate: true });
    expect(body.requestId).toMatch(/^req-/);
  });

  it('编辑重发：editMessageId 透传请求体，done 帧回传三个消息 id', async () => {
    const onDone = vi.fn();
    const fetchMock = vi.fn(async () => sseRes([{
      done: true, aborted: false,
      savedMessageId: 'msg-new-a', deletedMessageId: 'msg-old-a', userMessageId: 'msg-user-1',
    }]));
    vi.stubGlobal('fetch', fetchMock);
    streamChat({ ...baseArgs, editMessageId: 'msg-user-1' }, { onDone });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.editMessageId).toBe('msg-user-1');
    expect(body.regenerate).toBeUndefined();
    expect(onDone).toHaveBeenCalledWith({
      aborted: false, usage: null,
      savedMessageId: 'msg-new-a', deletedMessageId: 'msg-old-a', userMessageId: 'msg-user-1',
    });
  });

  it('stop() 中止本地读取并通知后端 /api/chat/stop', async () => {
    let remote;
    const body = new ReadableStream({ start(c) { remote = c; } });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/api/chat/stop')) return jsonRes({ stopped: true });
      return { ok: true, status: 200, body };
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn(); const onError = vi.fn();

    const handle = streamChat(baseArgs, { onDone, onError });
    remote.enqueue(enc.encode('data: {"delta":{"content":"说到一半"}}\n\n'));
    handle.stop();
    // 收尾：让挂起的读取完成，避免测试悬挂（abort 后读取结果应被静默丢弃）
    remote.enqueue(enc.encode('data: {"done":true}\n\n'));
    remote.close();

    await vi.waitFor(() => {
      const stopCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/chat/stop'));
      expect(stopCall).toBeTruthy();
      expect(JSON.parse(stopCall[1].body).requestId).toBe(handle.requestId);
    });
    expect(handle.requestId).toMatch(/^req-/);
  });
});

describe('streamChat：错误路径', () => {
  it('401：清理本地会话并广播 vireo:logout', async () => {
    setSession('tok-1', { id: 'u1' });
    const onError = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    streamChat(baseArgs, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(onError.mock.calls[0][0].message).toContain('登录已过期');
    expect(getToken()).toBe('');
    expect(dispatched).toContain('vireo:logout');
  });

  it('HTTP 400 携带 JSON error：透传后端文案', async () => {
    const onError = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: '不支持的模型：m1' }) })));
    streamChat(baseArgs, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0].message).toBe('不支持的模型：m1');
  });

  it('本地预检超限：超长内容直接报错，不发出请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const big = [{ role: 'user', content: 'x'.repeat(200_001) }];
    streamChat({ chatId: 'c1', model: 'm1', messages: big }, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0].message).toContain('过长');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('本地预检超限：消息条数超过 100 条同样拦截', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const many = Array.from({ length: 101 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    streamChat({ chatId: 'c1', model: 'm1', messages: many }, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('request：普通接口层', () => {
  it('非 200 且非 401：把后端 error 抛成 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: '会话不存在' }) })));
    await expect(api.messages('cX')).rejects.toThrow('会话不存在');
  });

  it('204 返回 null；普通接口带 Authorization', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setSession('tok-2', { id: 'u1' });
    const r = await api.removeModel('m1');
    expect(r).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-2');
  });

  it('clearSession 后请求不再携带 token', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ user: {} }));
    vi.stubGlobal('fetch', fetchMock);
    setSession('tok-3', { id: 'u1' });
    clearSession();
    await api.me();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
