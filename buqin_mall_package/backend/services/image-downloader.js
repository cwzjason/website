/**
 * 埠勤商贸 - 图片下载服务
 * 功能：从京东URL下载图片到本地存储，支持批量下载
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// 上传目录
const UPLOAD_BASE = path.join(__dirname, '..', '..', 'uploads', 'products');

// 确保目录存在
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 下载单张图片
 * @param {string} imageUrl - 图片URL
 * @param {string} destPath - 本地保存路径（完整路径含文件名）
 * @returns {Promise<string>} - 本地文件路径
 */
function downloadImage(imageUrl, destPath) {
  return new Promise((resolve, reject) => {
    // 如果已经是本地路径，直接返回
    if (!imageUrl.startsWith('http')) {
      return resolve(imageUrl);
    }

    const parsed = new URL(imageUrl);

    const protocol = imageUrl.startsWith('https') ? https : http;
    const options = {
      timeout: 30000,
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': parsed.origin + '/',
        'Origin': parsed.origin,
      },
    };
    const req = protocol.get(imageUrl, options, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 解析重定向URL（可能是相对路径）
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, parsed.origin).href;
        return downloadImage(redirectUrl, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${imageUrl.substring(0, 80)}`));
      }

      const dir = path.dirname(destPath);
      ensureDir(dir);

      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`下载超时: ${imageUrl.substring(0, 80)}`));
    });
    req.setTimeout(30000);
  });
}

/**
 * 批量下载产品图片（并发控制）
 * @param {number} productId - 产品ID
 * @param {Array<{url: string, type: string, sort: number}>} imageList - 图片列表
 * @param {number} concurrency - 并发数
 * @returns {Promise<Array>} - 下载结果 [{url, type, sort, localPath, success}]
 */
async function downloadProductImages(productId, imageList, concurrency = 5) {
  ensureDir(path.join(UPLOAD_BASE, String(productId)));

  const results = [];
  const queue = [...imageList];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const ext = item.url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)
        ? item.url.match(/\.(jpg|jpeg|png|webp)/i)[0]
        : 'jpg';

      // 基于URL生成稳定hash，相同URL复用已有文件
      const urlHash = crypto.createHash('md5').update(item.url).digest('hex').substring(0, 12);
      const filename = `${item.type}_${urlHash}.${ext}`;
      const destPath = path.join(UPLOAD_BASE, String(productId), filename);
      const relativePath = `/uploads/products/${productId}/${filename}`;

      // ---- 缓存检查：文件已存在则跳过 ----
      if (fs.existsSync(destPath)) {
        results.push({
          originalUrl: item.url,
          localUrl: relativePath,
          type: item.type,
          sort: item.sort,
          success: true,
          cached: true,
        });
        continue;
      }

      try {
        await downloadImage(item.url, destPath);
        results.push({
          originalUrl: item.url,
          localUrl: relativePath,
          type: item.type,
          sort: item.sort,
          success: true,
          cached: false,
        });
        // 下载间隔：避免高频请求京东 CDN
        await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 500)));
      } catch (err) {
        console.error(`[ImageDownloader] 下载失败: ${item.url.substring(0, 80)}`, err.message);
        results.push({
          originalUrl: item.url,
          localUrl: item.url,
          type: item.type,
          sort: item.sort,
          success: false,
          error: err.message,
        });
      }
    }
  }

  // 启动多个worker并发下载
  const workers = Array.from({ length: Math.min(concurrency, imageList.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * 获取图片本地访问URL
 */
function getImageUrl(localPath) {
  if (!localPath) return '';
  if (localPath.startsWith('http')) return localPath;
  return localPath; // 相对于静态目录的路径
}

/**
 * 删除产品所有本地图片
 */
function deleteProductImages(productId) {
  const dir = path.join(UPLOAD_BASE, String(productId));
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    files.forEach(f => fs.unlinkSync(path.join(dir, f)));
    fs.rmdirSync(dir);
    console.log(`[ImageDownloader] 已删除产品 ${productId} 的所有本地图片`);
  }
}

module.exports = {
  downloadImage,
  downloadProductImages,
  getImageUrl,
  deleteProductImages,
  UPLOAD_BASE,
};
