/**
 * auth.js - 账号密码认证路由
 *
 * 当前为「免密模式」：只需用户名即可登录/注册。
 * 后期启用密码验证时，只需将 USE_PASSWORD 设为 true，无需改前端。
 */
const crypto = require('crypto');

const USE_PASSWORD = false; // ← 后期设为 true 即可启用密码验证
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

// -------- 工具函数（保留，密码功能启用后即生效） --------
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET)
    .update(parts[0] + '.' + parts[1]).digest('base64url');
  if (expectedSig !== parts[2]) return null;
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
}

function generateUserId() {
  return 'u_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

// ===== 路由 =====
module.exports = { verifyToken, routes };

function routes(db) {
  const router = require('express').Router();

  // ===== 登录 =====
  router.post('/login', (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !username.trim()) {
        return res.status(400).json({ success: false, error: '请输入用户名' });
      }
      const normalized = username.trim().toLowerCase();
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(normalized);
      if (!user) {
        return res.status(401).json({ success: false, error: '用户不存在，请先注册' });
      }

      // 密码验证（免密模式下跳过）
      if (USE_PASSWORD) {
        if (!password || hashPassword(password) !== user.password_hash) {
          return res.status(401).json({ success: false, error: '密码错误' });
        }
      }

      const token = createToken({ id: user.id, role: user.role, name: user.name });
      res.json({
        success: true,
        data: { token, user: { id: user.id, username: user.username, name: user.name, role: user.role } },
      });
    } catch (err) {
      console.error('[Auth] 登录失败:', err.message);
      res.status(500).json({ success: false, error: '登录失败：' + err.message });
    }
  });

  // ===== 注册 =====
  router.post('/register', (req, res) => {
    try {
      const { username, password, name, role } = req.body;

      if (!username || !username.trim()) {
        return res.status(400).json({ success: false, error: '请输入用户名' });
      }
      if (username.trim().length < 4) {
        return res.status(400).json({ success: false, error: '用户名至少4位' });
      }
      if (USE_PASSWORD && (!password || password.length < 4)) {
        return res.status(400).json({ success: false, error: '密码至少4位' });
      }
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: '请输入姓名' });
      }

      const normalizedUsername = username.trim().toLowerCase();
      const normalizedRole = role === 'admin' ? 'admin' : 'staff';

      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(normalizedUsername);
      if (existing) {
        return res.status(409).json({ success: false, error: '该用户名已被注册' });
      }

      const userId = generateUserId();
      const passwordHash = USE_PASSWORD ? hashPassword(password) : '';

      db.prepare(
        'INSERT INTO users (id, username, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
      ).run(userId, normalizedUsername, passwordHash, name.trim(), normalizedRole);

      const token = createToken({ id: userId, role: normalizedRole, name: name.trim() });

      res.json({
        success: true,
        data: {
          token,
          user: { id: userId, username: normalizedUsername, name: name.trim(), role: normalizedRole },
        },
      });
    } catch (err) {
      console.error('[Auth] 注册失败:', err.message);
      res.status(500).json({ success: false, error: '注册失败：' + err.message });
    }
  });

  return router;
}
