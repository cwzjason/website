/**
 * 审批流路由
 * 处理申请(apply)和报销(expense)的提交、撤回、审批、驳回
 */
const express = require('express');
const path = require('path');

function getTableByItemType(item_type) {
  if (item_type === 'apply' || item_type === 'applications') return 'applications';
  if (item_type === 'expense' || item_type === 'expenses') return 'expenses';
  return item_type;
}

function getStatusLabel(status) {
  const map = {
    pending: '待审批',
    pass: '已通过',
    reject: '已驳回',
    revoked: '已撤回',
    completed: '已完成',
    待报销: '待报销',
    已报销: '已报销',
  };
  return map[status] || status;
}

module.exports = function (db) {
  const router = express.Router();

  // ===== 老板端：获取待审批列表 =====
  router.get('/pending', (req, res) => {
    try {
      const openid = req.openid || req.query.openid || '';
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

      // 验证用户是否是 admin
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ success: false, error: '无审批权限，仅老板可查看' });
      }

      // 老板可以看到所有员工的申请（不再用 manager_id 一对一关系）
      const allStaff = db.prepare("SELECT id FROM users WHERE role = 'staff'").all();
      const staffIds = allStaff.map(s => s.id);
      const combined = [...staffIds, openid]; // 老板自己的也算

      if (combined.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // 查询 pending 状态的申请
      const applyPending = db.prepare(
        `SELECT id, openid, title, description, status, created_at, 'apply' AS item_type 
         FROM applications WHERE openid IN (${combined.map(() => '?').join(',')}) AND status = 'pending' 
         ORDER BY created_at DESC`
      ).all(...combined);

      // 查询 pending 状态的报销
      const expensePending = db.prepare(
        `SELECT id, openid, title, description, amount, status, created_at, 'expense' AS item_type 
         FROM expenses WHERE openid IN (${combined.map(() => '?').join(',')}) AND status = 'pending' 
         ORDER BY created_at DESC`
      ).all(...combined);

      // 查询已处理的历史（pass/reject/revoked）
      const applyDone = db.prepare(
        `SELECT id, openid, title, description, status, approve_time, approve_comment, created_at, 'apply' AS item_type 
         FROM applications WHERE openid IN (${combined.map(() => '?').join(',')}) AND status IN ('pass','reject','revoked') 
         ORDER BY created_at DESC LIMIT 50`
      ).all(...combined);

      const expenseDone = db.prepare(
        `SELECT id, openid, title, description, amount, status, approve_time, approve_comment, created_at, 'expense' AS item_type 
         FROM expenses WHERE openid IN (${combined.map(() => '?').join(',')}) AND status IN ('pass','reject','revoked') 
         ORDER BY created_at DESC LIMIT 50`
      ).all(...combined);

      // 合并后排序：pending 在前，已处理在后
      const pending = [...applyPending, ...expensePending]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const done = [...applyDone, ...expenseDone]
        .sort((a, b) => new Date(b.approve_time || b.created_at) - new Date(a.approve_time || a.created_at));

      // 为每条记录附加发起人名称
      const allUserIds = [...new Set([...pending.map(i => i.openid), ...done.map(i => i.openid)])];
      const userNameMap = {};
      for (const uid of allUserIds) {
        const u = db.prepare("SELECT id, name FROM users WHERE id = ?").get(uid);
        userNameMap[uid] = u ? u.name : '未知用户';
      }

      const pendingWithName = pending.map(item => ({
        ...item,
        submitter_name: userNameMap[item.openid] || '未知用户',
      }));
      const doneWithName = done.map(item => ({
        ...item,
        submitter_name: userNameMap[item.openid] || '未知用户',
      }));

      res.json({
        success: true,
        data: {
          pending: pendingWithName,
          done: doneWithName,
          staff_count: allStaff.length,
        },
      });
    } catch (err) {
      console.error('[Approval] pending查询失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 员工端：我的审批记录 =====
  router.get('/my', (req, res) => {
    try {
      const openid = req.openid || req.query.openid || '';
      if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

      const myApplies = db.prepare(
        `SELECT id, title, description, status, approve_comment, approve_time, created_at, 'apply' AS item_type 
         FROM applications WHERE openid = ? 
         ORDER BY created_at DESC LIMIT 50`
      ).all(openid);

      const myExpenses = db.prepare(
        `SELECT id, title, description, amount, status, approve_comment, approve_time, created_at, 'expense' AS item_type 
         FROM expenses WHERE openid = ? 
         ORDER BY created_at DESC LIMIT 50`
      ).all(openid);

      const all = [...myApplies, ...myExpenses]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      res.json({ success: true, data: all });
    } catch (err) {
      console.error('[Approval] my查询失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 老板通过审批 =====
  router.post('/approve', (req, res) => {
    try {
      const openid = req.openid || req.body.openid || '';
      const { item_type, item_id, comment } = req.body;
      if (!openid || !item_type || !item_id) {
        return res.status(400).json({ success: false, error: '缺少必填参数' });
      }

      // 验证审批权限
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ success: false, error: '无审批权限' });
      }

      const table = getTableByItemType(item_type);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

      // 验证该条记录存在且状态为 pending
      const record = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item_id);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在' });
      }
      if (record.status !== 'pending') {
        return res.status(400).json({ success: false, error: `记录状态已是「${getStatusLabel(record.status)}」，无需重复审批` });
      }

      // 更新状态
      db.prepare(
        `UPDATE ${table} SET status = 'pass', approve_user_id = ?, approve_comment = ?, approve_time = ? WHERE id = ?`
      ).run(openid, comment || '同意', now, item_id);

      res.json({
        success: true,
        data: { id: item_id, status: 'pass', message: '审批通过' },
      });
    } catch (err) {
      console.error('[Approval] approve失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 老板驳回申请 =====
  router.post('/reject', (req, res) => {
    try {
      const openid = req.openid || req.body.openid || '';
      const { item_type, item_id, comment } = req.body;
      if (!openid || !item_type || !item_id) {
        return res.status(400).json({ success: false, error: '缺少必填参数' });
      }
      if (!comment || !comment.trim()) {
        return res.status(400).json({ success: false, error: '驳回必须填写理由' });
      }

      // 验证审批权限
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ success: false, error: '无审批权限' });
      }

      const table = getTableByItemType(item_type);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

      const record = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item_id);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在' });
      }
      if (record.status !== 'pending') {
        return res.status(400).json({ success: false, error: `记录状态已是「${getStatusLabel(record.status)}」，无法驳回` });
      }

      db.prepare(
        `UPDATE ${table} SET status = 'reject', approve_user_id = ?, approve_comment = ?, approve_time = ? WHERE id = ?`
      ).run(openid, comment.trim(), now, item_id);

      res.json({
        success: true,
        data: { id: item_id, status: 'reject', message: '已驳回' },
      });
    } catch (err) {
      console.error('[Approval] reject失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 员工撤回申请 =====
  router.post('/revoke', (req, res) => {
    try {
      const openid = req.openid || req.body.openid || '';
      const { item_type, item_id } = req.body;
      if (!openid || !item_type || !item_id) {
        return res.status(400).json({ success: false, error: '缺少必填参数' });
      }

      const table = getTableByItemType(item_type);

      const record = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item_id);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在' });
      }

      // 验证权限：只有发起人可以撤回
      if (record.openid !== openid) {
        return res.status(403).json({ success: false, error: '只能撤回自己的申请' });
      }
      if (record.status !== 'pending') {
        return res.status(400).json({ success: false, error: `只有「待审批」状态可撤回，当前状态：${getStatusLabel(record.status)}` });
      }

      db.prepare(`UPDATE ${table} SET status = 'revoked' WHERE id = ?`).run(item_id);

      res.json({ success: true, data: { id: item_id, status: 'revoked' } });
    } catch (err) {
      console.error('[Approval] revoke失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 批量通过（快捷操作） =====
  router.post('/batch-approve', (req, res) => {
    try {
      const openid = req.openid || req.body.openid || '';
      const { items } = req.body;
      if (!openid || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: '缺少参数' });
      }

      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(openid);
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ success: false, error: '无审批权限' });
      }

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const updateStmt = db.prepare(
        `UPDATE applications SET status = 'pass', approve_user_id = ?, approve_comment = ?, approve_time = ? WHERE id = ? AND status = 'pending'`
      );
      const updateExpenseStmt = db.prepare(
        `UPDATE expenses SET status = 'pass', approve_user_id = ?, approve_comment = ?, approve_time = ? WHERE id = ? AND status = 'pending'`
      );

      let count = 0;
      for (const item of items) {
        const stmt = item.item_type === 'expense' ? updateExpenseStmt : updateStmt;
        const result = stmt.run(openid, '批量通过', now, item.item_id);
        count += result.changes;
      }

      res.json({ success: true, data: { approved_count: count } });
    } catch (err) {
      console.error('[Approval] batch-approve失败:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
