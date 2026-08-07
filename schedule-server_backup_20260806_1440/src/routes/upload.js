/**
 * Upload 路由 - 文件上传
 * 文件存储到 Lighthouse 本地磁盘，返回访问 URL
 *
 * 前端调用链：
 *   wx.uploadFile → https://buqin.com.cn/schedule-api/api/upload
 *   → Nginx 转发 → localhost:3002/api/upload
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 上传根目录
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// 允许的文件类型（MIME 白名单）
const ALLOWED_MIMES = [
  // 图片
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // 文档
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv', 'text/plain',
  // 音频
  'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/mp4',
];

// 禁止的扩展名（双层防护）
const BLOCKED_EXTENSIONS = [
  '.exe', '.sh', '.bat', '.cmd', '.ps1', '.vbs', '.com',
  '.dll', '.so', '.php', '.jsp', '.asp', '.aspx', '.py', '.js',
];

// MIME 类型映射表
const MIME_MAP = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.aac':  'audio/aac',
  '.mp4':  'video/mp4',
  '.m4a':  'audio/mp4',
  '.pdf':  'application/pdf',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':  'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':  'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt':  'text/plain',
  '.csv':  'text/csv',
};

// 确保目录存在
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
ensureDir(UPLOAD_DIR);

module.exports = function () {
  const router = express.Router();

  // multer 存储配置
  const multer = require('multer');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // 按用户 openid 分目录（如果提供了的话）
      const openid = (req.body && req.body.openid) || 'anonymous';
      // 对 openid 做安全处理，防止路径穿越
      const safeDir = openid.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 32);
      const userDir = path.join(UPLOAD_DIR, safeDir);
      ensureDir(userDir);
      cb(null, userDir);
    },
    filename: (req, file, cb) => {
      // 生成唯一文件名：时间戳 + 随机 + 原始扩展名
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.txt', '.csv', '.mp3', '.wav', '.aac', '.mp4', '.m4a'].includes(ext) ? ext : '.bin';
      const hash = crypto.randomBytes(8).toString('hex');
      const ts = Date.now().toString(36);
      cb(null, `${ts}_${hash}${safeExt}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
      // 检查 MIME 类型
      if (!ALLOWED_MIMES.includes(file.mimetype)) {
        console.warn(`[Upload] 拒绝文件类型: ${file.mimetype} (${file.originalname})`);
        return cb(new Error(`不支持的文件类型: ${file.mimetype}`));
      }
      // 检查扩展名
      const ext = path.extname(file.originalname).toLowerCase();
      if (BLOCKED_EXTENSIONS.includes(ext)) {
        console.warn(`[Upload] 拒绝危险扩展名: ${ext} (${file.originalname})`);
        return cb(new Error(`不支持的文件类型: ${ext}`));
      }
      cb(null, true);
    },
  });

  // ===== POST /api/upload — 上传文件 =====
  router.post('/', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        // multer 错误区分
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ success: false, error: '文件大小不能超过 10MB' });
        }
        console.error('[Upload] 上传失败:', err.message);
        return res.status(400).json({ success: false, error: err.message });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: '未选择文件' });
      }

      // 计算相对于 UPLOAD_DIR 的路径（用于 URL）
      const relativePath = path.relative(UPLOAD_DIR, file.path).replace(/\\/g, '/');

      const fileInfo = {
        id: path.basename(file.filename, path.extname(file.filename)),
        fileId: relativePath,                     // 用于后续下载（相对于 uploads 根目录）
        fileName: file.originalname,
        fileType: file.mimetype,
        fileSize: file.size,
        url: `/api/upload/${relativePath}`,        // 访问 URL
        fileUrl: `/api/upload/${relativePath}`,    // 兼容字段
      };

      console.log(`[Upload] ✓ ${file.originalname} (${(file.size / 1024).toFixed(1)}KB) → ${relativePath}`);

      res.json({ success: true, data: fileInfo });
    });
  });

  // ===== GET /api/upload/* — 下载/预览文件 =====
  router.get('/:dirname/:filename', (req, res) => {
    const { dirname, filename } = req.params;
    serveFile(req, res, path.join(dirname, filename));
  });

  // 兼容旧格式：无子目录的文件名直接访问
  router.get('/:filename', (req, res) => {
    const { filename } = req.params;
    serveFile(req, res, filename);
  });

  function serveFile(req, res, relativePath) {
    // 安全检查：防止路径穿越
    const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(UPLOAD_DIR, safePath);

    if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
      return res.status(403).json({ success: false, error: '禁止访问' });
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ success: false, error: '文件不存在' });
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');

    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: '文件读取失败' });
      }
    });
    fileStream.pipe(res);
  }

  return router;
};
