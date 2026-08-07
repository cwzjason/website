/**
 * 微信推送服务
 * 
 * 环境变量：
 *   // 小程序（订阅消息）
 *   WECHAT_APPID     小程序 AppID
 *   WECHAT_SECRET    小程序 AppSecret
 *   WECHAT_TMPL_1H   "1小时前" 提醒模板 ID
 *   WECHAT_TMPL_5M   "5分钟前" 提醒模板 ID
 * 
 *   // 服务号（模板消息）
 *   MP_APPID         服务号 AppID
 *   MP_SECRET        服务号 AppSecret
 *   MP_TMPL_ID       服务号模板消息 ID
 * 
 * 未配置时只记录日志，不实际推送。
 */

const https = require('https');

let cachedToken = null;
let tokenExpireAt = 0;

function isConfigured() {
  return !!(process.env.WECHAT_APPID && process.env.WECHAT_SECRET);
}

function getTemplateId() {
  return process.env.WECHAT_TMPL_ID || '';
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpsPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (!isConfigured()) throw new Error('未配置微信小程序凭证');
  if (cachedToken && Date.now() < tokenExpireAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const appid = process.env.WECHAT_APPID;
  const secret = process.env.WECHAT_SECRET;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;

  const res = await httpsGet(url);
  if (!res.access_token) throw new Error(`获取 access_token 失败: ${JSON.stringify(res)}`);

  cachedToken = res.access_token;
  tokenExpireAt = Date.now() + (res.expires_in || 7200) * 1000;
  return cachedToken;
}

/**
 * 发送订阅消息
 * @param {object} options
 * @param {string} options.openid      用户 openid
 * @param {string} options.templateId  模板 ID
 * @param {string} options.page        点击后跳转的小程序页面
 * @param {object} options.data        模板数据
 */
async function sendSubscribeMessage({ openid, templateId, page, data }) {
  if (!isConfigured()) {
    console.log('[微信推送] 未配置凭证，跳过发送');
    return { sent: false, reason: 'not_configured' };
  }
  if (!templateId) {
    console.log('[微信推送] 未配置模板 ID，跳过发送');
    return { sent: false, reason: 'no_template_id' };
  }
  if (!openid) {
    return { sent: false, reason: 'no_openid' };
  }

  // 最多重试 1 次（处理 access_token 被其他进程刷新导致失效的情况）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = await getAccessToken();
      const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;

      const payload = {
        touser: openid,
        template_id: templateId,
        page: page || 'pages/schedule/schedule',
        data,
      };

      const res = await httpsPostJson(url, payload);
      if (res.errcode === 0) {
        return { sent: true, msgid: res.msgid };
      }
      // 40001: token 被其他进程刷新导致失效 → 清缓存重试
      if (res.errcode === 40001 && attempt === 0) {
        console.log('[微信推送] token 失效，刷新后重试...');
        cachedToken = null;
        tokenExpireAt = 0;
        continue;
      }
      return { sent: false, errcode: res.errcode, errmsg: res.errmsg };
    } catch (err) {
      if (attempt === 0) continue;
      console.error('[微信推送] 发送失败:', err.message);
      return { sent: false, reason: err.message };
    }
  }
  return { sent: false, reason: 'retry_exhausted' };
}

/**
 * 发送小程序订阅消息提醒
 */
async function sendReminder({ openid, schedule, minutesBefore }) {
  const templateId = getTemplateId();
  if (!templateId) return { sent: false, reason: 'no_template' };

  const dt = new Date(schedule.start_time);
  const timeStr = `${dt.getMonth() + 1}月${dt.getDate()}日 ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;

  // 订阅消息模板字段（模板ID: N_zq_o8V-hb-jLw5a5Y9rTz2V5qLVf0xKL5eaqR3yC8）
  // thing2=提醒内容, time6=开始时间, thing10=地点
  const reminderText = schedule.title || '日程提醒';
  const data = {
    thing2: { value: reminderText.substring(0, 20) },                         // 提醒内容（最多20字符）
    time6: { value: timeStr },                                                 // 开始时间
    thing10: { value: (schedule.location || '无地点').substring(0, 20) },     // 地点（最多20字符）
  };

  return sendSubscribeMessage({
    openid,
    templateId,
    page: 'pages/schedule/schedule',
    data,
  });
}

// ===== 服务号模板消息 =====

let mpCachedToken = null;
let mpTokenExpireAt = 0;

function isMpConfigured() {
  return !!(process.env.MP_APPID && process.env.MP_SECRET);
}

async function getMpAccessToken() {
  if (!isMpConfigured()) throw new Error('未配置服务号凭证');
  if (mpCachedToken && Date.now() < mpTokenExpireAt - 5 * 60 * 1000) {
    return mpCachedToken;
  }
  const appid = process.env.MP_APPID;
  const secret = process.env.MP_SECRET;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const res = await httpsGet(url);
  if (!res.access_token) throw new Error(`服务号 access_token 获取失败: ${JSON.stringify(res)}`);
  mpCachedToken = res.access_token;
  mpTokenExpireAt = Date.now() + (res.expires_in || 7200) * 1000;
  return mpCachedToken;
}

/**
 * 发送服务号模板消息
 * @param {object} options
 * @param {string} options.mpOpenid  用户服务号 openid
 * @param {string} options.templateId 模板 ID
 * @param {string} options.url       点击后跳转的 URL
 * @param {object} options.data      模板数据 { keyword1: {value:'...'}, ... }
 * @param {string} options.miniapp    可选：跳转小程序 {appid, pagepath}
 */
async function sendMpTemplateMessage({ mpOpenid, templateId, url, data, miniapp }) {
  if (!isMpConfigured()) {
    console.log('[MP推送] 未配置服务号凭证，跳过发送');
    return { sent: false, reason: 'mp_not_configured' };
  }
  if (!templateId) {
    console.log('[MP推送] 未配置模板 ID，跳过发送');
    return { sent: false, reason: 'no_template_id' };
  }
  if (!mpOpenid) {
    return { sent: false, reason: 'no_mp_openid' };
  }
  try {
    const token = await getMpAccessToken();
    const url_api = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`;
    const payload = {
      touser: mpOpenid,
      template_id: templateId,
      data,
    };
    if (url) payload.url = url;
    if (miniapp) payload.miniprogram = miniapp;

    const res = await httpsPostJson(url_api, payload);
    if (res.errcode === 0) {
      return { sent: true, msgid: res.msgid, channel: 'mp' };
    }
    return { sent: false, errcode: res.errcode, errmsg: res.errmsg, channel: 'mp' };
  } catch (err) {
    console.error('[MP推送] 发送失败:', err.message);
    return { sent: false, reason: err.message, channel: 'mp' };
  }
}

/**
 * 通过服务号发送日程提醒
 */
async function sendMpReminder({ mpOpenid, schedule, minutesBefore }) {
  const templateId = process.env.MP_TMPL_ID || '';
  if (!templateId) return { sent: false, reason: 'no_mp_template' };

  const dt = new Date(schedule.start_time);
  const timeStr = `${dt.getMonth() + 1}月${dt.getDate()}日 ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;

  const data = {
    first: { value: '您有一条日程提醒', color: '#173177' },
    keyword1: { value: schedule.title || '日程提醒', color: '#333333' },
    keyword2: { value: timeStr, color: '#333333' },
    keyword3: { value: schedule.type || '日程', color: '#666666' },
    remark: { value: schedule.location ? `地点：${schedule.location}` : '点击查看详情', color: '#888888' },
  };

  return sendMpTemplateMessage({
    mpOpenid,
    templateId,
    url: 'https://bugin.cn/login.html', // 可换成日程详情页
    data,
    miniapp: {
      appid: process.env.WECHAT_APPID || '',
      pagepath: 'pages/schedule/schedule',
    },
  });
}

module.exports = {
  sendSubscribeMessage,
  sendReminder,
  sendMpTemplateMessage,
  sendMpReminder,
  isConfigured,
  isMpConfigured,
};
