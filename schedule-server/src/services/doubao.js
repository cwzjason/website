/**
 * 豆包 Lite API 服务
 * 通过 HTTP 调用豆包（Doubao）模型进行 AI 对话和日程提取
 */

const https = require('https');
const http = require('http');

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || '';
const DOUBAO_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-lite-32k';
const DOUBAO_MODEL_PRO = process.env.DOUBAO_MODEL_PRO || DOUBAO_MODEL;

// HTTP Agent 连接复用，消除每次请求的 TCP+TLS 握手开销（省 1~2 秒）
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 5,
  timeout: 120000,
});

const SYSTEM_PROMPT = `你是日程管理助手"埠勤助手"。只返回 JSON。

## 输出格式
{"type":"create|query|update|delete|chat","module":"schedule|task|inspiration|apply|expense","text":"回复","schedule":null|{...},"task":null|{...},"inspiration":null|{...},"apply":null|{...},"expense":null|{...}}

## module 模块分类（关键）
- schedule: 日程/会议/约见/提醒
- task: 任务/待办/TODO/要做/别忘了
- inspiration: 灵感/想法/创意/笔记
- apply: 申请/审批
- expense: 报销/费用/花了

## 各模块字段
schedule: {title,start_time,end_time,type,priority,person,location,description}
task: {title,priority,due_date,description}
inspiration: {title,tags,description}
apply: {title,applicant,description}
expense: {title,amount,category,expense_date,description}

## 时间
- 当前日期 {{CURRENT_DATE}}；start_time/end_time 用 ISO 8601
- 未说结束时间时 end_time = start_time

## 回复格式
- schedule不为null时列出三要素（时间/地点/事件）
- 缺信息时追问`;

/**
 * 发送消息到豆包 API
 * @param {Array} messages - 对话历史 [{role, content}]
 * @param {Object} options - 可选参数
 * @returns {Object} 解析后的响应 {type, text, schedule}
 */
async function chat(messages, options = {}) {
  if (!DOUBAO_API_KEY && !options.apiKey) {
    console.warn('[Doubao] 未配置 DOUBAO_API_KEY 环境变量，使用规则引擎降级');
    return null;
  }

  const currentDate = options.currentDate || new Date().toISOString().split('T')[0];
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT.replace('{{CURRENT_DATE}}', currentDate);

  const requestBody = {
    model: options.model || DOUBAO_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10),
    ],
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 512,
    stream: false,
  };

  console.log('[Doubao] 发送请求:', { model: requestBody.model, msgCount: requestBody.messages.length });

  try {
    const response = await httpRequest(DOUBAO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DOUBAO_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      timeout: 120000,
      agent: httpsAgent,  // 复用连接，消除 TCP+TLS 握手延迟
    });

    const choice = response.choices && response.choices[0];
    if (!choice) {
      console.error('[Doubao] 响应无 choices:', response);
      return null;
    }

    const content = choice.message?.content || '';
    console.log('[Doubao] 原始响应:', content.substring(0, 200));

    // 尝试解析 JSON 响应
    try {
      // 清理可能的 markdown 包裹
      let jsonStr = content.trim();
      if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
      if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
      jsonStr = jsonStr.trim();

      const parsed = JSON.parse(jsonStr);
      return {
        type: parsed.type || 'chat',
        module: parsed.module || 'schedule',
        text: parsed.text || content,
        schedule: parsed.schedule || null,
        task: parsed.task || null,
        inspiration: parsed.inspiration || null,
        apply: parsed.apply || null,
        expense: parsed.expense || null,
        reasoning_content: null,
        usage: response.usage || null,
      };
    } catch (parseErr) {
      // JSON 解析失败，当作纯文本回复
      console.warn('[Doubao] JSON解析失败，作为纯文本:', content.substring(0, 100));
      return {
        type: 'chat',
        module: 'schedule',
        text: content,
        schedule: null,
        task: null,
        inspiration: null,
        apply: null,
        expense: null,
        reasoning_content: null,
        usage: response.usage || null,
      };
    }
  } catch (err) {
    console.error('[Doubao] 请求失败:', err.message);
    throw err;
  }
}

/**
 * 流式发送消息（SSE）
 */
async function chatStream(messages, options = {}) {
  if (!DOUBAO_API_KEY && !options.apiKey) {
    throw new Error('未配置 DOUBAO_API_KEY');
  }

  const currentDate = options.currentDate || new Date().toISOString().split('T')[0];
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT.replace('{{CURRENT_DATE}}', currentDate);

  const requestBody = {
    model: options.model || DOUBAO_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10),
    ],
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 512,
    stream: true,
  };

    const reqModule = DOUBAO_ENDPOINT.startsWith('https') ? https : http;
  const url = new URL(DOUBAO_ENDPOINT);

  return new Promise((resolve, reject) => {
    const req = reqModule.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DOUBAO_API_KEY}`,
      },
      timeout: 120000,
      agent: reqModule === https ? httpsAgent : undefined,
    }, (res) => {
      resolve(res);
    });
    req.on('error', reject);
    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

/**
 * HTTP 请求封装
 */
function httpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = url.startsWith('https') ? https : http;

    const req = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000,
      agent: options.agent || undefined,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(data.error?.message || data.error || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`响应解析失败: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

module.exports = { chat, chatStream, DOUBAO_MODEL, DOUBAO_MODEL_PRO };
