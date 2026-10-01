import React from 'react';
import { navigate } from '../lib/router.js';

const SUGGESTIONS = [
  { icon: '✍️', title: '帮我起草一封英文邮件', desc: '向海外团队同步项目延期，语气专业诚恳' },
  { icon: '🧠', title: '解释一下 RAG 的原理', desc: '用通俗比喻讲清检索增强生成' },
  { icon: '📊', title: '分析这份数据能得出什么结论', desc: '上传 CSV 文件，让 AI 结合知识库回答' },
  { icon: '💡', title: '为我的产品起 10 个中文名', desc: '要求好记、有科技感、可注册' },
];

export default function Home({ userName, status, onPick }) {
  const available = (status?.models || []).filter((m) => m.available);
  const noKey = available.length === 0;
  return (
    <div className="home">
      <div className="hero">
        <span className="logo-mark xl" />
        <h1>嗨，{userName}，今天想聊些什么？</h1>
        <p className="muted">Vireo 支持多模型对话、知识库检索与联网搜索</p>
        {noKey && (
          <div className="hero-hint warn">
            <b>还没有可用的模型 Key。</b>
            请到 <a href="#/settings" onClick={(e) => { e.preventDefault(); navigate('#/settings'); }}>设置</a>
            {' '}填入你自己的 DeepSeek / OpenAI / 通义千问 API Key，或让管理员配置平台 Key。
          </div>
        )}
      </div>
      <div className="suggest-grid">
        {SUGGESTIONS.map((s, i) => (
          <button className="suggest" key={i} onClick={() => onPick(`${s.title}：${s.desc}`)} disabled={noKey}>
            <span className="suggest-icon">{s.icon}</span>
            <span><b>{s.title}</b><i>{s.desc}</i></span>
          </button>
        ))}
      </div>
      {status?.kbIds?.length > 0 && (
        <p className="home-kb">📚 已挂载 {status.kbIds.length} 个知识库文件，对话时会自动检索引用</p>
      )}
    </div>
  );
}
