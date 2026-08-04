/**
 * 日程提醒服务
 * 
 * 定时扫描（每分钟）：
 *   1. 从 schedule_reminders 中找出 planned_time <= now 且 channel='scheduled' 的记录
 *   2. 关联 schedules 表确认 status='待办'
 *   3. 标记为 pending
 * 
 * 推送策略（双通道）：
 *   - 服务号模板消息（MP）：已关注服务号的用户，通过 unionid → mp_openid 推送
 *   - 小程序订阅消息（Mini）：未关注服务号的用户，降级到小程序订阅消息
 */
const cron = require('node-cron');
const { sendReminder, sendMpReminder } = require('./wechat-push');

class ReminderService {
  constructor(db) {
    this.db = db;
    this._task = null;
  }

  /** 启动定时任务 */
  start() {
    this._task = cron.schedule('* * * * *', () => {
      this.scan();
    });
    console.log('[提醒服务] 定时扫描已启动（每分钟）');
  }

  /** 停止定时任务 */
  stop() {
    if (this._task) {
      this._task.stop();
      this._task = null;
    }
  }

  /** 扫描到期提醒 */
  scan() {
    (async () => {
      try {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        // 把到期的提醒标记为 pending（如果对应日程仍是待办）
        const stmt = this.db.prepare(`
          UPDATE schedule_reminders
          SET channel = 'pending'
          WHERE channel = 'scheduled'
            AND planned_time <= ?
            AND schedule_id IN (
              SELECT id FROM schedules WHERE status = '待办'
            )
        `);
        stmt.run(nowStr);

        const pendingRows = this.db.prepare(`
          SELECT sr.id as reminder_id, sr.minutes_before, s.*
          FROM schedule_reminders sr
          JOIN schedules s ON s.id = sr.schedule_id
          WHERE sr.channel = 'pending' AND s.status = '待办'
          ORDER BY sr.planned_time ASC
        `).all();

        if (pendingRows.length > 0) {
          console.log(`[提醒服务] 当前有 ${pendingRows.length} 条待提醒`);
          await this.pushReminders(pendingRows);
        }
      } catch (err) {
        console.error('[提醒服务] 扫描出错:', err.message);
      }
    })();
  }

  /** 推送提醒 - 精确推送给创建日程的用户 */
  async pushReminders(rows) {
    for (const row of rows) {
      const scheduleOpenid = row.openid;
      if (!scheduleOpenid) {
        console.warn(`[提醒服务] 日程 ${row.id} (${row.title}) 没有 openid，跳过推送`);
        this.markSent(row.reminder_id); // 无 openid 的旧数据，直接标记已处理
        continue;
      }

      // 过期的提醒不推送（计划时间超过 2 小时前）
      const plannedTime = new Date(row.planned_time);
      const now = new Date();
      const hoursElapsed = (now - plannedTime) / (1000 * 60 * 60);
      if (hoursElapsed > 2) {
        console.warn(`[提醒服务] 提醒已过期 ${hoursElapsed.toFixed(1)}h，跳过: ${row.title}`);
        this.markSent(row.reminder_id);
        continue;
      }

      // 校验用户是否授权过该模板
      const sub = this.db.prepare(`
        SELECT 1 FROM user_subscriptions
        WHERE openid = ? AND template_id IS NOT NULL AND template_id != ''
        LIMIT 1
      `).get(scheduleOpenid);
      if (!sub) {
        console.warn(`[提醒服务] 用户 ${scheduleOpenid} 未授权订阅消息，跳过`);
        this.markSent(row.reminder_id); // 未授权的不重试
        continue;
      }

      // 查询用户的 mp_openid（关注服务号的用户走服务号通道）
      const user = this.db.prepare(`
        SELECT miniapp_openid, mp_openid, subscribed
        FROM mp_users WHERE miniapp_openid = ? OR unionid IN (
          SELECT unionid FROM mp_users WHERE miniapp_openid = ?
        )
        LIMIT 1
      `).get(scheduleOpenid, scheduleOpenid);

      let pushed = false;

      // 通道1：服务号模板消息（用户已关注服务号时优先）
      if (user && user.mp_openid && user.subscribed === 1) {
        try {
          const result = await sendMpReminder({
            mpOpenid: user.mp_openid,
            schedule: row,
            minutesBefore: row.minutes_before,
          });
          if (result.sent) {
            console.log(`[提醒服务] 服务号推送成功(${row.minutes_before}分):`, row.title);
            pushed = true;
          }
        } catch (e) {
          console.error('[提醒服务] 服务号推送异常:', e.message);
        }
      }

      // 通道2：小程序订阅消息（主通道，所有用户都适用）
      try {
        const result = await sendReminder({
          openid: scheduleOpenid,
          schedule: row,
          minutesBefore: row.minutes_before,
        });
        if (result.sent) {
          console.log(`[提醒服务] 微信推送成功(${row.minutes_before}分):`, row.title, '→', scheduleOpenid.substring(0, 8) + '...');
          this.markSent(row.reminder_id);
        } else {
          // 永久性错误码：不再重试，直接标记已处理
          const permanentErrors = [43101, 47003, 40037, 40003, 41028, 41029, 41030, 45009];
          if (permanentErrors.includes(result.errcode)) {
            console.warn(`[提醒服务] 推送永久失败(errcode=${result.errcode})，不再重试:`, row.title);
            this.markSent(row.reminder_id);
          } else {
            console.warn(`[提醒服务] 微信推送失败（暂留重试）:`, result);
          }
        }
      } catch (e) {
        console.error('[提醒服务] 微信推送异常:', e.message);
      }
    }
  }

  /** 获取待推送的提醒列表（供客户端轮询） */
  getPending(limit = 20) {
    return this.db.prepare(`
      SELECT s.*, sr.id as reminder_id, sr.minutes_before, sr.planned_time
      FROM schedule_reminders sr
      JOIN schedules s ON s.id = sr.schedule_id
      WHERE sr.channel = 'pending'
        AND s.status = '待办'
      ORDER BY sr.planned_time ASC
      LIMIT ?
    `).all(limit);
  }

  /** 标记提醒已送达（客户端 acknowledgement） */
  markSent(reminderId) {
    this.db.prepare(`
      UPDATE schedule_reminders
      SET channel = 'sent', sent_at = datetime('now','localtime')
      WHERE id = ?
    `).run(reminderId);
  }

  /** 标记某个日程的所有待提醒为已发送 */
  markSentBySchedule(scheduleId) {
    this.db.prepare(`
      UPDATE schedule_reminders
      SET channel = 'sent', sent_at = datetime('now','localtime')
      WHERE schedule_id = ? AND channel = 'pending'
    `).run(scheduleId);
  }
}

module.exports = ReminderService;
