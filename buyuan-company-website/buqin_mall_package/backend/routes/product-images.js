/**
 * 埠勤商贸 - 商品图片管理 API
 * 提供图片的CRUD、排序、下载、类型管理等
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { downloadProductImages, deleteProductImages } = require('../services/image-downloader');

const router = express.Router();

// 上传配置
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // 从 originalname 尝试提取类型和序号: "main_1_xxx.jpg" → type=main, sort=1
    const nameMatch = (file.originalname || '').match(/^(main|detail)_(\d+)_/);
    const type = nameMatch ? nameMatch[1] : (req.body.image_type || 'main');
    const sort = nameMatch ? nameMatch[2] : (req.body.sort_order || 99);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${type}_${String(sort).padStart(2, '0')}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 jpg/png/webp/gif 格式'));
    }
  },
});

// ============== 查询接口 ==============

/**
 * GET /api/products/:id/images
 * 获取产品所有图片，按类型和排序分组
 */
router.get('/:id/images', (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);

    const product = db.prepare('SELECT id, name, main_image FROM products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(404).json({ success: false, message: '产品不存在' });
    }

    // 优先从 product_images 表读取
    let images = db.prepare(
      'SELECT id, image_url, original_url, image_type, sort_order, created_at FROM product_images WHERE product_id = ? ORDER BY image_type, sort_order'
    ).all(productId);

    // 如果新表为空，尝试迁移旧JSON数据
    if (images.length === 0) {
      const oldImagesJSON = product.main_images || null;
      const oldDetailsJSON = product.detail_images || null;
      const imagesJSON = product.images || null;

      const migratedImages = [];

      // 解析旧主图
      if (oldImagesJSON) {
        try {
          const mainImgs = typeof oldImagesJSON === 'string' ? JSON.parse(oldImagesJSON) : oldImagesJSON;
          if (Array.isArray(mainImgs)) {
            mainImgs.forEach((url, i) => {
              if (url) migratedImages.push({ url, type: 'main', sort: i + 1 });
            });
          }
        } catch (e) {}
      }

      // 解析旧详情图
      if (oldDetailsJSON) {
        try {
          const detailImgs = typeof oldDetailsJSON === 'string' ? JSON.parse(oldDetailsJSON) : oldDetailsJSON;
          if (Array.isArray(detailImgs)) {
            detailImgs.forEach((url, i) => {
              if (url) migratedImages.push({ url, type: 'detail', sort: i + 1 });
            });
          }
        } catch (e) {}
      }

      // 兜底：通用 images 字段
      if (migratedImages.length === 0 && imagesJSON) {
        try {
          const allImgs = typeof imagesJSON === 'string' ? JSON.parse(imagesJSON) : imagesJSON;
          if (Array.isArray(allImgs)) {
            allImgs.forEach((url, i) => {
              if (url) migratedImages.push({ url, type: 'main', sort: i + 1 });
            });
          }
        } catch (e) {}
      }

      // 回写到 product_images 表
      if (migratedImages.length > 0) {
        const insertStmt = db.prepare(
          'INSERT INTO product_images (product_id, image_url, original_url, image_type, sort_order) VALUES (?, ?, ?, ?, ?)'
        );
        const migrateTx = db.transaction(() => {
          for (const img of migratedImages) {
            insertStmt.run(productId, img.url, img.url, img.type, img.sort);
          }
        });
        migrateTx();

        images = db.prepare(
          'SELECT id, image_url, original_url, image_type, sort_order, created_at FROM product_images WHERE product_id = ? ORDER BY image_type, sort_order'
        ).all(productId);
      }
    }

    // 分组
    const mainImages = images.filter(i => i.image_type === 'main').sort((a, b) => a.sort_order - b.sort_order);
    const detailImages = images.filter(i => i.image_type === 'detail').sort((a, b) => a.sort_order - b.sort_order);

    res.json({
      success: true,
      data: {
        product_id: productId,
        product_name: product.name,
        main_image: product.main_image,
        total: images.length,
        main_count: mainImages.length,
        detail_count: detailImages.length,
        main_images: mainImages,
        detail_images: detailImages,
        all_images: images,
      },
    });
  } catch (err) {
    console.error('[Images] 查询失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============== 手动上传 ==============

/**
 * POST /api/products/:id/images/upload
 * 手动上传图片到产品
 */
router.post('/:id/images/upload', upload.single('image'), (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const imageType = req.body.image_type || 'main';
    const sortOrder = parseInt(req.body.sort_order, 10) || 99;

    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择图片文件' });
    }

    const localUrl = `/uploads/products/${productId}/${req.file.filename}`;

    // 拿到当前最大排序
    const maxSort = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) as m FROM product_images WHERE product_id = ? AND image_type = ?'
    ).get(productId, imageType);
    const sort = sortOrder === 99 ? maxSort.m + 1 : sortOrder;

    const result = db.prepare(
      'INSERT INTO product_images (product_id, image_url, original_url, image_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(productId, localUrl, null, imageType, sort);

    // 如果是主图上传，更新产品主图
    if (imageType === 'main' && sort === 1) {
      db.prepare('UPDATE products SET main_image = ? WHERE id = ?').run(localUrl, productId);
    }

    res.json({
      success: true,
      data: {
        id: result.lastInsertRowid,
        product_id: productId,
        image_url: localUrl,
        image_type: imageType,
        sort_order: sort,
      },
      message: '上传成功',
    });
  } catch (err) {
    console.error('[Images] 上传失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============== 批量上传图片（主图1-5 + 详情图1-6）==============

/**
 * POST /api/products/:id/images/batch-upload
 */
router.post('/:id/images/batch-upload', upload.array('images', 20), (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: '请选择至少一张图片' });
    }

    const insertStmt = db.prepare(
      'INSERT OR IGNORE INTO product_images (product_id, image_url, image_type, sort_order) VALUES (?, ?, ?, ?)'
    );

    let saved = 0;
    const mainUrls = [];
    const detailUrls = [];

    for (const file of req.files) {
      const nameMatch = (file.originalname || '').match(/^(main|detail)_(\d+)_/);
      const imgType = nameMatch ? nameMatch[1] : 'main';
      const sortOrder = nameMatch ? parseInt(nameMatch[2], 10) : 99;
      const localUrl = `/uploads/products/${productId}/${file.filename}`;

      try {
        insertStmt.run(productId, localUrl, imgType, sortOrder);
        if (imgType === 'main') mainUrls.push(localUrl);
        else detailUrls.push(localUrl);
        saved++;
      } catch (e) {
        console.error('[BatchUpload] 插入图片记录失败:', e.message);
      }
    }

    if (mainUrls.length > 0 || detailUrls.length > 0) {
      const allMain = db.prepare(
        "SELECT image_url FROM product_images WHERE product_id = ? AND image_type = 'main' ORDER BY sort_order"
      ).all(productId).map(r => r.image_url);
      const allDetail = db.prepare(
        "SELECT image_url FROM product_images WHERE product_id = ? AND image_type = 'detail' ORDER BY sort_order"
      ).all(productId).map(r => r.image_url);

      db.prepare(
        'UPDATE products SET main_image = ?, main_images = ?, detail_images = ? WHERE id = ?'
      ).run(
        mainUrls.length > 0 ? mainUrls[0] : null,
        JSON.stringify([...new Set(allMain)]),
        JSON.stringify([...new Set(allDetail)]),
        productId
      );
    }

    res.json({
      success: true,
      data: { saved, productId },
      message: `成功上传 ${saved} 张图片`,
    });
  } catch (err) {
    console.error('[Images] 批量上传失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============== 下载京东图片到本地 ==============

/**
 * POST /api/products/:id/images/download
 * 将京东图片URL下载到本地存储
 * Body: { urls?: [{ url: string, type: 'main'|'detail', sort: number }] }
 * 如果不传 urls，则自动从 product_images 表读取已有图片进行下载
 */
router.post('/:id/images/download', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    let { urls } = req.body;

    // 如果没有传 urls，从数据库读取已有图片
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      const existingImages = db.prepare(
        'SELECT image_url, original_url, image_type, sort_order FROM product_images WHERE product_id = ? ORDER BY image_type, sort_order'
      ).all(productId);

      if (existingImages.length === 0) {
        return res.status(400).json({ success: false, error: '该商品没有可下载的图片' });
      }

      urls = existingImages.map(img => ({
        url: img.original_url || img.image_url,
        type: img.image_type,
        sort: img.sort_order,
      }));
    }

    console.log(`[Images] 开始下载产品 ${productId} 的 ${urls.length} 张图片...`);
    const results = await downloadProductImages(productId, urls, 5);

    // 更新数据库中的 image_url 为本地路径
    const updateStmt = db.prepare(
      'UPDATE product_images SET image_url = ? WHERE product_id = ? AND original_url = ?'
    );
    const updateTx = db.transaction(() => {
      for (const r of results) {
        if (r.success && r.localUrl) {
          updateStmt.run(r.localUrl, productId, r.originalUrl);
        }
      }
    });
    updateTx();

    // 更新产品主图
    const firstMain = results.find(r => r.type === 'main' && r.success);
    if (firstMain) {
      db.prepare('UPDATE products SET main_image = ? WHERE id = ?').run(firstMain.localUrl, productId);
    }

    const successCount = results.filter(r => r.success).length;
    res.json({
      success: true,
      downloaded: successCount,
      total: results.length,
      message: `下载完成: ${successCount}/${results.length} 张成功`,
    });
  } catch (err) {
    console.error('[Images] 批量下载失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============== 图片排序 ==============

/**
 * POST /api/products/:id/images/reorder
 * 批量更新图片排序
 * Body: { items: [{ id: number, sort_order: number, image_type?: string }] }
 */
router.post('/:id/images/reorder', (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const { items } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ success: false, message: '请提供排序列表' });
    }

    const updateStmt = db.prepare(
      'UPDATE product_images SET sort_order = ?, image_type = COALESCE(?, image_type) WHERE id = ? AND product_id = ?'
    );

    const reorderTx = db.transaction(() => {
      for (const item of items) {
        updateStmt.run(item.sort_order, item.image_type || null, item.id, productId);
      }
    });
    reorderTx();

    res.json({ success: true, message: '排序更新成功' });
  } catch (err) {
    console.error('[Images] 排序失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============== 单张图片操作 ==============

/**
 * PUT /api/products/images/:imageId
 * 更新单张图片类型或排序
 */
router.put('/images/:imageId', (req, res) => {
  try {
    const imageId = parseInt(req.params.imageId, 10);
    const { image_type, sort_order } = req.body;

    const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(imageId);
    if (!img) {
      return res.status(404).json({ success: false, message: '图片不存在' });
    }

    const newType = image_type || img.image_type;
    const newSort = sort_order !== undefined ? sort_order : img.sort_order;

    db.prepare('UPDATE product_images SET image_type = ?, sort_order = ? WHERE id = ?')
      .run(newType, newSort, imageId);

    // 如果设定为第1张主图，更新产品主图
    if (newType === 'main' && newSort === 1) {
      db.prepare('UPDATE products SET main_image = ? WHERE id = ?').run(img.image_url, img.product_id);
    }

    res.json({ success: true, message: '更新成功' });
  } catch (err) {
    console.error('[Images] 更新失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/products/images/:imageId
 * 删除单张图片
 */
router.delete('/images/:imageId', (req, res) => {
  try {
    const imageId = parseInt(req.params.imageId, 10);

    const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(imageId);
    if (!img) {
      return res.status(404).json({ success: false, message: '图片不存在' });
    }

    // 删除本地文件
    const localPath = path.join(__dirname, '..', '..', img.image_url);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }

    // 删除数据库记录
    db.prepare('DELETE FROM product_images WHERE id = ?').run(imageId);

    // 重新排序同类型图片
    const remaining = db.prepare(
      'SELECT id FROM product_images WHERE product_id = ? AND image_type = ? ORDER BY sort_order'
    ).all(img.product_id, img.image_type);

    const updateStmt = db.prepare(
      'UPDATE product_images SET sort_order = ? WHERE id = ?'
    );
    remaining.forEach((item, idx) => {
      updateStmt.run(idx + 1, item.id);
    });

    // 如果删除了第1张主图，更新产品表
    if (img.image_type === 'main' && img.sort_order === 1) {
      const newFirst = db.prepare(
        'SELECT image_url FROM product_images WHERE product_id = ? AND image_type = ? ORDER BY sort_order LIMIT 1'
      ).get(img.product_id, 'main');
      db.prepare('UPDATE products SET main_image = ? WHERE id = ?')
        .run(newFirst ? newFirst.image_url : '', img.product_id);
    }

    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    console.error('[Images] 删除失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/products/:id/images/from-urls
 * 直接保存已下载的图片URL（不需要再次下载）
 */
router.post('/:id/images/from-urls', (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const { images } = req.body;

    if (!images || !Array.isArray(images)) {
      return res.status(400).json({ success: false, message: '请提供图片列表' });
    }

    // 清空旧记录
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId);

    const insertStmt = db.prepare(
      'INSERT INTO product_images (product_id, image_url, original_url, image_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    );

    const insertTx = db.transaction(() => {
      images.forEach((img) => {
        insertStmt.run(
          productId,
          img.image_url || img.url,
          img.original_url || img.url,
          img.image_type || img.type || 'main',
          img.sort_order || img.sort || 0
        );
      });
    });
    insertTx();

    // 更新产品主图
    const firstMain = images.find(i => (i.image_type || i.type) === 'main');
    if (firstMain) {
      db.prepare('UPDATE products SET main_image = ? WHERE id = ?')
        .run(firstMain.image_url || firstMain.url, productId);
    }

    res.json({ success: true, count: images.length, message: `已保存 ${images.length} 张图片` });
  } catch (err) {
    console.error('[Images] 保存失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
