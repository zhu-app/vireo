import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', hint: 'platform.deepseek.com 创建，用于 deepseek-chat / reasoner' },
  { id: 'openai', name: 'OpenAI', hint: 'platform.openai.com 创建，用于 gpt-4o' },
  { id: 'qwen', name: '通义千问', hint: 'dashscope.console.aliyun.com 创建，用于 qwen-max' },
];

export default function Settings({ status, refreshStatus }) {
  const [keys, setKeys] = useState({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchTest, setSearchTest] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [models, setModels] = useState([]);
  const [discoverBusy, setDiscoverBusy] = useState('');
  const [discoverMsg, setDiscoverMsg] = useState('');

  const loadModels = () => api.models().then(setModels).catch(() => {});
  useEffect(() => { loadModels(); }, []);

  async function discover(providerId) {
    setDiscoverBusy(providerId);
    setDiscoverMsg('');
    setError('');
    try {
      const r = await api.discoverModels(providerId);
      setDiscoverMsg(`✓ ${providerId} 已发现 ${r.count} 个可对话模型（${r.models.slice(0, 5).map((m) => m.id).join('、')}${r.count > 5 ? '…' : ''}），已加入对话页下拉框`);
      await loadModels();
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setDiscoverBusy('');
    }
  }

  async function removeModel(id) {
    if (!window.confirm(`移除动态模型「${id}」？内置模型不受影响。`)) return;
    try {
      await api.removeModel(id);
      await loadModels();
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (status?.keys) setKeys(Object.fromEntries(PROVIDERS.map((p) => [p.id, ''])));
  }, [status]);

  async function saveKeys() {
    const payload = {};
    for (const p of PROVIDERS) if (keys[p.id]?.trim()) payload[p.id] = keys[p.id].trim();
    if (!Object.keys(payload).length) return;
    setBusy(true);
    setError('');
    try {
      await api.saveSettings({ apiKeys: payload });
      setKeys(Object.fromEntries(PROVIDERS.map((p) => [p.id, ''])));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>设置</h1><p className="muted">模型密钥、联网搜索与账号信息</p></div>
      </header>

      <section className="card">
        <h3>模型 API Key</h3>
        <p className="muted card-desc">你自己的 Key 只保存在服务端并加密使用，不会下发给其他用户。平台 Key 由管理员配置，个人 Key 优先。</p>
        {PROVIDERS.map((p) => {
          const info = status?.keys?.[p.id];
          return (
            <div className="key-row" key={p.id}>
              <div className="key-label"><b>{p.name}</b><i>{p.hint}</i></div>
              <div className="key-status">
                {info?.configured ? (
                  <em className={`kb-status ready`}>已配置{info.source === 'platform' ? '（平台）' : info.source === 'env' ? '（环境）' : ''} {info.masked}</em>
                ) : (
                  <em className="kb-status failed">未配置</em>
                )}
              </div>
              <input
                type="password"
                placeholder={info?.configured ? '输入新 Key 可覆盖' : 'sk-…'}
                value={keys[p.id] || ''}
                onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
              />
              {info?.configured && (
                <button className="btn" onClick={() => discover(p.id)} disabled={Boolean(discoverBusy)}>
                  {discoverBusy === p.id ? '获取中…' : '获取模型列表'}
                </button>
              )}
            </div>
          );
        })}
        {error && <div className="page-error">{error}</div>}
        {discoverMsg && <div className="notice ok">{discoverMsg}</div>}
        <div className="row-actions">
          <button className="btn primary" onClick={saveKeys} disabled={busy || !Object.values(keys).some((v) => v.trim())}>{busy ? '保存中…' : '保存密钥'}</button>
          {saved && <span className="saved-tip">✓ 已保存</span>}
        </div>
      </section>

      <section className="card">
        <h3>可用模型（{models.length}）</h3>
        <p className="muted card-desc">内置 4 个 + 上游发现的动态模型。「获取模型列表」会拉取该 Key 对应供应商的真实模型清单（已过滤 embedding/语音等非对话模型），发现结果全平台共享。</p>
        <ul className="model-list">
          {models.map((m) => (
            <li key={m.id} className={m.available ? '' : 'unavailable'}>
              <span className="model-name"><b>{m.name}</b><code>{m.id}</code>{m.reasoning && <em className="tag">思考</em>}{m.vision && <em className="tag">视觉</em>}{m.dynamic && <em className="tag dyn">动态</em>}</span>
              <span className="model-prov">{PROVIDERS.find((p) => p.id === m.provider)?.name || m.provider}{m.available ? '' : ' · 无 Key 不可用'}</span>
              {m.dynamic && <button className="icon-btn" title="移除该动态模型" onClick={() => removeModel(m.id)}>×</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>联网搜索</h3>
        <p className="muted card-desc">
          {status?.search?.configured
            ? `已启用（${status.search.engine}），可在对话页顶部的「联网」开关控制是否搜索。`
            : '未配置搜索服务 Key。管理员可在后台填入，或设置环境变量 SEARCH_API_KEY。支持 Tavily。'}
        </p>
        {status?.search?.configured && (
          <div className="search-test">
            <input placeholder="输入关键词测试搜索" value={searchTest} onChange={(e) => setSearchTest(e.target.value)}
              onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); try { const r = await api.testSearch(searchTest); setSearchResult(r.results); } catch (err) { setSearchResult([{ error: err.message }]); } } }} />
            <button className="btn" onClick={async () => { try { const r = await api.testSearch(searchTest); setSearchResult(r.results); } catch (err) { setSearchResult([{ error: err.message }]); } }}>测试</button>
          </div>
        )}
        {searchResult && (
          <ul className="search-results">
            {searchResult.map((r, i) => r.error ? <li key={i} className="page-error">{r.error}</li> : (
              <li key={i}><a href={r.url} target="_blank" rel="noreferrer noopener">{r.title || r.url}</a><i>{(r.content || '').slice(0, 120)}…</i></li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>知识库语义检索</h3>
        <p className="muted card-desc">
          {status?.embedding?.configured
            ? `已启用（${status.embedding.provider} · ${status.embedding.model}）。新上传的文档会自动生成向量，检索时按「语义 + 关键词」混合排序；此前入库的文件可到知识库页点「↻」重新解析补向量。`
            : '未启用，知识库当前使用关键词检索。配置任意一个 OpenAI 或通义千问 API Key（本页上方）即自动启用语义检索；也可用 EMBEDDING_PROVIDER / EMBEDDING_MODEL 环境变量指定。'}
        </p>
      </section>

      <section className="card">
        <h3>账号</h3>
        <p className="muted card-desc">邮箱：{status?.user?.email}；今日消息：{status?.quota?.used ?? 0}{status?.quota?.limit ? ` / ${status.quota.limit}` : '（无限制）'} 条</p>
      </section>
    </div>
  );
}
