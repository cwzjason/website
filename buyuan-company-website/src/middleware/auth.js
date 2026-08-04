/**
 * JWT 鉴权中间件 v2.0
 * 路径: middleware/auth.js
 *
 * 功能:
 *   - 拦截所有 /api/* 请求
 *   - 白名单放行 /auth/login 和 /auth/validate
 *   - 拦截返回 401 JSON (含 redirect_url 供前端处理)
 *   - 区分 token 过期和无效两种情况
 */
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-to-random-secret';

// 无需鉴权的路径（相对于 /api 挂载点）
const WHITELIST = ['/auth/login', '/auth/validate', '/auth/refresh', '/admin/rule-change', '/hunyuan/chat', '/hunyuan/ocr', '/hunyuan/status'];

function authMiddleware(req, res, next) {
  const reqPath = req.path;

  // 白名单放行
  if (WHITELIST.some(function(p) { return reqPath === p || reqPath.startsWith(p + '/'); })) {
    return next();
  }

  // 提取 Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: '请先登录',
      code: 'UNAUTHORIZED',
      redirect_url: '/login.html'
    });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // 将用户信息挂载到 req，方便后续路由使用
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: '登录已过期，请重新登录',
        code: 'TOKEN_EXPIRED',
        redirect_url: '/login.html'
      });
    }
    return res.status(401).json({
      error: '登录凭证无效',
      code: 'TOKEN_INVALID',
      redirect_url: '/login.html'
    });
  }
}

module.exports = { authMiddleware };
