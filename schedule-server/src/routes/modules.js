/**
 * 通用模块路由 - tasks / inspirations / applications / expenses
 * 提供统一 CRUD：POST 创建 / GET 列表 / PUT 更新 / DELETE 删除
 *
 * 使用方式：
 *   const moduleRoutes = require('./modules');
 *   app.use('/api/tasks',         moduleRoutes(db, 'tasks'));
 *   app.use('/api/inspirations',  moduleRoutes(db, 'inspirations'));
 *   app.use('/api/applications',  moduleRoutes(db, 'applications'));
 *   app.use('/api/expenses',      moduleRoutes(db, 'expenses'));
 *
 * 支持字段（各表不同，传 body 时动态写库）：
 *   tasks:         title, description, priority, due_date, status
 *   inspirations:  title, description, tags
 *   applications:  title, description, applicant, status
 *   expenses:      title, description, amount, category, expense_date
 */
const express = require('express');

module.exports = function (db, tableName) {
  const router = express.Router();

  // ===== POST / - 创建记录（支持从草稿创建） =====
  router.post('/', (req, res) => {
    try {
      const { draft_id, title, description, ...extra } = req.body;
      const openid = req.body.openid || "";
      if (!title) return res.status(400).json({ success: false, error: '缺少标题' });

      // 禁止创建过去时间的任务（只允许未来的截止日期）
      if (tableName === 'tasks' && extra.due_date) {
        const trimmed = String(extra.due_date).trim();
        const now = new Date();
        let isPast = false;
        if (trimmed.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
          const d = new Date(trimmed + 'T00:00:00');
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          isPast = d < today;
        } else {
          const d = new Date(trimmed.replace(' ', 'T'));
          isPast = !isNaN(d) && d < now;
        }
        if (isPast) return res.status(400).json({ success: false, error: '不能创建过去时间的任务，请使用未来的截止日期' });
      }

      // 动态构建 INSERT：从 body 取对应表的允许字段
      const allowedFields = getAllowedFields(tableName);
      const fieldEntries = [['title', title], ['openid', openid]];
      if (draft_id !== undefined && draft_id !== null) fieldEntries.push(['draft_id', String(draft_id)]);

      for (const key of allowedFields) {
        if (key === 'title') continue; // 已处理
        const val = extra[key] !== undefined ? extra[key] : description !== undefined && key === 'description' ? description : '';
        fieldEntries.push([key, val]);
      }

      const columns = fieldEntries.map(e => e[0]);
      const placeholders = fieldEntries.map(() => '?');
      const values = fieldEntries.map(e => {
        const v = e[1];
        return (v === null || v === undefined) ? '' : String(v);
      });

      const info = db.prepare(
        `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
      ).run(...values);

      // 如果关联了草稿，标记草稿为已完成
      if (draft_id) {
        try {
          db.prepare("UPDATE drafts SET status = 'completed', updated_at = datetime('now','localtime') WHERE id = ?")
            .run(Number(draft_id));
        } catch (e) { /* ignore */ }
      }

      const record = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(info.lastInsertRowid);
      console.log(`[${tableName}] 创建记录 id=${info.lastInsertRowid}`);
      res.json({ success: true, data: record });
    } catch (e) {
      console.error(`[${tableName}] POST / 失败:`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET / - 查询列表 =====
  router.get('/', (req, res) => {
    try {
      const { page = 1, pageSize = 20, due_date } = req.query;
      const openid = req.query.openid || "";
      const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Number(pageSize));
      const limit = Math.min(100, Number(pageSize));

      // 自动将过期的待办任务标记为已完成
      if (tableName === 'tasks') {
        try {
          db.prepare(
            "UPDATE tasks SET status = '已完成', updated_at = datetime('now','localtime') WHERE status = '待办' AND openid = ? AND due_date != '' AND date(due_date) < date('now','localtime')"
          ).run(openid);
        } catch (e) { /* 静默忽略 */ }
      }

      // 支持按截止日期过滤（用于 tasks 查询今日截止任务）
      let whereClause = `openid = ? AND status != 'deleted'`;
      const params = [openid];
      if (due_date) {
        whereClause += ` AND date(due_date) = date(?)`;
        params.push(due_date);
      } else if (req.query.expense_date) {
        whereClause += ` AND date(expense_date) = date(?)`;
        params.push(req.query.expense_date);
      } else if (req.query.date) {
        const dateField = tableName === 'tasks' ? 'due_date' :
                          tableName === 'expenses' ? 'expense_date' :
                          'created_at';
        whereClause += ` AND date(${dateField}) = date(?)`;
        params.push(req.query.date);
      }

      const rows = db.prepare(
        `SELECT * FROM ${tableName} WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      const countRow = db.prepare(
        `SELECT COUNT(*) as total FROM ${tableName} WHERE ${whereClause}`
      ).get(...params);

      res.json({ success: true, data: rows, total: countRow ? countRow.total : 0 });
    } catch (e) {
      console.error(`[${tableName}] GET / 失败:`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /:id - 查询单条 =====
  router.get('/:id', (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(Number(req.params.id));
      if (!row) return res.status(404).json({ success: false, error: '记录不存在' });
      res.json({ success: true, data: row });
    } catch (e) {
      console.error(`[${tableName}] GET /:id 失败:`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /:id - 更新记录 =====
  router.put('/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id);
      if (!existing) return res.status(404).json({ success: false, error: '记录不存在' });

      const allowedFields = getAllowedFields(tableName);
      const setClauses = [];
      const values = [];

      for (const key of allowedFields) {
        if (req.body[key] !== undefined) {
          setClauses.push(`${key} = ?`);
          values.push(req.body[key]);
        }
      }
      if (setClauses.length === 0) {
        return res.status(400).json({ success: false, error: '没有可更新的字段' });
      }
      setClauses.push("updated_at = datetime('now','localtime')");
      values.push(id);

      db.prepare(`UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id);
      console.log(`[${tableName}] 更新记录 id=${id}`);
      res.json({ success: true, data: updated });
    } catch (e) {
      console.error(`[${tableName}] PUT /:id 失败:`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /:id - 软删除 =====
  router.delete('/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = db.prepare(
        `UPDATE ${tableName} SET status = 'deleted', updated_at = datetime('now','localtime') WHERE id = ? AND status != 'deleted'`
      ).run(id);

      if (result.changes === 0) {
        return res.status(404).json({ success: false, error: '记录不存在或已删除' });
      }
      console.log(`[${tableName}] 删除记录 id=${id}`);
      res.json({ success: true, message: '已删除' });
    } catch (e) {
      console.error(`[${tableName}] DELETE /:id 失败:`, e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
};

/**
 * 获取模块表允许的字段名（通用字段 + 模块特有字段）
 */
function getAllowedFields(tableName) {
  const common = ['description', 'status'];
  const specific = {
    tasks:        ['title', 'description', 'priority', 'due_date', 'status'],
    inspirations: ['title', 'description', 'tags', 'status'],
    applications: ['title', 'description', 'applicant', 'status'],
    expenses:     ['title', 'description', 'amount', 'category', 'expense_date', 'status'],
  };
  return specific[tableName] || common;
}
