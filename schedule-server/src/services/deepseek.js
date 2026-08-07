/**
 * DeepSeek AI 服务（OpenAI 兼容接口）
 * 原豆包服务已替换为 DeepSeek：https://api.deepseek.com/chat/completions
 */

const https = require('https');
const http = require('http');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_MODEL_PRO = process.env.DEEPSEEK_MODEL_PRO || DEEPSEEK_MODEL;

// 复用连接，消除 TCP+TLS 握手延迟
const httpsAgent = new https.Agent({
  keepAlive: false,
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

// ===== 模块表单解析专用 Prompt（用于弹窗差异化表单） =====
const PARSE_PROMPT = `你是办公事项结构化解析助手。
你需要根据对话记录整理用户需求，输出严格单一JSON，**禁止输出任何额外解释、聊天话术、markdown**。

可选模块枚举：
schedule(日程)、task(任务)、inspiration(灵感)、apply(申请)、expense(报销)

JSON固定结构（不要增加字段）：
{
  "target_module": "schedule|task|inspiration|apply|expense",
  "title": "不超过15个字的精简标题",
  "content": "完整备注详情",
  "start_time": "YYYY-MM-DD HH:mm 或 null",
  "end_time": "YYYY-MM-DD HH:mm 或 null",
  "deadline": "YYYY-MM-DD HH:mm 或 null",
  "amount": 数字或null,
  "ai_hint": "当关键必填信息缺失时，给出简短提示；无缺失填null"
}

业务约束：
1. target_module=schedule时，尽力提取start_time和end_time；无法识别时间字段填null
2. target_module=task时优先填充deadline截止时间；start_time/end_time填null
3. target_module=expense时提取金额填amount字段
4. target_module=apply时，start_time/end_time表示请假/申请的起止时间，用户未明确时填null；apply没有地点字段，不要提取地点
5. 遵循对话时序，用户最新指令优先级高于历史内容
6. 当前日期 {{CURRENT_DATE}}，无明确年份默认取今年
7. 用户要求调整时，输出完整更新后的全部字段，不要只返回修改部分
8. 标题要精简（≤15字），过长时自动截取关键信息
9. 必填规则：
   - schedule 的 title 和 start_time 必填
   - task 的 title 和 deadline 必填
   - expense 的 title 和 amount 必填
   - apply 的 title 必填；start_time/end_time 可空（表示请假/申请时段）
   - inspiration 只需 title
   若必填项缺失，在 ai_hint 中用一句话提示用户补充，例如"请补充开始时间"`;

/**
 * 发送消息到 DeepSeek API
 */
async function chat(messages, options = {}) {
  if (!DEEPSEEK_API_KEY && !options.apiKey) {
    console.warn('[DeepSeek] 未配置 DEEPSEEK_API_KEY 环境变量，使用规则引擎降级');
    return null;
  }

  const currentDate = options.currentDate || new Date().toISOString().split('T')[0];
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT.replace('{{CURRENT_DATE}}', currentDate);

  const requestBody = {
    model: options.model || DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10),
    ],
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 1024,
    stream: false,
  };

  console.log('[DeepSeek] 发送请求:', { model: requestBody.model, msgCount: requestBody.messages.length });

  try {
    const response = await httpRequest(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.apiKey || DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      timeout: 120000,
      agent: httpsAgent,
    });

    const choice = response.choices && response.choices[0];
    if (!choice) {
      console.error('[DeepSeek] 响应无 choices:', response);
      return null;
    }

    const content = choice.message?.content || '';
    console.log('[DeepSeek] 原始响应:', content.substring(0, 200));

    try {
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
        reasoning_content: choice.message?.reasoning_content || null,
        usage: response.usage || null,
      };
    } catch (parseErr) {
      console.warn('[DeepSeek] JSON解析失败，作为纯文本:', content.substring(0, 100));
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
    console.error('[DeepSeek] 请求失败:', err.message);
    throw err;
  }
}

/**
 * 流式发送消息（SSE）
 */
async function chatStream(messages, options = {}) {
  if (!DEEPSEEK_API_KEY && !options.apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY');
  }

  const currentDate = options.currentDate || new Date().toISOString().split('T')[0];
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT.replace('{{CURRENT_DATE}}', currentDate);

  const requestBody = {
    model: options.model || DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10),
    ],
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 512,
    stream: true,
  };

  const reqModule = DEEPSEEK_ENDPOINT.startsWith('https') ? https : http;
  const url = new URL(DEEPSEEK_ENDPOINT);

  return new Promise((resolve, reject) => {
    const req = reqModule.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.apiKey || DEEPSEEK_API_KEY}`,
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

module.exports = { chat, chatStream, DEEPSEEK_MODEL, DEEPSEEK_MODEL_PRO, SYSTEM_PROMPT, PARSE_PROMPT };
