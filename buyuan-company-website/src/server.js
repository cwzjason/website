/**
 * 埠勤商贸 - API 服务器 (v2.0)
 * MariaDB 数据源 + RESTful API
 */
require('dotenv').config();

// ==================== 数据存储铁律 - 环境变量检查 ====================
if (!process.env.DB_RULE_PASSWORD) {
  console.error('[致命] DB_RULE_PASSWORD 环境变量未设置！');
  console.error('[致命] 请检查 .env 文件中是否包含 DB_RULE_PASSWORD 配置');
  process.exit(1);
}

// ==================== 全局日志拦截 - 防止 DB_RULE_PASSWORD 泄露 ====================
(function () {
  var _rulePwd = process.env.DB_RULE_PASSWORD;
  var _origLog = console.log;
  console.log = function () {
    var args = Array.prototype.slice.call(arguments);
    if (_rulePwd) {
      args = args.map(function (a) {
        if (typeof a === 'string') {
          return a.split(_rulePwd).join('***');
        }
        return a;
      });
    }
    _origLog.apply(console, args);
  };
})();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const https = require('https');
const path = require('path');
const pool = require('./db');
const { verifyRuleChange } = require('./db');
const tablesRouter = require('./routes/tables');
const authRouter = require('./routes/auth');
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 腾讯混元 TokenHub 配置 ====================
if (!process.env.TENCENT_TOKENHUB_API_KEY || process.env.TENCENT_TOKENHUB_API_KEY === "") {
    console.error("【致命配置错误】未配置腾讯混元TOKENHUB_API_KEY环境变量，程序退出");
    process.exit(1);
}
const TOKENHUB_API_KEY = process.env.TENCENT_TOKENHUB_API_KEY;
const TOKENHUB_HOST = 'tokenhub.tencentmaas.com';
const TOKENHUB_PATH = '/v1/chat/completions';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ==================== 中间件 ====================
app.use(cors({origin:"https://buqin.com.cn",credentials:true,methods:["GET","POST","PUT","DELETE"],allowedHeaders:["Content-Type","Authorization"]}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ==================== 鉴权中间件 ====================
app.use('/api', authMiddleware);

// ==================== 0. 认证 API (/api/auth) ====================
app.use('/api/auth', authRouter);

// ==================== 1. 表格 CRUD API (/api/tables) ====================
app.use('/api/tables', tablesRouter);


// ==================== 1.5. 全部表格数据端点（供AI助手使用） ====================
app.get('/api/tables/all-data', async (req, res) => {
  try {
    const tableNames = [
      '销售表_2022', '销售表_2023', '销售表_2024', '销售表_2025-1', '销售表_2025-2', '销售表_2025-3',
      '销售表_2025-4', '销售表_2025-5', '销售表_2025-6', '销售表_2025-7', '销售表_2025-8', '销售表_2025-9',
      '销售表_2025-10', '销售表_2025-11', '销售表_2025-12', '销售表_2026-1', '销售表_2026-2', '销售表_2026-3',
      '销售表_2026-4', '销售表_2026-5', '销售表_2026-6', '销售表_2026-7', '销售表_2026-8', '销售表_2026-9',
      '销售表_2026-10', '销售表_2026-11', '销售表_2026-12', '得力',
      '采购成本表', '采购成本表_2023', '采购成本表_2024', '采购成本表_2025', '收款表', '费用表', '利润表',
      '每日流水', '承包确认单', '客户统计表', '平台结算折扣率'
    ];

    const result = {};
    for (const name of tableNames) {
      try {
        const [rows] = await pool.query(
          'SELECT * FROM `' + name + '` ORDER BY id ASC'
        );
        const [cols] = await pool.query(
          "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME NOT IN ('id','created_at','updated_at') ORDER BY ORDINAL_POSITION",
          [name]
        );
        result[name] = {
          headers: cols.map(c => c.COLUMN_NAME),
          rows: rows,
          row_count: rows.length
        };
      } catch (e) {
        // 表可能为空或不存在
        result[name] = { headers: [], rows: [], row_count: 0 };
      }
    }

    res.json({ success: true, tables: result });
  } catch (err) {
    console.error('[all-data]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 2. 混元 HY3 API ====================

function hy3Request(payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKENHUB_HOST,
      port: 443,
      path: TOKENHUB_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKENHUB_API_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`解析失败: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/api/hunyuan/chat', async (req, res) => {
  try {
    const { messages, temperature, max_tokens, top_p } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'messages 不能为空' });
    }

    const result = await hy3Request({
      model: 'hy3',
      messages,
      ...(temperature !== undefined && { temperature }),
      ...(top_p !== undefined && { top_p }),
      ...(max_tokens !== undefined && { max_tokens }),
    });

    const rawReply = result?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      let jsonStr = rawReply.trim();
      const m = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (m) jsonStr = m[1].trim();
      parsed = JSON.parse(jsonStr);
      if (typeof parsed.text !== 'string') {
        parsed = { text: rawReply, actions: parsed.actions || [] };
      }
    } catch (e) {
      const actions = [];
      const cmdRegex = /\[CMD:\s*([^\]]+)\]/g;
      let match;
      while ((match = cmdRegex.exec(rawReply)) !== null) {
        const cmdStr = match[1];
        const eqIdx = cmdStr.indexOf('=');
        if (eqIdx > 0) {
          actions.push({
            type: cmdStr.substring(0, eqIdx).trim(),
            params: { table: cmdStr.substring(eqIdx + 1).trim() }
          });
        }
      }
      parsed = { text: rawReply, actions };
    }

    res.json({
      success: true,
      model: 'hy3',
      reply: parsed,
      usage: result?.usage || {},
    });
  } catch (e) {
    console.error('[Chat]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/hunyuan/ocr', upload.single('file'), async (req, res) => {
  try {
    let imageBase64, prompt;

    if (req.file) {
      const mime = req.file.mimetype || 'image/png';
      imageBase64 = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
      prompt = req.body.prompt || '请精准提取图片中的所有文字内容，保持原有格式和排版。';
    } else if (req.body.image) {
      imageBase64 = req.body.image;
      if (!imageBase64.startsWith('data:')) {
        imageBase64 = `data:image/png;base64,${imageBase64}`;
      }
      prompt = req.body.prompt || '请精准提取图片中的所有文字内容，保持原有格式和排版。';
    } else {
      return res.status(400).json({ success: false, error: '请上传图片文件或提供 base64 图片数据' });
    }

    const result = await hy3Request({
      model: 'hy3',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
      temperature: 0.1,
    });

    const content = result?.choices?.[0]?.message?.content || '';

    res.json({
      success: true,
      model: 'hy3',
      text: content,
      usage: result?.usage || {},
    });
  } catch (e) {
    console.error('[OCR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/hunyuan/status', (req, res) => {
  const ready = true; // 启动时已校验，此处必定有效
  res.json({
    status: ready ? 'ready' : 'unconfigured',
    apiKey: ready ? `${TOKENHUB_API_KEY.slice(0, 8)}***` : '未配置',
    endpoints: {
      chat: 'POST /api/hunyuan/chat',
      ocr: 'POST /api/hunyuan/ocr',
    },
  });
});

// ==================== 3. 健康检查 ====================
app.get('/api/health', async (req, res) => {
  try {
    const [dbResult] = await pool.query('SELECT 1 as ok');
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      database: err.message,
    });
  }
});

// ==================== 4. 获取所有表名（用于前端初始化） ====================
app.get('/api/table-names', (req, res) => {
  res.json({
    tables: [
      '销售表_2022', '销售表_2023', '销售表_2024', '销售表_2025-1', '销售表_2025-2', '销售表_2025-3',
      '销售表_2025-4', '销售表_2025-5', '销售表_2025-6', '销售表_2025-7', '销售表_2025-8', '销售表_2025-9',
      '销售表_2025-10', '销售表_2025-11', '销售表_2025-12', '销售表_2026-1', '销售表_2026-2', '销售表_2026-3',
      '销售表_2026-4', '销售表_2026-5', '销售表_2026-6', '销售表_2026-7', '销售表_2026-8', '销售表_2026-9',
      '销售表_2026-10', '销售表_2026-11', '销售表_2026-12', '得力',
      '采购成本表', '采购成本表_2023', '采购成本表_2024', '采购成本表_2025', '收款表', '费用表', '利润表',
      '每日流水', '承包确认单', '客户统计表', '平台结算折扣率'
    ],
  });
});

// ==================== 5. 数据存储铁律 - 规则修改接口 ====================
app.post('/api/admin/rule-change', (req, res) => {
  try {
    const { password, newRule } = req.body;
    if (!password) {
      return res.status(400).json({ error: '缺少密码' });
    }
    verifyRuleChange(password);
    console.log('[铁律] 数据存储规则更新请求已通过验证');
    res.json({ ok: true, message: '规则已更新' });
  } catch (e) {
    if (e.message === '密码验证失败') {
      return res.status(403).json({ error: '密码验证失败' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ==================== 启动服务 ====================
app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║                                              ║');
  console.log('  ║    埠勤商贸 API 服务器 v2.0                  ║');
  console.log('  ║    http://localhost:' + PORT + '                      ║');
  console.log('  ║                                              ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║  🛑  数据存储铁律                             ║');
  console.log('  ║  全站唯一数据出口: MariaDB 10.11              ║');
  console.log('  ║  禁止: SQLite / MySQL / JSON / localStorage ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  API 端点:');
  console.log('  - GET/POST/PUT/DELETE /api/tables/:name');
  console.log('  - POST /api/hunyuan/chat');
  console.log('  - POST /api/hunyuan/ocr');
  console.log('  - POST /api/admin/rule-change');
  console.log('');
});
