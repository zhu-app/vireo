import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const STATUS = {
  pending: { label: '解析中', cls: 'pending' },
  ready: { label: '可用', cls: 'ready' },
  failed: { label: '解析失败', cls: 'failed' },
  unsupported: { label: '格式不支持', cls: 'failed' },
};

export default function KnowledgeBase({ status, refreshStatus }) {
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = React.useRef();

  const load = () => api.files().then(setFiles).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  useEffect(() => {
    const handler = () => load();
    window.addEventListener('vireo:files-changed', handler);
    return () => window.removeEventListener('vireo:files-changed', handler);
  }, []);

  // 轮询解析中的文件
  useEffect(() => {
    if (!files.some((f) => f.status === 'pending')) return;
    const timer = setTimeout(load, 1500);
    return () => clearTimeout(timer);
  }, [files]);

  const kbIds = status?.kbIds || [];
  const toggleKb = async (id, on) => {
    const next = on ? [...kbIds, id] : kbIds.filter((x) => x !== id);
    await api.saveSettings({ kbIds: next }).catch((e) => setError(e.message));
    refreshStatus?.();
  };

  async function onUpload(e) {
    if (!e.target.files?.length) return;
    setUploading(true);
    setError('');
    try {
      await api.uploadFiles(e.target.files);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>知识库</h1>
          <p className="muted">上传文本类文档（txt / md / csv / json 等），勾选后对话时自动检索引用。当前支持文本格式，PDF / Word 解析在规划中。</p>
        </div>
        <button className="btn primary" onClick={() => fileRef.current.click()} disabled={uploading}>
          {uploading ? '上传中…' : '＋ 上传文件'}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={onUpload} accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yml,.yaml" />
      </header>
      {error && <div className="page-error">{error}</div>}
      {files.length === 0 ? (
        <div className="empty-block">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".5"><path d="M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13z" /><path d="M8 8h8M8 11h6" /></svg>
          <p>还没有文件，上传你的第一份资料吧</p>
        </div>
      ) : (
        <div className="kb-table">
          <div className="kb-row head"><span>启用</span><span>文件</span><span>大小</span><span>状态</span><span>时间</span><span /></div>
          {files.map((f) => (
            <div className="kb-row" key={f.id}>
              <span>
                <input
                  type="checkbox"
                  checked={kbIds.includes(f.id)}
                  disabled={f.status !== 'ready'}
                  onChange={(e) => toggleKb(f.id, e.target.checked)}
                  title={f.status !== 'ready' ? '解析完成后可启用' : '勾选后对话自动引用'}
                />
              </span>
              <span className="kb-name" title={f.name}>{f.name}</span>
              <span>{fmtSize(f.size)}</span>
              <span>
                <em className={`kb-status ${STATUS[f.status]?.cls}`}>{STATUS[f.status]?.label || f.status}</em>
                {f.status === 'failed' && f.note && <i className="kb-note" title={f.note}>{f.note}</i>}
                {f.status === 'ready' && <i className="kb-note">{f.chunks} 个片段</i>}
              </span>
              <span>{new Date(f.createdAt).toLocaleDateString('zh-CN')}</span>
              <span className="kb-ops">
                {(f.status === 'failed' || f.status === 'pending' || f.status === 'ready') && (
                  <button onClick={async () => { await api.reindexFile(f.id); load(); }} title={f.status === 'ready' ? '重新解析（配置嵌入 Key 后可补语义向量）' : '重新解析'}>↻</button>
                )}
                <button onClick={async () => { try { await api.downloadFile(f.id, f.name); } catch (err) { setError(err.message); } }} title="下载原文件">↓</button>
                <button className="danger" onClick={async () => { if (confirm(`删除「${f.name}」？`)) { await api.deleteFile(f.id); await load(); refreshStatus?.(); } }} title="删除">×</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
