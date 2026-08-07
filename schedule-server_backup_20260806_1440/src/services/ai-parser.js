/**
 * AI 日程解析引擎（规则引擎版）
 * 
 * 输入自然语言 → 输出结构化日程对象
 * 覆盖中文日期/时间/周期/人物/地点/优先级识别
 * 后续可无缝切换为调用大模型 API（保持输出格式一致）
 */

/**
 * 计算下一个指定星期几的日期
 */
function nextWeekday(from, targetDay, weekOffset) {
  const d = new Date(from);
  const currentDay = d.getDay();
  let diff = targetDay - currentDay;
  if (diff < 0) diff += 7;
  diff += weekOffset * 7;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 格式化时间为 HH:MM
 */
function fmtTime(t) {
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}

/**
 * 核心解析函数
 * @param {string} text 自然语言输入
 * @param {object} options 可选参数 { typeHint }
 * @returns {object} 结构化日程对象
 */
function aiParse(text, options = {}) {
  if (!text || !text.trim()) return { error: '输入为空' };

  const raw = text.trim();
  const now = new Date();

  const result = {
    title: raw,
    start_time: '',
    end_time: '',
    type: '日程',
    priority: '中',
    person: '',
    location: '',
    reminder_minutes: 15,
    repeat_type: 'none',
    raw_text: raw,
    confidence: 0,
  };

  // ===== 1. 重复周期 =====
  if (/(每|每个)\s*(天|日)/.test(raw)) result.repeat_type = 'daily';
  else if (/每周/.test(raw)) result.repeat_type = 'weekly';
  else if (/每月/.test(raw)) result.repeat_type = 'monthly';

  // ===== 2. 日期识别 =====
  let targetDate = new Date(now);

  // X月X日
  const md = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (md) {
    const m = parseInt(md[1]) - 1;
    const d = parseInt(md[2]);
    targetDate = new Date(now.getFullYear(), m, d);
    // 只有当日期严格在过去（不同天）才推进到明年
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (targetDate.getTime() < todayMidnight.getTime()) {
      targetDate.setFullYear(now.getFullYear() + 1);
    }
  }

  // 相对日期
  if (/明天/.test(raw)) { targetDate = new Date(now); targetDate.setDate(targetDate.getDate() + 1); }
  if (/后天/.test(raw)) { targetDate = new Date(now); targetDate.setDate(targetDate.getDate() + 2); }
  if (/大后天/.test(raw)) { targetDate = new Date(now); targetDate.setDate(targetDate.getDate() + 3); }
  if (/今天/.test(raw) && !md && !/明天|后天/.test(raw)) targetDate = new Date(now);

  // X天后
  const dl = raw.match(/(\d+)\s*天\s*[后以]/);
  if (dl) { targetDate = new Date(now); targetDate.setDate(targetDate.getDate() + parseInt(dl[1])); }

  // 下周X / 本周X
  const weekMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };

  const nw = raw.match(/下周\s*([一二三四五六日天1-7])/);
  if (nw) targetDate = nextWeekday(now, weekMap[nw[1]], 1);

  const tw = raw.match(/(?:本|这)?周\s*([一二三四五六日天1-7])/);
  if (tw && !nw) targetDate = nextWeekday(now, weekMap[tw[1]], 0);

  // ===== 3. 时段偏移 =====
  let periodBase = 0;
  if (/早上|早晨|上午/.test(raw)) periodBase = 0;
  else if (/中午/.test(raw)) periodBase = 12;
  else if (/下午/.test(raw)) periodBase = 12;
  else if (/傍晚/.test(raw)) periodBase = 17;
  else if (/晚上|今晚/.test(raw)) periodBase = 20;

  // ===== 4. 时间提取 =====
  let times = [];

  // HH:MM 格式
  const t1 = raw.match(/(\d{1,2}):(\d{2})/g);
  if (t1) t1.forEach(t => { const p = t.split(':'); times.push({ h: parseInt(p[0]), m: parseInt(p[1]) }); });

  // X点X分
  if (!times.length) {
    const t2 = raw.match(/(\d{1,2})\s*点\s*(\d{1,2})\s*分?/);
    if (t2) times.push({ h: parseInt(t2[1]), m: parseInt(t2[2]) });
  }

  // X点半
  if (!times.length) {
    const t3 = raw.match(/(\d{1,2})\s*点半/);
    if (t3) times.push({ h: parseInt(t3[1]), m: 30 });
  }

  // X点
  if (!times.length) {
    const t4 = raw.match(/(\d{1,2})\s*点/);
    if (t4) times.push({ h: parseInt(t4[1]), m: 0 });
  }

  // 中文数字时间（一~十二点）
  if (!times.length) {
    const cnNum = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 两: 2 };
    const ctm = raw.match(/([一二两三四五六七八九十]+)\s*点/);
    if (ctm && cnNum[ctm[1]]) times.push({ h: cnNum[ctm[1]], m: 0 });
  }

  // 应用时段偏移
  times = times.map(t => {
    let h = t.h;
    if ((/晚上|今晚|下午/.test(raw)) && h >= 1 && h < 12) h += 12;
    return { h, m: t.m };
  });

  const dateStr = fmtDate(targetDate);

  // 拼接时间字符串
  if (times.length >= 2) {
    result.start_time = `${dateStr}T${fmtTime(times[0])}:00`;
    result.end_time = `${dateStr}T${fmtTime(times[1])}:00`;
  } else if (times.length === 1) {
    result.start_time = `${dateStr}T${fmtTime(times[0])}:00`;
    result.end_time = '';
  } else if (periodBase > 0) {
    result.start_time = `${dateStr}T${String(periodBase).padStart(2, '0')}:00:00`;
  } else {
    result.start_time = `${dateStr}T09:00:00`;
  }

  // ===== 5. 类型分类 =====
  // 如果调用方强制指定了栏目类型，优先使用
  const { typeHint } = options;
  if (typeHint && /^(会议|任务|提醒|日程)$/.test(typeHint)) {
    result.type = typeHint;
  } else {
    if (/开会|会议|讨论|评审/.test(raw)) result.type = '会议';
    else if (/任务|完成|做|处理|交付/.test(raw)) result.type = '任务';
    else if (/提醒|记得|别忘了|别忘/.test(raw)) result.type = '提醒';
  }

  // ===== 6. 优先级 =====
  if (/紧急|马上|立即|赶紧|立刻/.test(raw)) result.priority = '高';
  else if (/重要/.test(raw)) result.priority = '高';

  // ===== 7. 人物提取 =====
  // 匹配"跟/和/与/同/找 + 中文名(1-3字)"，用非贪婪 + 后向动词/分隔符截断
  const pm = raw.match(/(?:跟|和|与|同|找)\s*([\u4e00-\u9fff]{1,3}?)(?:吃|喝|玩|见|见面|说话|聊天|讨论|商量|聊|谈|开会|在|去|到|，|。|一起|一下|$)/);
  if (pm) result.person = pm[1].trim();

  // ===== 8. 地点提取 =====
  // 在/去/到 + 地点词（非贪婪匹配前缀，优先匹配常见地点关键词）
  const lm = raw.match(/(?:在|去|到)\s*([^\s，。,，]{0,8}?(?:会议室|办公室|房间|大厅|餐厅|咖啡厅|广场|大厦|中心))/);
  if (lm) {
    result.location = lm[1];
  } else {
    // 退化为在/去/到后的短词，排除时间/动作词
    const lm2 = raw.match(/(?:在|去|到)\s*([^\s，。,，。\d]{1,8})/);
    if (lm2 && !/几点|时候|什么|讨论|商量|聊|谈|见|看|做|写/.test(lm2[1])) {
      result.location = lm2[1];
    }
  }

  // ===== 9. 提醒时间 =====
  const rm = raw.match(/提前\s*(\d+)\s*分钟/);
  if (rm) result.reminder_minutes = parseInt(rm[1]);
  else if (/提前\s*(\d+)\s*小时/.test(raw)) {
    result.reminder_minutes = parseInt(raw.match(/提前\s*(\d+)\s*小时/)[1]) * 60;
  }

  // ===== 10. 标题清洗 =====
  result.title = raw
    .replace(/今天|明天|后天|大后天/g, '')
    .replace(/早上|上午|中午|下午|傍晚|晚上|今晚/g, '')
    .replace(/提前\d+分钟|提前\d+小时/g, '')
    .replace(/记得|别忘了|别忘|提醒我/g, '')
    .replace(/每[天日周月]/g, '')
    .replace(/紧急|重要|马上|立即|赶紧|立刻/g, '')
    .replace(/\d{1,2}月\d{1,2}[日号]/g, '')
    .replace(/\d{1,2}点\d{0,2}分?|\d{1,2}点半|\d{1,2}:\d{2}|\d{1,2}点/g, '')
    .replace(/[，,。]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 主题不是必须的：清洗后若为空，用类型作为默认标题
  if (!result.title) {
    result.title = result.type || '日程';
  }

  // 置信度评估
  result.confidence = times.length > 0 ? 85 : (periodBase > 0 ? 70 : 50);

  return result;
}

module.exports = { aiParse };
