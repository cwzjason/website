import sys
f = '/www/wwwroot/schedule-server/src/routes/chat.js'
s = open(f, encoding='utf-8').read()

old = """    // ===== 日程查询：检测意图并注入数据库内容 =====
    const queryIntent = detectScheduleQuery(cleanMsg);
      const rows = querySchedulesFromDb(db, openid, queryIntent);
      if (scheduleCtx) {
        messages.splice(1, 0, { role: 'system', content: scheduleCtx });
      }"""

new = """    // ===== 日程查询：检测意图并注入数据库内容 =====
    const queryIntent = detectScheduleQuery(cleanMsg);
    if (queryIntent) {
      const rows = querySchedulesFromDb(db, openid, queryIntent);
      const scheduleCtx = formatScheduleContext(rows, openid);
      if (scheduleCtx) {
        messages.splice(1, 0, { role: 'system', content: scheduleCtx });
      }"""

print('FOUND:', old in s)
s = s.replace(old, new)
open(f, 'w', encoding='utf-8').write(s)
print('REPLACED')
