/**
 * 认证路由 v2.0 - 增强安全版
 * 路径: routes/auth.js
 *
 * 安全特性:
 *   - 指数退避限流（1s → 2s → 4s → 8s，连续5次失败后封禁15分钟）
 *   - 统一错误消息（用户名或密码错误），防用户枚举
 *   - 自动初始化 admin 账号（从 .env ADMIN_PASSWORD）
 *   - 自动更新密码 hash（当 .env 中密码变更时）
 *   - JWT 8小时过期
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'buqin-secret-key-change-in-production';
const JWT_EXPIRES = '4h';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wzz123@#';

// ==================== 限流器（内存存储，指数退避） ====================
const rateLimitStore = new Map();

// 清理过期记录（每5分钟清理一次）
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore) {
    if (now - record.firstAttempt > 15 * 60 * 1000) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

function getRateLimitKey(req) {
  // 使用 IP + Username 作为限流键（防止分布式攻击）
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const username = (req.body && req.body.username) || '';
  return ip + ':' + username;
}

/**
 * 获取登录延迟时间（指数退避）
 * count=1 → 1s, count=2 → 2s, count=3 → 4s, count=4 → 8s, count=5+ → 15min
 */
function getDelay(failureCount) {
  if (failureCount >= 5) return 15 * 60 * 1000; // 15分钟后重试
  return Math.pow(2, failureCount - 1) * 1000;  // 1s, 2s, 4s, 8s
}

// ==================== 账号自动初始化 ====================

async function ensureAdminUser() {
  const conn = await pool.getConnection();
  try {
    // 确保 users 表存在
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME NULL,
        is_active TINYINT(1) DEFAULT 1,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [rows] = await conn.execute(
      'SELECT id, username, password_hash FROM users WHERE username = ?',
      [ADMIN_USERNAME]
    );

    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    if (rows.length === 0) {
      // 首次创建 admin 账号
      await conn.execute(
        'INSERT INTO users (username, password_hash, is_active) VALUES (?, ?, 1)',
        [ADMIN_USERNAME, hash]
      );
      console.log('[Auth] admin 账号已自动创建');
      return { created: true };
    }

    // 检查密码是否需要更新（.env 中密码与数据库不一致）
    const currentHash = rows[0].password_hash;
    const match = await bcrypt.compare(ADMIN_PASSWORD, currentHash);
    if (!match) {
      await conn.execute(
        'UPDATE users SET password_hash = ? WHERE username = ?',
        [hash, ADMIN_USERNAME]
      );
      console.log('[Auth] admin 密码已自动同步更新');
      return { updated: true };
    }

    return { unchanged: true };
  } catch (err) {
    console.error('[Auth] 账号初始化失败:', err.message);
    throw err;
  } finally {
    conn.release();
  }
}

// 签发 JWT
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// ==================== API 端点 ====================

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const key = getRateLimitKey(req);

  // 检查限流状态
  const record = rateLimitStore.get(key) || { count: 0, firstAttempt: Date.now() };

  // 窗口重置
  if (Date.now() - record.firstAttempt > 15 * 60 * 1000) {
    record.count = 0;
    record.firstAttempt = Date.now();
  }

  // 被封禁
  if (record.count >= 5) {
    const remain = Math.ceil((15 * 60 * 1000 - (Date.now() - record.firstAttempt)) / 1000);
    return res.status(429).json({
      error: '登录尝试次数过多，请 ' + remain + ' 秒后重试',
      retryAfter: remain
    });
  }

  // 参数校验
  if (!username || !password) {
    record.count++;
    rateLimitStore.set(key, record);
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  try {
    // 确保 admin 账号存在
    await ensureAdminUser();

    // 查询用户（参数化查询，防 SQL 注入）
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, is_active FROM users WHERE username = ?',
      [username]
    );

    const user = rows[0];
    const isValid = user
      && user.is_active === 1
      && await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      record.count++;
      rateLimitStore.set(key, record);

      // 指数退避延迟
      const delay = getDelay(record.count);
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // 统一错误消息（不区分"用户不存在"和"密码错误"）
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 登录成功，清除限流记录
    rateLimitStore.delete(key);

    // 签发 JWT
    const token = signToken({
      id: user.id,
      username: user.username,
      role: 'admin'
    });

    // 更新最后登录时间
    await pool.query(
      'UPDATE users SET last_login_at = NOW() WHERE id = ?',
      [user.id]
    );

    console.log('[Auth] 登录成功:', user.username);

    res.json({
      success: true,
      token: token,
      user: {
        id: user.id,
        username: user.username,
        role: 'admin'
      }
    });
  } catch (err) {
    console.error('[Auth] 登录异常:', err.message);
    res.status(500).json({ error: '服务器内部错误，请稍后重试' });
  }
});

// GET /api/auth/validate
router.get('/validate', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // 验证用户是否仍处于活跃状态
    const [rows] = await pool.query(
      'SELECT id, username, is_active FROM users WHERE id = ?',
      [decoded.id]
    );

    const user = rows[0];
    if (!user || user.is_active !== 1) {
      return res.status(401).json({ valid: false });
    }

    res.json({
      valid: true,
      user: {
        id: user.id,
        username: user.username,
        role: 'admin'
      }
    });
  } catch (err) {
    return res.status(401).json({ valid: false });
  }
});


// POST /api/auth/refresh — 静默续期（用于前端 token 自动刷新）
router.post('/refresh', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // 验证用户是否仍处于活跃状态
    const [rows] = await pool.query(
      'SELECT id, username, is_active FROM users WHERE id = ?',
      [decoded.id]
    );
    const user = rows[0];
    if (!user || user.is_active !== 1) {
      return res.status(401).json({ success: false, code: 'USER_INACTIVE' });
    }
    // 签发新 token
    const newToken = signToken({
      id: user.id,
      username: user.username,
      role: 'admin'
    });
    // 计算过期时间戳
    const expiresAt = Date.now() + (4 * 60 * 60 * 1000);
    console.log('[Auth] Token 已续期:', user.username);
    res.json({
      success: true,
      token: newToken,
      expiresAt: expiresAt,
      user: {
        id: user.id,
        username: user.username,
        role: 'admin'
      }
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, code: 'TOKEN_INVALID' });
  }
});

module.exports = router;
