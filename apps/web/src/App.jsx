import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken, getUser, clearSession } from './lib/api.js';
import { currentRoute, subscribe, navigate, chatHref } from './lib/router.js';
import Auth from './components/Auth.jsx';
import Home from './components/Home.jsx';
import ChatView from './components/ChatView.jsx';
import KnowledgeBase from './components/KnowledgeBase.jsx';
import Settings from './components/Settings.jsx';
import Admin from './components/Admin.jsx';

const THEME_KEY = 'vireo-theme';

export default function App() {
  const [user, setUser] = useState(() => (getToken() ? getUser() : null));
  const [route, setRoute] = useState(() => currentRoute()); // { view, chatId }
  const [chats, setChats] = useState([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [status, setStatus] = useState(null);
  const [pendingText, setPendingText] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [streamMessage, setStreamMessage] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');

  // 路由派生状态：视图与当前会话完全由 URL 决定，支持刷新 / 深链 / 前进后退
  const { view, chatId } = route;
  const current = view === 'chat' && chatId ? chats.find((c) => c.id === chatId) || null : null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // 订阅路由变化（前进/后退、外部改 hash、我们自己的 navigate 都会触发）
  useEffect(() => subscribe(setRoute), []);

  const refreshStatus = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.status(), api.settings()]);
      setStatus({ ...s, ...st, user: getUser() });
    } catch {}
  }, []);

  const loadChats = useCallback(async () => {
    try {
      setChats(await api.chats());
    } catch {}
    setChatsLoaded(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshStatus();
    loadChats();
  }, [user, refreshStatus, loadChats]);

  useEffect(() => {
    if (user) {
      const onChatsChanged = () => loadChats();
      window.addEventListener('vireo:chats-changed', onChatsChanged);
      return () => window.removeEventListener('vireo:chats-changed', onChatsChanged);
    }
  }, [user, loadChats]);

  // 登录后回到该去的路由；退出登录重置为首页
  useEffect(() => {
    if (!user && window.location.hash && window.location.hash !== '#/') {
      navigate('#/', { replace: true });
    }
  }, [user]);

  useEffect(() => {
    const onLogout = () => {
      setUser(null);
      setChats([]);
      setChatsLoaded(false);
    };
    window.addEventListener('vireo:logout', onLogout);
    return () => window.removeEventListener('vireo:logout', onLogout);
  }, []);

  if (!user) return <Auth onAuth={(u) => setUser(u)} />;

  async function newChat(seedText = '') {
    try {
      const c = await api.createChat({ model: status?.model });
      setChats((v) => [c, ...v]);
      setPendingText(seedText);
      setSidebarOpen(false);
      navigate(chatHref(c.id));
    } catch (e) {
      setStreamMessage(e.message);
    }
  }

  function openChat(c) {
    setPendingText('');
    setSidebarOpen(false);
    navigate(chatHref(c.id));
  }

  async function renameChat(c) {
    const title = window.prompt('重命名会话', c.title);
    if (!title?.trim()) return;
    const r = await api.renameChat(c.id, title.trim()).catch((e) => { window.alert(e.message); return null; });
    if (r) setChats((v) => v.map((x) => (x.id === c.id ? { ...x, title: r.title } : x)));
  }

  async function deleteChat(c) {
    if (!window.confirm(`删除「${c.title}」？聊天记录将一并移除。`)) return;
    await api.deleteChat(c.id).catch((e) => window.alert(e.message));
    setChats((v) => v.filter((x) => x.id !== c.id));
    if (chatId === c.id) navigate('#/');
  }

  const go = (v) => {
    setSidebarOpen(false);
    navigate(v === 'home' ? '#/' : `#/${v}`);
  };

  return (
    <div className={`shell ${sidebarOpen ? 'drawer' : ''}`}>
      <div className="scrim" onClick={() => setSidebarOpen(false)} />
      <aside className="sidebar">
        <div className="brand"><span className="logo-mark" /><b>vireo</b></div>
        <button className="btn primary new-chat" onClick={() => newChat()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
          开启新对话
        </button>

        <nav className="nav">
          <button className={view === 'kb' ? 'on' : ''} onClick={() => go('kb')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13z" /></svg>
            知识库{status?.kbIds?.length ? <em className="count">{status.kbIds.length}</em> : null}
          </button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => go('settings')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3h0a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5h0a1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9v0a1.7 1.7 0 001.5 1h.1a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
            设置
          </button>
          {user.role === 'admin' && (
            <button className={view === 'admin' ? 'on' : ''} onClick={() => go('admin')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z" /></svg>
              管理后台
            </button>
          )}
        </nav>

        <div className="chat-list">
          <p className="list-label">最近会话</p>
          {chats.length === 0 && <p className="muted list-empty">{chatsLoaded ? '还没有对话' : '加载中…'}</p>}
          {chats.map((c) => (
            <div className={`chat-item ${current?.id === c.id && view === 'chat' ? 'selected' : ''}`} key={c.id}>
              <button className="chat-open" onClick={() => openChat(c)}>
                <span className="chat-name">{c.title}</span>
                {c.messageCount > 0 && <span className="chat-count">{c.messageCount}</span>}
              </button>
              <span className="chat-ops">
                <button onClick={() => renameChat(c)} title="重命名">⋯</button>
                <button onClick={() => deleteChat(c)} title="删除">×</button>
              </span>
            </div>
          ))}
        </div>

        <div className="side-foot">
          <div className="user-chip" title={user.email}>
            <span className="uavatar">{(user.name || user.email)[0].toUpperCase()}</span>
            <span className="uname">{user.name}</span>
          </div>
          <button className="icon-btn" title={theme === 'dark' ? '切换浅色' : '切换深色'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" /></svg>
            )}
          </button>
          <button className="icon-btn" title="退出登录" onClick={() => { clearSession(); setUser(null); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
          </button>
        </div>
      </aside>

      <div className="mobile-bar">
        <button className="icon-btn" onClick={() => setSidebarOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <span className="brand-sm"><span className="logo-mark sm" /><b>vireo</b></span>
      </div>

      <main className="main">
        {streamMessage && <div className="page-error">{streamMessage}<button className="ghost" onClick={() => setStreamMessage('')}>×</button></div>}
        {view === 'home' && <Home userName={user.name} status={status} onPick={(t) => newChat(t)} />}
        {view === 'chat' && (
          current ? (
            <ChatView
              key={current.id}
              chat={current}
              models={status?.models}
              status={status}
              refreshStatus={refreshStatus}
              onOpenHome={() => go('home')}
              initialText={pendingText}
              onInitialConsumed={() => setPendingText('')}
            />
          ) : chatsLoaded ? (
            <div className="empty-block">
              <p>会话不存在或已被删除</p>
              <button className="btn primary" onClick={() => navigate('#/')}>返回首页</button>
            </div>
          ) : null
        )}
        {view === 'kb' && <KnowledgeBase status={status} refreshStatus={refreshStatus} />}
        {view === 'settings' && <Settings status={status} refreshStatus={refreshStatus} />}
        {view === 'admin' && user.role === 'admin' && <Admin />}
      </main>
    </div>
  );
}
