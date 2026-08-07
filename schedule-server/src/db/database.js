/**
 * 数据库模块 - 基于 sql.js（纯 JS WebAssembly，无需 native 编译）
 * 对外暴露与 better-sqlite3 兼容的 API
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'schedules.db');

/**
 * 创建一个兼容 better-sqlite3 API 的数据库包装
 */
async function createDatabase() {
  const SQL = await initSqlJs();

  // 加载已有数据库或创建新的
  let sqlDb;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }

  // 将数据库持久化到磁盘
  function saveToDisk() {
    const data = sqlDb.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  // ========== Statement 包装类 ==========
  // 每次调用都创建新的 prepared statement，确保 sql.js 的正确语义
  class Stmt {
    constructor(sql) {
      this._sql = sql;
    }

    _prepareAndBind(params = []) {
      const stmt = sqlDb.prepare(this._sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      return stmt;
    }

    // ===== 兼容 better-sqlite3 API =====

    /** 执行写操作，返回 { changes, lastInsertRowid } */
    run(...params) {
      const stmt = this._prepareAndBind(params);
      // sql.js: step() 返回 false 时可能是正常结束也可能是错误
      // 用 getModifiedRows 前后对比判断是否真正执行成功
      const before = sqlDb.getRowsModified();
      while (stmt.step()) { /* consume */ }
      stmt.free();

      let changes = 0;
      let lastInsertRowid = 0;
      const after = sqlDb.getRowsModified();
      changes = after - before;
      if (changes > 0) {
        try {
          const info = sqlDb.exec('SELECT last_insert_rowid() as lid');
          if (info.length > 0 && info[0].values.length > 0) {
            lastInsertRowid = info[0].values[0][0];
          }
        } catch (e1) { /* ignore */ }
      }

      saveToDisk();
      return { changes, lastInsertRowid };
    }

    /** 获取单行 */
    get(...params) {
      const stmt = this._prepareAndBind(params);
      let row = undefined;
      if (stmt.step()) {
        row = stmt.getAsObject();
      }
      stmt.free();
      return row;
    }

    /** 获取所有行 */
    all(...params) {
      const stmt = this._prepareAndBind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    }
  }

  // ========== 主 db 对象（对外 API） ==========
  const db = {

    /** 创建 prepared statement */
    prepare(sql) {
      return new Stmt(sql);
    },

    /** 执行多条 SQL（如建表） */
    exec(sql) {
      sqlDb.exec(sql);
      saveToDisk();
    },

    /** 设置 pragma */
    pragma(key) {
      sqlDb.exec(`PRAGMA ${key}`);
      saveToDisk();
    },

    /** 事务包装 - 使用 sql.js 原生 run 避免 Stmt.saveToDisk 干扰 */
    transaction(fn) {
      return (...args) => {
        sqlDb.exec('BEGIN TRANSACTION');
        try {
          fn(...args);
          sqlDb.exec('COMMIT');
        } catch (e) {
          try { sqlDb.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ }
          throw e;
        }
      };
    },

    /** 关闭数据库 */
    close() {
      saveToDisk();
      sqlDb.close();
    },
  };

  // ===== 统一建表 =====
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      start_time TEXT NOT NULL,
      end_time TEXT DEFAULT '',
      type TEXT DEFAULT '日程',
      priority TEXT DEFAULT '中',
      person TEXT DEFAULT '',
      location TEXT DEFAULT '',
      reminder_minutes INTEGER DEFAULT 15,
      repeat_type TEXT DEFAULT 'none',
      status TEXT DEFAULT '待办',
      raw_text TEXT DEFAULT '',
      source_type TEXT DEFAULT 'text',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS reminders_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      reminded_at TEXT DEFAULT (datetime('now','localtime')),
      channel TEXT DEFAULT 'none',
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      minutes_before INTEGER NOT NULL DEFAULT 15,
      planned_time TEXT NOT NULL,
      channel TEXT DEFAULT 'pending',
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL,
      template_id TEXT NOT NULL,
      form_id TEXT,
      authorized_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      result_type TEXT,
      result_data TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS mp_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unionid TEXT NOT NULL UNIQUE,
      miniapp_openid TEXT NOT NULL,
      mp_openid TEXT,
      nickname TEXT DEFAULT '',
      subscribed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 【新增】草稿表 - 首页AI粗解析临时缓存，会话级临时数据
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL DEFAULT '',
      source_type TEXT DEFAULT 'text',
      raw_content TEXT DEFAULT '',
      raw_file_url TEXT DEFAULT '',
      parsed_title TEXT DEFAULT '',
      parsed_content TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    -- 草稿表字段升级（兼容已有数据库）
    -- 注意：sql.js(WASM) 不支持 ALTER TABLE ... ADD COLUMN IF NOT EXISTS 语法，
    -- 改用 JS 检测列是否存在后逐个添加
    `);

    // 动态添加 drafts 表缺失字段（兼容旧数据库）
    const draftColumns = db.prepare('PRAGMA table_info(drafts)').all().map(c => c.name);
    const draftAddColumns = [
      'start_time', 'end_time', 'deadline', 'location', 'person', 'amount', 'target_module', 'priority',
      'suggest_module', 'user_selected_module', 'apply_type',
    ];
    for (const col of draftAddColumns) {
      if (!draftColumns.includes(col)) {
        const def = col === 'target_module' || col === 'suggest_module' || col === 'user_selected_module' ? "'schedule'" : (col === 'priority' ? "'中'" : "''");
        db.exec(`ALTER TABLE drafts ADD COLUMN ${col} TEXT DEFAULT ${def}`);
      }
    }
    db.exec(`

    -- 【新增】每日记录表 - 正式归档记录，长期持久存储
    CREATE TABLE IF NOT EXISTS daily_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL DEFAULT '',
      draft_id INTEGER NULL,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      attachments TEXT DEFAULT '[]',
      record_date TEXT DEFAULT (datetime('now','localtime')),
      target_module TEXT DEFAULT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 【新增】任务表
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL DEFAULT '',
      draft_id INTEGER NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      priority TEXT DEFAULT '中',
      due_date TEXT DEFAULT '',
      status TEXT DEFAULT '待办',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 【新增】灵感表
    CREATE TABLE IF NOT EXISTS inspirations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL DEFAULT '',
      draft_id INTEGER NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 【新增】申请表
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL DEFAULT '',
      draft_id INTEGER NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      applicant TEXT DEFAULT '',
      status TEXT DEFAULT '待审批',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 【新增】报销表
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL DEFAULT '',
      draft_id INTEGER NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      amount TEXT DEFAULT '',
      category TEXT DEFAULT '其他',
      expense_date TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 【新增】用户表（含角色和上下级关系 + 密码登录）
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
      manager_id TEXT DEFAULT NULL,
      department TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
    CREATE INDEX IF NOT EXISTS idx_schedules_start_time ON schedules(start_time);
    CREATE INDEX IF NOT EXISTS idx_schedules_type ON schedules(type);
    CREATE INDEX IF NOT EXISTS idx_schedule_reminders_planned_time ON schedule_reminders(planned_time);
    CREATE INDEX IF NOT EXISTS idx_schedule_reminders_channel ON schedule_reminders(channel);
    CREATE INDEX IF NOT EXISTS idx_chat_history_openid ON chat_history(openid);
    CREATE INDEX IF NOT EXISTS idx_chat_history_created ON chat_history(created_at);
    CREATE INDEX IF NOT EXISTS idx_mp_users_unionid ON mp_users(unionid);
    CREATE INDEX IF NOT EXISTS idx_mp_users_miniapp_openid ON mp_users(miniapp_openid);

    -- 【新增】drafts 表索引
    CREATE INDEX IF NOT EXISTS idx_drafts_openid ON drafts(openid);
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_created ON drafts(created_at);

    -- 【新增】daily_records 表索引
    CREATE INDEX IF NOT EXISTS idx_daily_records_openid ON daily_records(openid);
    CREATE INDEX IF NOT EXISTS idx_daily_records_record_date ON daily_records(record_date);
    CREATE INDEX IF NOT EXISTS idx_daily_records_target_module ON daily_records(target_module);
    CREATE INDEX IF NOT EXISTS idx_daily_records_draft_id ON daily_records(draft_id);

    -- 【新增】模块表索引
    CREATE INDEX IF NOT EXISTS idx_tasks_openid ON tasks(openid);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_inspirations_openid ON inspirations(openid);
    CREATE INDEX IF NOT EXISTS idx_applications_openid ON applications(openid);
    CREATE INDEX IF NOT EXISTS idx_expenses_openid ON expenses(openid);
  `);

  // 兼容旧表：添加 source_type 字段
  try {
    db.prepare("ALTER TABLE schedules ADD COLUMN source_type TEXT DEFAULT 'text'").run();
  } catch (e) {
    // 字段已存在
  }

  // 【阶段3】daily_records 添加 ai_analysis 字段（存储AI高级分析JSON结果）
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN ai_analysis TEXT DEFAULT ''").run();
  } catch (e) {
    // 字段已存在
  }

  // 兼容旧表：添加 openid 字段（用于精确推送给创建者）
  try {
    db.prepare("ALTER TABLE schedules ADD COLUMN openid TEXT DEFAULT ''").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_schedules_openid ON schedules(openid)").run();
  } catch (e) {
    // 字段已存在
  }

  // 【阶段6】daily_records 添加分发追踪字段
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN distributed_module TEXT DEFAULT NULL").run();
  } catch (e) { /* 字段已存在 */ }
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN distributed_at TEXT DEFAULT NULL").run();
  } catch (e) { /* 字段已存在 */ }
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN distributed_schedule_id INTEGER NULL").run();
  } catch (e) { /* 字段已存在 */ }
  // 草稿关联字段：存入时从 drafts 表同步
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN priority TEXT DEFAULT '中'").run();
  } catch (e) { /* 字段已存在 */ }
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN location TEXT DEFAULT ''").run();
  } catch (e) { /* 字段已存在 */ }
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN person TEXT DEFAULT ''").run();
  } catch (e) { /* 字段已存在 */ }
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN start_time TEXT DEFAULT ''").run();
  } catch (e) { /* 字段已存在 */ }
  try {
    db.prepare("ALTER TABLE daily_records ADD COLUMN end_time TEXT DEFAULT ''").run();
  } catch (e) { /* 字段已存在 */ }

  // 兼容：chat_history 添加 session_id 字段（会话分组）
  try {
    db.prepare("ALTER TABLE chat_history ADD COLUMN session_id TEXT DEFAULT ''").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_id)").run();
  } catch (e) {
    // 字段已存在
  }

  // ===== 审批流程升级：applications 表追加审批字段 =====
  try { db.prepare("ALTER TABLE applications ADD COLUMN expected_time TEXT DEFAULT ''").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("ALTER TABLE applications ADD COLUMN approve_user_id TEXT DEFAULT ''").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("ALTER TABLE applications ADD COLUMN approve_comment TEXT DEFAULT ''").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("ALTER TABLE applications ADD COLUMN approve_time TEXT DEFAULT ''").run(); } catch (e) { /* 已存在 */ }

  // ===== 审批流程升级：expenses 表追加审批字段 =====
  try { db.prepare("ALTER TABLE expenses ADD COLUMN approve_user_id TEXT DEFAULT ''").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("ALTER TABLE expenses ADD COLUMN approve_comment TEXT DEFAULT ''").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("ALTER TABLE expenses ADD COLUMN approve_time TEXT DEFAULT ''").run(); } catch (e) { /* 已存在 */ }

  // ===== 创建用户表索引 =====
  try { db.prepare("CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id)").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)").run(); } catch (e) { /* 已存在 */ }

  // ===== 密码登录升级：users 表追加 username + password_hash =====
  try { db.prepare("ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* 已存在 */ }
  // try { db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)").run(); } catch (e) { /* 已存在 */ }
try { db.prepare("DROP INDEX IF EXISTS idx_users_username").run(); } catch (e) { /* 索引不存在 */ }
  // ===== 阶段1 身份准入 =====
  try { db.prepare("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("ALTER TABLE users ADD COLUMN is_boss INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)").run(); } catch (e) { /* 已存在 */ }
  try { db.prepare("CREATE INDEX IF NOT EXISTS idx_users_is_boss ON users(is_boss)").run(); } catch (e) { /* 已存在 */ }

  // 修复历史提醒时间
  function parseLocalDateTime(str) {
    const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const d = new Date(0);
    d.setFullYear(parseInt(m[1], 10));
    d.setMonth(parseInt(m[2], 10) - 1);
    d.setDate(parseInt(m[3], 10));
    d.setHours(parseInt(m[4], 10));
    d.setMinutes(parseInt(m[5], 10));
    d.setSeconds(parseInt(m[6], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  function formatLocalDateTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  try {
    const rows = db.prepare(`
      SELECT r.id, r.minutes_before, s.start_time, r.planned_time
      FROM schedule_reminders r
      JOIN schedules s ON s.id = r.schedule_id
      WHERE r.channel IN ('scheduled', 'pending')
    `).all();
    const update = db.prepare('UPDATE schedule_reminders SET planned_time = ? WHERE id = ?');
    let fixed = 0;
    for (const row of rows) {
      const start = parseLocalDateTime(row.start_time);
      if (!start) continue;
      const planned = new Date(start.getTime() - row.minutes_before * 60 * 1000);
      const plannedStr = formatLocalDateTime(planned);
      if (plannedStr !== row.planned_time) {
        update.run(plannedStr, row.id);
        fixed++;
      }
    }
    if (fixed > 0) console.log(`[数据库] 已修复 ${fixed} 条提醒 planned_time`);
  } catch (e) {
    console.error('[数据库] 修复提醒时间失败:', e.message);
  }

  return db;
}

// 导出 Promise，调用方 await 后获得 db 对象
module.exports = createDatabase();
