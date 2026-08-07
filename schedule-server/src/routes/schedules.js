/**
 * 日程管理路由
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { aiParse } = require('../services/ai-parser');
const { recognizeVoice, recognizeImage } = require('../services/asr-ocr');

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

module.exports = function (db) {

  // ===== 辅助：判断时间是否已过期 =====
  function isPastTime(timeStr) {
    if (!timeStr) return false;
    const trimmed = String(timeStr).trim();
    const now = new Date();
    // 仅日期（如 "2026-08-05"），按天比较
    if (trimmed.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(trimmed + 'T00:00:00');
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return d < today;
    }
    // 带时间的完整字符串
    const d = new Date(trimmed.replace(' ', 'T'));
    return !isNaN(d) && d < now;
  }

  // ===== 辅助：自动同步今日日程到每日记录 =====
  function autoSyncToDailyRecord(db, openid, title, description, start_time, type, location, person) {
    try {
      if (!openid || !start_time) return;
      // 只同步今天的日程
      const scheduleDate = start_time.substring(0, 10);
      const today = new Date().toISOString().substring(0, 10);
      if (scheduleDate !== today) return;

      // 检查是否已有今天的记录
      const existing = db.prepare(
        'SELECT id FROM daily_records WHERE openid = ? AND record_date = ? AND status = ?'
      ).get(openid, today, 'active');

      const contentLine = `【${type || '日程'}】${title || '日程'} | ${location || ''} | ${person || ''} | ${description || ''}`;

      if (existing) {
        // 更新今天的记录：追加新日程
        const oldContent = db.prepare('SELECT content FROM daily_records WHERE id = ?').get(existing.id)?.content || '';
        const newContent = oldContent ? oldContent + '\n' + contentLine : contentLine;
        db.prepare('UPDATE daily_records SET content = ?, updated_at = ? WHERE id = ?')
          .run(newContent, new Date().toISOString(), existing.id);
        console.log(`[DailySync] 更新今日记录 id=${existing.id}`);
      } else {
        // 创建今天的记录
        const result = db.prepare(
          `INSERT INTO daily_records (openid, title, content, record_date, target_module, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(openid, `今日日程`, contentLine, today, 'schedule', 'active',
          new Date().toISOString(), new Date().toISOString());
        console.log(`[DailySync] 创建今日记录 id=${result.lastInsertRowid}`);
      }
    } catch (e) {
      console.warn('[DailySync] 同步失败:', e.message);
    }
  }

  // ===== 解析文本（不保存） =====
  router.post('/parse', (req, res) => {
    const { text, typeHint } = req.body;
    if (!text) return res.status(400).json({ success: false, error: '请提供文本内容' });
    const result = aiParse(text, { typeHint });
    res.json({ success: true, data: result });
  });

  // ===== 创建日程 =====
  router.post('/', (req, res) => {
    const { text, typeHint, sourceType = 'text', reminder_minutes_list, openid = '' } = req.body;
    if (!text) return res.status(400).json({ success: false, error: '请提供文本内容' });

    const parsed = aiParse(text, { typeHint });

    // 禁止创建过去时间的日程（只允许未来的时间）
    if (parsed.start_time && isPastTime(parsed.start_time)) {
      return res.status(400).json({ success: false, error: '不能创建过去时间的日程，请使用未来的时间' });
    }
    const stmt = db.prepare(`
      INSERT INTO schedules
        (title, start_time, end_time, type, priority, person, location, reminder_minutes, repeat_type, status, raw_text, source_type, openid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      parsed.title, parsed.start_time, parsed.end_time, parsed.type, parsed.priority,
      parsed.person, parsed.location, parsed.reminder_minutes, parsed.repeat_type, '待办', parsed.raw_text, sourceType,
      openid
    );

    const scheduleId = info.lastInsertRowid;

    // 创建提醒：优先使用前端传入的自定义提醒时间，否则默认 1小时前 + 10分钟前
    if (parsed.start_time) {
      const minutesList = Array.isArray(reminder_minutes_list) && reminder_minutes_list.length > 0
        ? reminder_minutes_list
        : null; // null 表示使用默认值 [60, 5]
      try {
        createDefaultReminders(db, scheduleId, parsed.start_time, minutesList);
      } catch (e) {
        console.warn('创建默认提醒失败:', e.message);
        // 日程已创建，提醒失败无需中断请求
      }
    }

    // 自动同步到今日每日记录
    autoSyncToDailyRecord(db, openid, parsed.title, parsed.description, parsed.start_time, parsed.type, parsed.location, parsed.person);

    res.json({ success: true, data: { id: scheduleId, ...parsed } });
  });

  // ===== 从 AI 草案创建日程（不走 aiParse，直接入库） =====
  router.post('/from-draft', (req, res) => {
    const { title, start_time, end_time, type, priority, person, location, description, sourceType = 'ai', reminder_minutes_list, openid = '' } = req.body;
    if (!title) return res.status(400).json({ success: false, error: '缺少标题' });

    // 规范化枚举值（AI 可能返回中文，这里做兜底转换）
    const TYPE_MAP = { '日程': 'event', '会议': 'meeting', '任务': 'task', '提醒': 'remind' };
    const PRIORITY_MAP = { '高': 'high', '中': 'medium', '低': 'low' };
    const normalizedType = TYPE_MAP[type] || type || 'event';
    const normalizedPriority = PRIORITY_MAP[priority] || priority || 'medium';

    // 时间默认值：不能用空字符串，否则前端按日期过滤时永远查不到
    // 同时规范化时间格式（AI 可能返回 "2026-08-05 15:00" 而非 ISO 8601）
    const normalizeTime = (t) => {
      if (!t || !String(t).trim()) return null;
      let ts = String(t).trim();
      // 替换空格为 T（修复 "2026-08-05 15:00" 格式）
      ts = ts.replace(' ', 'T');
      // 补全秒数（如果只有日期）
      if (ts.length === 10) ts += 'T00:00:00';
      // 只补全缺失的部分：如果已有时:分但缺秒，补秒
      if (ts.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)) ts += ':00';
      // 保留为本地时间，不附加 Z 时区标记（确保前后端一致显示北京时间）
      return ts;
    };
    const nowISO = new Date().toISOString();
    const oneHourLater = new Date(Date.now() + 3600000).toISOString();
    const validStart = normalizeTime(start_time) || nowISO;
    const validEnd = normalizeTime(end_time) || oneHourLater;

    // 禁止创建过去时间的日程
    if (validStart && validStart !== nowISO && isPastTime(validStart)) {
      return res.status(400).json({ success: false, error: '不能创建过去时间的日程，请使用未来的时间' });
    }

    const stmt = db.prepare(`
      INSERT INTO schedules
        (title, description, start_time, end_time, type, priority, person, location, reminder_minutes, repeat_type, status, raw_text, source_type, openid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      title,
      description || '',
      validStart,
      validEnd,
      normalizedType,
      normalizedPriority,
      person || '',
      location || '',
      0,
      '单次',
      '待办',
      '',
      sourceType,
      openid
    );

    const scheduleId = info.lastInsertRowid;

    if (validStart) {
      const minutesList = Array.isArray(reminder_minutes_list) && reminder_minutes_list.length > 0
        ? reminder_minutes_list
        : null;
      try {
        createDefaultReminders(db, scheduleId, validStart, minutesList);
      } catch (e) {
        console.warn('创建默认提醒失败:', e.message);
      }
    }

    // 自动写入每日记录（仅当日程日期为今天时）
    autoSyncToDailyRecord(db, openid, title, description, validStart, normalizedType, undefined, location, person);

    res.json({ success: true, data: { id: scheduleId, title, start_time: validStart, end_time: validEnd, type: normalizedType, priority: normalizedPriority, person, location, description } });
  });

  // ===== 更新日程的提醒设置 =====
  router.post('/:id/reminders', (req, res) => {
    const { id } = req.params;
    const { minutes_list } = req.body;

    const row = db.prepare('SELECT id, start_time FROM schedules WHERE id = ?').get(parseInt(id));
    if (!row) return res.status(404).json({ success: false, error: '日程不存在' });
    if (!row.start_time) return res.status(400).json({ success: false, error: '该日程无开始时间' });

    // 删除旧的提醒记录
    db.prepare('DELETE FROM schedule_reminders WHERE schedule_id = ?').run(parseInt(id));

    // 创建新的提醒
    if (Array.isArray(minutes_list) && minutes_list.length > 0) {
      createDefaultReminders(db, parseInt(id), row.start_time, minutes_list, false);
    }

    res.json({ success: true, message: '提醒已更新' });
  });

  // ===== 语音识别 =====
  router.post('/voice', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传音频文件' });

    try {
      const result = await recognizeVoice(req.file.path, req.file.originalname);
      fs.unlinkSync(req.file.path);
      res.json({ success: true, data: result });
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      res.status(500).json({ success: false, error: err.message || '语音识别失败' });
    }
  });

  // ===== 图片 OCR =====
  router.post('/image', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传图片' });

    try {
      const result = await recognizeImage(req.file.path);
      fs.unlinkSync(req.file.path);
      res.json({ success: true, data: result });
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      res.status(500).json({ success: false, error: err.message || '图片识别失败' });
    }
  });

  // ===== 获取日程列表 =====
  router.get('/', (req, res) => {
    const openid = req.query.openid || '';
    // 查询前自动将过期的待办日程标记为已完成（只处理当前用户的）
    // 统一使用 date() 比较日期部分，避免纯日期格式（如 "2026-01-15"）
    // 在 SQLite 字符串比较中被误判为 < datetime('now')（短字符串是长字符串前缀）
    // 规则：start 或 end 日期的日期部分 必须严格早于今天 才自动完成
    try {
      db.prepare(
        "UPDATE schedules SET status = '已完成', updated_at = datetime('now','localtime') WHERE status = '待办' AND openid = ? AND ((end_time != '' AND date(substr(end_time,1,10)) < date('now','localtime')) OR (end_time = '' AND date(substr(start_time,1,10)) < date('now','localtime')))"
      ).run(openid);
    } catch (e) {
      // 静默忽略
    }

    const { status, type, date_from, date_to, limit } = req.query;
    let sql = 'SELECT * FROM schedules WHERE openid = ?';
    const params = [openid];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (date_from) { sql += ' AND datetime(start_time) >= datetime(?)'; params.push(date_from); }
    if (date_to) { sql += ' AND datetime(start_time) <= datetime(?)'; params.push(date_to); }

    sql += ' ORDER BY start_time ASC';
    if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }

    const rows = db.prepare(sql).all(...params);
    res.json({ success: true, data: rows, total: rows.length });
  });

  // ===== 获取单条日程 =====
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ success: false, error: '日程不存在' });
    res.json({ success: true, data: row });
  });

  // ===== 更新日程 =====
  router.put('/:id', (req, res) => {
    const { id } = req.params;
    const openid = req.body.openid || req.query.openid || '';
    const row = db.prepare('SELECT id, openid FROM schedules WHERE id = ?').get(parseInt(id));
    if (!row) return res.status(404).json({ success: false, error: '日程不存在' });
    if (openid && row.openid !== openid) return res.status(403).json({ success: false, error: '无权修改此日程' });

    const fields = [];
    const params = [];
    const allowed = ['title', 'start_time', 'end_time', 'type', 'priority', 'person', 'location', 'reminder_minutes', 'repeat_type', 'status', 'description'];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: '没有可更新的字段' });
    }

    fields.push("updated_at = datetime('now','localtime')");
    params.push(parseInt(id));
    db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    // 如果更新了开始时间，重置提醒
    if (req.body.start_time !== undefined) {
      db.prepare('DELETE FROM schedule_reminders WHERE schedule_id = ?').run(parseInt(id));
      const minutesList = Array.isArray(req.body.reminder_minutes_list) ? req.body.reminder_minutes_list : null;
      createDefaultReminders(db, parseInt(id), req.body.start_time, minutesList);
    }

    const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(parseInt(id));
    res.json({ success: true, data: updated });
  });

  // ===== 删除日程 =====
  router.delete('/:id', (req, res) => {
    const openid = req.query.openid || req.body.openid || '';
    const row = db.prepare('SELECT id, openid FROM schedules WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ success: false, error: '日程不存在' });
    if (openid && row.openid !== openid) return res.status(403).json({ success: false, error: '无权删除此日程' });

    db.prepare('DELETE FROM schedules WHERE id = ?').run(parseInt(req.params.id));
    res.json({ success: true, message: '已删除' });
  });

  // ===== 批量完成/恢复 =====
  router.post('/batch-status', (req, res) => {
    const { ids, status, openid = '' } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !status) {
      return res.status(400).json({ success: false, error: '请提供 ids 数组和 status' });
    }

    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE schedules SET status = ?, updated_at = datetime('now','localtime') WHERE id IN (${placeholders}) AND openid = ?`)
      .run(status, ...ids.map(Number), openid);

    res.json({ success: true, message: `已更新 ${ids.length} 条日程` });
  });

  return router;
};

/**
 * 为日程创建提醒记录（不使用事务，简单逐条插入）
 * @param {Array<number>|null} minutesList - 提醒分钟数数组，null 表示使用默认 [60, 5]
 * @param {boolean} useDefault - true 表示即使传了 minutesList 也要合并默认值
 */
function createDefaultReminders(db, scheduleId, startTime, minutesList, useDefault = true) {
  const start = parseLocalDateTime(startTime);
  if (!start) return;

  const now = new Date();
  const minutesUntil = (start.getTime() - now.getTime()) / 60000;

  // 已过期的日程不创建提醒
  if (minutesUntil <= 0) return;

  // 收集所有提醒点
  let allReminders;
  if (Array.isArray(minutesList) && minutesList.length > 0) {
    allReminders = minutesList.map(m => ({ minutes: m }));
    if (useDefault) {
      if (!minutesList.some(m => m === 60)) allReminders.push({ minutes: 60 });
      if (!minutesList.some(m => m === 10)) allReminders.push({ minutes: 10 });
    }
  } else {
    allReminders = [
      { minutes: 60 },
      { minutes: 10 },
    ];
  }

  const insert = db.prepare(`
    INSERT INTO schedule_reminders (schedule_id, minutes_before, planned_time, channel)
    VALUES (?, ?, ?, ?)
  `);

  for (const item of allReminders) {
    try {
      const { minutes } = item;
      let channel = 'scheduled';
      let plannedStr;

      if (minutesUntil <= 10) {
        // 距开会 ≤ 10 分钟 → 立即推送
        channel = 'pending';
        plannedStr = formatLocalDateTime(now);
      } else if (Math.abs(minutesUntil - minutes) <= 1 && minutesUntil <= minutes + 1) {
        // 恰好在提醒窗口内（如 59-60 分 或 9-10 分）→ 立即推送
        channel = 'pending';
        plannedStr = formatLocalDateTime(now);
      } else if (minutesUntil > minutes) {
        // 正常排期：日程还早，到时再推
        const planned = new Date(start.getTime() - minutes * 60 * 1000);
        plannedStr = formatLocalDateTime(planned);
      } else {
        // 已过提醒点但没在窗口内（如 minutesUntil=30，10 分钟提醒点已过）→ 跳过
        continue;
      }

      insert.run(scheduleId, minutes, plannedStr, channel);
    } catch (e) {
      console.error('创建提醒失败 (schedule_id=%d, minutes_before=%d):', scheduleId, item.minutes, e.message);
    }
  }
}

function parseLocalDateTime(str) {
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(0);
  d.setFullYear(parseInt(m[1], 10));
  d.setMonth(parseInt(m[2], 10) - 1);
  d.setDate(parseInt(m[3], 10));
  d.setHours(parseInt(m[4], 10));
  d.setMinutes(parseInt(m[5], 10));
  d.setSeconds(parseInt(m[6], 10));
  return isNaN(d.getTime()) ? null : d;
}

function formatLocalDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
