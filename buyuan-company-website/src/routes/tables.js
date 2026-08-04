/**
 * 埠勤商贸 - 表格 CRUD 路由
 * 9 张业务表的完整 RESTful API
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');

// 所有业务表名列表
const ALL_TABLES = [
  '销售表_2022', '销售表_2023', '销售表_2024', '销售表_2025-1', '销售表_2025-2', '销售表_2025-3',
  '销售表_2025-4', '销售表_2025-5', '销售表_2025-6', '销售表_2025-7', '销售表_2025-8', '销售表_2025-9',
  '销售表_2025-10', '销售表_2025-11', '销售表_2025-12', '销售表_2026-1', '销售表_2026-2', '销售表_2026-3',
  '销售表_2026-4', '销售表_2026-5', '销售表_2026-6', '销售表_2026-7', '销售表_2026-8', '销售表_2026-9',
  '销售表_2026-10', '销售表_2026-11', '销售表_2026-12', '得力', '特殊订单汇总表', '未下单统计表', '采购成本表_2023', '采购成本表_2024', '采购成本表_2025', '收款表',
  '采购成本表',
  '费用表', '利润表', '每日流水', '承包确认单', '客户统计表', '平台结算折扣率',
];

// 辅助：更新版本号
async function bumpVersion(tableName) {
  await pool.execute(
    `INSERT INTO table_meta (table_name, version) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE version = version + 1`,
    [tableName]
  );
}

// ==================== GET /api/tables — 获取所有表 ====================
router.get('/', async (req, res) => {
  try {
    const result = {};
    for (const tableName of ALL_TABLES) {
      const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` ORDER BY id`);
      const [meta] = await pool.query(
        `SELECT version FROM table_meta WHERE table_name = ?`, [tableName]
      );
      result[tableName] = {
        headers: rows.length > 0 ? Object.keys(rows[0]).filter(k => k !== '_idx' && k !== 'id' && k !== 'created_at' && k !== 'updated_at') : [],
        rows: rows.map(r => {
          const { created_at, updated_at, ...data } = r;
          return data;
        }),
        row_count: rows.length,
        version: meta.length > 0 ? meta[0].version : 0,
      };
    }
    res.json(result);
  } catch (err) {
    console.error('[GET /tables]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== GET /api/tables/versions — 获取所有表版本号 ====================
router.get('/versions', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT table_name, version FROM table_meta`);
    const versions = {};
    rows.forEach(r => { versions[r.table_name] = r.version; });
    // 确保所有表都有版本号
    ALL_TABLES.forEach(t => {
      if (!(t in versions)) versions[t] = 0;
    });
    res.json(versions);
  } catch (err) {
    console.error('[GET /versions]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== GET /api/tables/:tableName — 获取单表数据 ====================

// ==================== GET /api/tables/version — 版本号（必须在 /:tableName 之前）====================
router.get("/version", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT table_name, version FROM table_meta");
    const versions = {};
    rows.forEach(function(r) { versions[r.table_name] = r.version; });
    ALL_TABLES.forEach(function(t) { if (!(t in versions)) versions[t] = 0; });
    res.json(versions);
  } catch(e) { res.json({}); }
});

router.get('/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    if (!ALL_TABLES.includes(tableName)) {
      return res.status(404).json({ error: `表 "${tableName}" 不存在` });
    }

    const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` ORDER BY id`);
    const [meta] = await pool.query(
      `SELECT version FROM table_meta WHERE table_name = ?`, [tableName]
    );

    res.json({
      table_name: tableName,
      headers: rows.length > 0 ? Object.keys(rows[0]).filter(k => k !== '_idx' && k !== 'id' && k !== 'created_at' && k !== 'updated_at') : [],
      rows: rows.map(r => {
        const { created_at, updated_at, ...data } = r;
        return { _id: id, ...data };
      }),
      row_count: rows.length,
      version: meta.length > 0 ? meta[0].version : 0,
    });
  } catch (err) {
    console.error(`[GET /tables/${req.params.tableName}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== POST /api/tables/:tableName — 新增一行 ====================
router.post('/:tableName', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { tableName } = req.params;
    const rowData = req.body;

    if (!ALL_TABLES.includes(tableName)) {
      return res.status(404).json({ error: `表 "${tableName}" 不存在` });
    }
    if (!rowData || Object.keys(rowData).length === 0) {
      return res.status(400).json({ error: '行数据不能为空' });
    }

    const columns = Object.keys(rowData).filter(k => k !== '_id' && k !== '_idx');
    if (columns.length === 0) {
      return res.status(400).json({ error: '没有有效的数据列' });
    }

    // 检查编号是否重复
    if (columns.includes('编号')) {
      const bianhao = String(rowData['编号'] || '').trim();
      if (bianhao) {
        const [existing] = await conn.execute(
          `SELECT id FROM \`${tableName}\` WHERE \`编号\` = ? LIMIT 1`,
          [bianhao]
        );
        if (existing.length > 0) {
          return res.status(409).json({ error: `编号 "${bianhao}" 已存在，不可重复插入` });
        }
      }
    }

    const placeholders = columns.map(() => '?').join(', ');
    const colNames = columns.map(c => `\`${c}\``).join(', ');
    const values = columns.map(c => rowData[c] ?? '');

    const sql = `INSERT INTO \`${tableName}\` (${colNames}) VALUES (${placeholders})`;
    await conn.execute(sql, values);
    await bumpVersion(tableName);

    const [insertId] = await conn.query('SELECT LAST_INSERT_ID() as id');
    const newId = insertId[0].id;

    res.status(201).json({
      ok: true,
      id: newId,
      message: '新增成功',
    });
  } catch (err) {
    console.error(`[POST /tables/${req.params.tableName}]`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ==================== PUT /api/tables/:tableName/:id — 更新一行 ====================
router.put('/:tableName/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { tableName, id } = req.params;
    const rowData = req.body;

    if (!ALL_TABLES.includes(tableName)) {
      return res.status(404).json({ error: `表 "${tableName}" 不存在` });
    }

    const columns = Object.keys(rowData).filter(k => k !== '_id' && k !== '_idx' && k !== 'id' && k !== 'created_at' && k !== 'updated_at');
    if (columns.length === 0) {
      return res.status(400).json({ error: '没有需要更新的列' });
    }

    const setClauses = columns.map(c => `\`${c}\` = ?`).join(', ');
    const values = columns.map(c => rowData[c] ?? '');

    const sql = `UPDATE \`${tableName}\` SET ${setClauses} WHERE id = ?`;
    const [result] = await conn.execute(sql, [...values, parseInt(id)]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }

    await bumpVersion(tableName);

    res.json({ ok: true, message: '更新成功' });
  } catch (err) {
    console.error(`[PUT /tables/${req.params.tableName}]`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ==================== DELETE /api/tables/:tableName/:id — 删除一行 ====================
router.delete('/:tableName/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { tableName, id } = req.params;

    if (!ALL_TABLES.includes(tableName)) {
      return res.status(404).json({ error: `表 "${tableName}" 不存在` });
    }

    const [result] = await conn.execute(
      `DELETE FROM \`${tableName}\` WHERE id = ?`, [parseInt(id)]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }

    await bumpVersion(tableName);

    res.json({ ok: true, message: '删除成功' });
  } catch (err) {
    console.error(`[DELETE /tables/${req.params.tableName}]`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ==================== POST /api/tables/:tableName/batch-delete — 批量删除 ====================
router.post('/:tableName/batch-delete', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { tableName } = req.params;
    const { ids } = req.body;

    if (!ALL_TABLES.includes(tableName)) {
      return res.status(404).json({ error: `表 "${tableName}" 不存在` });
    }
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids 数组不能为空' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const [result] = await conn.execute(
      `DELETE FROM \`${tableName}\` WHERE id IN (${placeholders})`,
      ids.map(id => parseInt(id))
    );

    await bumpVersion(tableName);

    res.json({
      ok: true,
      deleted: result.affectedRows,
      message: `成功删除 ${result.affectedRows} 行`,
    });
  } catch (err) {
    console.error(`[batch-delete ${req.params.tableName}]`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ==================== POST /api/tables/:tableName/sync — 全量同步 ====================

router.post('/:tableName/sync', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { tableName } = req.params;
    const { rows, oldBianhao } = req.body;

    if (!ALL_TABLES.includes(tableName)) {
      return res.status(404).json({ error: `表 "${tableName}" 不存在` });
    }
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows 必须是数组' });
    }

    // 全量替换：删除所有行 → 批量插入
    // 编辑同步：按旧编号定位更新，不删全表
    if (oldBianhao && rows.length === 1) {
      const record = rows[0];
      const newBianhao = String(record['编号'] || '').trim();
      // 如果编号改了，检查新编号是否与其他记录冲突
      if (newBianhao && newBianhao !== String(oldBianhao).trim()) {
        const [dup] = await conn.execute(
          `SELECT id FROM \`${tableName}\` WHERE \`编号\` = ? AND \`编号\` != ? LIMIT 1`,
          [newBianhao, oldBianhao]
        );
        if (dup.length > 0) {
          return res.status(409).json({ error: `编号 "${newBianhao}" 已存在，不可重复插入` });
        }
      }
      const keys = Object.keys(record).filter(k => k !== "_id" && k !== "_idx");
      const setParts = keys.map(k => `\`${k}\` = ?`).join(", ");
      const values = keys.map(k => record[k] ?? "");
      const [result] = await conn.execute(
        `UPDATE \`${tableName}\` SET ${setParts} WHERE \`编号\` = ?`,
        [...values, oldBianhao]
      );
      await bumpVersion(tableName);
      return res.json({ ok: true, updated: result.affectedRows, message: "更新成功" });
    }

    await conn.beginTransaction();

    await conn.execute(`DELETE FROM \`${tableName}\``);

    if (rows.length > 0) {
      // 取第一行确定列名
      const keys = Object.keys(rows[0]).filter(k => k !== '_id' && k !== '_idx');
      const colNames = keys.map(k => `\`${k}\``).join(', ');
      const placeholders = keys.map(() => '?').join(', ');

      const sql = `INSERT INTO \`${tableName}\` (${colNames}) VALUES (${placeholders})`;

      for (const row of rows) {
        const values = keys.map(k => row[k] ?? '');
        await conn.execute(sql, values);
      }
    }

    await bumpVersion(tableName);
    await conn.commit();

    res.json({ ok: true, count: rows.length, message: '同步成功' });
  } catch (err) {
    await conn.rollback();
    console.error(`[sync ${req.params.tableName}]`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// === 兼容端点 ===
router.post("/:tableName/rows/delete", async (req, res) => {
  try {
    const { bianhaos } = req.body;
    if (!bianhaos || !bianhaos.length) return res.status(400).json({ error: "missing bianhaos" });
    const ph = bianhaos.map(() => "?").join(",");
    const sql = "DELETE FROM `" + req.params.tableName + "` WHERE `编号` IN (" + ph + ")";
    const [r] = await pool.query(sql, bianhaos);
    await bumpVersion(req.params.tableName);
    res.json({ success: true, deleted: r.affectedRows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== POST /api/tables/:tableName/import ====================
router.post("/:tableName/import", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { tableName } = req.params;
    const { rows } = req.body;

    if (!ALL_TABLES.includes(tableName)) {
      return res.status(404).json({ error: "table not found" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "no data" });
    }

    // Read actual DB columns
    const [dbCols] = await conn.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME NOT IN ('id','created_at','updated_at') ORDER BY ORDINAL_POSITION",
      [tableName]
    );
    const valid = new Set(dbCols.map(c => c.COLUMN_NAME));
    const colTypes = {}; dbCols.forEach(c => { colTypes[c.COLUMN_NAME] = c.DATA_TYPE; });
    if (valid.size === 0) {
      return res.status(500).json({ error: "cannot get columns" });
    }

    // Find matching columns from import data
    const keySet = new Set();
    for (const row of rows) {
      Object.keys(row).forEach(k => { if (valid.has(k)) keySet.add(k); });
    }
    const keys = Array.from(keySet);
    if (keys.length === 0) {
      const dbNames = Array.from(valid).join(", ");
      return res.status(400).json({ error: "no matching columns. DB columns: " + dbNames });
    }

    await conn.beginTransaction();

    // For 编号: ignore uploaded values, auto-increment instead
    const hasBianhao = keys.includes("编号");

    // Get current max 编号 from DB
    let currentMaxNum = 0;
    if (hasBianhao) {
      try {
        const [maxResult] = await conn.query(
          "SELECT MAX(CAST(\`编号\` AS UNSIGNED)) as m FROM " + conn.escapeId(tableName) + " WHERE \`编号\` REGEXP '^[0-9]+$'"
        );
        if (maxResult[0] && maxResult[0].m !== null) {
          currentMaxNum = parseInt(maxResult[0].m, 10);
        }
      } catch (e) { /* fallback */ }
    }

    // Build INSERT SQL
    const escapedCols = keys.map(k => conn.escapeId(k)).join(", ");
    const qmarks = keys.map(() => "?").join(", ");
    const insSql = "INSERT INTO " + conn.escapeId(tableName) + " (" + escapedCols + ") VALUES (" + qmarks + ")";

    let inserted = 0, updated = 0, failed = 0;
    const errs = [];

    for (let i = 0; i < rows.length; i++) {
      const row = { ...rows[i] };
      try {
        // Auto-increment 编号, ignore uploaded value
        if (hasBianhao) {
          currentMaxNum += 1;
          row["编号"] = String(currentMaxNum);
        }
        const vals = keys.map(k => { var v = (row[k] !== undefined && row[k] !== null) ? row[k] : ''; if (v === '' && ['decimal','int','float','double','tinyint','smallint','mediumint','bigint','numeric'].includes(colTypes[k])) v = 0; return v; });
        await conn.execute(insSql, vals);
        inserted++;
      } catch (rowErr) {
        failed++;
        if (errs.length < 5) errs.push("row " + (i + 1) + ": " + rowErr.message);
      }
    }

    await bumpVersion(tableName);
    await conn.commit();

    let allRows = [], allHeaders = [];
    try {
      allHeaders = dbCols.map(c => c.COLUMN_NAME);
      const [fetched] = await conn.query("SELECT * FROM " + conn.escapeId(tableName) + " ORDER BY id ASC");
      allRows = fetched;
    } catch (e) {
      console.log("[import] fetch after import failed: " + e.message);
    }

    const result = { success: true, inserted, failed, headers: allHeaders, rows: allRows };
    result.message = "inserted " + inserted + " rows" + (failed > 0 ? ", " + failed + " failed" : "");
    if (errs.length > 0) result.errors = errs;
    res.json(result);


  } catch (err) {
    await conn.rollback();
    console.error("[import " + req.params.tableName + "]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
