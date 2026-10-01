import React, { useEffect, useRef, useState } from 'react';
import { navigate } from '../lib/router.js';
import { api, streamChat } from '../lib/api.js';
import { Markdown } from '../markdown.jsx';

function Notice({ notice }) {
  if (notice.type === 'kb') {
    return <div className="notice"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13z" /></svg>已参考知识库{notice.via === 'hybrid' ? '（语义+关键词）' : ''}：{notice.files.join('、')}（{notice.count} 个片段）</div>;
  }
  if (notice.type === 'search') {
    return (
      <div className="notice ok">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" /></svg>
        联网搜索到 {notice.count} 条结果：
        {notice.sources?.length > 0 && (
          <span className="src-links">{notice.sources.slice(0, 4).map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>[{i + 1}]</a>)}</span>
        )}
      </div>
    );
  }
  if (notice.type === 'search-error') {
    return <div className="notice warn">⚠ {notice.message}</div>;
  }
  return null;
}

function ReasoningBlock({ reasoning, streaming }) {
  const [open, setOpen] = useState(false);
  if (!reasoning) return null;
  return (
    <div className="reasoning">
      <button className="reasoning-toggle" onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={open ? 'chev open' : 'chev'}><path d="M9 6l6 6-6 6" /></svg>
        {streaming && !open ? '深度思考中…' : open ? (streaming ? '正在思考' : '已完成思考') : '查看思考过程'}
      </button>
      {open && <div className="reasoning-body">{reasoning}</div>}
    </div>
  );
}

function Message({ message, isLast, busy, onRegenerate, modelLabel }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <article className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="avatar">{isUser ? '你' : <span className="logo-mark sm" />}</div>
      <div className="msg-body">
        {!isUser && message.reasoning && <ReasoningBlock reasoning={message.reasoning} streaming={isLast && busy && !message.content} />}
        {!isUser && message.notices?.map((n, i) => <Notice key={i} notice={n} />)}
        <div className="bubble">
          {isUser ? <p className="user-text">{message.content}</p> : message.content ? <Markdown text={message.content} streaming={isLast && busy} /> : !busy ? <span className="muted">（空回复）</span> : null}
        </div>
        <div className="msg-actions">
          <button onClick={copy} title="复制">{copied ? '✓ 已复制' : '复制'}</button>
          {!isUser && isLast && !busy && onRegenerate && <button onClick={onRegenerate} title="重新生成">↻ 重新生成</button>}
          {!isUser && isLast && busy && <span className="typing"><i /><i /><i /></span>}
          {!isUser && message.content && !busy && <span className="model-tag">{modelLabel}</span>}
        </div>
      </div>
    </article>
  );
}

export default function ChatView({ chat, models, status, refreshStatus, onOpenHome, initialText, onInitialConsumed }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(chat.model || status?.model || 'deepseek-chat');
  const [streamError, setStreamError] = useState('');
  const [searchOn, setSearchOn] = useState(Boolean(status?.searchEnabled));
  const streamRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);

  const sendingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setBusy(false);
    api.messages(chat.id)
      .then((rows) => { if (!cancelled && !sendingRef.current) setMessages(rows); })
      .catch(() => {});
    return () => { cancelled = true; streamRef.current?.stop(); };
  }, [chat.id]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 首页建议带入的初始问题：消息加载完成后自动发送一次
  useEffect(() => {
    if (!initialText) return;
    if (messages.length === 0) {
      setText(initialText);
      onInitialConsumed?.();
      setTimeout(() => sendRef.current?.(initialText), 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText, messages.length]);

  const sendRef = useRef(null);
  useEffect(() => {
    sendRef.current = (t) => {
      if (!t?.trim()) return;
      send(t);
    };
  });

  // 回答结束后刷新侧栏（标题可能被后端自动改写）
  useEffect(() => {
    if (!busy) window.dispatchEvent(new Event('vireo:chats-changed'));
  }, [busy]);

  const modelOptions = (status?.models || models || []).filter((m) => m.available);
  const currentModel = (status?.models || models || []).find((m) => m.id === model);

  function buildHistory(list) {
    return list.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
  }

  function send(payloadText, { regenerate = false } = {}) {
    const content = (payloadText ?? text).trim();
    if (!content || busy) return;
    setStreamError('');

    let base;
    if (regenerate) {
      // 重新生成：去掉最后一条助手消息，保留其前的用户消息作为触发
      base = messages.slice(0, -1);
    } else {
      base = [...messages, { role: 'user', content }];
    }
    const placeholder = { role: 'assistant', content: '', reasoning: '', notices: null, error: false };
    sendingRef.current = true;
    setMessages([...base, placeholder]);
    if (!regenerate) setText('');
    setBusy(true);

    const history = buildHistory(base);
    streamRef.current = streamChat(
      { chatId: chat.id, model, messages: history },
      {
        onMeta: (meta) => {
          setMessages((cur) => {
            const next = [...cur];
            next[next.length - 1] = { ...next[next.length - 1], notices: meta.notices || [] };
            return next;
          });
        },
        onDelta: (piece) => {
          setMessages((cur) => {
            const next = [...cur];
            const last = { ...next[next.length - 1] };
            if (piece.content) last.content += piece.content;
            if (piece.reasoning) last.reasoning += piece.reasoning;
            next[next.length - 1] = last;
            return next;
          });
        },
        onDone: () => { sendingRef.current = false; setStreamError(''); setBusy(false); },
        onError: (err) => {
          sendingRef.current = false;
          setStreamError(err.message);
          // 后端失败时会保留旧回复并落库用户消息，重新拉取即可恢复真实历史
          api.messages(chat.id)
            .then((rows) => { if (!sendingRef.current) setMessages(rows); })
            .catch(() => {
              setMessages((cur) => {
                const next = [...cur];
                next[next.length - 1] = { ...next[next.length - 1], error: true, content: `⚠ ${err.message}` };
                return next;
              });
            });
          setBusy(false);
          refreshStatus?.();
        },
      }
    );
  }

  const stop = () => {
    streamRef.current?.stop();
    sendingRef.current = false;
    setBusy(false);
  };

  const regenerate = () => send(null, { regenerate: true });

  async function onUpload(e) {
    const files = e.target.files;
    if (!files?.length) return;
    try {
      await api.uploadFiles(files);
      e.target.value = '';
      refreshStatus?.();
      window.dispatchEvent(new Event('vireo:files-changed'));
    } catch (err) {
      setStreamError(err.message);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const canSend = text.trim() && !busy && modelOptions.length > 0;

  return (
    <section className="chat-view">
      <header className="chat-head">
        <button className="ghost home-btn" onClick={onOpenHome} title="首页">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10.5L12 3l9 7.5V21h-6v-6h-6v6H3z" /></svg>
        </button>
        <h2 className="chat-title" title={chat.title}>{chat.title}</h2>
        <div className="head-tools">
          <label className="chip-toggle" title="开启后回答前会自动联网搜索">
            <input type="checkbox" checked={searchOn} onChange={async (e) => {
              setSearchOn(e.target.checked);
              await api.saveSettings({ searchEnabled: e.target.checked }).catch(() => {});
              refreshStatus?.();
            }} />
            <span>联网</span>
          </label>
          <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} title="当前模型">
            {(modelOptions.length ? modelOptions : [currentModel || { id: model, name: model }]).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      </header>

      <div className="msg-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-hint">
            <span className="logo-mark lg" />
            <p>开始和 {currentModel?.name || '模型'} 对话吧</p>
            {status?.kbIds?.length > 0 && <p className="muted">知识库已启用，回答会引用你上传的资料</p>}
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} isLast={i === messages.length - 1} busy={busy} onRegenerate={m.role === 'assistant' && !m.error && !busy ? regenerate : undefined} modelLabel={currentModel?.name} />
        ))}
      </div>

      <div className="composer-wrap">
        {streamError && (
          <div className="notice warn" role="alert">
            ⚠ {streamError}
            <button className="ghost" style={{ marginLeft: 8 }} onClick={() => setStreamError('')}>知道了</button>
          </div>
        )}
        {modelOptions.length === 0 && (
          <div className="key-hint">尚未配置可用的模型 API Key —— <a href="#/settings" onClick={(e) => { e.preventDefault(); navigate('#/settings'); }}>去设置 →</a></div>
        )}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input ref={fileRef} type="file" multiple hidden onChange={onUpload} accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yml,.yaml" />
          <button type="button" className="icon-btn" onClick={() => fileRef.current.click()} title="上传文件到知识库">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.5l-8.5 8.5a5.4 5.4 0 01-7.6-7.6L13.5 4.9a3.6 3.6 0 015.1 5.1L10 18.9a1.8 1.8 0 01-2.5-2.5l7.8-7.8" /></svg>
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder="给 Vireo 发送消息…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            }}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button type="button" className="btn stop" onClick={stop} title="停止生成">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <button type="submit" className="btn primary send" disabled={!canSend} title="发送">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>
          )}
        </form>
        <p className="composer-tip">内容由 AI 生成，请仔细甄别</p>
      </div>
    </section>
  );
}
