/**
 * 【阶段3】每日记录路由 - 草稿归档 + AI高级分析
 * 独立链路，仅操作 daily_records 表 + 读取 drafts 表
 * AI底层调用 deepseek.js，使用阶段2专用 System Prompt
 */
const express = require('express');
const router = express.Router();
const { chat, DEEPSEEK_MODEL_PRO } = require('../services/deepseek');

// ===== 阶段2 AI高级分析 System Prompt =====
const ANALYSIS_PROMPT = `你是办公事项高级分析助手。
输入为员工工作记录内容，需要完成：
1. 识别事项类型：可选类型【schedule日程、task任务、inspiration灵感、apply申请、expense报销】，输出推荐类型；
2. 提取时间、参与人、地点、截止日期等结构化信息；
3. 判断是否存在时间冲突风险（仅做文字风险提示，不主动查询数据库日程）；
4. 给出简短操作建议；

输出严格JSON格式：
{"suggest_module":"schedule","summary":"事项简短摘要","time_info":"提取到的完整时间信息","conflict_tip":"冲突风险提示，无冲突填空字符串","suggestion":"操作建议"}
禁止编造不存在信息；不要生成额外闲聊文字，只返回标准JSON。`;

/**
 * 调用 AI 高级分析，返回结构化结果对象
 * AI 不可用时返回 null，不阻断保存流程
 */
async function aiAnalyze(content) {
  if (!content || !content.trim()) return null;
  try {
    const result = await chat(
      [{ role: 'user', content }],
      { systemPrompt: ANALYSIS_PROMPT, temperature: 0.3, maxTokens: 1024, model: DEEPSEEK_MODEL_PRO }
    );
    if (result && result.text) {
      try {
        let jsonStr = result.text.trim();
        if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
        if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
        const parsed = JSON.parse(jsonStr.trim());
        return {
          suggest_module: parsed.suggest_module || '',
          summary: parsed.summary || '',
          time_info: parsed.time_info || '',
          conflict_tip: parsed.conflict_tip || '',
          suggestion: parsed.suggestion || '',
        };
      } catch {
        console.error('[DailyRecords] AI返回JSON解析失败');
      }
    }
  } catch (e) {
    console.error('[DailyRecords] AI分析调用失败:', e.message);
  }
  return null;
}

/**
 * 同步到对应模块表
 * @returns 模块名，失败返回 null
 */
function syncToModule(db, openid, draftId, targetModule, fields) {
  if (!targetModule || !openid) return null;
  const { title, content, startTime, endTime, location, person, priority, deadline, amount } = fields;

  // 本地时间格式化，避免 toISOString() 的 UTC 偏移问题
  const nowLocal = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  try {
    switch (targetModule) {
      // ---- 日程 ----
      case 'schedule': {
        const stmt = db.prepare(`
          INSERT INTO schedules (title, description, start_time, end_time, type, priority, person, location, status, source_type, openid)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '待办', 'draft', ?)
        `);
        stmt.run(
          title, content || '',
          startTime || nowLocal(),
          endTime || '',
          'event',
          priority || 'medium',
          person || '', location || '',
          openid
        );
        console.log(`[DailyRecords→schedule] 已同步: "${title}"`);
        return 'schedule';
      }

      // ---- 申请 ----
      case 'apply': {
        db.prepare(`
          INSERT INTO applications (openid, draft_id, title, description, applicant, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
        `).run(openid, draftId, title, content || '', person || '');
        console.log(`[DailyRecords→applications] 已同步: "${title}"`);
        return 'applications';
      }

      // ---- 任务 ----
      case 'task': {
        db.prepare(`
          INSERT INTO tasks (openid, draft_id, title, description, priority, due_date, status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `).run(
          openid, draftId, title, content || '',
          priority || 'medium',
          deadline || endTime || ''
        );
        console.log(`[DailyRecords→tasks] 已同步: "${title}"`);
        return 'tasks';
      }

      // ---- 灵感 ----
      case 'inspiration': {
        db.prepare(`
          INSERT INTO inspirations (openid, draft_id, title, description, tags)
          VALUES (?, ?, ?, ?, '')
        `).run(openid, draftId, title, content || '');
        console.log(`[DailyRecords→inspirations] 已同步: "${title}"`);
        return 'inspirations';
      }

      // ---- 报销 ----
      case 'expense': {
        db.prepare(`
          INSERT INTO expenses (openid, draft_id, title, description, amount, category, expense_date)
          VALUES (?, ?, ?, ?, ?, '', ?)
        `).run(
          openid, draftId, title, content || '',
          amount || 0,
          startTime || nowLocal()
        );
        console.log(`[DailyRecords→expenses] 已同步: "${title}"`);
        return 'expenses';
      }

      default:
        // 未识别的模块，不操作
        return null;
    }
  } catch (e) {
    // 同步失败不影响每日记录保存
    console.error(`[DailyRecords] 同步到 ${targetModule} 失败:`, e.message);
    return null;
  }
}

module.exports = function (db) {

  // ================================================================
  // 1. POST /saveFromDraft - 草稿存入每日记录（复制+AI分析）
  // ================================================================
  router.post('/saveFromDraft', async (req, res) => {
    try {
      const {
        openid, draft_id,
        // 前端直接传入的字段
        target_module: reqTargetModule,
        title: reqTitle,
        content: reqContent,
        start_time: reqStartTime,
        end_time: reqEndTime,
        deadline: reqDeadline,
        amount: reqAmount,
        location: reqLocation,
        person: reqPerson,
        priority: reqPriority,
      } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!draft_id) return res.status(400).json({ success: false, error: '缺少draft_id' });

      // ① 防止重复存入（优先于草稿状态校验，因存入后草稿会被标记deleted）
      const existing = db.prepare(
        'SELECT id FROM daily_records WHERE openid = ? AND draft_id = ?'
      ).get(openid, draft_id);
      if (existing) {
        return res.status(409).json({ success: false, error: '该草稿已存入每日记录，不可重复操作' });
      }

      // ② 校验草稿存在且属于当前用户
      const draft = db.prepare(
        "SELECT * FROM drafts WHERE id = ? AND openid = ? AND status = 'draft'"
      ).get(draft_id, openid);
      if (!draft) {
        return res.status(404).json({ success: false, error: '草稿不存在、已删除或不属于当前用户' });
      }

      // ③ 优先用前端传入的字段，其次草稿数据
      const title = reqTitle || draft.parsed_title || draft.raw_content?.slice(0, 50) || '';
      const content = reqContent || draft.parsed_content || draft.raw_content || '';
      const attachments = draft.raw_file_url ? JSON.stringify([draft.raw_file_url]) : '[]';
      const startTime = reqStartTime || draft.start_time || '';
      const endTime = reqEndTime || draft.end_time || '';
      const location = reqLocation || draft.location || '';
      const person = reqPerson || draft.person || '';
      const priority = reqPriority || draft.priority || '中';

      const info = db.prepare(
        `INSERT INTO daily_records (openid, draft_id, title, content, attachments, priority, location, person, start_time, end_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        openid, draft_id, title, content, attachments,
        priority, location, person, startTime, endTime
      );

      const recordId = info.lastInsertRowid;

      // ④ 更新草稿状态为 deleted
      db.prepare(
        "UPDATE drafts SET status = 'deleted', updated_at = datetime('now','localtime') WHERE id = ? AND openid = ?"
      ).run(draft_id, openid);

      // ⑤ 调用阶段2 AI高级分析
      const aiResult = await aiAnalyze(content);
      const aiAnalysisJson = aiResult ? JSON.stringify(aiResult) : '';
      // 模块判定优先级：前端指定 > AI分析 > 草稿记录
      const finalModule = reqTargetModule || aiResult?.suggest_module || draft.target_module || draft.user_selected_module || null;

      // 写入AI分析结果
      db.prepare(
        'UPDATE daily_records SET target_module = ?, ai_analysis = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?'
      ).run(finalModule, aiAnalysisJson, recordId);

      // ⑥ 同步到对应模块表
      const syncResult = syncToModule(db, openid, draft_id, finalModule, {
        title, content, startTime, endTime,
        location, person, priority,
        deadline: reqDeadline, amount: reqAmount,
      });

      // 返回完整记录
      const record = db.prepare('SELECT * FROM daily_records WHERE id = ?').get(recordId);

      console.log(`[DailyRecords] 草稿 id=${draft_id} → 每日记录 id=${recordId}  module=${finalModule || 'none'}  sync=${syncResult || 'none'}`);
      res.json({
        success: true,
        data: record,
        ai_analysis: aiResult || null,
        sync_module: syncResult,
      });
    } catch (e) {
      console.error('[DailyRecords] POST /saveFromDraft 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 2. POST /reAnalysis - 手动触发二次AI分析
  // ================================================================
  router.post('/reAnalysis', async (req, res) => {
    try {
      const { openid, record_id } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!record_id) return res.status(400).json({ success: false, error: '缺少record_id' });

      const record = db.prepare(
        "SELECT * FROM daily_records WHERE id = ? AND openid = ? AND status = 'active'"
      ).get(record_id, openid);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在或已删除' });
      }

      const aiResult = await aiAnalyze(record.content);
      const aiAnalysisJson = aiResult ? JSON.stringify(aiResult) : '';
      const targetModule = aiResult?.suggest_module || record.target_module;

      db.prepare(
        "UPDATE daily_records SET target_module = ?, ai_analysis = ?, updated_at = datetime('now','localtime') WHERE id = ? AND openid = ?"
      ).run(targetModule, aiAnalysisJson, record_id, openid);

      const updated = db.prepare('SELECT * FROM daily_records WHERE id = ?').get(record_id);

      console.log(`[DailyRecords] 重新AI分析 记录 id=${record_id}`);
      res.json({
        success: true,
        data: updated,
        ai_analysis: aiResult || null,
      });
    } catch (e) {
      console.error('[DailyRecords] POST /reAnalysis 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 3. POST /edit - 手动编辑每日记录
  // ================================================================
  router.post('/edit', (req, res) => {
    try {
      const { openid, record_id, title, content, attachments } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!record_id) return res.status(400).json({ success: false, error: '缺少record_id' });

      const record = db.prepare(
        "SELECT * FROM daily_records WHERE id = ? AND openid = ? AND status = 'active'"
      ).get(record_id, openid);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在或已删除' });
      }

      db.prepare(
        "UPDATE daily_records SET title = ?, content = ?, attachments = ?, updated_at = datetime('now','localtime') WHERE id = ? AND openid = ?"
      ).run(
        title !== undefined ? title : record.title,
        content !== undefined ? content : record.content,
        attachments !== undefined ? (typeof attachments === 'string' ? attachments : JSON.stringify(attachments)) : record.attachments,
        record_id,
        openid
      );

      const updated = db.prepare('SELECT * FROM daily_records WHERE id = ?').get(record_id);

      console.log(`[DailyRecords] 手动编辑 记录 id=${record_id}`);
      res.json({ success: true, data: updated });
    } catch (e) {
      console.error('[DailyRecords] POST /edit 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 4. POST /delete - 逻辑删除（不反向操作原始草稿）
  // ================================================================
  router.post('/delete', (req, res) => {
    try {
      const { openid, record_id } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!record_id) return res.status(400).json({ success: false, error: '缺少record_id' });

      const result = db.prepare(
        "UPDATE daily_records SET status = 'inactive', updated_at = datetime('now','localtime') WHERE id = ? AND openid = ? AND status = 'active'"
      ).run(record_id, openid);

      if (result.changes === 0) {
        return res.status(404).json({ success: false, error: '记录不存在或已删除' });
      }

      console.log(`[DailyRecords] 软删除 记录 id=${record_id}`);
      res.json({ success: true, message: '记录已删除' });
    } catch (e) {
      console.error('[DailyRecords] POST /delete 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 5. GET /list - 分页查询每日记录
  // ================================================================
  router.get('/list', (req, res) => {
    try {
      const { openid, record_date, target_module, page, pageSize } = req.query;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });

      const pageNum = Math.max(1, parseInt(page) || 1);
      const size = Math.min(100, Math.max(1, parseInt(pageSize) || 20));
      const offset = (pageNum - 1) * size;

      // 构建动态查询条件
      const conditions = ["openid = ?", "status = 'active'"];
      const params = [openid];

      if (record_date) {
        conditions.push("date(record_date) = date(?)");
        params.push(record_date);
      }
      if (target_module) {
        conditions.push("target_module = ?");
        params.push(target_module);
      }

      const whereClause = conditions.join(' AND ');

      // 查询总数
      const countRow = db.prepare(
        `SELECT COUNT(*) as total FROM daily_records WHERE ${whereClause}`
      ).get(...params);
      const total = countRow ? countRow.total : 0;

      // 分页数据
      const records = db.prepare(
        `SELECT * FROM daily_records WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).all(...params, size, offset);

      res.json({
        success: true,
        data: records,
        total,
        page: pageNum,
        pageSize: size,
        totalPages: Math.ceil(total / size),
      });
    } catch (e) {
      console.error('[DailyRecords] GET /list 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 6. GET /detail - 单条记录详情
  // ================================================================
  router.get('/detail', (req, res) => {
    try {
      const { openid, record_id } = req.query;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!record_id) return res.status(400).json({ success: false, error: '缺少record_id' });

      const record = db.prepare(
        "SELECT * FROM daily_records WHERE id = ? AND openid = ? AND status = 'active'"
      ).get(record_id, openid);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在或已删除' });
      }

      // 解析 ai_analysis JSON
      let aiAnalysis = null;
      if (record.ai_analysis) {
        try {
          aiAnalysis = JSON.parse(record.ai_analysis);
        } catch { /* ignore */ }
      }

      res.json({ success: true, data: record, ai_analysis: aiAnalysis });
    } catch (e) {
      console.error('[DailyRecords] GET /detail 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 7. POST /distributePreview - 分发预览，展示AI分析结果供用户确认
  // ================================================================
  router.post('/distributePreview', (req, res) => {
    try {
      const { openid, record_id, target_module } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!record_id) return res.status(400).json({ success: false, error: '缺少record_id' });
      if (!target_module) return res.status(400).json({ success: false, error: '缺少target_module' });

      const record = db.prepare(
        "SELECT * FROM daily_records WHERE id = ? AND openid = ? AND status = 'active'"
      ).get(record_id, openid);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在或已删除' });
      }

      // 检查是否已分发
      if (record.distributed_module) {
        return res.status(409).json({ success: false, error: `该记录已分发至【${record.distributed_module}】模块，不可重复分发` });
      }

      if (target_module === 'schedule') {
        // 解析 AI 分析结果，组装完整预览数据
        let aiData = {};
        if (record.ai_analysis) {
          try { aiData = JSON.parse(record.ai_analysis); } catch { /* ignore */ }
        }

        res.json({
          success: true,
          data: {
            target_module: 'schedule',
            preview: {
              title: record.title,
              description: record.content,
              summary: aiData.summary || '',
              time_info: aiData.time_info || '',
              conflict_tip: aiData.conflict_tip || '',
              suggestion: aiData.suggestion || '',
              source_type: 'daily_record',
              draft_id: record.draft_id,
              record_id: record.id,
            },
            message: '请确认后分发至日程模块',
          },
        });
      } else {
        const moduleNames = {
          task: '任务', inspiration: '灵感', apply: '申请', expense: '报销',
        };
        res.json({
          success: true,
          data: {
            target_module,
            preview: null,
            message: `【${moduleNames[target_module] || target_module}】模块暂未开放落地，敬请期待`,
          },
        });
      }
    } catch (e) {
      console.error('[DailyRecords] POST /distributePreview 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 8. POST /distribute - 【阶段6】分发至日程模块，写入 schedules 表
  // ================================================================
  router.post('/distribute', async (req, res) => {
    try {
      const { openid, record_id, target_module } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!record_id) return res.status(400).json({ success: false, error: '缺少record_id' });
      if (!target_module) return res.status(400).json({ success: false, error: '缺少target_module' });

      const record = db.prepare(
        "SELECT * FROM daily_records WHERE id = ? AND openid = ? AND status = 'active'"
      ).get(record_id, openid);
      if (!record) {
        return res.status(404).json({ success: false, error: '记录不存在或已删除' });
      }

      // 防重复分发
      if (record.distributed_module) {
        return res.status(409).json({ success: false, error: `该记录已分发至【${record.distributed_module}】模块` });
      }

      // 目前仅支持日程模块
      if (target_module !== 'schedule') {
        return res.status(400).json({ success: false, error: `模块【${target_module}】暂不支持分发` });
      }

      // 解析 AI 分析结果
      let aiData = {};
      if (record.ai_analysis) {
        try { aiData = JSON.parse(record.ai_analysis); } catch { /* ignore */ }
      }

      // 从 AI time_info 尝试提取日期时间（格式如 "2026-08-03 15:00"）
      const timeStr = aiData.time_info || '';
      const { start_time, end_time } = extractTime(timeStr);

      // 写入 schedules 表
      const insertSchedule = db.prepare(`
        INSERT INTO schedules
          (title, description, start_time, end_time, type, priority, person, location, reminder_minutes, repeat_type, status, raw_text, source_type, openid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = insertSchedule.run(
        record.title,
        record.content || '',
        start_time || record.start_time || '',
        end_time || record.end_time || '',
        '日程',
        record.priority || '中',
        record.person || '',
        record.location || '',
        0,
        '单次',
        '待办',
        record.content || '',
        'daily_record',
        openid
      );

      const scheduleId = info.lastInsertRowid;

      // 创建默认提醒
      if (start_time) {
        try {
          createRemindersForSchedule(db, scheduleId, start_time);
        } catch (e) {
          console.warn('[DailyRecords] 创建提醒失败:', e.message);
        }
      }

      // 更新 daily_records 分发状态
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(
        "UPDATE daily_records SET distributed_module = ?, distributed_at = ?, distributed_schedule_id = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(target_module, now, scheduleId, record_id);

      console.log(`[DailyRecords] 分发成功: 记录 id=${record_id} → 日程 id=${scheduleId}`);

      res.json({
        success: true,
        data: {
          schedule_id: scheduleId,
          title: record.title,
          start_time,
          end_time,
          distributed_at: now,
        },
        message: '已成功分发至日程模块',
      });
    } catch (e) {
      console.error('[DailyRecords] POST /distribute 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ================================================================
  // 辅助函数 - 从AI time_info 提取开始/结束时间
  // ================================================================
  function extractTime(timeStr) {
    let start_time = '';
    let end_time = '';
    if (!timeStr) return { start_time, end_time };

    // 匹配 "YYYY-MM-DD HH:MM" 或 "YYYY-MM-DDTHH:MM"
    const dtPattern = /(\d{4}-\d{2}-\d{2})[\sT]+(\d{1,2}:\d{2})/g;
    const matches = [...timeStr.matchAll(dtPattern)];

    if (matches.length >= 2) {
      start_time = `${matches[0][1]} ${matches[0][2].padStart(5, '0')}:00`;
      end_time = `${matches[1][1]} ${matches[1][2].padStart(5, '0')}:00`;
    } else if (matches.length === 1) {
      start_time = `${matches[0][1]} ${matches[0][2].padStart(5, '0')}:00`;
      // 日程不需要默认结束时间，保持为空
    }

    return { start_time, end_time };
  }

  // ================================================================
  // 辅助函数 - 为日程创建默认提醒（提前60分钟 + 10分钟）
  // ================================================================
  function createRemindersForSchedule(db, scheduleId, startTime) {
    const parseLocal = (str) => {
      const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/);
      if (!m) return null;
      const d = new Date(0);
      d.setFullYear(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
      d.setHours(parseInt(m[4]), parseInt(m[5]), parseInt(m[6]));
      return isNaN(d.getTime()) ? null : d;
    };
    const fmtLocal = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const start = parseLocal(startTime);
    if (!start) return;

    const now = new Date();
    const minutesUntil = (start.getTime() - now.getTime()) / 60000;
    if (minutesUntil <= 0) return;

    const reminders = [60, 10]; // 默认提前60分钟和10分钟
    const insert = db.prepare(
      'INSERT INTO schedule_reminders (schedule_id, minutes_before, planned_time, channel) VALUES (?, ?, ?, ?)'
    );

    for (const minutes of reminders) {
      let channel = 'scheduled';
      let plannedStr;

      if (minutesUntil <= 10) {
        channel = 'pending';
        plannedStr = fmtLocal(now);
      } else if (Math.abs(minutesUntil - minutes) <= 1 && minutesUntil <= minutes + 1) {
        channel = 'pending';
        plannedStr = fmtLocal(now);
      } else if (minutesUntil > minutes) {
        const planned = new Date(start.getTime() - minutes * 60 * 1000);
        plannedStr = fmtLocal(planned);
      } else {
        continue;
      }

      try {
        insert.run(scheduleId, minutes, plannedStr, channel);
      } catch (e) {
        console.warn('[DailyRecords] 创建提醒失败:', scheduleId, minutes, e.message);
      }
    }
  }

  return router;
};
