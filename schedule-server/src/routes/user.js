/**
 * 用户管理路由
 * 处理用户注册、角色设置、上下级关系
 */
const express = require('express');

module.exports = function (db) {
  const router = express.Router();

  // ===== 获取用户信息 =====
  router.get('/info', (req, res) => {
    try {
      const { openid } = req.query;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

      let user = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);

      if (!user) {
        // 自动注册为新员工（默认 role=staff）
        db.prepare("INSERT INTO users (id, name, role) VALUES (?, ?, 'staff')").run(openid, '用户');
        user = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);
      }

      // 获取老板名称（如果是员工）
      let manager_name = '';
      if (user.role === 'staff' && user.manager_id) {
        const manager = db.prepare("SELECT name FROM users WHERE id = ?").get(user.manager_id);
        manager_name = manager ? manager.name : '';
      }

      // 获取员工数量（如果是老板）
      let staff_count = 0;
      if (user.role === 'admin') {
        const staffList = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE manager_id = ?").get(openid);
        staff_count = staffList ? staffList.cnt : 0;
      }

      res.json({
        success: true,
        data: {
          id: user.id,
          name: user.name,
          role: user.role,
          status: user.status || 'staff_ok',
          is_boss: !!(user.is_boss) || user.role === 'admin',
          manager_id: user.manager_id,
          manager_name,
          department: user.department || '',
          staff_count,
        },
      });
    } catch (err) {
      console.error('[User] info失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 注册/更新用户信息 =====
  router.post('/register', (req, res) => {
    try {
      const { openid, name, role, manager_id } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

      const normalizedRole = role === 'admin' ? 'admin' : 'staff';

      const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);
      if (existing) {
        // 更新已有用户
        const updates = [];
        const params = [];
        if (name) { updates.push("name = ?"); params.push(name); }
        if (role) { updates.push("role = ?"); params.push(normalizedRole); }
        if (manager_id !== undefined) { updates.push("manager_id = ?"); params.push(manager_id || null); }
        if (updates.length > 0) {
          updates.push("updated_at = datetime('now','localtime')");
          db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params, openid);
        }
      } else {
        db.prepare(
          "INSERT INTO users (id, name, role, manager_id) VALUES (?, ?, ?, ?)"
        ).run(openid, name || '用户', normalizedRole, manager_id || null);
      }

      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);
      res.json({ success: true, data: user });
    } catch (err) {
      console.error('[User] register失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 获取老板列表（员工选择直属上级） =====
  router.get('/managers', (req, res) => {
    try {
      const managers = db.prepare("SELECT id, name, department FROM users WHERE role = 'admin'").all();
      res.json({ success: true, data: managers });
    } catch (err) {
      console.error('[User] managers查询失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 获取员工列表（老板查看自己的员工） =====
  router.get('/staff', (req, res) => {
    try {
      const { openid } = req.query;
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

      const staffList = db.prepare("SELECT id, name, department FROM users WHERE manager_id = ?").all(openid);
      res.json({ success: true, data: staffList });
    } catch (err) {
      console.error('[User] staff查询失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
