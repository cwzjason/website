/**
 * 埠勤商贸 - MariaDB 连接池模块
 *
 * 【数据存储铁律】所有业务数据只允许存入 MariaDB 数据库，严禁使用：
 *   - SQLite / 文件数据库
 *   - MySQL（本服务器未安装）
 *   - 本地 JSON 文件
 *   - localStorage / 浏览器存储
 * 全站唯一数据出口：本模块 -> MariaDB 10.11
 *
 * 使用 mysql2/promise 实现连接池管理
 */
const mysql = require('mysql2/promise');
const crypto = require('crypto');
require('dotenv').config();

const pool = mysql.createPool({
  host:            process.env.DB_HOST || '127.0.0.1',
  port:            parseInt(process.env.DB_PORT || '3306', 10),
  user:            process.env.DB_USER || 'root',
  password:        process.env.DB_PASSWORD || '',
  database:        process.env.DB_NAME || 'buqin_business',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '20', 10),
  queueLimit:      0,
  charset:         'utf8mb4',
});

// 测试连接
pool.getConnection()
  .then(conn => {
    console.log('[DB] MariaDB 连接池已就绪');
    conn.release();
  })
  .catch(err => {
    console.error('[DB] 连接失败:', err.message);
  });


/**
 * 验证数据存储铁律修改密码
 * 使用 crypto.timingSafeEqual 恒定时间比对，防止时序攻击
 * 密码从环境变量 DB_RULE_PASSWORD 读取，不硬编码在任何代码中
 */
function verifyRuleChange(password) {
  const expected = process.env.DB_RULE_PASSWORD;
  if (!expected) {
    throw new Error('DB_RULE_PASSWORD 环境变量未配置');
  }
  const input = String(password || '');
  const bufA = Buffer.from(input);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length) {
    // 长度不同仍进行恒定时间比对，防止长度信息泄露
    crypto.timingSafeEqual(Buffer.alloc(bufB.length, 0), bufB);
    throw new Error('密码验证失败');
  }
  if (!crypto.timingSafeEqual(bufA, bufB)) {
    throw new Error('密码验证失败');
  }
  return true;
}

module.exports = pool;
module.exports.verifyRuleChange = verifyRuleChange;
