/**
 * 日程管理 - 后端入口
 *
 * 架构：
 *   routes/schedules.js     → 日程 CRUD + AI 解析 + 语音/图片上传
 *   services/ai-parser.js   → 自然语言解析引擎（规则引擎）
 *   services/reminder.js    → 定时提醒扫描 + 推送
 *   services/asr-ocr.js     → 腾讯云 ASR/OCR（语音转文字 / 图片识字）
 *   services/wechat-push.js → 微信小程序订阅消息 + 服务号模板消息推送
 *   db/database.js          → SQLite 数据库（sql.js，无需 native 编译）
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const getDb = require('./db/database');

// ===== 全局异常处理 - 防止进程崩溃 =====
process.on('uncaughtException', (err) => {
  console.error('[进程] 未捕获异常:', err.message);
  console.error(err.stack);
  // 不退出进程，让服务器继续运行
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[进程] 未处理的 Promise 拒绝:', reason?.message || reason);
  // 不退出进程
});

process.on('SIGINT', () => {
  console.log('[日程管理] 收到退出信号，正在关闭...');
  process.exit(0);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== 异步启动 =====
async function start() {
  const db = await getDb;

  const scheduleRoutes = require('./routes/schedules')(db);
  const chatRoutes = require('./routes/chat')(db);
  const uploadRoutes = require('./routes/upload')();
  const ReminderService = require('./services/reminder');
  const { sendReminder } = require('./services/wechat-push');

  // ===== 路由挂载 =====
  app.use('/api/schedules', scheduleRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/upload', uploadRoutes);

  // ===== 提醒服务 =====
  const reminder = new ReminderService(db);
  reminder.start();

  // ===== 聊天历史自动清理（每1小时清理7天前的记录） =====
  function cleanOldChatHistory() {
    try {
      const result = db.prepare("DELETE FROM chat_history WHERE created_at < datetime('now','localtime','-7 days')").run();
      if (result.changes > 0) {
        console.log(`[清理] 已删除 ${result.changes} 条过期聊天记录（7天前）`);
      }
    } catch (e) {
      // 静默忽略，不影响主流程
    }
  }
  cleanOldChatHistory(); // 启动时立即清理一次
  setInterval(cleanOldChatHistory, 3600000); // 每小时清理一次

  // 客户端轮询待提醒日程
  app.get('/api/reminders/pending', (_req, res) => {
    const pending = reminder.getPending(20);
    res.json({ success: true, data: pending, total: pending.length });
  });

  // 客户端确认提醒已送达
  app.post('/api/reminders/ack/:reminderId', (req, res) => {
    const { reminderId } = req.params;
    reminder.markSent(parseInt(reminderId));
    res.json({ success: true, message: '已确认' });
  });

  // ===== 微信登录：用 code 换 openid + unionid =====
  app.post('/api/auth/login', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: '缺少 code' });

    const appid = process.env.WECHAT_APPID;
    const secret = process.env.WECHAT_SECRET;

    // 未配置 AppID/Secret 时使用 code 作为 openid（开发调试用）
    if (!appid || !secret) {
      console.warn('[Auth] 未配置 WECHAT_APPID/WECHAT_SECRET，使用降级模式（code 作为 openid）');
      return res.json({ success: true, data: { openid: 'dev_' + code, session_key: 'dev_session' } });
    }

    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;

    try {
      const data = await new Promise((resolve, reject) => {
        https.get(url, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
        }).on('error', reject);
      });

      if (data.openid) {
        const miniappOpenid = data.openid;
        const unionid = data.unionid || null;

        // 存储/更新 mp_users 映射
        if (unionid) {
          try {
            const existing = db.prepare('SELECT id, mp_openid FROM mp_users WHERE unionid = ?').get(unionid);
            if (existing) {
              db.prepare('UPDATE mp_users SET miniapp_openid = ?, updated_at = datetime(\'now\',\'localtime\') WHERE unionid = ?')
                .run(miniappOpenid, unionid);
            } else {
              db.prepare('INSERT OR IGNORE INTO mp_users (unionid, miniapp_openid) VALUES (?, ?)')
                .run(unionid, miniappOpenid);
            }
          } catch (e) {
            console.error('[Auth] 保存 unionid 失败:', e.message);
          }
        }

        res.json({
          success: true,
          data: {
            openid: miniappOpenid,
            session_key: data.session_key,
            unionid: unionid || undefined,
          }
        });
      } else {
        res.status(400).json({ success: false, error: data.errmsg || '微信登录失败' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== 保存订阅消息授权 =====
  app.post('/api/subscribe', (req, res) => {
    const { openid, templateId, formId } = req.body;
    if (!openid || !templateId) {
      return res.status(400).json({ success: false, error: '缺少 openid 或 templateId' });
    }

    const stmt = db.prepare(`
      INSERT INTO user_subscriptions (openid, template_id, form_id)
      VALUES (?, ?, ?)
    `);
    stmt.run(openid, templateId, formId || null);

    res.json({ success: true, message: '订阅授权已保存' });
  });

  // ===== 服务号/企业微信事件回调（关注/取消关注/扫码等） =====
  // 同一个 URL 同时支持公众号（明文 echostr）和企业微信（AES 加密 echostr）
  // 通过参数 msg_signature 区分：企业微信有，公众号没有
  const MP_TOKEN = process.env.MP_TOKEN || 'schedule_mp_token';
  const WECOM_TOKEN = process.env.WECOM_TOKEN || MP_TOKEN;
  const WECOM_AES_KEY = process.env.WECOM_AES_KEY || '';
  const WECOM_CORPID = process.env.WECOM_CORPID || '';

  // 企业微信 AES-256-CBC 解密（按官方 WXBizMsgCrypt 规范）
  function wecomDecrypt(echostr, encodingAESKey) {
    const key = Buffer.from(encodingAESKey + '=', 'base64'); // 32 字节 AES key
    if (key.length !== 32) throw new Error('AES key 长度不对');
    const iv = key.slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    const encrypted = Buffer.from(echostr, 'base64');
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    // 去 PKCS#7 padding
    const pad = decrypted[decrypted.length - 1];
    if (pad < 1 || pad > 32) throw new Error('padding 异常');
    const content = decrypted.slice(0, decrypted.length - pad);
    // 解析：random(16B) + msg_len(4B 网络字节序) + msg + receiveid
    const msgBuf = content.slice(16);
    const msgLen = msgBuf.readUInt32BE(0);
    return msgBuf.slice(4, 4 + msgLen).toString('utf8');
  }

  // 企业微信 sha1 签名（4 个参数：token/timestamp/nonce/echostr）
  function wecomSignature(token, timestamp, nonce, echostr) {
    return crypto.createHash('sha1').update([token, timestamp, nonce, echostr].sort().join('')).digest('hex');
  }

  app.get('/api/mp/callback', (req, res) => {
    const { msg_signature, timestamp, nonce, echostr, signature } = req.query;
    if (!timestamp || !nonce || !echostr) {
      return res.status(400).send('missing params');
    }

    // ===== 1) 企业微信模式（msg_signature + AES 解密）=====
    if (msg_signature && WECOM_AES_KEY) {
      const sig = wecomSignature(WECOM_TOKEN, timestamp, nonce, echostr);
      if (sig !== msg_signature) {
        console.error('[Wecom] 签名校验失败', { expected: sig, got: msg_signature });
        return res.status(403).send('signature error');
      }
      try {
        const plain = wecomDecrypt(echostr, WECOM_AES_KEY);
        console.log('[Wecom] URL 校验成功，明文 echostr 长度:', plain.length);
        return res.send(plain);
      } catch (err) {
        console.error('[Wecom] 解密失败:', err.message);
        return res.status(500).send('decrypt error: ' + err.message);
      }
    }

    // ===== 2) 公众号模式（明文 echostr，3 参数 sha1）=====
    if (signature) {
      const arr = [MP_TOKEN, timestamp, nonce].sort();
      const sha1 = crypto.createHash('sha1').update(arr.join('')).digest('hex');
      if (sha1 === signature) return res.send(echostr);
    }
    return res.status(403).send('Forbidden');
  });

  app.post('/api/mp/callback', (req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const parser = new XMLParser({ ignoreAttributes: false });
        const parsed = parser.parse(body);
        const xml = parsed.xml || {};
        const event = xml.Event || xml.MsgType || '';
        const fromUser = xml.FromUserName || '';

        if (!fromUser) return res.send('success');

        if (event === 'subscribe' || event === 'event' && xml.Event === 'subscribe') {
          // 用户关注服务号
          const unionid = await getMpUserUnionId(db, fromUser);
          if (unionid) {
            const existing = db.prepare('SELECT id FROM mp_users WHERE unionid = ?').get(unionid);
            if (existing) {
              db.prepare('UPDATE mp_users SET mp_openid = ?, subscribed = 1, updated_at = datetime(\'now\',\'localtime\') WHERE unionid = ?')
                .run(fromUser, unionid);
            } else {
              db.prepare('INSERT OR IGNORE INTO mp_users (unionid, miniapp_openid, mp_openid, subscribed) VALUES (?, ?, ?, 1)')
                .run(unionid, '', fromUser);
            }
            console.log(`[MP] 用户关注: mp_openid=${fromUser}, unionid=${unionid}`);
          }
        } else if (event === 'unsubscribe' || event === 'event' && xml.Event === 'unsubscribe') {
          // 用户取消关注
          db.prepare('UPDATE mp_users SET subscribed = 0, updated_at = datetime(\'now\',\'localtime\') WHERE mp_openid = ?')
            .run(fromUser);
          console.log(`[MP] 用户取消关注: mp_openid=${fromUser}`);
        }

        res.send('success');
      } catch (err) {
        console.error('[MP] 回调处理失败:', err.message);
        res.send('success');
      }
    });
  });

  /**
   * 通过服务号 openid 获取用户 unionid
   */
  async function getMpUserUnionId(db, mpOpenid) {
    if (!process.env.MP_APPID || !process.env.MP_SECRET) return null;
    const token = await getMpAccessToken();
    if (!token) return null;
    const url = `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${token}&openid=${mpOpenid}&lang=zh_CN`;
    try {
      const data = await new Promise((resolve, reject) => {
        https.get(url, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
        }).on('error', reject);
      });
      return data.unionid || null;
    } catch {
      return null;
    }
  }

  /**
   * 获取服务号 access_token（独立缓存，不跟小程序共用）
   */
  let mpCachedToken = null;
  let mpTokenExpireAt = 0;
  async function getMpAccessToken() {
    if (mpCachedToken && Date.now() < mpTokenExpireAt - 5 * 60 * 1000) return mpCachedToken;
    const appid = process.env.MP_APPID;
    const secret = process.env.MP_SECRET;
    if (!appid || !secret) return null;
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
      }).on('error', reject);
    });
    if (data.access_token) {
      mpCachedToken = data.access_token;
      mpTokenExpireAt = Date.now() + (data.expires_in || 7200) * 1000;
      return mpCachedToken;
    }
    return null;
  }

  // ===== 健康检查 =====
  app.get('/api/health', (_req, res) => {
    const count = db.prepare('SELECT COUNT(*) as total FROM schedules').get();
    const pendingReminders = db.prepare('SELECT COUNT(*) as total FROM schedule_reminders WHERE channel = ?').get('pending');
    res.json({
      success: true,
      status: 'running',
      schedules_total: count ? count.total : 0,
      pending_reminders: pendingReminders ? pendingReminders.total : 0,
    });
  });

  // ===== 静态资源（网页端） =====
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ===== Express 全局错误处理中间件 =====
  app.use((err, _req, res, _next) => {
    console.error('[Express] 全局错误:', err.message);
    res.status(500).json({ success: false, error: err.message || '服务器内部错误' });
  });

  const PORT = process.env.PORT || 3002;
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[日程管理] API 已启动 → http://0.0.0.0:${PORT}`);
    console.log(`[日程管理] 网页端    → http://0.0.0.0:${PORT}/`);
    console.log(`[日程管理] 健康检查 → http://0.0.0.0:${PORT}/api/health`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[日程管理] 端口 ${PORT} 被占用，请先关闭占用进程或更换端口`);
    } else {
      console.error('[日程管理] 服务器错误:', err.message);
    }
    process.exit(1);
  });
}

start().catch(err => {
  console.error('[日程管理] 启动失败:', err.message);
  process.exit(1);
});
