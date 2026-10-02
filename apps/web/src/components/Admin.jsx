import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function Admin() {
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [keys, setKeys] = useState({});
  const [providers, setProviders] = useState([]);
  const [input, setInput] = useState({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.adminStats().then(setStats).catch((e) => setError(e.message));
    api.adminUsers().then(setUsers).catch((e) => setError(e.message));
    api.providers().then(setProviders).catch(() => {});
  }, []);

  // 每次进入「平台密钥」标签都重新拉取，避免挂载后其他页面新存的 Key 不显示、无「清除」按钮
  useEffect(() => {
    if (tab === 'keys') api.adminKeys().then(setKeys).catch((e) => setError(e.message));
  }, [tab]);

  async function patchUser(id, body) {
    await api.adminPatchUser(id, body).catch((e) => setError(e.message));
    setUsers(await api.adminUsers());
  }

  async function deleteUser(u) {
    const extra = u.messageCount ? `及其 ${u.messageCount} 条消息、用量与知识库文件` : '';
    if (!window.confirm(`彻底删除用户「${u.name}（${u.email}）」？该操作不可恢复，会连带清除${extra || '其用量与设置'}。`)) return;
    try {
      await api.adminDeleteUser(u.id);
      setUsers(await api.adminUsers());
      setStats(await api.adminStats());
    } catch (err) {
      setError(err.message);
    }
  }

  function editQuota(u) {
    const input = window.prompt(`为「${u.name}」设置每日消息条数（0 = 无限制）`, String(u.dailyLimit));
    if (input === null) return;
    const limit = Math.max(0, Math.floor(Number(input)) || 0);
    patchUser(u.id, { dailyLimit: limit });
  }

  async function saveKeys() {
    const payload = {};
    for (const [p, v] of Object.entries(input)) if (v?.trim()) payload[p] = v.trim();
    if (!Object.keys(payload).length) return;
    await api.adminSaveKeys(payload).catch((e) => setError(e.message));
    setInput({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setKeys(await api.adminKeys());
  }

  async function clearKey(provider) {
    const label = provider === 'search' ? '搜索服务' : providers.find((x) => x.id === provider)?.name || provider;
    if (!window.confirm(`清除「${label}」的平台密钥？清除后若该供应商无环境变量 Key，用户需各自填写个人 Key 才能使用。`)) return;
    try {
      await api.adminSaveKeys({ [provider]: '' });
      setKeys(await api.adminKeys());
    } catch (err) {
      setError(err.message);
    }
  }

  const maxDaily = Math.max(1, ...(stats?.daily || []).map((d) => d.tokens || 0));

  return (
    <div className="page admin">
      <header className="page-head">
        <div><h1>管理后台</h1><p className="muted">平台密钥、用户与用量</p></div>
        <div className="tabs">
          {['overview', 'users', 'keys'].map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'overview' ? '概览' : t === 'users' ? '用户' : '平台密钥'}
            </button>
          ))}
        </div>
      </header>
      {error && <div className="page-error">{error}</div>}

      {tab === 'overview' && stats && (
        <>
          <div className="stat-grid">
            {[
              ['注册用户', stats.totals.users],
              ['会话数', stats.totals.chats],
              ['消息数', stats.totals.messages],
              ['今日请求', stats.totals.todayRequests],
              ['7日用量 (tokens)', (stats.totals.tokens7d || 0).toLocaleString()],
              ['知识库文件', stats.totals.files],
            ].map(([label, value]) => (
              <div className="stat-card" key={label}><b>{value}</b><span>{label}</span></div>
            ))}
          </div>
          <section className="card">
            <h3>近 7 日 Token 用量</h3>
            <div className="bars">
              {(stats.daily || []).map((d) => (
                <div className="bar-col" key={d.day} title={`${d.day}：${d.requests} 次 / ${d.tokens} tokens`}>
                  <div className="bar-fill" style={{ height: `${Math.max(4, ((d.tokens || 0) / maxDaily) * 100)}%` }} />
                  <span>{d.day.slice(5)}</span>
                </div>
              ))}
              {(!stats.daily || stats.daily.length === 0) && <p className="muted">暂无用量数据</p>}
            </div>
          </section>
          <section className="card">
            <h3>模型分布</h3>
            {(stats.byModel || []).length ? (
              <div className="kb-table mini">
                <div className="kb-row head"><span>模型</span><span>请求</span><span>Tokens</span><span /><span /><span /></div>
                {stats.byModel.map((m) => (
                  <div className="kb-row" key={m.model}><span>{m.model}</span><span>{m.requests}</span><span>{(m.tokens || 0).toLocaleString()}</span><span /><span /><span /></div>
                ))}
              </div>
            ) : <p className="muted">暂无数据</p>}
          </section>
        </>
      )}

      {tab === 'users' && (
        <section className="card">
          <div className="kb-table mini">
            <div className="kb-row head"><span>用户</span><span>今日 / 额度</span><span>累计 Tokens</span><span>注册时间</span><span /><span>操作</span></div>
            {users.map((u) => (
              <div className="kb-row" key={u.id}>
                <span><b>{u.name}</b> <i className="muted">{u.email}</i>{u.role === 'admin' && <em className="role-tag">管理员</em>}</span>
                <span>{u.todayUsage} / {u.dailyLimit || '∞'}</span>
                <span>{(u.tokens || 0).toLocaleString()}</span>
                <span>{new Date(u.createdAt).toLocaleDateString('zh-CN')}</span>
                <span />
                <span className="kb-ops">
                  {u.role !== 'admin' && (
                    <>
                      <button onClick={() => editQuota(u)} title="设置每日额度">✎</button>
                      <button onClick={() => patchUser(u.id, { disabled: !u.disabled })} title={u.disabled ? '启用该用户' : '停用该用户'}>{u.disabled ? '启' : '停'}</button>
                      <button className="danger" onClick={() => deleteUser(u)} title="彻底删除该用户">删</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'keys' && (
        <section className="card">
          <p className="muted card-desc">平台级密钥对所有用户生效（用户个人 Key 优先）。用于不暴露个人 Key 的团队/产品部署。</p>
          {Object.entries(keys).map(([p, info]) => {
            const prov = providers.find((x) => x.id === p);
            return (
            <div className="key-row" key={p}>
              <div className="key-label"><b>{p === 'search' ? '搜索服务（Tavily）' : prov?.name || p}</b>{prov?.custom && <i>{prov.baseUrl}</i>}</div>
              <div className="key-status">
                {info?.configured ? <em className="kb-status ready">已配置 {info.masked}</em> : <em className="kb-status failed">未配置</em>}
                {info?.configured && (
                  <button className="btn sm danger-ghost" onClick={() => clearKey(p)} title="从平台移除该密钥">清除</button>
                )}
              </div>
              <input
                type="password"
                placeholder={info?.configured ? '输入新 Key 可覆盖；留空不修改' : 'sk-…'}
                value={input[p] || ''}
                onChange={(e) => setInput((s) => ({ ...s, [p]: e.target.value }))}
              />
            </div>
            );
          })}
          <div className="row-actions">
            <button className="btn primary" onClick={saveKeys}>保存平台密钥</button>
            {saved && <span className="saved-tip">✓ 已保存</span>}
          </div>
        </section>
      )}
    </div>
  );
}
