import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import db from './db.js';

// 生产必须显式配置 JWT_SECRET；缺失则拒绝启动，杜绝用可被伪造的固定兜底密钥上线。
const secret = (() => {
  const value = process.env.JWT_SECRET;
  if (value && value.length >= 16) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET 未设置或长度不足 16 位：生产环境拒绝启动，请配置随机长字符串。');
  }
  console.warn('[auth] 未配置 JWT_SECRET，本次使用随机临时密钥（重启后登录态失效），请勿用于生产。');
  return crypto.randomBytes(32).toString('hex');
})();

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, value] = String(stored || '').split(':');
  if (!salt || !value) return false;
  const expected = Buffer.from(value, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function signToken(user) {
  // pwd：改密时间戳。auth 中间件与库中当前值比对——修改密码后所有旧 token 立即失效
  return jwt.sign({ id: user.id, role: user.role, pwd: Number(user.pwd_changed_at || 0) }, secret, { expiresIn: '7d' });
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username || null,
    name: user.name,
    email: user.email,
    role: user.role,
    dailyLimit: user.daily_limit,
    createdAt: user.created_at,
  };
}

export function auth(req, res, next) {
  let payload;
  try {
    payload = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), secret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: '请先登录' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user) return res.status(401).json({ error: '账号不存在，请重新登录' });
  // 密码修改后旧 token 一律失效（payload.pwd 与库中当前值不一致）
  if (Number(user.pwd_changed_at || 0) !== Number(payload.pwd || 0)) {
    return res.status(401).json({ error: '密码已变更，请重新登录' });
  }
  if (user.disabled) return res.status(403).json({ error: '该账号已被停用，请联系管理员' });
  req.user = user;
  next();
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
