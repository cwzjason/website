/**
 * 【新增】草稿路由 - 首页AI粗解析
 * 独立链路，仅操作 drafts 表，不复用 /api/chat
 * AI底层调用 doubao.js，使用阶段1专用 System Prompt
 */
const express = require('express');
const router = express.Router();
const { chat } = require('../services/doubao');

// 【新增】阶段1 AI粗解析 System Prompt（禁止冲突检测、禁止模块分类）
const PARSE_PROMPT = `你是办公文本整理助手。只完成三件事：
1、修正语音识别错别字（重点适配南方口音文字误差）；
2、梳理文本，提取标题+正文结构；
3、区分附件信息。
禁止行为：不要检测日程冲突、不要判断事项归属模块、不要生成待办、不要额外预测。
输出固定JSON格式：{"title":"文本标题","content":"整理后的完整正文"}`;

/**
 * 调用 AI 解析文本，返回 { title, content }
 * AI 不可用时降级返回原始内容
 */
async function aiParseDraft(rawContent) {
  try {
    const result = await chat(
      [{ role: 'user', content: rawContent }],
      { systemPrompt: PARSE_PROMPT, temperature: 0.3, maxTokens: 1024 }
    );
    if (result && result.text) {
      try {
        let jsonStr = result.text.trim();
        if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
        if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
        const parsed = JSON.parse(jsonStr.trim());
        return {
          title: parsed.title || '',
          content: parsed.content || rawContent,
        };
      } catch {
        // JSON 解析失败，AI 文本直接作为内容
        return { title: '', content: result.text || rawContent };
      }
    }
  } catch (e) {
    console.error('[Drafts] AI 调用失败:', e.message);
  }
  // 降级：AI 不可用时返回原始内容
  return { title: '', content: rawContent };
}

module.exports = function (db) {

  // ===== POST /create - 创建草稿（AI粗解析） =====
  router.post('/create', async (req, res) => {
    try {
      const { openid, source_type, raw_content, raw_file_url } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!raw_content && !raw_file_url) {
        return res.status(400).json({ success: false, error: '缺少素材内容（raw_content 或 raw_file_url）' });
      }

      // 调用阶段1 AI 粗解析
      let parsed_title = '';
      let parsed_content = raw_content || '';
      if (raw_content && raw_content.trim()) {
        const parsed = await aiParseDraft(raw_content);
        parsed_title = parsed.title;
        parsed_content = parsed.content;
      }

      const info = db.prepare(
        'INSERT INTO drafts (openid, source_type, raw_content, raw_file_url, parsed_title, parsed_content) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(openid, source_type || 'text', raw_content || '', raw_file_url || '', parsed_title, parsed_content);

      const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid);
      console.log(`[Drafts] 创建草稿 id=${info.lastInsertRowid} source=${source_type || 'text'}`);
      res.json({ success: true, data: draft });
    } catch (e) {
      console.error('[Drafts] POST /create 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /adjust - AI 重新调整草稿 =====
  router.post('/adjust', async (req, res) => {
    try {
      const { openid, draft_id } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!draft_id) return res.status(400).json({ success: false, error: '缺少draft_id' });

      const draft = db.prepare(
        'SELECT * FROM drafts WHERE id = ? AND openid = ? AND status = ?'
      ).get(draft_id, openid, 'draft');
      if (!draft) return res.status(404).json({ success: false, error: '草稿不存在或已删除' });

      const contentToParse = draft.raw_content || draft.parsed_content || '';
      if (!contentToParse.trim()) {
        return res.status(400).json({ success: false, error: '草稿无文本内容可供AI调整' });
      }

      const parsed = await aiParseDraft(contentToParse);

      db.prepare(
        "UPDATE drafts SET parsed_title = ?, parsed_content = ?, updated_at = datetime('now','localtime') WHERE id = ? AND openid = ?"
      ).run(parsed.title, parsed.content, draft_id, openid);

      const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft_id);
      console.log(`[Drafts] AI调整草稿 id=${draft_id}`);
      res.json({ success: true, data: updated });
    } catch (e) {
      console.error('[Drafts] POST /adjust 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /edit - 手动编辑草稿 =====
  router.post('/edit', (req, res) => {
    try {
      const { openid, draft_id, parsed_title, parsed_content } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!draft_id) return res.status(400).json({ success: false, error: '缺少draft_id' });

      const draft = db.prepare(
        'SELECT * FROM drafts WHERE id = ? AND openid = ? AND status = ?'
      ).get(draft_id, openid, 'draft');
      if (!draft) return res.status(404).json({ success: false, error: '草稿不存在或已删除' });

      db.prepare(
        "UPDATE drafts SET parsed_title = ?, parsed_content = ?, updated_at = datetime('now','localtime') WHERE id = ? AND openid = ?"
      ).run(
        parsed_title !== undefined ? parsed_title : draft.parsed_title,
        parsed_content !== undefined ? parsed_content : draft.parsed_content,
        draft_id,
        openid
      );

      const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft_id);
      console.log(`[Drafts] 手动编辑草稿 id=${draft_id}`);
      res.json({ success: true, data: updated });
    } catch (e) {
      console.error('[Drafts] POST /edit 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /delete - 软删除草稿 =====
  router.post('/delete', (req, res) => {
    try {
      const { openid, draft_id } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!draft_id) return res.status(400).json({ success: false, error: '缺少draft_id' });

      const result = db.prepare(
        "UPDATE drafts SET status = 'deleted', updated_at = datetime('now','localtime') WHERE id = ? AND openid = ? AND status = 'draft'"
      ).run(draft_id, openid);

      if (result.changes === 0) {
        return res.status(404).json({ success: false, error: '草稿不存在或已删除' });
      }

      console.log(`[Drafts] 软删除草稿 id=${draft_id}`);
      res.json({ success: true, message: '草稿已删除' });
    } catch (e) {
      console.error('[Drafts] POST /delete 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /list - 查询当前用户草稿列表 =====
  router.get('/list', (req, res) => {
    try {
      const { openid } = req.query;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });

      const drafts = db.prepare(
        "SELECT * FROM drafts WHERE openid = ? AND status = 'draft' ORDER BY created_at DESC"
      ).all(openid);

      res.json({ success: true, data: drafts, total: drafts.length });
    } catch (e) {
      console.error('[Drafts] GET /list 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
};
