/**
 * 埠勤商贸 - 数据库初始化脚本
 * 用法: node scripts/init-db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function init() {
  const rootCfg = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  };

  console.log('正在连接 MariaDB...');

  // 1. 先创建数据库（如果不存在）
  const conn = await mysql.createConnection(rootCfg);
  await conn.execute(
    `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'buqin_business'}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  console.log(`数据库 '${process.env.DB_NAME}' 就绪`);
  await conn.end();

  // 2. 连接目标数据库并执行建表脚本
  const pool = mysql.createPool({
    ...rootCfg,
    database: process.env.DB_NAME || 'buqin_business',
    multipleStatements: true,
  });

  const sqlFile = path.join(__dirname, '..', 'sql', 'init.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');

  // 跳过 CREATE DATABASE 和 USE 语句（已经处理过）
  const statements = sql
    .replace(/CREATE DATABASE.*?;/gs, '')
    .replace(/USE `.*?`;/g, '')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await pool.execute(stmt);
    } catch (err) {
      if (!err.message.includes('already exists') && !err.message.includes('Duplicate')) {
        console.error('执行失败:', err.message);
        console.error('SQL:', stmt.slice(0, 100));
      }
    }
  }

  console.log('所有数据表创建完成！');
  await pool.end();
}

init().catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});
