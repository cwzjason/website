/**
 * 埠勤商贸 - 批量图片导入路由
 *
 * 流程：
 *   1. 下载 SKU 模板 → 填入 SKU 编码（≤50个）
 *   2. 上传模板 → 创建导入任务（session）
 *   3. 上传图片 → 按文件名 {SKU}01{XX}.jpg 匹配 SKU
 *   4. 核对匹配结果 → 结束上传，绑定图片到商品
 *
 * 图片命名规则：
 *   - 主图:    {SKU}01{序号}.扩展名  例: 1520559990101.jpg
 *   - 详情图:  {SKU}02{序号}.扩展名  例: 1520559990201.jpg
 *   - 备案截图: {SKU}03{序号}.扩展名
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const db = require('../db');

// --------------- 上传目录 ---------------
const UPLOAD_BASE = path.join(__dirname, '..', '..', 'uploads', 'products');
const SESSION_BASE = path.join(__dirname, '..', '..', 'uploads', 'batch_sessions');
fs.mkdirSync(UPLOAD_BASE, { recursive: true });
fs.mkdirSync(SESSION_BASE, { recursive: true });

// --------------- Multer 配置 ---------------
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) cb(null, true);
    else cb(new Error('仅支持 .xlsx / .xls / .csv 文件'));
  },
});

const imageUpload = multer({
  limits: { fileSize: 50 * 1024 * 1024, files: 2000 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) cb(null, true);
    else cb(new Error('仅支持 jpg/jpeg/png/webp/gif 图片'));
  },
});

// --------------- 图片匹配正则 ---------------
// 文件名: {SKU}01{XX}.ext 或 {SKU}02{XX}.ext 或 {SKU}03{XX}.ext
// 从末尾匹配：图片类型码01/02/03 + 2位序号 + 扩展名（4位整体匹配避免SKU末尾数字混淆）
const IMAGE_PATTERN = /^(.+?)(0[123]\d{2})\.(jpg|jpeg|png|webp|gif)$/i;

const TYPE_MAP = { '01': 'main', '02': 'detail', '03': 'screenshot' };
const TYPE_LABELS = { main: '主图', detail: '详情图', screenshot: '备案截图' };

// --------------- 辅助函数 ---------------
function parseImageFilename(filename) {
  const m = filename.match(IMAGE_PATTERN);
  if (!m) return null;
  // m[1] = SKU编码, m[2] = 类型码(2位)+序号(2位)=4位, m[3] = 扩展名
  const typeAndSeq = m[2];           // 如 "0101", "0203"
  const typeCode = typeAndSeq.substring(0, 2);  // "01"
  const seq = parseInt(typeAndSeq.substring(2), 10); // 1
  const skuCode = m[1];
  const ext = '.' + m[3].toLowerCase();
  return { skuCode, typeCode, imgType: TYPE_MAP[typeCode] || 'unknown', seq, ext };
}

/**
 * 多字段匹配产品：product_code → cr_sku → barcode → 模糊缩短
 * 当多个产品匹配时，返回 ID 最大的（最新创建的）
 */
function resolveSkuCode(candidateSku) {
  if (!candidateSku) return null;
  const sku = String(candidateSku).trim();

  // 1. 直接匹配 product_code（取最新）
  let row = db.prepare('SELECT id, name, product_code FROM products WHERE product_code = ? ORDER BY id DESC LIMIT 1').get(sku);
  if (row) return row;

  // 2. 直接匹配 cr_sku（取最新）
  row = db.prepare('SELECT id, name, product_code FROM products WHERE cr_sku = ? ORDER BY id DESC LIMIT 1').get(sku);
  if (row) return row;

  // 3. 匹配 barcode（条码，取最新）
  row = db.prepare('SELECT id, name, product_code FROM products WHERE barcode = ? ORDER BY id DESC LIMIT 1').get(sku);
  if (row) return row;

  // 4. 匹配 sub_category_code（小类分类编码，取最新）
  row = db.prepare('SELECT id, name, product_code FROM products WHERE sub_category_code = ? ORDER BY id DESC LIMIT 1').get(sku);
  if (row) return row;

  // 5. 模糊匹配：product_code LIKE（取最新）
  row = db.prepare('SELECT id, name, product_code FROM products WHERE product_code LIKE ? ORDER BY id DESC LIMIT 1').get(`%${sku}%`);
  if (row) return row;

  // 6. 尝试去掉末尾1位数字（解决 SKU 末尾数字与类型码混淆问题）
  if (sku.length > 4 && /\d$/.test(sku)) {
    const shorter = sku.slice(0, -1);
    row = db.prepare('SELECT id, name, product_code FROM products WHERE product_code = ? ORDER BY id DESC LIMIT 1').get(shorter);
    if (row) return row;
    row = db.prepare('SELECT id, name, product_code FROM products WHERE cr_sku = ? ORDER BY id DESC LIMIT 1').get(shorter);
    if (row) return row;
    row = db.prepare('SELECT id, name, product_code FROM products WHERE barcode = ? ORDER BY id DESC LIMIT 1').get(shorter);
    if (row) return row;
  }

  return null;
}

// --------------- 1. 下载 SKU 模板 ---------------
router.get('/template', (_req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['序号', 'SKU编码']]);

  // 预留50行
  for (let i = 1; i <= 50; i++) {
    XLSX.utils.sheet_add_aoa(ws, [[i, '']], { origin: `A${i + 1}` });
  }

  ws['!cols'] = [{ wch: 8 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'SKU列表');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="SKU_template.xlsx"; filename*=UTF-8\'\'SKU%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx');
  res.send(buf);
});

// --------------- 2. 创建导入任务 ---------------
router.post('/sessions', excelUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传 SKU 模板文件' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    // 提取 SKU 编码（同时兼容 "SKU编码" 和 "sku" 等各种列名）
    const skus = [];
    for (const r of rows) {
      const skuKey = Object.keys(r).find(k =>
        /sku|编码|code/i.test(k)
      ) || Object.keys(r)[1]; // 第二列通常是 SKU 编码
      const sku = String(r[skuKey] || '').trim();
      if (sku && sku !== 'SKU编码' && sku !== 'sku') {
        skus.push(sku);
      }
    }

    if (skus.length === 0) {
      return res.status(400).json({ success: false, error: '模板中未找到有效 SKU 编码' });
    }

    if (skus.length > 100) {
      return res.status(400).json({ success: false, error: `单次最多导入100个SKU，当前${skus.length}个` });
    }

    // 创建 session
    const name = req.body.name || `批量导入_${new Date().toLocaleString('zh-CN')}`;
    const sessionResult = db.prepare(
      'INSERT INTO batch_image_sessions (name, sku_count, status) VALUES (?, ?, ?)'
    ).run(name, skus.length, 'pending');

    const sessionId = sessionResult.lastInsertRowid;

    // 创建 session 图片目录
    const sessionDir = path.join(SESSION_BASE, String(sessionId));
    fs.mkdirSync(sessionDir, { recursive: true });

    // 插入 SKU 记录并尝试匹配现有商品
    const insertSku = db.prepare(
      `INSERT INTO batch_image_session_skus (session_id, sku_code, seq, product_id, product_name, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    let matchedCount = 0;
    skus.forEach((sku, idx) => {
      const product = resolveSkuCode(sku);

      if (product) {
        insertSku.run(sessionId, sku, idx + 1, product.id, product.name, 'pending');
        matchedCount++;
      } else {
        insertSku.run(sessionId, sku, idx + 1, null, '', 'unmatched');
      }
    });

    console.log(`[BatchImg] 任务 #${sessionId} 创建: ${skus.length} 个SKU, 已匹配 ${matchedCount} 个商品`);

    res.json({
      success: true,
      data: {
        id: sessionId,
        name,
        skuCount: skus.length,
        matchedCount,
        unmatchedCount: skus.length - matchedCount,
        status: 'pending',
      },
    });
  } catch (err) {
    console.error('[BatchImg] 创建任务失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------- 3. 任务列表 ---------------
router.get('/sessions', (_req, res) => {
  try {
    const sessions = db.prepare(`
      SELECT * FROM batch_image_sessions
      WHERE status != 'cancelled'
      ORDER BY created_at DESC
      LIMIT 50
    `).all();

    // 为每个 session 统计 SKU 状态
    const results = sessions.map(s => {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) as matched,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial,
          SUM(CASE WHEN status = 'unmatched' THEN 1 ELSE 0 END) as unmatched,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(main_count) as total_main,
          SUM(detail_count) as total_detail,
          SUM(screenshot_count) as total_screenshot
        FROM batch_image_session_skus WHERE session_id = ?
      `).get(s.id);
      return { ...s, stats };
    });

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------- 4. 任务详情 ---------------
router.get('/sessions/:id', (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM batch_image_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: '任务不存在' });

    const skus = db.prepare(`
      SELECT * FROM batch_image_session_skus WHERE session_id = ? ORDER BY seq
    `).all(req.params.id);

    const stats = {
      total: skus.length,
      matched: skus.filter(s => s.status === 'matched').length,
      partial: skus.filter(s => s.status === 'partial').length,
      unmatched: skus.filter(s => s.status === 'unmatched' || s.status === 'pending').length,
      totalMain: skus.reduce((sum, s) => sum + (s.main_count || 0), 0),
      totalDetail: skus.reduce((sum, s) => sum + (s.detail_count || 0), 0),
      totalScreenshot: skus.reduce((sum, s) => sum + (s.screenshot_count || 0), 0),
    };

    // 列出 session 目录下的图片文件
    const sessionDir = path.join(SESSION_BASE, String(session.id));
    let imageFiles = [];
    if (fs.existsSync(sessionDir)) {
      imageFiles = fs.readdirSync(sessionDir)
        .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
        .map(f => {
          const parsed = parseImageFilename(f);
          return {
            filename: f,
            parsed,
            size: fs.statSync(path.join(sessionDir, f)).size,
          };
        });
    }

    res.json({
      success: true,
      data: { session, skus, stats, imageFiles, imageCount: imageFiles.length },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------- 5. 上传图片 ---------------
router.post('/sessions/:id/upload', (req, res) => {
  // 使用自定义 multer 处理，支持大量文件
  const handleUpload = imageUpload.array('images', 2000);
  handleUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    processUpload(req, res);
  });
});

function processUpload(req, res) {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const session = db.prepare('SELECT * FROM batch_image_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ success: false, error: '任务不存在' });
    if (session.status === 'completed') {
      return res.status(400).json({ success: false, error: '任务已完成，无法继续上传' });
    }

    // 更新任务状态为 uploading
    db.prepare('UPDATE batch_image_sessions SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run('uploading', sessionId);

    const files = req.files || [];
    const sessionDir = path.join(SESSION_BASE, String(sessionId));

    if (files.length === 0) {
      return res.status(400).json({ success: false, error: '没有接收到图片文件' });
    }

    const results = {
      total: files.length,
      matched: 0,
      unmatched: 0,
      skipped: [],
      saved: [],
    };

    // 获取当前 session 的 SKU 列表（用于验证）
    const sessionSkus = db.prepare(
      'SELECT sku_code, product_id FROM batch_image_session_skus WHERE session_id = ?'
    ).all(sessionId);
    const skuSet = new Set(sessionSkus.map(s => s.sku_code));

    // 暂时图片计数
    const skuImageCounts = {}; // { skuCode: { main, detail, screenshot } }

    for (const file of files) {
      const filename = file.originalname;
      const parsed = parseImageFilename(filename);

      if (!parsed || parsed.imgType === 'unknown') {
        results.skipped.push({ filename, reason: '文件名不符合命名规则 ({SKU}01{XX}.ext / {SKU}02{XX}.ext)' });
        results.unmatched++;
        continue;
      }

      // 尝试解析 SKU（支持模糊匹配）
      const product = resolveSkuCode(parsed.skuCode);
      const actualSku = product ? product.product_code : parsed.skuCode;

      // 检查是否在本次导入的 SKU 列表中
      if (!skuSet.has(actualSku) && !skuSet.has(parsed.skuCode)) {
        results.skipped.push({
          filename,
          skuCode: parsed.skuCode,
          reason: `SKU "${parsed.skuCode}" 不在本次导入任务中`,
        });
        results.unmatched++;
        continue;
      }

      // 确定最终 SKU 编码
      const finalSku = skuSet.has(actualSku) ? actualSku :
                      (skuSet.has(parsed.skuCode) ? parsed.skuCode : null);
      if (!finalSku) {
        results.unmatched++;
        results.skipped.push({ filename, reason: 'SKU 匹配不到数据库中的商品' });
        continue;
      }

      // 保存图片到 session 目录
      const safeFilename = filename.replace(/[\/\\:*?"<>|]/g, '_');
      const destPath = path.join(sessionDir, safeFilename);

      // 如果同名文件已存在，覆盖
      fs.writeFileSync(destPath, file.buffer);

      // 更新计数
      if (!skuImageCounts[finalSku]) {
        skuImageCounts[finalSku] = { main: 0, detail: 0, screenshot: 0 };
      }
      skuImageCounts[finalSku][parsed.imgType] = (skuImageCounts[finalSku][parsed.imgType] || 0) + 1;

      results.matched++;
      results.saved.push({
        filename,
        skuCode: finalSku,
        imgType: parsed.imgType,
        seq: parsed.seq,
      });
    }

    // 更新 SKU 级别的图片计数和状态
    const updateSku = db.prepare(`
      UPDATE batch_image_session_skus
      SET main_count = ?, detail_count = ?, screenshot_count = ?,
          status = ?
      WHERE session_id = ? AND sku_code = ?
    `);

    for (const [skuCode, counts] of Object.entries(skuImageCounts)) {
      let status = 'pending';
      if (counts.main > 0 || counts.detail > 0 || counts.screenshot > 0) {
        status = counts.main > 0 && counts.detail > 0 ? 'matched' : 'partial';
      }
      const product = resolveSkuCode(skuCode);
      // 更新 product_id 如果之前未关联
      if (product) {
        db.prepare(
          'UPDATE batch_image_session_skus SET product_id = ?, product_name = ? WHERE session_id = ? AND sku_code = ? AND product_id IS NULL'
        ).run(product.id, product.name, sessionId, skuCode);
      }
      updateSku.run(counts.main, counts.detail, counts.screenshot, status, sessionId, skuCode);
    }

    console.log(`[BatchImg] 任务 #${sessionId} 上传: ${results.matched} 匹配, ${results.unmatched} 不匹配, ${results.skipped.length} 跳过`);

    res.json({
      success: true,
      data: {
        sessionId,
        total: results.total,
        matched: results.matched,
        unmatched: results.unmatched,
        skipped: results.skipped,
        saved: results.saved,
      },
    });
  } catch (err) {
    console.error('[BatchImg] 上传处理失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// --------------- 6. 删除单张图片 ---------------
router.delete('/sessions/:id/image', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ success: false, error: '请指定文件名' });

    const filePath = path.join(SESSION_BASE, String(sessionId), filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // 重新计算对应 SKU 的图片计数
    const parsed = parseImageFilename(filename);
    if (parsed) {
      const product = resolveSkuCode(parsed.skuCode);
      const actualSku = product ? product.product_code : parsed.skuCode;

      // 重新扫描目录
      const sessionDir = path.join(SESSION_BASE, String(sessionId));
      const allFiles = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [];
      const mainCount = allFiles.filter(f => {
        const p = parseImageFilename(f);
        return p && ((p.skuCode === actualSku || (resolveSkuCode(p.skuCode) || {}).product_code === actualSku)) && p.imgType === 'main';
      }).length;
      const detailCount = allFiles.filter(f => {
        const p = parseImageFilename(f);
        return p && ((p.skuCode === actualSku || (resolveSkuCode(p.skuCode) || {}).product_code === actualSku)) && p.imgType === 'detail';
      }).length;
      const screenshotCount = allFiles.filter(f => {
        const p = parseImageFilename(f);
        return p && ((p.skuCode === actualSku || (resolveSkuCode(p.skuCode) || {}).product_code === actualSku)) && p.imgType === 'screenshot';
      }).length;

      let status = 'pending';
      const total = mainCount + detailCount + screenshotCount;
      if (total > 0) {
        status = mainCount > 0 && detailCount > 0 ? 'matched' : 'partial';
      }

      db.prepare(`
        UPDATE batch_image_session_skus
        SET main_count = ?, detail_count = ?, screenshot_count = ?, status = ?
        WHERE session_id = ? AND sku_code = ?
      `).run(mainCount, detailCount, screenshotCount, status, sessionId, actualSku);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------- 7. 结束上传（正式绑定图片到商品） ---------------
router.post('/sessions/:id/finalize', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const session = db.prepare('SELECT * FROM batch_image_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ success: false, error: '任务不存在' });
    if (session.status === 'completed') {
      return res.status(400).json({ success: false, error: '任务已结束' });
    }

    const sessionDir = path.join(SESSION_BASE, String(sessionId));
    if (!fs.existsSync(sessionDir)) {
      return res.status(400).json({ success: false, error: '没有上传任何图片' });
    }

    const imageFiles = fs.readdirSync(sessionDir).filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));

    if (imageFiles.length === 0) {
      return res.status(400).json({ success: false, error: '没有上传任何图片，无法结束' });
    }

    const insertImg = db.prepare(
      'INSERT OR IGNORE INTO product_images (product_id, image_url, image_type, sort_order) VALUES (?, ?, ?, ?)'
    );

    const results = { bound: 0, skipped: [], errors: [] };

    // 按商品分组处理
    const productImageMap = {}; // { productId: { main: [{url, sort}], detail: [...], screenshot: [...] } }

    for (const filename of imageFiles) {
      const parsed = parseImageFilename(filename);
      if (!parsed || parsed.imgType === 'unknown') {
        results.skipped.push({ filename, reason: '命名规则不匹配' });
        continue;
      }

      const product = resolveSkuCode(parsed.skuCode);
      if (!product) {
        results.skipped.push({ filename, skuCode: parsed.skuCode, reason: '找不到对应商品' });
        continue;
      }

      if (!productImageMap[product.id]) {
        productImageMap[product.id] = { main: [], detail: [], screenshot: [], product };
      }

      const localUrl = `/uploads/products/${product.id}/${filename}`;
      productImageMap[product.id][parsed.imgType].push({ url: localUrl, sort: parsed.seq });
    }

    // 写入图片并更新 product_images 表
    for (const [productId, data] of Object.entries(productImageMap)) {
      const productDir = path.join(UPLOAD_BASE, String(productId));
      fs.mkdirSync(productDir, { recursive: true });

      for (const imgType of ['main', 'detail', 'screenshot']) {
        const images = data[imgType].sort((a, b) => a.sort - b.sort);
        for (const img of images) {
          try {
            // 复制图片到商品目录
            const src = path.join(sessionDir, img.url.split('/').pop());
            const dest = path.join(productDir, img.url.split('/').pop());
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, dest);
            }

            // 写入数据库
            insertImg.run(productId, img.url, imgType, img.sort);
            results.bound++;
          } catch (e) {
            results.errors.push({ productId, url: img.url, error: e.message });
          }
        }
      }

      // 更新产品的 main_images / detail_images 字段（去重，避免重复导入累加）
      const allMain = db.prepare(
        "SELECT image_url, sort_order FROM product_images WHERE product_id = ? AND image_type = 'main' ORDER BY sort_order, id"
      ).all(productId);
      const allDetail = db.prepare(
        "SELECT image_url, sort_order FROM product_images WHERE product_id = ? AND image_type = 'detail' ORDER BY sort_order, id"
      ).all(productId);

      // 用 Map 按 image_url 去重，保留最小 sort_order
      const dedupeUrls = (rows) => {
        const map = new Map();
        for (const r of rows) {
          if (!map.has(r.image_url)) map.set(r.image_url, r.image_url);
        }
        return Array.from(map.values());
      };
      const mainUrls = dedupeUrls(allMain);
      const detailUrls = dedupeUrls(allDetail);

      db.prepare(
        'UPDATE products SET main_images = ?, detail_images = ?, main_image = ? WHERE id = ?'
      ).run(
        JSON.stringify(mainUrls),
        JSON.stringify(detailUrls),
        mainUrls.length > 0 ? mainUrls[0] : null,
        productId
      );
    }

    // 更新任务状态
    db.prepare(
      "UPDATE batch_image_sessions SET status = 'completed', updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(sessionId);

    // 更新所有 SKU 的匹配状态为 matched
    db.prepare(
      "UPDATE batch_image_session_skus SET status = 'matched' WHERE session_id = ? AND status IN ('matched','partial')"
    ).run(sessionId);

    console.log(`[BatchImg] 任务 #${sessionId} 结束: 绑定了 ${results.bound} 张图片, ${results.skipped.length} 跳过, ${results.errors.length} 错误`);

    res.json({
      success: true,
      data: {
        sessionId,
        bound: results.bound,
        skipped: results.skipped,
        errors: results.errors,
      },
    });
  } catch (err) {
    console.error('[BatchImg] 结束上传失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------- 8. 手动绑定 SKU 到商品 ---------------
router.put('/sessions/:id/skus/:sku_code/bind', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const skuCode = req.params.sku_code;
    const { product_id } = req.body;

    if (!product_id) return res.status(400).json({ success: false, error: '缺少 product_id' });

    const session = db.prepare('SELECT * FROM batch_image_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ success: false, error: '任务不存在' });

    const skuRow = db.prepare(
      'SELECT * FROM batch_image_session_skus WHERE session_id = ? AND sku_code = ?'
    ).get(sessionId, skuCode);
    if (!skuRow) return res.status(404).json({ success: false, error: 'SKU 不存在' });

    const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(product_id);
    if (!product) return res.status(404).json({ success: false, error: '商品不存在' });

    db.prepare(
      'UPDATE batch_image_session_skus SET product_id = ?, product_name = ?, status = ? WHERE id = ?'
    ).run(product.id, product.name, skuRow.main_count + skuRow.detail_count + skuRow.screenshot_count > 0 ? 'matched' : 'pending', skuRow.id);

    res.json({ success: true, data: { sku_code: skuCode, product_id: product.id, product_name: product.name } });
  } catch (err) {
    console.error('[BatchImg] 手动绑定失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------- 9. 取消/删除任务 ---------------
router.delete('/sessions/:id', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const session = db.prepare('SELECT * FROM batch_image_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ success: false, error: '任务不存在' });

    // 删除 session 图片目录
    const sessionDir = path.join(SESSION_BASE, String(sessionId));
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    // 删除数据库记录（SKU 记录会级联删除）
    db.prepare('DELETE FROM batch_image_sessions WHERE id = ?').run(sessionId);

    console.log(`[BatchImg] 任务 #${sessionId} 已删除`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------- 9.5 批量删除任务 ---------------
router.delete('/sessions', (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: '请选择要删除的任务' });
    }

    const validIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    if (validIds.length === 0) {
      return res.status(400).json({ success: false, error: '请选择有效的任务ID' });
    }

    const placeholders = validIds.map(() => '?').join(',');
    const sessions = db.prepare(`SELECT id FROM batch_image_sessions WHERE id IN (${placeholders})`).all(...validIds);
    const existingIds = sessions.map(s => s.id);

    if (existingIds.length === 0) {
      return res.status(404).json({ success: false, error: '所选任务不存在' });
    }

    const deleteStmt = db.prepare('DELETE FROM batch_image_sessions WHERE id = ?');
    const deleteTransaction = db.transaction((ids) => {
      for (const sessionId of ids) {
        const sessionDir = path.join(SESSION_BASE, String(sessionId));
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        deleteStmt.run(sessionId);
      }
    });

    deleteTransaction(existingIds);

    console.log(`[BatchImg] 批量删除任务: ${existingIds.join(', ')}`);
    res.json({ success: true, deleted: existingIds.length });
  } catch (err) {
    console.error('[BatchImg] 批量删除任务失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
