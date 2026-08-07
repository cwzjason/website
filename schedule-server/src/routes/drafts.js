/**
 * 【新增】草稿路由 - 首页AI粗解析
 * 独立链路，仅操作 drafts 表，不复用 /api/chat
 * AI底层调用 deepseek.js，使用阶段1专用 System Prompt
 */
const express = require('express');
const router = express.Router();
const { chat } = require('../services/deepseek');

/**
 * 兜底：从中文文本中提取具体时间 HH:mm
 * 支持：下午四点、4点、四点半、4点半、上午十点、晚上八点、早上六点、凌晨三点、中午十二点、四点二十分
 * 优先根据 currentStartTime 推断上午/下午；没有则裸数字默认下午
 */
function extractTimeFallback(text, currentStartTime = '') {
  if (!text) return null;
  const t = String(text).trim();

  const cnNums = {
    '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    '两': 2, '廿': 20, '卅': 30
  };

  function cnToNumber(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (/^[一二三四五六七八九十两]+$/.test(s)) {
      if (s === '十') return 10;
      if (s.startsWith('十')) return 10 + cnToNumber(s.slice(1));
      if (s.endsWith('十')) return cnToNumber(s.slice(0, -1)) * 10;
      const parts = s.split('十');
      if (parts.length === 2) return cnToNumber(parts[0]) * 10 + cnToNumber(parts[1]);
      let sum = 0;
      for (const ch of s) sum = sum * 10 + (cnNums[ch] || 0);
      return sum;
    }
    return null;
  }

  let defaultAfternoon = true;
  const currentTimeMatch = String(currentStartTime).match(/(\d{2}):(\d{2})/);
  if (currentTimeMatch) {
    const currentHour = parseInt(currentTimeMatch[1], 10);
    defaultAfternoon = currentHour >= 12;
  }

  // 1. 带明确时段词
  const explicitPattern = /(凌晨|早上|上午|中午|下午|晚上)\s*([\d一二三四五六七八九十两]+)\s*点(?:\s*([\d一二三四五六七八九十两]+?)\s*分)?/;
  const m1 = t.match(explicitPattern);
  if (m1) {
    const period = m1[1];
    const hour = cnToNumber(m1[2]);
    let minute = 0;
    if (m1[3]) minute = cnToNumber(m1[3]);
    if (hour === null || hour < 0 || hour > 23) return null;

    let realHour = hour;
    if (period === '下午' && hour < 12) realHour = hour + 12;
    if (period === '晚上' && hour < 12) realHour = hour + 12;
    if (period === '中午' && hour < 12 && hour !== 12) realHour = hour + 12;
    if (period === '凌晨' && hour >= 12) realHour = hour - 12;
    if (period === '早上' && hour >= 12) realHour = hour - 12;
    if (period === '上午' && hour >= 12) realHour = hour - 12;

    return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')} ${String(realHour).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}`;
  }

  // 2. 半点
  const halfPattern = /([\d一二三四五六七八九十两]+)\s*点\s*半/;
  const m2 = t.match(halfPattern);
  if (m2) {
    const hour = cnToNumber(m2[1]);
    if (hour === null) return null;
    const realHour = defaultAfternoon && hour < 12 ? hour + 12 : hour;
    return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')} ${String(realHour).padStart(2, '0')}:30`;
  }

  // 3. X点Y分
  const minutePattern = /([\d一二三四五六七八九十两]+)\s*点\s*([\d一二三四五六七八九十两]+)\s*分/;
  const m3 = t.match(minutePattern);
  if (m3) {
    const hour = cnToNumber(m3[1]);
    const minute = cnToNumber(m3[2]);
    if (hour === null || minute === null) return null;
    const realHour = defaultAfternoon && hour < 12 ? hour + 12 : hour;
    return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')} ${String(realHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // 4. 裸 X点
  const hourPattern = /([\d一二三四五六七八九十两]+)\s*点(?:钟)?/;
  const m4 = t.match(hourPattern);
  if (m4) {
    const hour = cnToNumber(m4[1]);
    if (hour === null || hour < 0 || hour > 23) return null;
    const realHour = defaultAfternoon && hour < 12 ? hour + 12 : hour;
    return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')} ${String(realHour).padStart(2, '0')}:00`;
  }

  return null;
}

// 阶段1 AI粗解析 Prompt（精简版）
function buildParsePrompt() {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const tomorrowStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()+1).padStart(2,'0')}`;
  return `你是文本解析器，只输出JSON。今天=${todayStr}，明天=${tomorrowStr}。

## 模块优先级
1. 花钱/报销/费用 → expense
2. 请假/调休/出差/审批 → apply
3. 有截止日期的待办/任务 → task
4. 有具体钟点的会面/聚餐/活动 → schedule
5. 其余想法/点子/灵感 → inspiration

## JSON格式
{"title":"纯事件名称，不含人物/地点/时间","remark":"补充说明","module_type":"5选1",
 "schedule":{"start_time":"YYYY-MM-DD HH:mm或空","location":"","person":"","priority":"中"},
 "task":{"deadline":"","priority":"中"},
 "apply":{"start_time":"","end_time":""},
 "expense":{"amount":"纯数字"}}

## 核心规则
- title=纯事件名。和/跟XX→person字段，在/去XX→location，带/记得/要准备XX→remark
- X点/X:XX才填时间字段，只有"下午/上午/明天"无具体钟点不填。下午X点=12+X
- 没识别到的字段=null或空字符串，禁止编造
- amount只提取数字，"120元"→"120"
- 关键词优先：文本含"请假/报销"关键词时，module_type必须按apply/expense处理

## 示例（严格遵守字段分离）
"下午四点跟老虎在黄鹤楼吃饭带红酒"
→ {"title":"吃饭","remark":"带红酒","module_type":"schedule","schedule":{"start_time":"${todayStr} 16:00","location":"黄鹤楼","person":"老虎","priority":"中"},"task":{"deadline":null,"priority":"中"},"apply":{"start_time":null,"end_time":null},"expense":{"amount":null}}

"明天下午没钟点和老虎吃饭"
→ {"title":"吃饭","remark":null,"module_type":"schedule","schedule":{"start_time":null,"location":null,"person":"老虎","priority":"中"},...}

"周五前交周报"
→ {"title":"交周报","remark":null,"module_type":"task",...,"task":{"deadline":"${todayStr} 23:59","priority":"中"},...}

"打车80元报销"
→ {"title":"打车","remark":null,"module_type":"expense",...,"expense":{"amount":"80"}}

"下周一请假去医院"
→ {"title":"请假","remark":"去医院","module_type":"apply",...,"apply":{"start_time":"${todayStr} 09:00","end_time":"${todayStr} 18:00"}}

"新产品点子AI日程"
→ {"title":"新产品点子","remark":"AI日程","module_type":"inspiration",...}

❌ title="和老虎吃饭" → 人物混入title，应title="吃饭" person="老虎"
❌ title="在武汉开会" → 地点混入title，应title="开会" location="武汉"

只输出JSON，不要解释文字或markdown。`;
}

// AI 调整草稿 Prompt（精简版）
function buildAdjustPrompt(targetModule = 'schedule') {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const tomorrowStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()+1).padStart(2,'0')}`;

  const modConfigs = {
    schedule: {
      label: '日程',
      fields: `可用字段：title, content, person, location, start_time(YYYY-MM-dd HH:mm), end_time, priority(高中低)
- title=纯事件名。和/跟XX→person，在/去XX→location，带/记得XX→content
- 只有X点/X:X才填时间，仅"下午/上午/明天"不填。下午X点=12+X，默认当天`,
      ex: `卡片{"title":"吃饭","person":"老虎"} + "下午四点" → {"title":"吃饭","person":"老虎","start_time":"${todayStr} 16:00","priority":"中"}
卡片{"title":"吃饭"} + "跟小王在星巴克开" → {"title":"开会","person":"小王","location":"星巴克","priority":"中"}
卡片{"title":"开会"} + "带PPT" → {"title":"开会","content":"带PPT","priority":"中"}`,
    },
    task: {
      label: '任务',
      fields: `可用字段：title, content, deadline(YYYY-MM-dd HH:mm), priority(高中低)
- 任务没有 start_time/location/person/amount`,
      ex: `卡片{"title":"提交周报"} + "截止下午5点" → {"title":"提交周报","deadline":"${todayStr} 17:00","priority":"中"}
卡片{"title":"写报告"} + "需要附上数据" → {"title":"写报告","content":"需要附上数据","priority":"中"}`,
    },
    inspiration: {
      label: '灵感',
      fields: `只有 title 和 content 两个字段，没有时间/人物/地点/优先级`,
      ex: `卡片{"title":"产品想法","content":"做AI"} + "支持语音输入" → {"title":"产品想法","content":"做AI，支持语音输入"}`,
    },
    application: {
      label: '申请',
      fields: `可用字段：title, content, start_time, end_time, priority(高中低)`,
      ex: `卡片{"title":"请假"} + "明天9点到11点" → {"title":"请假","start_time":"${tomorrowStr} 09:00","end_time":"${tomorrowStr} 11:00","priority":"中"}
卡片{"title":"请假"} + "去医院" → {"title":"请假","content":"去医院","priority":"中"}`,
    },
    expense: {
      label: '报销',
      fields: `可用字段：title, content, amount(纯数字), start_time(YYYY-MM-dd日期)`,
      ex: `卡片{"title":"餐饮费"} + "128元和客户吃的" → {"title":"餐饮费","content":"和客户吃的","amount":128,"start_time":"${todayStr}"}`,
    },
  };

  const cfg = modConfigs[targetModule] || modConfigs.schedule;
  return `你是${cfg.label}卡片修改助手，只输出JSON。今天=${todayStr}，明天=${tomorrowStr}。

${cfg.fields}

规则：
- 你是修补工，只改用户提到的字段，其他原封不动
- 和/跟XX→person，在/去XX→location，带/记得/备注XX→content。title永远是纯事件名
- "下午/晚上+数字点"填时间（下午4点=16:00），只有"下午/明天"无钟点不填
- 日期默认今天，说"明天"才用${tomorrowStr}
- 不要编造用户没说的内容

示例：
${cfg.ex}

只输出纯JSON，一行，不要markdown。`;
}

/**
 * 调用 AI 解析文本，返回 { title, content, person, location, start_time, end_time, priority }
 * AI 不可用时降级返回原始内容
 */
async function aiParseDraft(rawContent) {
  try {
    const result = await chat(
      [{ role: 'user', content: rawContent }],
      { systemPrompt: buildParsePrompt(), temperature: 0.1, maxTokens: 1024 }
    );
      if (result && result.text) {
        try {
          let jsonStr = result.text.trim();
          if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
          if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
          if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
          const parsed = JSON.parse(jsonStr.trim());

          // 新版输出格式：module_type + 嵌套模块字段
          let moduleType = ['schedule','task','inspiration','apply','expense'].includes(parsed.module_type)
            ? parsed.module_type : 'schedule';

          // 关键词兜底：防止 AI 对短文本误判（如"想请假"被 AI 误判为 inspiration）
          const rawForCheck = rawContent.replace(/\r?\n/g, ' ').trim();
          if (/请假|调休|出差|批假|年假|事假|病假|婚假/.test(rawForCheck)) {
            console.log(`[Drafts] 关键词兜底 apply："${rawForCheck}" → force apply（AI返回=${moduleType}）`);
            moduleType = 'apply';
          } else if (/报销|报销单|打车费|餐费|请款|费用报销/.test(rawForCheck)) {
            console.log(`[Drafts] 关键词兜底 expense："${rawForCheck}" → force expense（AI返回=${moduleType}）`);
            moduleType = 'expense';
          }

          const schedule = parsed.schedule || {};
          const task = parsed.task || {};
          const apply = parsed.apply || {};
          const expense = parsed.expense || {};

          // 映射到数据库扁平字段
          let startTime = schedule.start_time || apply.start_time || '';
          let endTime = apply.end_time || '';
          let deadline = task.deadline || '';
          let location = schedule.location || '';
          let person = schedule.person || '';
          let amount = expense.amount || '';
          let priority = schedule.priority || task.priority || '中';

          // 兜底：AI 没抽出时间但用户原文里有时间表达，直接正则提取
          if (!startTime && !deadline) {
            const fallbackTime = extractTimeFallback(rawContent, '');
            if (fallbackTime) {
              const today = new Date();
              const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
              if (moduleType === 'task') {
                deadline = `${todayStr} ${fallbackTime}`;
              } else {
                startTime = `${todayStr} ${fallbackTime}`;
              }
              console.log(`[Drafts] 初始解析时间兜底命中："${rawContent}" → ${startTime || deadline}`);
            }
          }

          console.log(`[Drafts] AI解析 module_type=${moduleType} title="${parsed.title}"`);

          return {
            title: parsed.title || '',
            content: parsed.remark || parsed.content || '',
            person,
            location,
            start_time: startTime,
            end_time: endTime,
            deadline,
            amount,
            priority: ['低', '中', '高'].includes(priority) ? priority : '中',
            module_type: moduleType,
          };
        } catch {
          // JSON 解析失败，AI 文本直接作为内容
          return { title: '', content: result.text || rawContent, person: '', location: '', start_time: '', end_time: '', deadline: '', amount: '', priority: '中', module_type: 'schedule' };
        }
      }
    } catch (e) {
      console.error('[Drafts] AI 调用失败:', e.message);
    }
    // 降级：AI 不可用时返回原始内容
    return { title: '', content: rawContent, person: '', location: '', start_time: '', end_time: '', deadline: '', amount: '', priority: '中', module_type: 'schedule' };
}

/**
 * 调用 AI 根据用户修改指令调整草稿字段
 * @param {object} draft - 当前草稿对象（含所有字段）
 * @param {string} userText - 用户的修改指令文本
 * @param {string} targetModule - 当前模块（schedule/task/inspiration/application/expense）
 */
async function aiAdjustDraft(draft, userText, targetModule = 'schedule') {
  try {
    // 用 JSON 格式呈现当前卡片，让 AI 看清楚每个字段
    // 只展示当前模块相关字段，避免 AI 被无关字段干扰
    const currentCard = { title: draft.parsed_title || '', content: draft.parsed_content || '' };
    if (targetModule === 'schedule' || targetModule === 'application') {
      currentCard.start_time = draft.start_time || '';
      currentCard.end_time = draft.end_time || '';
    }
    if (targetModule === 'schedule') {
      currentCard.person = draft.person || '';
      currentCard.location = draft.location || '';
      currentCard.priority = draft.priority || '中';
    }
    if (targetModule === 'task') {
      currentCard.deadline = draft.deadline || '';
      currentCard.priority = draft.priority || '中';
    }
    if (targetModule === 'application') {
      currentCard.apply_type = draft.apply_type || '';
      currentCard.priority = draft.priority || '中';
    }
    if (targetModule === 'expense') {
      currentCard.amount = draft.amount || 0;
      currentCard.priority = draft.priority || '中';
    }
    if (targetModule === 'inspiration') {
      // 只有 title + content
    }

    const context = [
      '当前卡片完整内容：',
      JSON.stringify(currentCard, null, 2),
      '',
      `用户修改指令：${userText}`,
      '',
      '请返回修改后的完整JSON（只改用户提到的字段，其他字段必须与上述卡片完全一致）：',
    ].join('\n');

    const result = await chat(
      [{ role: 'user', content: context }],
      { systemPrompt: buildAdjustPrompt(targetModule), temperature: 0.1, maxTokens: 1024 }
    );

    if (result && result.text) {
      try {
        let jsonStr = result.text.trim();
        // 清洗可能包裹的 markdown 标记
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(jsonStr.trim());

        // 兜底：如果 AI 返回的 title 包含指令性文句（如"修改"、"调整"），
        // 说明 AI 没有正确理解，用原 title 覆盖
        const instructionKeywords = ['修改', '调整', '更新', '设置为', '改为', '变更', '改成'];
        const titleLooksWrong = instructionKeywords.some(kw => (parsed.title || '').includes(kw) && !(draft.parsed_title || '').includes(kw));
        if (titleLooksWrong && draft.parsed_title) {
          console.log(`[Drafts] AI 错误改写了 title: "${parsed.title}" → 回退为 "${draft.parsed_title}"`);
          parsed.title = draft.parsed_title;
        }

    let finalStartTime = parsed.start_time !== undefined ? parsed.start_time : currentCard.start_time;
    let finalDeadline = parsed.deadline !== undefined ? parsed.deadline : currentCard.deadline;
    console.log(`[Drafts] AI调整 raw="${userText}" module=${targetModule} currentStart=${currentCard.start_time} parsedStart=${parsed.start_time} parsedDeadline=${parsed.deadline}`);

    const todayStrForTime = () => {
      const today = new Date();
      return `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    };

    // 兜底：AI 没抽出时间但用户原文里有时间表达，直接正则提取
    if (!finalStartTime) {
      const fallbackTime = extractTimeFallback(userText, currentCard.start_time);
      console.log(`[Drafts] 时间兜底结果：fallbackTime=${fallbackTime}`);
      if (fallbackTime) {
        finalStartTime = `${todayStrForTime()} ${fallbackTime}`;
        console.log(`[Drafts] 时间兜底命中："${userText}" → ${finalStartTime}`);
      }
    }

    // 兜底：任务模块 deadline 同样做时间兜底
    if (!finalDeadline && targetModule === 'task') {
      const fallbackTime = extractTimeFallback(userText, '');
      console.log(`[Drafts] deadline 时间兜底结果：fallbackTime=${fallbackTime}`);
      if (fallbackTime) {
        finalDeadline = `${todayStrForTime()} ${fallbackTime}`;
        console.log(`[Drafts] deadline 时间兜底命中："${userText}" → ${finalDeadline}`);
      }
    }

    // 规范化：如果只返回了 HH:mm，自动补今天的日期
    if (finalStartTime && /^\d{2}:\d{2}$/.test(finalStartTime.trim())) {
      finalStartTime = `${todayStrForTime()} ${finalStartTime.trim()}`;
      console.log(`[Drafts] 时间补全日期：${finalStartTime}`);
    }
    if (finalDeadline && /^\d{2}:\d{2}$/.test(finalDeadline.trim())) {
      finalDeadline = `${todayStrForTime()} ${finalDeadline.trim()}`;
      console.log(`[Drafts] deadline 补全日期：${finalDeadline}`);
    }

    return {
          title: parsed.title !== undefined ? parsed.title : currentCard.title,
          content: parsed.content !== undefined ? parsed.content : currentCard.content,
          person: parsed.person !== undefined ? parsed.person : currentCard.person,
          location: parsed.location !== undefined ? parsed.location : currentCard.location,
          start_time: finalStartTime,
          end_time: parsed.end_time !== undefined ? parsed.end_time : currentCard.end_time,
          deadline: finalDeadline,
          amount: parsed.amount !== undefined ? parsed.amount : currentCard.amount,
          apply_type: parsed.apply_type !== undefined ? parsed.apply_type : currentCard.apply_type,
          priority: parsed.priority || currentCard.priority,
          ai_hint: `已按"${userText}"进行调整`,
        };
      } catch (parseErr) {
        console.error('[Drafts] AI调整 JSON 解析失败:', result.text, parseErr.message);
      }
    }
  } catch (e) {
    console.error('[Drafts] AI调整调用失败:', e.message);
  }
  return null;
}

const MODULE_LABELS = {
  schedule: '日程',
  task: '任务',
  inspiration: '灵感',
  apply: '申请',
  expense: '报销'
};

// ======================= AI 对话助手 Prompt =======================
function buildChatPrompt(currentCard, chatHistory, targetModule) {
  const label = MODULE_LABELS[targetModule] || '日程';
  const cardText = _formatCardForPrompt(currentCard, targetModule, label);
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const tomorrowStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()+1).padStart(2,'0')}`;

  const fieldMap = {
    schedule: 'title/content/person/location/start_time(YYYY-MM-dd HH:mm)/end_time/priority(高中低)',
    task: 'title/content/deadline(YYYY-MM-dd HH:mm)/priority(高中低)',
    inspiration: 'title/content',
    application: 'title/content/apply_type(请假出差等)/priority(高中低)',
    expense: 'title/content/amount(纯数字)/priority(高中低)',
  };

  return `你是埠勤助手，帮用户编辑【${label}】卡片。语气友好自然。
今天=${todayStr}，明天=${tomorrowStr}，今天是周${['日','一','二','三','四','五','六'][now.getDay()]}。

卡片：${cardText}

历史：${chatHistory.slice(-5).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join(' → ')}
字段：${fieldMap[targetModule] || fieldMap.schedule}

回复格式（严格JSON）：
- 聊天：{"reply":"..."}
- 修改：{"reply":"...","changes":{"字段":"值"}}

规则：
1. title=纯事件名。和/跟XX→person，在/去XX→location，带/记得/备注XX→content
2. 时间用start_time字段。**用原始中文表达式**（如下周二、下个月5号、15号），后端会自动解析成准确日期
3. 只有"下午四点"这种纯钟点才用具体日期格式：${todayStr} 16:00
4. 多轮合并：用户先说了钟点又说了日期，后一次回复合并
5. 只改提到的字段，只用JSON回答，禁止markdown
6. **changes的key必须精确匹配字段列表中的名称**
7. **用户要求修改任何字段时，必须在changes中返回该字段，不能只回复文字**
8. **追加人物：当卡片已有person值，用户说"和XX一起/XX也在/XX也去"时，把新人物追加到原人物后面，用顿号分隔。如当前person="老王"，用户说"和老胡一起"→changes{"person":"老王、老胡"}**

示例（时间用中文表达）：
"下周二" → {"reply":"已更新~","changes":{"start_time":"下周二"}}
"下周二下午四点" → {"reply":"已更新~","changes":{"start_time":"下周二下午四点"}}
"时间改成下周二" → {"reply":"已更新~","changes":{"start_time":"下周二"}}
"下个月5号" → {"reply":"已更新~","changes":{"start_time":"下个月5号"}}
"下个月15号下午3点" → {"reply":"已安排~","changes":{"start_time":"下个月15号下午3点"}}
"改成12月25号" → {"reply":"已更新~","changes":{"start_time":"12月25号"}}
"明年3月8号" → {"reply":"已更新~","changes":{"start_time":"明年3月8号"}}
"月底" → {"reply":"已更新~","changes":{"start_time":"月底"}}
"15号" → {"reply":"已更新~","changes":{"start_time":"15号"}}
示例（纯钟点用日期格式）：
"下午四点" → {"reply":"已安排~","changes":{"start_time":"${todayStr} 16:00"}}
"明天上午十点" → {"reply":"已安排~","changes":{"start_time":"${tomorrowStr} 10:00"}}
"四点半" → {"reply":"已安排~","changes":{"start_time":"${todayStr} 16:30"}}
示例（其他字段）：
"跟老王开会" → {"reply":"好的~","changes":{"title":"开会","person":"老王"}}
"和老虎吃饭" → {"reply":"好的~","changes":{"title":"吃饭","person":"老虎"}}
（假设卡片已有person="老王"）"和老胡一起" → {"reply":"好的~","changes":{"person":"老王、老胡"}}
（假设卡片已有person="老王"）"小周也去" → {"reply":"好的~","changes":{"person":"老王、小周"}}
"在武汉吃" → {"reply":"已记录~","changes":{"location":"武汉"}}
"备注带红酒" → {"reply":"已记下~","changes":{"content":"带红酒"}}
"记得带红酒" → {"reply":"已记下~","changes":{"content":"记得带红酒"}}
"带红酒" → {"reply":"已记录~","changes":{"content":"带红酒"}}
"优先级改为低" → {"reply":"已调整~","changes":{"priority":"低"}}
"天气不错" → {"reply":"是呀，出门走走~"}
${targetModule === 'task' ? '"截止明天五点" → {"reply":"已设截止~","changes":{"deadline":"'+tomorrowStr+' 17:00"}}' : ''}`;
}

function _formatCardForPrompt(draft, module, label) {
  const parts = [];
  if (draft.parsed_title) parts.push(`标题：${draft.parsed_title}`);
  if (draft.parsed_content) parts.push(`内容：${draft.parsed_content}`);
  if (module === 'schedule') {
    if (draft.start_time) parts.push(`开始时间：${draft.start_time}`);
    if (draft.location) parts.push(`地点：${draft.location}`);
    if (draft.person) parts.push(`人物：${draft.person}`);
    if (draft.priority) parts.push(`优先级：${draft.priority}`);
  }
  if (module === 'task') {
    if (draft.deadline) parts.push(`截止时间：${draft.deadline}`);
    if (draft.priority) parts.push(`优先级：${draft.priority}`);
  }
  if (module === 'application') {
    if (draft.apply_type) parts.push(`类型：${draft.apply_type}`);
    if (draft.priority) parts.push(`优先级：${draft.priority}`);
  }
  if (module === 'expense') {
    if (draft.amount) parts.push(`金额：${draft.amount}`);
    if (draft.priority) parts.push(`优先级：${draft.priority}`);
  }
  return parts.length > 0 ? parts.join('\n') : '(空卡片)';
}

// 解析自然语言时间表达式 → YYYY-MM-DD HH:mm 或 YYYY-MM-DD（纯日期）
// 支持：
//   - 月份级：下个月5号、下下个月15号、12月25号、明年3月8号、月底、月初、年底
//   - 星期级：下周二、下下周三、后天、大后天、明天、周二
//   - 日期级：15号（当月）、明天、后天、大后天
function _parseTimeExpression(raw) {
  const now = new Date();
  let targetYear = now.getFullYear();
  let targetMonth = now.getMonth() + 1;
  let targetDay = now.getDate();
  const weekday = now.getDay(); // 0=周日,1=周一,...,6=周六
  const s = raw.replace(/\s+/g, '');
  const pad = (n) => String(n).padStart(2, '0');

  let hasDateExpr = false; // 是否匹配到任何日期表达式

  // ========== 1. 月份级别表达式（直接设置年月日） ==========

  // 明年X月X号
  let m = s.match(/明年(\d{1,2})月(\d{1,2})[号日]?/);
  if (m) {
    targetYear += 1;
    targetMonth = parseInt(m[1], 10);
    targetDay = parseInt(m[2], 10);
    hasDateExpr = true;
  }

  // X月X号 / X月X日（显式月份日期，不含"明年"）
  if (!hasDateExpr) {
    m = s.match(/^(\d{1,2})月(\d{1,2})[号日]?|[^\d](\d{1,2})月(\d{1,2})[号日]?/);
    if (m) {
      const mon = parseInt(m[1] || m[3], 10);
      const dy = parseInt(m[2] || m[4], 10);
      if (mon >= 1 && mon <= 12 && dy >= 1 && dy <= 31) {
        targetMonth = mon;
        targetDay = dy;
        hasDateExpr = true;
      }
    }
  }

  // 下下个月X号 / 下下个月X日
  if (!hasDateExpr) {
    m = s.match(/下下个?月(\d{1,2})[号日]/);
    if (m) {
      targetMonth += 2;
      if (targetMonth > 12) { targetMonth -= 12; targetYear++; }
      targetDay = parseInt(m[1], 10);
      hasDateExpr = true;
    }
  }

  // 下个月X号 / 下个月X日
  if (!hasDateExpr) {
    m = s.match(/下个?月(\d{1,2})[号日]/);
    if (m) {
      targetMonth += 1;
      if (targetMonth > 12) { targetMonth = 1; targetYear++; }
      targetDay = parseInt(m[1], 10);
      hasDateExpr = true;
    }
  }

  // 下个月底 / 下个月初 / 下个月中
  if (!hasDateExpr && /下个?月底/.test(s)) {
    targetMonth += 1;
    if (targetMonth > 12) { targetMonth = 1; targetYear++; }
    targetDay = new Date(targetYear, targetMonth, 0).getDate(); // 月末最后一天
    hasDateExpr = true;
  }
  if (!hasDateExpr && /下个?月初/.test(s)) {
    targetMonth += 1;
    if (targetMonth > 12) { targetMonth = 1; targetYear++; }
    targetDay = 1;
    hasDateExpr = true;
  }
  if (!hasDateExpr && /下个?月中/.test(s)) {
    targetMonth += 1;
    if (targetMonth > 12) { targetMonth = 1; targetYear++; }
    targetDay = 15;
    hasDateExpr = true;
  }

  // 下个月（没有具体日期）→ 默认1号
  if (!hasDateExpr && /下个?月/.test(s) && !/下周/.test(s)) {
    targetMonth += 1;
    if (targetMonth > 12) { targetMonth = 1; targetYear++; }
    targetDay = 1;
    hasDateExpr = true;
  }

  // 年底
  if (!hasDateExpr && /年底/.test(s)) {
    targetMonth = 12;
    targetDay = 31;
    hasDateExpr = true;
  }

  // 月底 / 月初 / 月中（当月）
  if (!hasDateExpr && /月底/.test(s)) {
    targetDay = new Date(targetYear, targetMonth, 0).getDate();
    hasDateExpr = true;
  }
  if (!hasDateExpr && /月初/.test(s)) {
    targetDay = 1;
    hasDateExpr = true;
  }
  if (!hasDateExpr && /月中/.test(s)) {
    targetDay = 15;
    hasDateExpr = true;
  }

  // X号 / X日（当月某天）
  if (!hasDateExpr) {
    m = s.match(/(\d{1,2})[号日]/);
    if (m) {
      const dy = parseInt(m[1], 10);
      if (dy >= 1 && dy <= 31) {
        targetDay = dy;
        hasDateExpr = true;
      }
    }
  }

  // ========== 2. 星期/天级别表达式（dayOffset） ==========
  let dayOffset = 0;

  if (!hasDateExpr) {
    if (/明天/.test(s)) {
      dayOffset = 1;
    } else if (/大后天/.test(s)) {
      dayOffset = 3;
    } else if (/后天/.test(s)) {
      dayOffset = 2;
    } else if (/下下周[一二三四五六日]/.test(s)) {
      const targetWk = '日一二三四五六'.indexOf(s.match(/下下周([一二三四五六日])/)[1]);
      let daysToNextMonday = ((1 - weekday + 7) % 7);
      if (daysToNextMonday === 0) daysToNextMonday = 7;
      const daysAfterMonday = targetWk === 0 ? 6 : targetWk - 1;
      dayOffset = 7 + daysToNextMonday + daysAfterMonday;
    } else if (/下周[一二三四五六日]/.test(s)) {
      const targetWk = '日一二三四五六'.indexOf(s.match(/下周([一二三四五六日])/)[1]);
      let daysToNextMonday = ((1 - weekday + 7) % 7);
      if (daysToNextMonday === 0) daysToNextMonday = 7;
      const daysAfterMonday = targetWk === 0 ? 6 : targetWk - 1;
      dayOffset = daysToNextMonday + daysAfterMonday;
    } else if (/星期[一二三四五六日]/.test(s) || /周[一二三四五六日]/.test(s)) {
      const wm = s.match(/(?:星期|周)([一二三四五六日])/);
      if (wm) {
        const targetWk = '日一二三四五六'.indexOf(wm[1]);
        let diff = targetWk - weekday;
        if (diff <= 0) diff += 7;
        dayOffset = diff;
      }
    }

    if (dayOffset > 0) {
      const targetDate = new Date(targetYear, targetMonth - 1, targetDay + dayOffset);
      targetYear = targetDate.getFullYear();
      targetMonth = targetDate.getMonth() + 1;
      targetDay = targetDate.getDate();
      hasDateExpr = true;
    }
  }

  // ========== 3. 提取时间 ==========
  let hour, minute;
  const fbTime = extractTimeFallback(raw, '');
  if (fbTime) {
    [hour, minute] = fbTime.split(':').map(Number);
  } else {
    // 先尝试匹配中文数字（下午三点、晚上十点半）
    const cnTimeM = s.match(/(上午|下午|晚上|中午|凌晨|早上)?([一二三四五六七八九十两]+)\s*点(?:\s*半|[:\s]([一二三四五六七八九十两]+)\s*分?)?/);
    if (cnTimeM) {
      const period = cnTimeM[1] || '';
      hour = cnToNumber(cnTimeM[2]);
      if (cnTimeM[3]) {
        minute = cnToNumber(cnTimeM[3]);
      } else if (s.includes('点半')) {
        minute = 30;
      } else {
        minute = 0;
      }
      if (period === '下午' && hour < 12) hour += 12;
      if (period === '晚上' && hour < 12) hour += 12;
      if (period === '中午' && hour < 12 && hour !== 12) hour += 12;
      if (period === '凌晨' && hour >= 12) hour -= 12;
      if (period === '早上' && hour >= 12) hour -= 12;
      if (period === '上午' && hour >= 12) hour -= 12;
    } else {
      // 再尝试阿拉伯数字
      const timeM = s.match(/(上午|下午|晚上)?(\d{1,2})(?:[点:](\d{1,2}))?/);
      if (timeM) {
        const period = timeM[1] || '';
        hour = parseInt(timeM[2], 10);
        minute = timeM[3] ? parseInt(timeM[3], 10) : 0;
        if (period === '下午' && hour < 12) hour += 12;
        if (period === '晚上' && hour < 12) hour += 12;
        if (period === '上午' && hour === 12) hour = 0;
        if (!period && hour >= 1 && hour <= 6) hour += 12;
      }
    }
  }

  if (hasDateExpr && hour !== undefined) {
    return `${targetYear}-${pad(targetMonth)}-${pad(targetDay)} ${pad(hour)}:${pad(minute)}`;
  } else if (hasDateExpr) {
    return `${targetYear}-${pad(targetMonth)}-${pad(targetDay)}`;
  }
  return null;
}

// 中文数字 → 阿拉伯数字（一~三十九）
function cnToNumber(cn) {
  const map = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'两':2 };
  if (!cn) return 0;
  cn = cn.replace(/两/g, '二');
  if (cn.length === 1) return map[cn] || 0;
  if (cn === '十一') return 11; if (cn === '十二') return 12;
  if (cn === '十三') return 13; if (cn === '十四') return 14;
  if (cn === '十五') return 15; if (cn === '十六') return 16;
  if (cn === '十七') return 17; if (cn === '十八') return 18;
  if (cn === '十九') return 19; if (cn === '二十') return 20;
  if (cn === '二十一') return 21; if (cn === '二十二') return 22;
  if (cn === '二十三') return 23; if (cn === '二十四') return 24;
  if (cn === '二十五') return 25; if (cn === '二十六') return 26;
  if (cn === '二十七') return 27; if (cn === '二十八') return 28;
  if (cn === '二十九') return 29; if (cn === '三十') return 30;
  if (cn === '三十一') return 31; if (cn === '三十二') return 32;
  if (cn === '三十三') return 33; if (cn === '三十四') return 34;
  if (cn === '三十五') return 35; if (cn === '三十六') return 36;
  if (cn === '三十七') return 37; if (cn === '三十八') return 38;
  if (cn === '三十九') return 39;
  // 通用解析
  let num = 0;
  for (let i = 0; i < cn.length; i++) {
    const ch = cn[i];
    if (ch === '十') {
      if (num === 0) num = 10;
      else num = num * 10;
    } else if (map[ch]) {
      num += map[ch];
    }
  }
  return num || 0;
}

// 从 AI 文本回复中提取修改意图（fallback 方案）
function _extractChangesFromText(text, module, card) {
  const changes = {};
  const t = text.replace(/\*\*/g, '');

  // 标题
  const titleMatch = t.match(/(?:标题|名称)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?([^"'\n，。]+)/i);
  if (titleMatch) changes.title = titleMatch[1].trim();

  // 内容/备注（两种模式：1.显式"内容改为xxx" 2.隐含"带红酒""记得带xxx""要准备xxx"）
  const explicitContent = t.match(/(?:内容|描述|详情|备注)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?([^"'\n]+?)(?=\n|$|，|。)/i);
  if (explicitContent) {
    changes.content = explicitContent[1].trim();
  } else {
    // 隐含模式：记得带/要准备/别忘了/记得拿/带上 + 物品/事项
    // 支持：备注带红酒、记得带红酒、记得带红酒去、带红酒
    // 注意：先匹配更长的前缀（记得拿/带上），再匹配短的（带/记得）
    const implicitContent = t.match(/(?:记得拿|带上|别忘了|提醒一下|提醒|备注|记得|带|要准备|准备)([^。，\n]{1,30})/i);
    if (implicitContent) {
      let content = implicitContent[0].trim();
      // 去掉前缀词，保留核心内容
      content = content.replace(/^(记得拿|带上|别忘了|提醒一下|提醒|备注|记得|带|要准备|准备)/, '');
      if (content) changes.content = content.trim();
    }
  }

  // 二次兜底：从用户原始输入中直接提取"记得带xxx" / "带xxx"（即使 AI 没返回 changes）
  if (!changes.content) {
    const directNote = text.match(/(?:记得|备注|带|准备|别忘了|提醒)([^。，\n]{1,30})/i);
    if (directNote) {
      let note = directNote[0].trim();
      note = note.replace(/^(记得|备注|带|准备|别忘了|提醒)/, '');
      if (note) changes.content = note.trim();
    }
  }

  // 地点（三种模式：1.明确指定"地点改为xxx" 2.隐含"在xxx吃/喝" 3.reply中的"：XXX，" 格式）
  const explicitLoc = t.match(/(?:地点|位置|地址)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?([^"'\n，。]+)/i);
  if (explicitLoc) {
    changes.location = explicitLoc[1].trim();
  } else {
    // 隐含模式：在/去/到 + 地名 + 动词
    const implicitLoc = t.match(/(?:在|去|到)([\u4e00-\u9fa5]{1,8})(?:吃|喝|玩|住|开会|吃饭|喝茶|见面|打球|逛街|旅游|聚餐|约会|聊天|谈事|上班|上课|考试)/i);
    if (implicitLoc) {
      changes.location = implicitLoc[1].trim();
    } else {
      // 兜底：从"已更新时间和地点：武汉，xxx" 或 "地点：武汉" 中提取
      const colonLoc = t.match(/(?:地点|位置)[：:]\s*([\u4e00-\u9fa5]{2,10})/i);
      if (colonLoc) changes.location = colonLoc[1].trim();
    }
  }

  // 人物（三种模式：1.明确指定"人物改为xxx" 2.追加"XX也在/也去" 3.隐含"和xxx吃饭/开会/一起"）
  const explicitPerson = t.match(/(?:人物|参与人|和谁|和谁一起)["']?\s*(?:改为|改成|修改为|更新为|调整为|和)\s*["']?([^"'\n，。]+)/i);
  if (explicitPerson) {
    changes.person = explicitPerson[1].trim();
  } else {
    // 追加模式：小周也在/XX也去（已有person时追加）
    const appendPerson = t.match(/([\u4e00-\u9fa5]{1,5})(?:也在|也去|也去)/i);
    if (appendPerson) {
      const existing = (card.person || '').trim();
      const added = appendPerson[1].trim();
      if (existing && !existing.includes(added)) {
        changes.person = existing + '、' + added;
      } else if (!existing) {
        changes.person = added;
      }
    } else {
      // 隐含模式：和/与/跟 + 人名 + [可选介词短语] + 动作
      // 支持：和老虎吃饭、和老虎在武汉吃饭、跟老王开会、和老胡一起
      const implicitPerson = t.match(/(?:和|与|跟)([\u4e00-\u9fa5]{1,5})(?:在|去|到|跟|一起)?[^\n，。]{0,10}?(?:吃饭|喝茶|喝酒|见面|开会|打球|逛街|旅游|聚餐|约会|聊天|谈事|一起)/i);
      if (implicitPerson) changes.person = implicitPerson[1].trim();
    }
  }

  // 金额（报销）
  const amountMatch = t.match(/(?:金额|费用|钱)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?(\d+(?:\.\d+)?)/i);
  if (amountMatch) changes.amount = parseFloat(amountMatch[1]);

  // 优先级
  const priorityMatch = t.match(/(?:优先级|重要程度)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?(高|中|低)/i);
  if (priorityMatch) changes.priority = priorityMatch[1];

  // 申请类型
  const applyTypeMatch = t.match(/(?:类型|申请类型|申请类别)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?([^"'\n，。]+)/i);
  if (applyTypeMatch) changes.apply_type = applyTypeMatch[1].trim();

  // 时间（日程/任务）- 尝试多种格式
  // 支持：下个月5号、12月25号、下周二、明天下午四点、15号下午3点、月底等
  const N = '[零一二三四五六七八九十两三廿\\d]';
  const timePatterns = [
    // 显式指定：时间改为2025-08-06 16:00
    /(?:时间|开始时间|日期)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2})/i,
    // 显式：时间改为 + 月份级表达式（下个月5号/12月25号/明年3月/月底 等）
    /(?:时间|开始时间|日期)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?(下下个?月\d{1,2}[号日]|下下个?月[初中底]|下个?月底?|明年\d{1,2}月\d{1,2}[号日]?|\d{1,2}月\d{1,2}[号日]?|[初中底]|年底)/i,
    // 显式：时间改为 + 星期级表达式（无钟点）
    /(?:时间|开始时间|日期)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?(下周[一二三四五六日]|下下周[一二三四五六日]|大后天|后天|明天)/i,
    // 显式：时间改为 + 带钟点时间
    new RegExp(`(?:时间|开始时间|日期)["']?\\s*(?:改为|改成|修改为|更新为|调整为)\\s*["']?(下下?个?月\\d{1,2}[号日]?|明年\\d{1,2}月\\d{1,2}[号日]?|\\d{1,2}月\\d{1,2}[号日]?|下周[一二三四五六日]|下下周[一二三四五六日]|大后天|后天|明天?)?\\s*(?:上午|下午|晚上)?\\s*${N}{1,3}\\s*[点:](?:${N}{1,2})?`, 'i'),
    // 隐含：月份级表达式（下个月5号/12月25号/月底 等）
    /(下下个?月\d{1,2}[号日]|下下个?月[初中底]|下个?月底?|明年\d{1,2}月\d{1,2}[号日]?|\d{1,2}月\d{1,2}[号日]?|[初中底]|年底|\d{1,2}[号日])/i,
    // 隐含：星期级带钟点
    new RegExp(`(下周[一二三四五六日]|下下周[一二三四五六日]|大后天|后天|明天?)\\s*(?:上午|下午|晚上)?\\s*${N}{1,3}\\s*[点:](?:${N}{1,2})?`, 'i'),
    // 隐含：仅星期表达式（无钟点）
    /(下周[一二三四五六日]|下下周[一二三四五六日]|大后天|后天|明天)/i,
    // 隐含：纯钟点时间（四点、16:00）
    new RegExp(`(${N}{1,3}\\s*[点:]${N}{1,2})`, 'i'),
  ];
  for (const p of timePatterns) {
    const m = t.match(p);
    if (m) {
      const raw = m[1].trim();
      const parsed = _parseTimeExpression(raw);
      if (parsed) { changes.start_time = parsed; break; }
      changes.start_time = raw;
      break;
    }
  }

  // 截止时间（任务）
  const deadlinePatterns = [
    /(?:截止时间|deadline|期限)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2})/i,
    /(?:截止时间|deadline|期限)["']?\s*(?:改为|改成|修改为|更新为|调整为)\s*["']?(\d{1,2}月\d{1,2}日)/i,
  ];
  for (const p of deadlinePatterns) {
    const m = t.match(p);
    if (m) { changes.deadline = m[1]; break; }
  }

  // 如果没有明确提取到任何字段，但文本中明确说"已更新"、"已修改"等，且包含"标题改为xxx"这类明确模式
  if (Object.keys(changes).length === 0) {
    const hasUpdateKeyword = /(?:已更新|已修改|已调整|已改为|已改成)/.test(t);
    const hasExplicitChange = /(?:改为|改成|修改为|更新为|调整为)/.test(t);
    if (hasUpdateKeyword && hasExplicitChange) {
      // 尝试提取被引号包裹的内容作为标题
      const quotedTitle = t.match(/["']([^"']+)["']\s*(?:作为|设为|成为)?\s*(?:新标题|标题)/i);
      if (quotedTitle) changes.title = quotedTitle[1].trim();
    }
  }

  // 只返回当前模块支持的字段
  const allowedKeys = {
    schedule: ['title', 'content', 'start_time', 'end_time', 'location', 'person', 'priority'],
    task: ['title', 'content', 'deadline', 'priority'],
    inspiration: ['title', 'content'],
    application: ['title', 'content', 'apply_type', 'priority'],
    expense: ['title', 'content', 'amount', 'priority'],
  }[module] || ['title', 'content'];

  const filtered = {};
  for (const k of Object.keys(changes)) {
    if (allowedKeys.includes(k)) filtered[k] = changes[k];
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

/**
 * 辅助：规范化 changes 对象中的时间字段，确保返回标准 YYYY-MM-DD HH:mm 格式
 */
function _normalizeTimeInChanges(changes, todayStr) {
  if (!changes || typeof changes !== 'object') return changes;
  const result = { ...changes };
  // 别名映射：AI 可能用 time/datetime 替代 start_time
  const aliasMap = { time: 'start_time', datetime: 'start_time', date: 'start_time' };
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (result[alias] !== undefined && result[target] === undefined) {
      result[target] = result[alias];
      delete result[alias];
    }
  }
  ['start_time', 'end_time', 'deadline'].forEach(field => {
    if (result[field] !== undefined && result[field] !== null) {
      let v = String(result[field]).trim();
      if (!v) {
        delete result[field];
        return;
      }
      // 已经是标准格式（带时间）
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return;
      // 纯日期格式 YYYY-MM-DD（仅指定日期未指定时间）→ 保留原样
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        result[field] = v;
        return;
      }
      // 只有 HH:mm
      if (/^\d{2}:\d{2}$/.test(v)) {
        result[field] = `${todayStr} ${v}`;
        return;
      }
      // 尝试解析中文日期时间格式：2026年8月8日 15:00
      const cnDateMatch = v.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
      if (cnDateMatch) {
        const [, y, m, d, h, min] = cnDateMatch;
        result[field] = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${min}`;
        return;
      }
      // 尝试 _parseTimeExpression（处理"明天下午四点"等，支持日期计算）
      const parsed = _parseTimeExpression(v);
      if (parsed) {
        result[field] = parsed;
        return;
      }
      // 兜底：只提取 HH:mm（不处理日期，默认今天）
      const fb = extractTimeFallback(v, '');
      if (fb) {
        result[field] = `${todayStr} ${fb}`;
        return;
      }
    }
  });
  return result;
}

async function aiChatWithCard(currentCard, userText, chatHistory, targetModule) {
  try {
    const messages = chatHistory.slice(-5).map(m => ({
      role: m.role === 'ai' ? 'assistant' : m.role,
      content: m.content,
    }));
    messages.push({ role: 'user', content: userText });

    const result = await chat(messages, {
      systemPrompt: buildChatPrompt(currentCard, chatHistory, targetModule),
      temperature: 0.3,
      maxTokens: 1024,
    });
    if (!result || !result.text) return null;

    // 解析 AI 的 JSON 回复
    let cleaned = result.text
      .replace(/```json\s*|```/gi, '')
      .trim();

    // 尝试找第一个 { 和最后一个配对的 }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    try {
      const parsed = JSON.parse(cleaned);
      let changes = parsed.changes && Object.keys(parsed.changes).length > 0 ? parsed.changes : null;
      
      // 兜底：JSON 有效但 AI 忘了输出 changes，尝试从 reply 文本中提取字段修改
      if (!changes && parsed.reply) {
        const extractedFromReply = _extractChangesFromText(parsed.reply, targetModule, currentCard);
        if (extractedFromReply && Object.keys(extractedFromReply).length > 0) {
          console.log(`[Drafts] 兜底提取 changes from reply="${parsed.reply.slice(0, 40)}..." →`, JSON.stringify(extractedFromReply));
          changes = extractedFromReply;
        }
      }
      
      // 二次兜底：从用户原始输入中提取修改意图（适用于 AI 完全没返回 changes 的情况）
      if (!changes && userText) {
        const extractedFromUser = _extractChangesFromText(userText, targetModule, currentCard);
        if (extractedFromUser && Object.keys(extractedFromUser).length > 0) {
          console.log(`[Drafts] 兜底提取 changes from userText="${userText.slice(0, 40)}..." →`, JSON.stringify(extractedFromUser));
          changes = extractedFromUser;
        }
      }

      // 三次兜底：如果 AI 返回了 changes 但缺少 content/备注，尝试从 userText 补录
      if (changes && userText && !changes.content) {
        const extractedNote = _extractChangesFromText(userText, targetModule, currentCard);
        if (extractedNote && extractedNote.content) {
          console.log(`[Drafts] 补录备注 from userText="${userText.slice(0, 40)}..." → content="${extractedNote.content}"`);
          changes.content = extractedNote.content;
        }
      }
      
      // 规范化时间字段，确保返回标准格式
      if (changes) {
        const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
        changes = _normalizeTimeInChanges(changes, todayStr);
      }
      
      return { reply: parsed.reply || '收到！', changes };
    } catch (parseErr) {
      // 如果 AI 返回的不是 JSON，尝试从文本中提取修改意图
      const extractedChanges = _extractChangesFromText(result.text, targetModule, currentCard);
      if (extractedChanges && Object.keys(extractedChanges).length > 0) {
        const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;
        const normalizedChanges = _normalizeTimeInChanges(extractedChanges, todayStr);
        return { reply: result.text.trim(), changes: normalizedChanges };
      }
      if (result.text.trim()) {
        return { reply: result.text.trim(), changes: null };
      }
      return null;
    }
  } catch (e) {
    console.error('[Drafts] AI对话调用失败:', e.message);
    return null;
  }
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
      let person = '';
      let location = '';
      let start_time = '';
      let end_time = '';
      let deadline = '';
      let amount = '';
      let priority = '中';
      let module_type = 'schedule';
      if (raw_content && raw_content.trim()) {
        const parsed = await aiParseDraft(raw_content);
        parsed_title = parsed.title;
        parsed_content = parsed.content;
        person = parsed.person || '';
        location = parsed.location || '';
        start_time = parsed.start_time || '';
        end_time = parsed.end_time || '';
        deadline = parsed.deadline || '';
        amount = parsed.amount || '';
        priority = parsed.priority || '中';
        module_type = parsed.module_type || 'schedule';

        // 申请模块：时间默认当前时间
        if (module_type === 'apply') {
          const now = new Date();
          const nowStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
          if (!start_time) start_time = nowStr;
          if (!end_time) end_time = nowStr;
          console.log(`[Drafts] 申请模块默认时间：${nowStr}`);
        }
      }

      const info = db.prepare(
        `INSERT INTO drafts (openid, source_type, raw_content, raw_file_url, parsed_title, parsed_content,
          person, location, start_time, end_time, deadline, amount, priority,
          target_module, suggest_module, user_selected_module)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(openid, source_type || 'text', raw_content || '', raw_file_url || '',
        parsed_title, parsed_content, person, location, start_time, end_time,
        deadline, amount, priority,
        module_type, module_type, module_type);

      const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid);
      console.log(`[Drafts] 创建草稿 id=${info.lastInsertRowid} source=${source_type || 'text'}`);
      res.json({ success: true, data: draft });
    } catch (e) {
      console.error('[Drafts] POST /create 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /adjust - AI 根据用户指令调整草稿 =====
  router.post('/adjust', async (req, res) => {
    try {
      const { openid, draft_id, user_text, target_module } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!draft_id) return res.status(400).json({ success: false, error: '缺少draft_id' });

      const draft = db.prepare(
        'SELECT * FROM drafts WHERE id = ? AND openid = ? AND status = ?'
      ).get(draft_id, openid, 'draft');
      if (!draft) return res.status(404).json({ success: false, error: '草稿不存在或已删除' });

      const module_ = target_module || draft.user_selected_module || draft.target_module || 'schedule';
      let updateFields = {};

      if (user_text && user_text.trim()) {
        // 有用户修改指令：用 AI 分析指令 + 当前卡片内容，返回修改后的字段
        const adjusted = await aiAdjustDraft(draft, user_text.trim(), module_);
        if (adjusted) {
          updateFields = adjusted;
        } else {
          return res.status(500).json({ success: false, error: 'AI调整失败，请重试' });
        }
      } else {
        // 无用户指令：兜底，对原始内容重新解析
        const contentToParse = draft.raw_content || draft.parsed_content || '';
        if (!contentToParse.trim()) {
          return res.status(400).json({ success: false, error: '草稿无文本内容可供AI调整' });
        }
        const parsed = await aiParseDraft(contentToParse);
        updateFields.title = parsed.title;
        updateFields.content = parsed.content;
        updateFields.person = parsed.person;
        updateFields.location = parsed.location;
        updateFields.start_time = parsed.start_time;
        updateFields.end_time = parsed.end_time;
        updateFields.deadline = parsed.deadline;
        updateFields.amount = parsed.amount;
        updateFields.priority = parsed.priority;
      }

      // 构建动态 SQL 更新
      const setClauses = [];
      const params = [];
      if (updateFields.title !== undefined) {
        setClauses.push('parsed_title = ?');
        params.push(updateFields.title);
      }
      if (updateFields.content !== undefined) {
        setClauses.push('parsed_content = ?');
        params.push(updateFields.content);
      }
      if (updateFields.person !== undefined) {
        setClauses.push('person = ?');
        params.push(updateFields.person);
      }
      if (updateFields.location !== undefined) {
        setClauses.push('location = ?');
        params.push(updateFields.location);
      }
      if (updateFields.start_time !== undefined) {
        setClauses.push('start_time = ?');
        params.push(updateFields.start_time);
      }
      if (updateFields.end_time !== undefined) {
        setClauses.push('end_time = ?');
        params.push(updateFields.end_time);
      }
      if (updateFields.amount !== undefined) {
        setClauses.push('amount = ?');
        params.push(updateFields.amount);
      }
      if (updateFields.deadline !== undefined) {
        setClauses.push('deadline = ?');
        params.push(updateFields.deadline);
      }
      if (updateFields.priority !== undefined) {
        setClauses.push('priority = ?');
        params.push(updateFields.priority);
      }
      // 不覆盖用户手动选择的模块（adjust 只更新字段不改变 tab）
      setClauses.push("updated_at = datetime('now','localtime')");
      params.push(draft_id, openid);

      db.prepare(
        `UPDATE drafts SET ${setClauses.join(', ')} WHERE id = ? AND openid = ?`
      ).run(...params);

      const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft_id);
      // 附加 ai_hint（不会存入 DB）
      if (updateFields.ai_hint) {
        updated.ai_hint = updateFields.ai_hint;
      }
      console.log(`[Drafts] AI调整草稿 id=${draft_id}${user_text ? ', user_text=' + user_text.slice(0, 30) : ''}`);
      res.json({ success: true, data: updated });
    } catch (e) {
      console.error('[Drafts] POST /adjust 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /adjust-existing - AI 根据用户指令调整「已存在的记录」（非草稿） =====
  router.post('/adjust-existing', async (req, res) => {
    try {
      const { openid, record_type, record_id, user_text, target_module } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!record_type) return res.status(400).json({ success: false, error: '缺少record_type' });
      if (!record_id) return res.status(400).json({ success: false, error: '缺少record_id' });

      // 模块 -> 表名/字段名映射
      const tableMap = {
        schedule: 'schedules',
        task: 'tasks',
        application: 'applications',
        expense: 'expenses',
        inspiration: 'inspirations',
        daily_record: 'daily_records',
      };
      const table = tableMap[record_type];
      if (!table) return res.status(400).json({ success: false, error: '不支持的record_type' });

      const record = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND openid = ?`).get(record_id, openid);
      if (!record) return res.status(404).json({ success: false, error: '记录不存在或已删除' });

      const module_ = target_module || record.target_module || record.type || record.module_type || record_type;

      // 把记录字段统一成 aiAdjustDraft 能识别的 draft 字段
      const draftLike = {
        parsed_title: record.title || record.parsed_title || '',
        parsed_content: record.description || record.content || record.parsed_content || record.remark || '',
        start_time: record.start_time || '',
        end_time: record.end_time || '',
        location: record.location || '',
        person: record.person || '',
        priority: record.priority || '中',
        deadline: record.deadline || record.due_date || '',
        amount: record.amount || '',
        category: record.category || '',
        tags: record.tags || '',
      };

      let updateFields = {};
      if (user_text && user_text.trim()) {
        const adjusted = await aiAdjustDraft(draftLike, user_text.trim(), module_);
        if (adjusted) {
          updateFields = adjusted;
        } else {
          return res.status(500).json({ success: false, error: 'AI调整失败，请重试' });
        }
      } else {
        return res.status(400).json({ success: false, error: '缺少修改指令user_text' });
      }

      // 返回字段时附带当前模块，方便前端
      updateFields.module_type = module_;
      console.log(`[Drafts] AI调整已有记录 type=${record_type} id=${record_id}${user_text ? ', user_text=' + user_text.slice(0, 30) : ''}`);
      res.json({ success: true, data: updateFields });
    } catch (e) {
      console.error('[Drafts] POST /adjust-existing 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /save-extra - 保存草稿额外字段（时间、地点、人物、金额、模块、优先级、备注、申请类型、标题） =====
  router.post('/save-extra', (req, res) => {
    try {
      const { openid, draft_id, parsed_title, start_time, end_time, deadline, location, person, amount, target_module, user_selected_module, priority, parsed_content, apply_type } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!draft_id) return res.status(400).json({ success: false, error: '缺少draft_id' });

      // 报销模块：金额必填校验
      const effectiveModule = target_module || 'schedule';
      if (effectiveModule === 'expense') {
        const amt = amount !== undefined && amount !== '' ? parseFloat(amount) : NaN;
        if (isNaN(amt) || amt <= 0) {
          return res.status(400).json({ success: false, error: '报销模块金额不能为空，请输入金额' });
        }
      }

      // 申请模块：时间默认当前时间（用户没填则自动补）
      if (effectiveModule === 'apply') {
        const now = new Date();
        const nowStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        if (!start_time) start_time = nowStr;
        if (!end_time) end_time = nowStr;
        console.log(`[Drafts] save-extra 申请模块默认时间：${nowStr}`);
      }

      const draft = db.prepare(
        'SELECT * FROM drafts WHERE id = ? AND openid = ? AND status = ?'
      ).get(draft_id, openid, 'draft');
      if (!draft) return res.status(404).json({ success: false, error: '草稿不存在或已删除' });

      db.prepare(
        `UPDATE drafts SET
          parsed_title = ?, start_time = ?, end_time = ?, deadline = ?, location = ?, person = ?,
          amount = ?, target_module = ?, user_selected_module = ?, priority = ?,
          parsed_content = ?, apply_type = ?,
          updated_at = datetime('now','localtime')
        WHERE id = ? AND openid = ?`
      ).run(
        parsed_title || draft.parsed_title || '',
        start_time || null,
        end_time || null,
        deadline || null,
        location || '',
        person || '',
        amount !== undefined && amount !== '' ? amount : null,
        effectiveModule,
        user_selected_module || effectiveModule,
        priority || '中',
        parsed_content || '',
        apply_type || '',
        draft_id,
        openid
      );

      const updated = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft_id);
      console.log(`[Drafts] 保存额外字段 id=${draft_id} module=${effectiveModule}`);
      res.json({ success: true, data: updated });
    } catch (e) {
      console.error('[Drafts] POST /save-extra 失败:', e.message);
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

  // ===== POST /chat - AI 对话助手（支持自由对话 + 智能修改卡片） =====
  router.post('/chat', async (req, res) => {
    try {
      const { openid, draft_id, user_text, chat_history, target_module } = req.body;
      if (!openid) return res.status(400).json({ success: false, error: '缺少openid' });
      if (!user_text || !user_text.trim()) return res.status(400).json({ success: false, error: '缺少消息内容' });

      // 如果有 draft_id，读取当前卡片内容
      let currentCard = {};
      if (draft_id) {
        const draft = db.prepare('SELECT * FROM drafts WHERE id = ? AND openid = ?').get(draft_id, openid);
        if (draft) currentCard = draft;
      }

      const module_ = target_module || currentCard.target_module || 'schedule';
      const history = chat_history || [];

      const result = await aiChatWithCard(currentCard, user_text.trim(), history, module_);
      if (!result) return res.status(500).json({ success: false, error: 'AI 应答失败，请重试' });

      console.log(`[Drafts] AI对话 draft_id=${draft_id} module=${module_} hasChanges=${!!result.changes}`);
      res.json({
        success: true,
        data: {
          reply: result.reply,
          changes: result.changes || null,
          module_type: module_,
        },
      });
    } catch (e) {
      console.error('[Drafts] POST /chat 失败:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
};
