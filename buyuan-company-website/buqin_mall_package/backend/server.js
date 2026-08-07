/**
 * 埠勤商贸 - API 服务器 (v2.0)
 * MariaDB 数据源 + RESTful API
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const tablesRouter = require('./routes/tables');
const productsRouter = require('./routes/products');
const productImagesRouter = require('./routes/product-images');
const categoriesRouter = require('./routes/categories');
const batchImageImportRouter = require('./routes/batch-image-import');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 腾讯混元 TokenHub 配置 ====================
const TOKENHUB_API_KEY = process.env.TENCENT_TOKENHUB_API_KEY || 'your-tokenhub-key';
const TOKENHUB_HOST = 'tokenhub.tencentmaas.com';
const TOKENHUB_PATH = '/v1/chat/completions';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const diskStorage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'uploads', 'products');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ==================== 中间件 ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..')));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ==================== 1. 表格 CRUD API (/api/tables) ====================
app.use('/api/tables', tablesRouter);
app.use('/api/categories', categoriesRouter);

// ==================== 商城 API (/api/products) ====================
app.use('/api/products', productsRouter);
app.use('/api/products', productImagesRouter);
app.use('/api/batch-image-import', batchImageImportRouter);

// ==================== 2. 混元 HY3 API ====================

function hy3Request(payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKENHUB_HOST,
      port: 443,
      path: TOKENHUB_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKENHUB_API_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`解析失败: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/api/hunyuan/chat', async (req, res) => {
  try {
    const { messages, temperature, max_tokens, top_p } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'messages 不能为空' });
    }

    const result = await hy3Request({
      model: 'hy3',
      messages,
      ...(temperature !== undefined && { temperature }),
      ...(top_p !== undefined && { top_p }),
      ...(max_tokens !== undefined && { max_tokens }),
    });

    res.json({
      success: true,
      model: 'hy3',
      reply: result?.choices?.[0]?.message?.content || '',
      usage: result?.usage || {},
    });
  } catch (e) {
    console.error('[Chat]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/hunyuan/ocr', upload.single('file'), async (req, res) => {
  try {
    let imageBase64, prompt;

    if (req.file) {
      const mime = req.file.mimetype || 'image/png';
      imageBase64 = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
      prompt = req.body.prompt || '请精准提取图片中的所有文字内容，保持原有格式和排版。';
    } else if (req.body.image) {
      imageBase64 = req.body.image;
      if (!imageBase64.startsWith('data:')) {
        imageBase64 = `data:image/png;base64,${imageBase64}`;
      }
      prompt = req.body.prompt || '请精准提取图片中的所有文字内容，保持原有格式和排版。';
    } else {
      return res.status(400).json({ success: false, error: '请上传图片文件或提供 base64 图片数据' });
    }

    const result = await hy3Request({
      model: 'hy3',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
      temperature: 0.1,
    });

    const content = result?.choices?.[0]?.message?.content || '';

    res.json({
      success: true,
      model: 'hy3',
      text: content,
      usage: result?.usage || {},
    });
  } catch (e) {
    console.error('[OCR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/hunyuan/status', (req, res) => {
  const ready = TOKENHUB_API_KEY !== 'your-tokenhub-key';
  res.json({
    status: ready ? 'ready' : 'unconfigured',
    apiKey: ready ? `${TOKENHUB_API_KEY.slice(0, 8)}***` : '未配置',
    endpoints: {
      chat: 'POST /api/hunyuan/chat',
      ocr: 'POST /api/hunyuan/ocr',
    },
  });
});

// ==================== 3. 商品图片上传（本地磁盘）====================
app.post('/api/upload/image', diskStorage.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请选择要上传的图片' });
    const fileUrl = `/uploads/products/${req.file.filename}`;
    res.json({ success: true, url: fileUrl, filename: req.file.filename });
  } catch (err) {
    console.error('[Upload]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 4. 健康检查 ====================
app.get('/api/health', (req, res) => {
  try {
    const result = db.prepare('SELECT 1 as ok').get();
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      database: err.message,
    });
  }
});

// ==================== 5. 图片代理（解决京东等防盗链）====================
function proxyImage(targetUrl, res, depth = 0) {
  if (depth > 3) {
    return res.status(502).json({ success: false, error: '重定向次数过多' });
  }
  try {
    const parsed = new URL(targetUrl);
    const protocol = parsed.protocol === 'https:' ? https : http;
    const req = protocol.get(targetUrl, {
      timeout: 30000,
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': parsed.origin + '/',
      },
    }, (imgRes) => {
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        return proxyImage(imgRes.headers.location, res, depth + 1);
      }
      if (imgRes.statusCode !== 200) {
        return res.status(imgRes.statusCode || 502).json({ success: false, error: `源站返回 ${imgRes.statusCode}` });
      }
      const contentType = imgRes.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      imgRes.pipe(res);
    });
    req.on('error', (err) => {
      console.error('[ProxyImage]', err.message, targetUrl.substring(0, 80));
      res.status(502).json({ success: false, error: '图片获取失败: ' + err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      res.status(504).json({ success: false, error: '图片获取超时' });
    });
  } catch (err) {
    console.error('[ProxyImage] URL解析失败:', err.message);
    res.status(400).json({ success: false, error: 'URL无效' });
  }
}

app.get('/api/proxy-image', (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: '缺少 url 参数' });
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return res.status(400).json({ success: false, error: '仅支持 http/https URL' });
  }
  proxyImage(url, res);
});

// ==================== 5b. 批量下载图片到本地（无需 productId） ====================
const { downloadImage } = require('./services/image-downloader');

app.post('/api/images/batch-download', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ success: false, error: '请提供图片URL列表' });
    }

    const sessionId = crypto.randomUUID();
    const tempDir = path.join(__dirname, '..', 'uploads', 'batch', sessionId);
    fs.mkdirSync(tempDir, { recursive: true });

    const results = [];
    const queue = [...urls];
    const concurrency = 5;

    async function worker() {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item || !item.url) continue;

        const urlStr = item.url.trim();
        if (!urlStr.startsWith('http')) {
          // 已经是本地/相对路径
          results.push({ originalUrl: urlStr, localUrl: urlStr, type: item.type, sort: item.sort, success: true, cached: true });
          continue;
        }

        const urlHash = crypto.createHash('md5').update(urlStr).digest('hex').substring(0, 12);
        const ext = (urlStr.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i) || [null, 'jpg'])[1];
        const filename = `${(item.type || 'img')}_${urlHash}.${ext}`;
        const destPath = path.join(tempDir, filename);
        const localUrl = `/uploads/batch/${sessionId}/${filename}`;

        // 缓存：文件已存在则跳过
        if (fs.existsSync(destPath)) {
          results.push({ originalUrl: urlStr, localUrl, type: item.type, sort: item.sort, success: true, cached: true });
          continue;
        }

        try {
          await downloadImage(urlStr, destPath);
          results.push({ originalUrl: urlStr, localUrl, type: item.type, sort: item.sort, success: true, cached: false });
        } catch (err) {
          console.error(`[BatchDownload] 失败: ${urlStr.substring(0, 80)}`, err.message);
          results.push({ originalUrl: urlStr, localUrl: urlStr, type: item.type, sort: item.sort, success: false, error: err.message });
        }

        // 下载间隔，避免被反爬
        await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 400)));
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
    await Promise.all(workers);

    const successCount = results.filter(r => r.success).length;
    res.json({
      success: true,
      sessionId,
      downloaded: successCount,
      total: results.length,
      results,
      message: `下载完成: ${successCount}/${results.length} 张成功`,
    });
  } catch (err) {
    console.error('[BatchDownload] 批量下载失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 5c. 按编号批量导入图片（文件名匹配商品条码）====================
const batchImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 5000 }, // 50MB, 最多5000个文件
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 jpg/jpeg/png/webp/gif 图片格式'));
    }
  },
});

app.post('/api/images/batch-import-by-barcode', batchImageUpload.array('images', 5000), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: '请上传图片文件' });
    }

    const files = req.files;
    const baseDir = path.join(__dirname, '..', 'uploads', 'products');
    fs.mkdirSync(baseDir, { recursive: true });

    // 匹配规则：编号_数字.后缀
    // 例如：6901234567890_11.jpg → 条码=6901234567890，主图1
    //       6901234567890_12.jpg → 主图2 ... 6901234567890_15.jpg → 主图5
    //       6901234567890_21.jpg → 详情图1 ... 6901234567890_26.jpg → 详情图6
    const IMAGE_PATTERN = /^(.+?)[_\-](\d{2})\.(jpg|jpeg|png|webp|gif)$/i;

    // 解析每个文件
    const parsedFiles = [];
    const skippedFiles = [];
    files.forEach(file => {
      const match = (file.originalname || '').match(IMAGE_PATTERN);
      if (!match) {
        skippedFiles.push({ filename: file.originalname, reason: '文件名不符合"编号_XX.后缀"格式' });
        return;
      }
      const barcode = match[1].trim();
      const suffix = parseInt(match[2], 10);
      const ext = `.${match[3].toLowerCase()}`;

      // 判断是主图还是详情图
      let imgType = null;
      let sortOrder = null;
      if (suffix >= 11 && suffix <= 15) {
        imgType = 'main';
        sortOrder = suffix - 10; // 1-5
      } else if (suffix >= 21 && suffix <= 26) {
        imgType = 'detail';
        sortOrder = suffix - 20; // 1-6
      }

      if (!imgType) {
        skippedFiles.push({ filename: file.originalname, reason: `后缀${suffix}不在有效范围（11-15主图，21-26详情图）` });
        return;
      }

      parsedFiles.push({ barcode, suffix, sortOrder, imgType, ext, buffer: file.buffer, originalname: file.originalname });
    });

    if (parsedFiles.length === 0) {
      return res.json({
        success: false,
        error: '没有找到符合命名规范的文件',
        skipped: skippedFiles,
      });
    }

    // 查询所有涉及的 barcode 对应的 product
    const uniqueBarcodes = [...new Set(parsedFiles.map(f => f.barcode))];
    const productMap = {};
    const stmt = db.prepare('SELECT id, name, barcode FROM products WHERE barcode = ?');
    uniqueBarcodes.forEach(bc => {
      const row = stmt.get(bc);
      if (row) productMap[bc] = row;
    });

    const insertImageStmt = db.prepare(
      'INSERT INTO product_images (product_id, image_url, original_url, image_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    const updateProductStmt = db.prepare(
      'UPDATE products SET main_image = ?, main_images = ?, detail_images = ? WHERE id = ?'
    );

    const results = { matched: 0, notFound: 0, saved: 0, errors: [] };

    // 按 barcode 分组处理
    const transactions = [];
    const productUpdates = {}; // { productId: { mainUrls: [], detailUrls: [] } }

    for (const bc of uniqueBarcodes) {
      productUpdates[bc] = { mainUrls: [], detailUrls: [] };
    }

    for (const pf of parsedFiles) {
      const product = productMap[pf.barcode];
      if (!product) {
        results.notFound++;
        results.errors.push({ barcode: pf.barcode, filename: pf.originalname, error: '找不到对应条码的商品' });
        continue;
      }

      try {
        const productImgDir = path.join(baseDir, String(product.id));
        fs.mkdirSync(productImgDir, { recursive: true });

        const safeBarcode = pf.barcode.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 30);
        const filename = `${safeBarcode}_${pf.suffix}${pf.ext}`;
        const filePath = path.join(productImgDir, filename);
        fs.writeFileSync(filePath, pf.buffer);

        const localUrl = `/uploads/products/${product.id}/${filename}`;

        insertImageStmt.run(product.id, localUrl, null, pf.imgType, pf.sortOrder);

        if (!productUpdates[pf.barcode]) productUpdates[pf.barcode] = { mainUrls: [], detailUrls: [] };
        if (pf.imgType === 'main') {
          productUpdates[pf.barcode].mainUrls.push({ url: localUrl, sort: pf.sortOrder });
        } else {
          productUpdates[pf.barcode].detailUrls.push({ url: localUrl, sort: pf.sortOrder });
        }

        results.matched++;
        results.saved++;
      } catch (imgErr) {
        results.errors.push({ barcode: pf.barcode, filename: pf.originalname, error: imgErr.message });
      }
    }

    // 更新 product 的图片字段
    for (const [bc, update] of Object.entries(productUpdates)) {
      const product = productMap[bc];
      if (!product || (update.mainUrls.length === 0 && update.detailUrls.length === 0)) continue;

      update.mainUrls.sort((a, b) => a.sort - b.sort);
      update.detailUrls.sort((a, b) => a.sort - b.sort);

      const mainUrlList = update.mainUrls.map(u => u.url);
      const detailUrlList = update.detailUrls.map(u => u.url);
      const mainImage = mainUrlList.length > 0 ? mainUrlList[0] : '';

      updateProductStmt.run(
        mainImage,
        JSON.stringify(mainUrlList),
        JSON.stringify(detailUrlList),
        product.id
      );
    }

    res.json({
      success: true,
      data: {
        totalFiles: files.length,
        matched: results.matched,
        notFound: results.notFound,
        saved: results.saved,
        skipped: skippedFiles,
        errors: results.errors,
      },
      message: `图片导入完成：${results.saved} 张已保存${results.notFound > 0 ? `，${results.notFound} 个条码未匹配` : ''}`,
    });
  } catch (err) {
    console.error('[BatchImageImport]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 6. 获取所有表名（用于前端初始化） ====================
app.get('/api/table-names', (req, res) => {
  res.json({
    tables: [
      '销售表', '采购成本表', '收款表', '费用表', '利润表',
      '每日流水', '承包确认单', '客户统计表', '平台结算折扣率'
    ],
  });
});

// ==================== 启动服务 ====================
app.listen(PORT, () => {
  console.log('========================================');
  console.log('  埠勤商贸 API 服务器 v2.0');
  console.log(`  http://localhost:${PORT}`);
  console.log('  MariaDB 数据源');
  console.log('  - GET/POST/PUT/DELETE /api/tables/:name');
  console.log('  - GET/POST/PUT/DELETE /api/products');
  console.log('  - POST /api/products/import-jd (京东链接导入)');
  console.log('  - POST /api/products/preview-jd (京东链接预览)');
  console.log('  - GET  /api/products/:id/images (商品图片查询)');
  console.log('  - POST /api/products/:id/images/upload (手动上传图片)');
  console.log('  - POST /api/products/:id/images/download (下载京东图片)');
  console.log('  - POST /api/products/:id/images/reorder (拖拽排序)');
  console.log('  - PUT/DELETE /api/products/images/:imageId (图片操作)');
  console.log('  - GET  /api/proxy-image?url=... (图片代理，解决防盗链)');
  console.log('  - POST /api/images/batch-download (批量下载图片到本地)');
  console.log('  - POST /api/images/batch-import-by-barcode (按编号批量导入图片)');
  console.log('  - POST /api/products/import-excel-v2 (Excel导入含内嵌图片)');
  console.log('  - POST /api/hunyuan/chat');
  console.log('  - POST /api/hunyuan/ocr');
  console.log('========================================');
});
