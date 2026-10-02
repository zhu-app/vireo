import React, { useEffect, useState } from 'react';
import { api, clearSession } from '../lib/api.js';

const BUILTIN_HINTS = {
  deepseek: 'platform.deepseek.com 创建',
  qwen: 'dashscope.console.aliyun.com 创建',
};

export default function Settings({ status, refreshStatus }) {
  const [keys, setKeys] = useState({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchTest, setSearchTest] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const [discoverBusy, setDiscoverBusy] = useState('');
  const [discoverMsg, setDiscoverMsg] = useState('');
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '', key: '' });
  const [providerBusy, setProviderBusy] = useState(false);
  const [manual, setManual] = useState({ provider: '', modelId: '' });
  const [manualBusy, setManualBusy] = useState(false);
  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdDone, setPwdDone] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);

  const isAdmin = status?.user?.role === 'admin';

  const loadModels = () => api.models().then(setModels).catch(() => {});
  const loadProviders = () => api.providers().then(setProviders).catch(() => {});
  useEffect(() => { loadModels(); loadProviders(); }, []);

  async function discover(providerId) {
    setDiscoverBusy(providerId);
    setDiscoverMsg('');
    setError('');
    try {
      const r = await api.discoverModels(providerId);
      setDiscoverMsg(`✓ 已发现 ${r.count} 个可对话模型（${r.models.slice(0, 5).map((m) => m.name).join('、')}${r.count > 5 ? '…' : ''}），已加入对话页下拉框`);
      await loadModels();
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setDiscoverBusy('');
    }
  }

  async function removeModel(id) {
    if (!window.confirm(`移除模型「${id}」？重新「获取模型列表」可再次导入。`)) return;
    try {
      await api.removeModel(id);
      await loadModels();
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    }
  }

  async function addProvider() {
    const name = newProvider.name.trim();
    const baseUrl = newProvider.baseUrl.trim();
    if (!name || !baseUrl) { setError('请填写供应商名称与接口地址'); return; }
    setProviderBusy(true);
    setError('');
    try {
      await api.addProvider({ name, baseUrl, key: newProvider.key.trim() || undefined });
      setNewProvider({ name: '', baseUrl: '', key: '' });
      await loadProviders();
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setProviderBusy(false);
    }
  }

  async function removeProvider(p) {
    if (!window.confirm(`删除自定义供应商「${p.name}」？其已发现的模型与平台 Key 将一并移除。`)) return;
    try {
      await api.deleteProvider(p.id);
      await Promise.all([loadProviders(), loadModels()]);
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitManualModel() {
    const provider = manual.provider;
    const modelId = manual.modelId.trim();
    if (!provider || !modelId) { setError('请选择供应商并填写模型 ID'); return; }
    setManualBusy(true);
    setError('');
    try {
      const m = await api.addManualModel(provider, modelId);
      setManual({ provider: '', modelId: '' });
      setDiscoverMsg(`✓ 已添加模型「${m.name}」（${m.id}），可在对话页选择使用`);
      await loadModels();
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setManualBusy(false);
    }
  }

  useEffect(() => {
    if (status?.keys) setKeys(Object.fromEntries((status.providers || []).map((p) => [p.id, ''])));
  }, [status]);

  async function saveKeys() {
    const payload = {};
    for (const p of providers) if (keys[p.id]?.trim()) payload[p.id] = keys[p.id].trim();
    if (!Object.keys(payload).length) return;
    setBusy(true);
    setError('');
    try {
      await api.saveSettings({ apiKeys: payload });
      setKeys(Object.fromEntries(providers.map((p) => [p.id, ''])));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const providerName = (id) => providers.find((p) => p.id === id)?.name || id;

  async function clearKey(providerId) {
    if (!window.confirm(`删除「${providerName(providerId)}」的个人密钥？删除后若管理员配有平台 Key，将自动改用平台 Key。`)) return;
    setError('');
    try {
      await api.saveSettings({ apiKeys: { [providerId]: '' } });
      refreshStatus?.();
    } catch (err) {
      setError(err.message);
    }
  }

  // ---- 修改密码 / 注销账号 ----
  async function submitPassword() {
    setError('');
    const { currentPassword, newPassword, confirmPassword } = pwd;
    if (!currentPassword || !newPassword) { setError('请填写当前密码与新密码'); return; }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setError('新密码至少 8 位，且需同时包含字母和数字'); return;
    }
    if (newPassword !== confirmPassword) { setError('两次输入的新密码不一致'); return; }
    setPwdBusy(true);
    try {
      // changePassword 成功后已把新 token 写入本地会话，当前登录态无缝延续
      await api.changePassword({ currentPassword, newPassword });
      setPwd({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPwdDone(true);
      setTimeout(() => setPwdDone(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setPwdBusy(false);
    }
  }

  async function submitCloseAccount() {
    setError('');
    const password = window.prompt('注销账号不可恢复：将永久删除你的全部会话、消息、知识库文件与用量记录。\n请输入当前密码确认注销：');
    if (password === null) return;
    if (!password.trim()) { setError('注销账号需要输入当前密码'); return; }
    if (!window.confirm('再次确认：注销后所有数据立即删除且无法找回，确定继续？')) return;
    setCloseBusy(true);
    try {
      await api.closeAccount(password.trim());
      // 账号已删除：清理本地会话并广播登出，回到登录页
      clearSession();
      window.dispatchEvent(new Event('vireo:logout'));
    } catch (err) {
      setError(err.message);
    } finally {
      setCloseBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>设置</h1><p className="muted">模型密钥、供应商、联网搜索与账号信息</p></div>
      </header>

      <section className="card">
        <h3>模型 API Key</h3>
        <p className="muted card-desc">填入 Key 后点「获取模型列表」拉取该供应商的真实模型，之后即可在对话页选择。你自己的 Key 只保存在服务端，平台 Key 由管理员配置，个人 Key 优先。</p>
        {providers.map((p) => {
          const info = status?.keys?.[p.id];
          return (
            <div className="key-row" key={p.id}>
              <div className="key-label"><b>{p.name}{p.custom && <em className="tag dyn" style={{ marginLeft: 6 }}>自定义</em>}</b><i>{p.custom ? p.baseUrl : BUILTIN_HINTS[p.id] || p.id}</i></div>
              <div className="key-status">
                {info?.configured ? (
                  <em className={`kb-status ready`}>已配置{info.source === 'platform' ? '（平台）' : info.source === 'env' ? '（环境）' : ''} {info.masked}</em>
                ) : (
                  <em className="kb-status failed">未配置</em>
                )}
                {info?.configured && info.source === 'user' && (
                  <button className="btn sm danger-ghost" onClick={() => clearKey(p.id)} title="删除我的个人密钥">删除</button>
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
          <button className="btn primary" onClick={saveKeys} disabled={busy || !Object.values(keys).some((v) => v?.trim())}>{busy ? '保存中…' : '保存密钥'}</button>
          {saved && <span className="saved-tip">✓ 已保存</span>}
        </div>
      </section>

      {isAdmin && (
        <section className="card">
          <h3>自定义供应商</h3>
          <p className="muted card-desc">任何 OpenAI 兼容接口（/v1/chat/completions + /v1/models）都可接入：如 Kimi、智谱 GLM、Ollama、vLLM、企业私有网关等。添加后即可为其填入平台 Key 并「获取模型列表」。</p>
          <div className="provider-form">
            <input placeholder="名称（如 Kimi）" value={newProvider.name} onChange={(e) => setNewProvider((v) => ({ ...v, name: e.target.value }))} />
            <input placeholder="接口地址（如 https://api.moonshot.cn/v1）" value={newProvider.baseUrl} onChange={(e) => setNewProvider((v) => ({ ...v, baseUrl: e.target.value }))} />
            <input type="password" placeholder="平台 Key（可选）" value={newProvider.key} onChange={(e) => setNewProvider((v) => ({ ...v, key: e.target.value }))} />
            <button className="btn primary" onClick={addProvider} disabled={providerBusy}>{providerBusy ? '添加中…' : '＋ 添加供应商'}</button>
          </div>
          {providers.some((p) => p.custom) && (
            <ul className="model-list" style={{ marginTop: 12 }}>
              {providers.filter((p) => p.custom).map((p) => (
                <li key={p.id}>
                  <span className="model-name"><b>{p.name}</b><code>{p.baseUrl}</code></span>
                  <span className="model-prov">{status?.keys?.[p.id]?.configured ? `Key ${status.keys[p.id].masked}` : '无平台 Key（用户可填个人 Key）'}</span>
                  <button className="icon-btn danger" title="删除该供应商" onClick={() => removeProvider(p)}>×</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {isAdmin && (
        <section className="card">
          <h3>手动添加模型</h3>
          <p className="muted card-desc">
            适用于不提供「获取模型列表」接口的上游（如微信 Coding Plan，调用 /v1/models 会报 400）。
            从平台页面原样复制模型 ID 填入，添加后与发现的模型一样进入对话页下拉框，全平台共享。
            聊天调用本身不依赖列表接口，只要模型 ID 准确即可正常使用。
          </p>
          <div className="provider-form">
            <select
              value={manual.provider}
              onChange={(e) => setManual((v) => ({ ...v, provider: e.target.value }))}
            >
              <option value="">选择供应商…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.custom ? '' : '（内置）'}</option>
              ))}
            </select>
            <input
              placeholder="模型 ID（从平台页面复制，如 deepseek-v4-flash）"
              value={manual.modelId}
              onChange={(e) => setManual((v) => ({ ...v, modelId: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') submitManualModel(); }}
            />
            <span className="muted" style={{ fontSize: 12 }}>大小写以平台页面为准</span>
            <button className="btn primary" onClick={submitManualModel} disabled={manualBusy || !manual.provider || !manual.modelId.trim()}>
              {manualBusy ? '添加中…' : '＋ 添加模型'}
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h3>可用模型（{models.length}）</h3>
        <p className="muted card-desc">模型全部来自「获取模型列表」的发现结果（已过滤 embedding/语音等非对话模型），发现一次全平台共享。列表为空时请先配置 Key 并获取。</p>
        {models.length === 0 ? (
          <p className="muted">暂无模型 —— 在上方为任一供应商填入 API Key 后点「获取模型列表」。</p>
        ) : (
          <ul className="model-list">
            {models.map((m) => (
              <li key={m.id} className={m.available ? '' : 'unavailable'}>
                <span className="model-name"><b>{m.name}</b><code>{m.id}</code>{m.reasoning && <em className="tag">思考</em>}{m.vision && <em className="tag">视觉</em>}</span>
                <span className="model-prov">{providerName(m.provider)}{m.available ? '' : ' · 无 Key 不可用'}</span>
                <button className="icon-btn" title="移除该模型" onClick={() => removeModel(m.id)}>×</button>
              </li>
            ))}
          </ul>
        )}
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
            ? `已启用（${providerName(status.embedding.provider)} · ${status.embedding.model}）。新上传的文档会自动生成向量，检索时按「语义 + 关键词」混合排序；此前入库的文件可到知识库页点「↻」重新解析补向量。`
            : '未启用，知识库当前使用关键词检索。配置通义千问 Key（自动探测 text-embedding-v3），或添加支持 embeddings 的自定义供应商并设置 EMBEDDING_PROVIDER 指向它。'}
        </p>
      </section>

      <section className="card">
        <h3>账号</h3>
        <p className="muted card-desc">邮箱：{status?.user?.email}；今日消息：{status?.quota?.used ?? 0}{status?.quota?.limit ? ` / ${status.quota.limit}` : '（无限制）'} 条</p>

        <h4 className="sub-head">修改密码</h4>
        <p className="muted card-desc">修改后其他设备与页面的登录状态会立即失效，需用新密码重新登录。</p>
        <div className="provider-form">
          <input type="password" placeholder="当前密码" value={pwd.currentPassword} autoComplete="current-password"
            onChange={(e) => setPwd((v) => ({ ...v, currentPassword: e.target.value }))} />
          <input type="password" placeholder="新密码（≥8 位，含字母和数字）" value={pwd.newPassword} autoComplete="new-password"
            onChange={(e) => setPwd((v) => ({ ...v, newPassword: e.target.value }))} />
          <input type="password" placeholder="确认新密码" value={pwd.confirmPassword} autoComplete="new-password"
            onKeyDown={(e) => { if (e.key === 'Enter') submitPassword(); }}
            onChange={(e) => setPwd((v) => ({ ...v, confirmPassword: e.target.value }))} />
          <button className="btn primary" onClick={submitPassword}
            disabled={pwdBusy || !pwd.currentPassword || !pwd.newPassword || !pwd.confirmPassword}>
            {pwdBusy ? '提交中…' : '修改密码'}
          </button>
        </div>
        {pwdDone && <span className="saved-tip">✓ 密码已修改</span>}

        {!isAdmin && (
          <>
            <h4 className="sub-head danger-title">注销账号</h4>
            <p className="muted card-desc">永久删除本账号及其全部会话、消息、知识库文件与用量记录，操作不可恢复。</p>
            <button className="btn danger" onClick={submitCloseAccount} disabled={closeBusy}>
              {closeBusy ? '注销中…' : '注销我的账号'}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
