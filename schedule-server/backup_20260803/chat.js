/**
 * Chat 路由 - AI 对话 + 日程提取 + 会话管理
 * 对接 Deepseek API，处理语音转文字，管理聊天历史（支持多会话）
 */
const express = require('express');
const deepseek = require('../services/doubao');
const crypto = require('crypto');

function genSessionId() {
  return 's_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

// ========== 日程查询辅助 ==========

/**
 * 检测用户消息是否在查询自己已有的日程
 * 返回 { dateFrom, dateTo, scheduleType } 或 null
 */
function detectScheduleQuery(msg) {
  if (!msg) return null;
  const text = msg;

  let dateFrom = null, dateTo = null;
  let scheduleType = null;

  const today = new Date();
  const toDateStr = (d) => d.toISOString().split('T')[0];

  if (/今天|今日/.test(text)) {
    dateFrom = dateTo = toDateStr(today);
  } else if (/明天|明日/.test(text)) {
    const t = new Date(today); t.setDate(t.getDate() + 1);
    dateFrom = dateTo = toDateStr(t);
  } else if (/后天/.test(text)) {
    const t = new Date(today); t.setDate(t.getDate() + 2);
    dateFrom = dateTo = toDateStr(t);
  } else if (/本周|这周|这礼拜/.test(text)) {
    const day = today.getDay() || 7;
    const mon = new Date(today); mon.setDate(today.getDate() - day + 1);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    dateFrom = toDateStr(mon); dateTo = toDateStr(sun);
  } else if (/下周|下礼拜/.test(text)) {
    const day = today.getDay() || 7;
    const nextMon = new Date(today); nextMon.setDate(today.getDate() - day + 8);
    const nextSun = new Date(nextMon); nextSun.setDate(nextMon.getDate() + 6);
    dateFrom = toDateStr(nextMon); dateTo = toDateStr(nextSun);
  } else if (/最近|近期|未来|后面/.test(text)) {
    dateFrom = toDateStr(today);
    const end = new Date(today); end.setDate(today.getDate() + 7);
    dateTo = toDateStr(end);
  }

  if (/会议|开会/.test(text)) scheduleType = '会议';
  else if (/任务|待办/.test(text)) scheduleType = '任务';
  else if (/提醒/.test(text)) scheduleType = '提醒';

  // 查询意图关键词
  const isQueryLike = /有几个|多少个|有多少|有什么|有哪些|查询|查看|看看|查查|告诉我|我的.*日程|我的.*安排|日程.*怎么样|安排.*情况|梳理一下|总结一下/.test(text);

  if (!isQueryLike && !dateFrom) return null;

  return { dateFrom, dateTo, scheduleType };
}

/**
 * 从数据库查询日程
 */
function querySchedulesFromDb(db, openid, { dateFrom, dateTo, scheduleType }) {
  let sql = 'SELECT title, type, start_time, end_time, priority, location, status FROM schedules WHERE openid = ?';
  const params = [openid];

  if (dateFrom && dateTo) {
    sql += ' AND date(start_time) BETWEEN ? AND ?';
    params.push(dateFrom, dateTo);
  } else if (dateFrom) {
    sql += ' AND date(start_time) >= ?';
    params.push(dateFrom);
  } else if (dateTo) {
    sql += ' AND date(start_time) <= ?';
    params.push(dateTo);
  } else {
    // 无日期关键词，默认查未来 7 天
    const today = new Date().toISOString().split('T')[0];
    const end = new Date(); end.setDate(end.getDate() + 7);
    sql += ' AND date(start_time) BETWEEN ? AND ?';
    params.push(today, end.toISOString().split('T')[0]);
  }

  if (scheduleType) {
    sql += ' AND type = ?';
    params.push(scheduleType);
  }

  sql += ' ORDER BY start_time ASC LIMIT 20';

  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    console.error('[ScheduleQuery] DB 查询失败:', e.message);
    return [];
  }
}

/**
 * 将日程数据格式化为 AI 可读的文本
 */
function formatScheduleContext(rows, openid) {
  if (!rows || rows.length === 0) return ''; // 空结果不注入，让 AI 自由回答

  // 按类型统计
  const typeCount = {};
  rows.forEach(r => { typeCount[r.type] = (typeCount[r.type] || 0) + 1; });

  let text = '## 该用户的日程数据（来自数据库）\n';
  text += `共 ${rows.length} 条日程：`;
  const typeParts = [];
  Object.entries(typeCount).forEach(([t, c]) => typeParts.push(`${t} ${c}条`));
  text += typeParts.join('，') + '\n\n';

  rows.forEach((r, i) => {
    const start = r.start_time || '';
    const end = r.end_time || '';
    const timeStr = start === end ? start : `${start} ~ ${end}`;
    text += `${i + 1}. [${r.type}][${r.priority}] ${r.title}`;
    if (timeStr) text += ` | ${timeStr}`;
    if (r.location) text += ` | 📍${r.location}`;
    if (r.status) text += ` | ${r.status}`;
    text += '\n';
  });

  text += '\n请基于以上真实数据回答。如果用户问数量请准确计数。如果没有匹配的日程请如实说明。';
  return text;
}

/**
 * 解析 AI 返回文本，保存助手消息到 DB，并写入 SSE 完成事件
 */
function sendFinalResult(res, fullText, sessionId, db, openid, usage) {
  let replyText = fullText;
  let draftSchedule = null;
  let resultType = 'chat';

  if (fullText && fullText.trim()) {
    // 尝试从流式拼接的结果中提取 JSON
    try {
      let jsonStr = fullText.trim();
      if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
      if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
      jsonStr = jsonStr.trim();
      const parsed = JSON.parse(jsonStr);
      replyText = parsed.text || fullText;
      resultType = parsed.type || 'chat';
      draftSchedule = parsed.schedule || null;
    } catch (e) {
      // 非 JSON 输出，保留原文字
    }
  }

  if (!replyText || !replyText.trim()) {
    replyText = '收到您的消息，但我不太确定如何帮您。可以尝试描述您的日程，例如"明天下午3点开会"。';
  }

  // 保存助手消息到 DB
  try {
    const insertHistory = db.prepare(
      'INSERT INTO chat_history (openid, role, content, result_type, result_data, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insertHistory.run(openid, 'assistant', replyText,
      draftSchedule ? 'schedule' : 'chat',
      draftSchedule ? JSON.stringify(draftSchedule) : null,
      sessionId
    );
  } catch (err) {
    console.error('[Chat/Stream] 保存助手消息失败:', err.message);
  }

  // 发送完成事件
  res.write(`data: ${JSON.stringify({
    done: true,
    text: replyText,
    type: resultType,
    schedule: draftSchedule,
    session_id: sessionId,
    usage: usage,
  })}\n\n`);
  res.end();
}

module.exports = function (db) {
  const router = express.Router();

  // ===== 核心：AI 对话接口（支持 session_id + 数据库查询） =====
  router.post('/', async (req, res) => {
    const { openid, msg, botId, files, history, session_id } = req.body;

    if (!openid || !msg) {
      return res.status(400).json({ success: false, error: '缺少 openid 或 msg' });
    }

    // 防御：拒绝空消息
    const cleanMsg = (msg || '').trim();
    if (!cleanMsg) {
      return res.status(400).json({ success: false, error: '消息内容不能为空' });
    }

    // 自动分配或使用已有 session_id
    const sid = session_id || genSessionId();

    try {
      // 构建消息历史
      const messages = (history || []).map(h => ({
        role: h.role,
        content: h.content,
      }));
      messages.push({ role: 'user', content: cleanMsg });

      // 如果有文件，追加到消息中
      if (files && files.length > 0) {
        const fileInfo = files.map(f => `[文件: ${f}]`).join(', ');
        messages[messages.length - 1].content += `\n附件: ${fileInfo}`;
      }

      // ===== 日程查询：检测意图并注入数据库内容 =====
      const queryIntent = detectScheduleQuery(cleanMsg);
      if (queryIntent) {
        const rows = querySchedulesFromDb(db, openid, queryIntent);
        const scheduleCtx = formatScheduleContext(rows, openid);
        if (scheduleCtx) {
          // 在系统消息之后插入一条 system 消息提供数据上下文
          // 系统消息是第一条（index 0），我们在它后面插入
          messages.splice(1, 0, { role: 'system', content: scheduleCtx });
        }
      }

      // 1. 尝试调用 Deepseek API
      let aiResult = null;
      try {
        aiResult = await deepseek.chat(messages);
      } catch (dsErr) {
        console.error('[Chat] Deepseek调用失败，降级到规则引擎:', dsErr.message);
      }

      let replyText = '';
      let draftSchedule = null;

      if (aiResult) {
        replyText = aiResult.text;
        if (aiResult.schedule) {
          draftSchedule = aiResult.schedule;
        }
      }

      // 如果没有任何回复，给默认消息
      if (!replyText) {
        replyText = '收到您的消息，但我不太确定如何帮您。可以尝试描述您的日程，例如"明天下午3点开会"。';
      }

      // 保存聊天历史（带 session_id）
      try {
        const insertHistory = db.prepare(`
          INSERT INTO chat_history (openid, role, content, result_type, result_data, session_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        insertHistory.run(openid, 'user', cleanMsg, null, null, sid);
        insertHistory.run(
          openid, 'assistant', replyText,
          draftSchedule ? 'schedule' : 'chat',
          draftSchedule ? JSON.stringify(draftSchedule) : null,
          sid
        );
      } catch (err) {
        console.error('[Chat] 历史记录保存失败:', err.message);
      }

      res.json({
        success: true,
        data: {
          text: replyText,
          schedule: draftSchedule,
          type: draftSchedule ? 'schedule' : 'chat',
          usage: aiResult?.usage || null,
          session_id: sid,
        },
      });
    } catch (err) {
      console.error('[Chat] 处理失败:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 获取会话列表 =====
  router.get('/sessions', (req, res) => {
    const { openid } = req.query;
    if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

    try {
      const sessions = db.prepare(`
        SELECT session_id as id,
               MIN(created_at) as created_at,
               MAX(created_at) as updated_at,
               COUNT(*) as msg_count,
               (SELECT content FROM chat_history WHERE session_id = ch.session_id AND role = 'user' ORDER BY created_at ASC LIMIT 1) as title
        FROM chat_history ch
        WHERE openid = ? AND session_id != ''
        GROUP BY session_id
        ORDER BY updated_at DESC
      `).all(openid);

      res.json({ success: true, data: sessions });
    } catch (err) {
      console.error('[Chat] 获取会话列表失败:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 获取某个会话的聊天历史 =====
  router.get('/history', (req, res) => {
    const { openid, session_id, pageSize = 50, pageNumber = 1 } = req.query;
    if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' });

    try {
      const offset = (parseInt(pageNumber) - 1) * parseInt(pageSize);
      const limit = parseInt(pageSize);

      let totalRow, rows;
      if (session_id) {
        totalRow = db.prepare('SELECT COUNT(*) as total FROM chat_history WHERE openid = ? AND session_id = ?').get(openid, session_id);
        rows = db.prepare(`
          SELECT id, role, content, result_type, result_data, session_id, created_at
          FROM chat_history WHERE openid = ? AND session_id = ?
          ORDER BY created_at ASC LIMIT ? OFFSET ?
        `).all(openid, session_id, limit, offset);
      } else {
        totalRow = db.prepare('SELECT COUNT(*) as total FROM chat_history WHERE openid = ?').get(openid);
        rows = db.prepare(`
          SELECT id, role, content, result_type, result_data, session_id, created_at
          FROM chat_history WHERE openid = ?
          ORDER BY created_at DESC LIMIT ? OFFSET ?
        `).all(openid, limit, offset);
      }

      const data = rows.map(row => {
        let resultData = null;
        if (row.result_data) {
          try { resultData = JSON.parse(row.resultData || row.result_data); } catch { }
        }
        return {
          id: row.id,
          role: row.role,
          content: row.content,
          resultType: row.result_type,
          resultData,
          sessionId: row.session_id,
          createdAt: row.created_at,
        };
      });

      // 非 session 查询时保持 DESC（前端可能用 reverse），session 查询返回 ASC 直接使用
      res.json({
        success: true,
        data: session_id ? data : data.reverse(),
        total: totalRow.total,
        pageNumber: parseInt(pageNumber),
        pageSize: limit,
      });
    } catch (err) {
      console.error('[Chat] 获取历史失败:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 删除整个会话 =====
  router.delete('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { openid } = req.body;

    if (!openid || !sessionId) {
      return res.status(400).json({ success: false, error: '缺少参数' });
    }

    try {
      const result = db.prepare('DELETE FROM chat_history WHERE openid = ? AND session_id = ?').run(openid, sessionId);
      res.json({ success: true, data: { deleted: result.changes } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 语音转文字（降级方案） =====
  // 当微信 WechatSI 插件不可用时，上传音频到服务器做 ASR
  router.post('/speech', (req, res) => {
    // 需要 multer 解析文件上传
    // 这里使用腾讯云 ASR 服务
    const asrOcr = require('../services/asr-ocr');

    // multer 中间件已在 index.js 挂载，这里需要单独处理
    // 如果在 index.js 中挂载了 multer，文件会在 req.file 中
    res.json({
      success: false,
      error: '语音识别请使用微信语音插件，更稳定更快速',
    });
  });

  // ===== 流式 AI 对话（实时逐字输出 + 数据库查询） =====
  router.post('/stream', async (req, res) => {
    const { openid, msg, history, session_id } = req.body;

    if (!openid || !msg) {
      return res.status(400).json({ success: false, error: '缺少 openid 或 msg' });
    }

    // 防御：拒绝保存空消息（trim 后空字符串）
    const cleanMsg = (msg || '').trim();
    if (!cleanMsg) {
      return res.status(400).json({ success: false, error: '消息内容不能为空' });
    }

    const sid = session_id || genSessionId();

    // 构建消息历史
    const messages = (history || []).map(h => ({
      role: h.role,
      content: h.content,
    }));
    messages.push({ role: 'user', content: cleanMsg });

    // ===== 日程查询：检测意图并注入数据库内容 =====
    const queryIntent = detectScheduleQuery(cleanMsg);
    if (queryIntent) {
      const rows = querySchedulesFromDb(db, openid, queryIntent);
      const scheduleCtx = formatScheduleContext(rows, openid);
      if (scheduleCtx) {
        messages.splice(1, 0, { role: 'system', content: scheduleCtx });
      }
    }

    // 保存用户消息
    try {
      const insertHistory = db.prepare(
        'INSERT INTO chat_history (openid, role, content, result_type, result_data, session_id) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertHistory.run(openid, 'user', cleanMsg, null, null, sid);
    } catch (err) {
      console.error('[Chat/Stream] 保存用户消息失败:', err.message);
    }

    // SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let fullText = '';
    let dsUsage = null;

    try {
      const stream = await deepseek.chatStream(messages, { maxTokens: 1024 });

      // 收集 SSE chunks 并解析文本
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留不完整的行

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta;
            // Deepseek 直接输出 content，无 reasoning_content
            if (delta?.content) {
              fullText += delta.content;
              res.write(`data: ${JSON.stringify({ chunk: delta.content })}\n\n`);
            }
            if (json.usage) dsUsage = json.usage;
          } catch (e) { /* 跳过无法解析的行 */ }
        }
      });

      stream.on('end', () => {
        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
          const dataStr = buffer.slice(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const json = JSON.parse(dataStr);
              if (json.usage) dsUsage = json.usage;
            } catch (e) { /* ignore */ }
          }
        }
        sendFinalResult(res, fullText, sid, db, openid, dsUsage);
      });

      stream.on('error', (err) => {
        console.error('[Chat/Stream] 流读取错误:', err.message);
        if (fullText) {
          sendFinalResult(res, fullText, sid, db, openid, dsUsage);
        } else {
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
          res.end();
        }
      });
    } catch (err) {
      console.error('[Chat/Stream] Deepseek调用失败:', err.message);
      // 降级：直接返回规则引擎兜底
      const fallbackText = '收到您的消息，但我不太确定如何帮您。可以尝试描述您的日程，例如"明天下午3点开会"。';
      res.write(`data: ${JSON.stringify({ chunk: fallbackText })}\n\n`);
      sendFinalResult(res, fallbackText, sid, db, openid, null);
    }
  });

  // ===== 文件解析（可选） =====
  router.post('/files', async (req, res) => {
    const { openid, fileUrl, fileName, fileType } = req.body;

    if (!openid || !fileUrl) {
      return res.status(400).json({ success: false, error: '缺少参数' });
    }

    try {
      res.json({
        success: true,
        data: {
          message: '文件已接收',
          fileUrl,
          fileName,
          fileType,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};


