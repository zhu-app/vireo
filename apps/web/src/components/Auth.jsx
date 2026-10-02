import React, { useState } from 'react';
import { api, setSession } from '../lib/api.js';

export default function Auth({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // 与后端同口径的密码强度校验：≥8 位且含字母与数字，提前拦截避免提交后被拒
  function checkPasswordStrength() {
    if (mode !== 'register') return '';
    const p = form.password;
    if (p.length < 8) return '密码至少 8 位';
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return '密码需同时包含字母和数字';
    return '';
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const strengthMsg = checkPasswordStrength();
    if (strengthMsg) { setError(strengthMsg); return; }
    setBusy(true);
    try {
      if (mode === 'register') {
        // 注册接口已返回 token，直接建立会话：无需再发一次登录请求
        const session = await api.register(form);
        setSession(session.token, session.user);
        onAuth(session.user);
        return;
      }
      const session = await api.login({ email: form.email, password: form.password });
      setSession(session.token, session.user);
      onAuth(session.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-bg" aria-hidden="true"><i /><i /><i /></div>
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-lg"><span className="logo-mark" /><b>vireo</b></div>
        <h1>{mode === 'login' ? '欢迎回来' : '创建账户'}</h1>
        <p className="muted">{mode === 'login' ? '登录后可继续你的所有对话与知识库' : '只需邮箱与密码，即刻开始（密码需 8 位以上，含字母和数字）'}</p>
        {mode === 'register' && (
          <label className="field"><span>昵称</span><input value={form.name} onChange={set('name')} placeholder="怎么称呼你？" maxLength={40} /></label>
        )}
        <label className="field"><span>邮箱</span><input type="email" required value={form.email} onChange={set('email')} placeholder="you@example.com" autoComplete="email" /></label>
        <label className="field"><span>密码</span><input type="password" required minLength={8} value={form.password} onChange={set('password')} placeholder="至少 8 位" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}</button>
        <button type="button" className="switch-mode" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? '还没有账户？创建一个' : '已有账户？直接登录'}
        </button>
      </form>
    </div>
  );
}
