/**
 * 初始化用户表 & 创建/更新管理员账号
 * 路径: scripts/init-users.js
 *
 * 使用方式: node scripts/init-users.js
 * 读取 .env 中的 ADMIN_USERNAME 和 ADMIN_PASSWORD
 *
 * 功能:
 *   - 自动创建 users 表（如果不存在）
 *   - 自动创建 admin 账号（如果不存在）
 *   - 自动更新 admin 密码（如果 .env 中密码已变更）
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wzz123@#';

async function init() {
  const conn = await pool.getConnection();
  try {
    console.log('========================================');
    console.log('  埠勤商贸 - 用户初始化脚本 v2.0');
    console.log('========================================\n');

    // 1. 建表
    console.log('[1/3] 创建 users 表...');
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME NULL,
        is_active TINYINT(1) DEFAULT 1,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('  [OK] users 表已就绪');

    // 2. 生成密码 hash
    console.log('\n[2/3] 生成密码 hash (cost=12)...');
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    console.log('  [OK] hash 已生成');

    // 3. 创建或更新 admin
    console.log('\n[3/3] 处理管理员账号...');
    const [rows] = await conn.execute(
      'SELECT id, username, password_hash FROM users WHERE username = ?',
      [ADMIN_USERNAME]
    );

    if (rows.length === 0) {
      await conn.execute(
        'INSERT INTO users (username, password_hash, is_active) VALUES (?, ?, 1)',
        [ADMIN_USERNAME, hash]
      );
      console.log('  [OK] admin 账号已创建');
      console.log('  - 用户名: ' + ADMIN_USERNAME);
      console.log('  - 密码:   (来自 .env 配置)');
    } else {
      const currentHash = rows[0].password_hash;
      const match = await bcrypt.compare(ADMIN_PASSWORD, currentHash);
      if (!match) {
        await conn.execute(
          'UPDATE users SET password_hash = ? WHERE username = ?',
          [hash, ADMIN_USERNAME]
        );
        console.log('  [OK] admin 密码已更新（与 .env 同步）');
      } else {
        console.log('  [OK] admin 账号无需变更（密码一致）');
      }
      console.log('  - 用户名: ' + ADMIN_USERNAME);
      console.log('  - 创建时间: ' + (rows[0].created_at || 'N/A'));
    }

    console.log('\n========================================');
    console.log('  初始化完成!');
    console.log('========================================');
  } catch (err) {
    console.error('\n[ERROR] 初始化失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

init();
