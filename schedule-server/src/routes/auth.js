/**
 * auth.js - 身份认证路由（基于OpenID，不使用名字匹配）
 * 核心原则：OpenID唯一标识用户，第一位注册者自动成为管理员
 */
const crypto = require('crypto');

const JWT_SECRET = crypto.randomBytes(32).toString('hex');

// -------- 工具函数 --------
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

// ===== 路由 =====
module.exports = { verifyToken, routes };

function routes(db) {
  const router = require('express').Router();

  // ===== 登录：用 OpenID/device_id 查询用户是否存在 =====
  router.post('/login', (req, res) => {
    try {
      var openid = (req.body.device_id || '').trim();
      if (!openid) {
        openid = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
      }
      var user = db.prepare('SELECT id, name, status, is_boss, role FROM users WHERE id = ?').get(openid);
      if (user) {
        res.json({
          success: true,
          data: {
            openid: openid,
            exists: true,
            status: user.status,
            name: user.name,
            is_boss: !!user.is_boss,
            role: user.role
          }
        });
      } else {
        res.json({ success: true, data: { openid: openid, exists: false } });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 查询用户准入状态 =====
  router.get('/status', (req, res) => {
    try {
      const openid = req.query.openid;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

      const user = db.prepare('SELECT id, name, status, is_boss, role FROM users WHERE id = ?').get(openid);
      if (!user) {
        return res.json({ success: true, data: { exists: false } });
      }

      res.json({
        success: true,
        data: {
          exists: true,
          status: user.status,
          role: user.role,
          is_boss: !!user.is_boss,
          name: user.name,
        },
      });
    } catch (err) {
      console.error('[Auth] 查询状态失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 提交使用申请（首个用户自动成为管理员）=====
  router.post('/apply', (req, res) => {
    try {
      var openid = req.body.openid;
      var name = req.body.name;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });
      if (!name || !name.trim()) return res.status(400).json({ success: false, error: '请输入姓名' });

      var trimmedName = name.trim();
      var existing = db.prepare('SELECT id, status, is_boss FROM users WHERE id = ?').get(openid);

      if (existing) {
        // 已存在用户：如果已批准，直接返回
        if (existing.status === 'approved') {
          return res.json({
            success: true,
            data: {
              status: 'approved',
              is_boss: !!existing.is_boss,
              role: !!existing.is_boss ? 'admin' : 'staff_ok',
              message: '您已是正式用户'
            }
          });
        }
        // 待审批/已拒绝：更新名字重新申请
        db.prepare("UPDATE users SET name = ?, status = 'pending', updated_at = datetime('now','localtime') WHERE id = ?")
          .run(trimmedName, openid);
        return res.json({ success: true, data: { status: 'pending', message: '申请已重新提交' } });
      }

      // 全新用户：检查是否是第一位注册者
      var totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get();
      var isFirst = !totalUsers || totalUsers.c === 0;

      if (isFirst) {
        // 第一位用户 → 自动设为管理员
        db.prepare(
          "INSERT INTO users (id, name, role, status, is_boss, created_at, updated_at) VALUES (?, ?, 'admin', 'boss', 1, datetime('now','localtime'), datetime('now','localtime'))"
        ).run(openid, trimmedName);
        res.json({
          success: true,
          data: {
            status: 'approved',
            is_boss: true,
            role: 'admin',
            message: '检测到您是第一位用户，已自动设为管理员'
          }
        });
      } else {
        // 后续用户 → 待审批
        db.prepare(
          "INSERT INTO users (id, name, role, status, is_boss, created_at, updated_at) VALUES (?, ?, 'staff', 'pending', 0, datetime('now','localtime'), datetime('now','localtime'))"
        ).run(openid, trimmedName);
        res.json({
          success: true,
          data: {
            status: 'pending',
            is_boss: false,
            role: 'staff',
            message: '申请已提交，等待管理员审批'
          }
        });
      }
    } catch (err) {
      console.error('[Auth] 提交申请失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 管理员查看所有用户（待审批 + 已通过） =====
  router.get('/pending-users', (req, res) => {
    try {
      const openid = req.query.openid;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

      // 校验是否为管理员
      const admin = db.prepare('SELECT id FROM users WHERE id = ? AND is_boss = 1').get(openid);
      if (!admin) {
        return res.status(403).json({ success: false, error: '仅管理员可查看此列表' });
      }

      const pending = db.prepare(
        "SELECT id, name, status, created_at FROM users WHERE status = 'pending' ORDER BY created_at DESC"
      ).all();

      const approved = db.prepare(
        "SELECT id, name, status, created_at FROM users WHERE status = 'approved' AND id != ? ORDER BY created_at DESC"
      ).all(openid);

      res.json({
        success: true,
        data: { pending, approved, total: pending.length + approved.length },
      });
    } catch (err) {
      console.error('[Auth] 查询待审批列表失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 管理员审批/拒绝用户 =====
  router.post('/approve-user', (req, res) => {
    try {
      const { openid, target_openid, action } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });
      if (!target_openid) return res.status(400).json({ success: false, error: '缺少待审批用户 ID' });
      if (!['approve', 'reject'].includes(action)) return res.status(400).json({ success: false, error: 'action 必须为 approve 或 reject' });

      // 校验是否为管理员
      const admin = db.prepare('SELECT id FROM users WHERE id = ? AND is_boss = 1').get(openid);
      if (!admin) {
        return res.status(403).json({ success: false, error: '仅管理员可执行此操作' });
      }

      const targetUser = db.prepare('SELECT id, name, status FROM users WHERE id = ?').get(target_openid);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: '用户不存在' });
      }

      if (action === 'approve') {
        db.prepare("UPDATE users SET status = 'approved', updated_at = datetime('now','localtime') WHERE id = ?")
          .run(target_openid);
        res.json({ success: true, data: { message: '已通过 ' + targetUser.name + ' 的使用申请' } });
      } else {
        db.prepare("UPDATE users SET status = 'rejected', updated_at = datetime('now','localtime') WHERE id = ?")
          .run(target_openid);
        res.json({ success: true, data: { message: '已拒绝 ' + targetUser.name + ' 的使用申请' } });
      }
    } catch (err) {
      console.error('[Auth] 审批用户失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 【调试用】查看所有用户 OpenID =====
  router.get('/debug-users', (req, res) => {
    try {
      const users = db.prepare('SELECT id, name, status, is_boss, role, created_at FROM users ORDER BY created_at DESC').all();
      res.json({ success: true, data: users });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 管理员设置/取消另一个管理员 =====
  router.post('/set-boss', (req, res) => {
    try {
      const { openid, target_openid, is_boss } = req.body;
      if (!openid || !target_openid) return res.status(400).json({ success: false, error: '缺少参数' });

      // 校验是否为管理员
      const admin = db.prepare('SELECT id FROM users WHERE id = ? AND is_boss = 1').get(openid);
      if (!admin) {
        return res.status(403).json({ success: false, error: '仅管理员可执行此操作' });
      }

      if (is_boss) {
        db.prepare("UPDATE users SET is_boss = 1, role = 'admin', updated_at = datetime('now','localtime') WHERE id = ?")
          .run(target_openid);
      } else {
        db.prepare("UPDATE users SET is_boss = 0, updated_at = datetime('now','localtime') WHERE id = ?")
          .run(target_openid);
      }

      res.json({ success: true, data: { message: is_boss ? '已设为管理员' : '已取消管理员身份' } });
    } catch (err) {
      console.error('[Auth] 设置管理员失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 管理员删除员工 =====
  router.post('/delete-user', (req, res) => {
    try {
      const { openid, target_openid } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });
      if (!target_openid) return res.status(400).json({ success: false, error: '缺少待删除用户 ID' });

      // 校验是否为管理员
      const admin = db.prepare('SELECT id FROM users WHERE id = ? AND is_boss = 1').get(openid);
      if (!admin) {
        return res.status(403).json({ success: false, error: '仅管理员可执行此操作' });
      }

      // 不能删除自己
      if (openid === target_openid) {
        return res.status(400).json({ success: false, error: '不能删除自己' });
      }

      const targetUser = db.prepare('SELECT id, name FROM users WHERE id = ?').get(target_openid);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: '用户不存在' });
      }

      // 直接删除用户，删除后需要重新申请
      db.prepare('DELETE FROM users WHERE id = ?').run(target_openid);

      res.json({ success: true, data: { message: '已删除 ' + targetUser.name + '，该员工需要重新申请才能加入' } });
    } catch (err) {
      console.error('[Auth] 删除用户失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
