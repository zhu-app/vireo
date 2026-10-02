import React, { useEffect, useRef, useState } from 'react';
import { navigate } from '../lib/router.js';
import { api, streamChat } from '../lib/api.js';
import { Markdown } from '../markdown.jsx';

function Notice({ notice }) {
  if (notice.type === 'kb') {
    return <div className="notice"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13z" /></svg>已参考知识库{notice.via === 'hybrid' ? '（语义+关键词）' : ''}：{notice.files.join('、')}（{notice.count} 个片段）</div>;
  }
  if (notice.type === 'attachment') {
    return <div className="notice"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.5l-8.5 8.5a5.4 5.4 0 01-7.6-7.6L13.5 4.9a3.6 3.6 0 015.1 5.1L10 18.9a1.8 1.8 0 01-2.5-2.5l7.8-7.8" /></svg>已参考本对话附件{notice.via === 'hybrid' ? '（语义+关键词）' : ''}：{notice.files.join('、')}（{notice.count} 个片段）</div>;
  }
  if (notice.type === 'attachment-error') {
    return <div className="notice warn">⚠ 附件「{notice.files.join('、')}」解析失败，本次回答未引用其内容</div>;
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

function Message({ message, idx, isLast, busy, onRegenerate, onEdit, modelLabel }) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isUser = message.role === 'user';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const startEdit = () => { setDraft(message.content); setEditing(true); };
  const saveEdit = () => {
    const next = draft.trim();
    if (!next) return;
    setEditing(false);
    if (next !== message.content) onEdit?.(idx, next);
  };
  return (
    <article className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="avatar">{isUser ? '你' : <span className="logo-mark sm" />}</div>
      <div className="msg-body">
        {!isUser && message.reasoning && <ReasoningBlock reasoning={message.reasoning} streaming={isLast && busy && !message.content} />}
        {!isUser && message.notices?.map((n, i) => <Notice key={i} notice={n} />)}
        <div className="bubble">
          {isUser && editing ? (
            <div className="msg-edit">
              <textarea
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
              />
              <div className="msg-edit-actions">
                <button className="btn primary sm" onClick={saveEdit} disabled={!draft.trim()}>保存并重新生成</button>
                <button className="btn sm" onClick={() => setEditing(false)}>取消</button>
                <span className="muted edit-hint">将替换该条之后的全部对话</span>
              </div>
            </div>
          ) : isUser ? <p className="user-text">{message.content}</p>
            : message.content ? <Markdown text={message.content} streaming={isLast && busy} /> : !busy ? <span className="muted">（空回复）</span> : null}
        </div>
        <div className="msg-actions">
          <button onClick={copy} title="复制">{copied ? '✓ 已复制' : '复制'}</button>
          {isUser && message.id && !busy && !editing && <button onClick={startEdit} title="编辑后重新生成（替换此条之后的对话）">✎ 编辑</button>}
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
  const [model, setModel] = useState(chat.model || status?.model || '');
  const [streamError, setStreamError] = useState('');
  const [searchOn, setSearchOn] = useState(Boolean(status?.searchEnabled));
  const streamRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);

  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);

  const sendingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setBusy(false);
    setAttachments([]);
    api.messages(chat.id)
      .then((rows) => { if (!cancelled && !sendingRef.current) setMessages(rows); })
      .catch(() => {});
    api.attachments(chat.id).then((rows) => { if (!cancelled) setAttachments(rows); }).catch(() => {});
    return () => { cancelled = true; streamRef.current?.stop(); };
  }, [chat.id]);

  // 附件解析中：轮询刷新（与知识库页一致）
  // cancelled 防护：1.5s 轮询窗口内切换会话时，旧请求的响应不得覆盖新会话的附件列表
  useEffect(() => {
    if (!attachments.some((f) => f.status === 'pending')) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.attachments(chat.id).then((rows) => { if (!cancelled) setAttachments(rows); }).catch(() => {});
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [attachments, chat.id]);

  const refreshAttachments = () => api.attachments(chat.id).then(setAttachments).catch(() => {});

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
  // 无选中模型、或所选模型已不可用（被移除/供应商删除）时，自动切到第一个可用模型
  useEffect(() => {
    if (modelOptions.length && !modelOptions.some((m) => m.id === model)) setModel(modelOptions[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOptions.map((m) => m.id).join(','), model]);
  const providerLabel = (id) => (status?.providers || []).find((p) => p.id === id)?.name || ({ deepseek: 'DeepSeek', qwen: '通义千问' }[id] || id);

  function buildHistory(list) {
    return list.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
  }

  function send(payloadText, { regenerate = false, editAt = -1 } = {}) {
    // editAt：被编辑消息在本地列表中的下标。其内容替换为 payloadText，
    // 该条之后的消息从本地移除（后端仅在新回复成功后才真正截断）。
    const content = editAt >= 0
      ? (payloadText ?? '').trim()
      : (payloadText ?? text).trim();
    if (!content || busy) return;
    setStreamError('');

    let base;
    let editTargetId = null;
    if (editAt >= 0) {
      const edited = { ...messages[editAt], content };
      editTargetId = messages[editAt].id || null;
      base = [...messages.slice(0, editAt), edited];
    } else if (regenerate) {
      // 重新生成：去掉最后一条助手消息，保留其前的用户消息作为触发
      base = messages.slice(0, -1);
    } else {
      base = [...messages, { role: 'user', content }];
    }
    const placeholder = { role: 'assistant', content: '', reasoning: '', notices: null, error: false };
    sendingRef.current = true;
    setMessages([...base, placeholder]);
    if (editAt < 0 && !regenerate) setText('');
    setBusy(true);

    const history = buildHistory(base);
    streamRef.current = streamChat(
      { chatId: chat.id, model, messages: history, regenerate, editMessageId: editTargetId || undefined },
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
        onDone: (stats = {}) => {
          // 回填库中真实 id：编辑重发时无 id 的用户气泡、以及占位的助手回复
          setMessages((cur) => {
            const next = [...cur];
            if (stats.userMessageId && next.length >= 2) {
              const ui = next.length - 2;
              if (ui >= 0 && next[ui].role === 'user' && !next[ui].id) next[ui] = { ...next[ui], id: stats.userMessageId };
            }
            if (stats.savedMessageId) {
              const li = next.length - 1;
              if (li >= 0 && next[li]?.role === 'assistant') next[li] = { ...next[li], id: stats.savedMessageId };
            }
            return next;
          });
          sendingRef.current = false; setStreamError(''); setBusy(false);
        },
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

  // 编辑重发：content 为该条用户消息的新内容，基于它截断其后对话并重新生成
  const editMessage = (idx, content) => send(content, { editAt: idx });

  async function onUpload(e) {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    try {
      await api.uploadFiles(files, chat.id);
      e.target.value = '';
      await refreshAttachments();
    } catch (err) {
      setStreamError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function removeAttachment(f) {
    try {
      await api.deleteFile(f.id);
      await refreshAttachments();
    } catch (err) {
      setStreamError(err.message);
    }
  }

  async function reparseAttachment(f) {
    try {
      await api.reindexFile(f.id);
      await refreshAttachments();
    } catch (err) {
      setStreamError(err.message);
    }
  }

  const ATT_STATUS = { pending: '解析中…', ready: '可用', failed: '解析失败', unsupported: '格式不支持' };

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const canSend = text.trim() && !busy && modelOptions.length > 0;

  // ---- 对话级角色设定 ----
  const [personaOpen, setPersonaOpen] = useState(false);
  const [persona, setPersona] = useState(chat.systemPrompt || '');
  const [personaSaving, setPersonaSaving] = useState(false);
  useEffect(() => { setPersona(chat.systemPrompt || ''); }, [chat.id, chat.systemPrompt]);

  async function savePersona() {
    setPersonaSaving(true);
    try {
      const r = await api.updateChat(chat.id, { systemPrompt: persona.trim() });
      setPersona(r.systemPrompt ?? persona.trim());
      window.dispatchEvent(new Event('vireo:chats-changed')); // App 重新拉取会话，chat.systemPrompt 随 prop 更新
      setPersonaOpen(false);
    } catch (err) {
      setStreamError(err.message);
    } finally {
      setPersonaSaving(false);
    }
  }

  // ---- 导出会话为 Markdown（浏览器端拼好下载，无需后端） ----
  function exportMarkdown() {
    const done = messages.filter((m) => !m.error && m.content);
    if (!done.length) { setStreamError('当前会话还没有可导出的内容'); return; }
    const lines = [`# ${chat.title}`, ''];
    if (chat.systemPrompt) lines.push(`> 角色设定：${chat.systemPrompt.replace(/\n/g, ' ')}`, '');
    for (const m of done) {
      lines.push(m.role === 'user' ? '## 用户' : '## 助手', '', m.content.trim(), '');
    }
    lines.push('---', '', `_导出时间：${new Date().toLocaleString('zh-CN')} · 共 ${done.length} 条消息_`, '');
    const safeTitle = chat.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'chat';
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="chat-view">
      <header className="chat-head">
        <button className="ghost home-btn" onClick={onOpenHome} title="首页">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10.5L12 3l9 7.5V21h-6v-6h-6v6H3z" /></svg>
        </button>
        <h2 className="chat-title" title={chat.title}>{chat.title}</h2>
        <div className="head-tools">
          <button
            className={`chip-btn persona-btn ${chat.systemPrompt ? 'on' : ''}`}
            onClick={() => setPersonaOpen((v) => !v)}
            title="为本对话设定角色 / 系统提示词（覆盖默认助手人设）"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l2.4 6.9L21 11l-6.6 2.1L12 20l-2.4-6.9L3 11l6.6-2.1z" /></svg>
            <span>角色</span>
          </button>
          <label className="chip-toggle" title="开启后回答前会自动联网搜索">
            <input type="checkbox" checked={searchOn} onChange={async (e) => {
              setSearchOn(e.target.checked);
              await api.saveSettings({ searchEnabled: e.target.checked }).catch(() => {});
              refreshStatus?.();
            }} />
            <span>联网</span>
          </label>
          <select className="model-select" value={modelOptions.some((m) => m.id === model) ? model : ''} onChange={(e) => setModel(e.target.value)} title="当前模型">
            {modelOptions.length === 0 && <option value="">无可用模型 · 去设置获取</option>}
            {Object.entries(
              modelOptions.reduce((groups, m) => {
                const key = m.provider || 'other';
                (groups[key] ||= []).push(m);
                return groups;
              }, {})
            ).map(([provider, list]) => (
              <optgroup key={provider} label={providerLabel(provider)}>
                {list.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.reasoning ? ' · 思考' : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="icon-btn" onClick={exportMarkdown} title="导出本会话为 Markdown 文件">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M4 19h16" /></svg>
          </button>
        </div>
      </header>

      {personaOpen && (
        <div className="persona-panel">
          <div className="persona-head">
            <b>角色设定（本对话）</b>
            <button className="ghost" onClick={() => setPersonaOpen(false)}>×</button>
          </div>
          <p className="muted">为这个对话指定 AI 的身份与回答风格，留空使用默认助手人设。仅影响本会话，下一条消息起生效。</p>
          <textarea
            rows={3}
            maxLength={2000}
            placeholder="例如：你是一位严格的代码审查专家，回答指出问题并给出修改建议，不需要客套话。"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
          />
          <div className="persona-actions">
            <button className="btn primary sm" onClick={savePersona} disabled={personaSaving}>
              {personaSaving ? '保存中…' : '保存设定'}
            </button>
            {persona && (
              <button className="btn sm" onClick={() => setPersona('')} disabled={personaSaving}>清空</button>
            )}
            <span className="muted">{persona.length}/2000</span>
          </div>
        </div>
      )}

      <div className="msg-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-hint">
            <span className="logo-mark lg" />
            <p>开始和 Vireo 对话吧</p>
            {status?.kbIds?.length > 0 && <p className="muted">知识库已启用，回答会引用你上传的资料</p>}
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} idx={i} isLast={i === messages.length - 1} busy={busy} onRegenerate={m.role === 'assistant' && !m.error && !busy ? regenerate : undefined} onEdit={m.role === 'user' && m.id && !busy ? editMessage : undefined} modelLabel={currentModel?.name} />
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
        {attachments.length > 0 && (
          <div className="att-strip">
            <span className="att-label" title="附件只在这个对话里被引用，不会进知识库">本对话附件</span>
            {attachments.map((f) => (
              <span className={`att-chip ${f.status}`} key={f.id} title={f.status === 'ready' ? `${f.chunks} 个片段 · 仅本对话引用` : ATT_STATUS[f.status] || f.status}>
                <i className="att-dot" />
                <span className="att-name">{f.name}</span>
                {f.status === 'pending' && <em className="att-status">解析中</em>}
                {(f.status === 'failed' || f.status === 'unsupported') && <em className="att-status">不可用</em>}
                {f.status !== 'unsupported' && (
                  <button type="button" className="att-x" onClick={() => reparseAttachment(f)} title="重新解析（配置嵌入 Key 后可补语义向量）">↻</button>
                )}
                <button type="button" className="att-x" onClick={() => removeAttachment(f)} title="从本对话移除">×</button>
              </span>
            ))}
          </div>
        )}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input ref={fileRef} type="file" multiple hidden onChange={onUpload} accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yml,.yaml" />
          <button type="button" className="icon-btn" onClick={() => fileRef.current.click()} disabled={uploading} title="上传附件（仅本对话引用，不进知识库）">
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
