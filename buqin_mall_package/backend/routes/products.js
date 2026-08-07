/**
 * 埠勤商贸 - 商品商城 API 路由
 * 商品 CRUD + 分类查询 + 京东链接导入 + Excel批量导入
 * 数据源: SQLite (better-sqlite3)
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const pathLib = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseImagesFromXlsx, groupImagesByDataRow } = require('../services/excel-image-parser');

// ==================== 分类自动映射 ====================
/** 根据类目文字自动匹配 product_categories 表中的 category_id */
const autoMapCategory = (() => {
  let cached = null;     // { l1_name: { l2_name: l2_id } }
  let cachedAt = 0;
  const CACHE_MS = 60000; // 缓存 60 秒

  const loadCache = () => {
    if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
    const rows = db.prepare(
      `SELECT c1.id l1_id, c1.name l1,
              c2.id l2_id, c2.name l2
       FROM product_categories c1
       JOIN product_categories c2 ON c2.parent_id = c1.id
       WHERE c1.parent_id IS NULL
       ORDER BY c1.sort_order, c2.sort_order`
    ).all();

    cached = {};
    for (const r of rows) {
      if (!cached[r.l1]) cached[r.l1] = {};
      cached[r.l1][r.l2] = r.l2_id;
    }
    cachedAt = Date.now();
    return cached;
  };

  /** 清洗文本：去空格、统一全角半角、去标点 */
  const clean = (s) => {
    if (!s) return '';
    return String(s)
      .trim()
      .replace(/\s+/g, '')
      .replace(/[，,、。．.；;：:！!？?（）()【】\[\]]/g, '');
  };

  /** 判断两个类目名是否匹配 */
  const isMatch = (a, b) => {
    const ca = clean(a);
    const cb = clean(b);
    if (ca === cb) return 10;                       // 精确匹配
    if (ca.includes(cb) || cb.includes(ca)) return 8; // 包含匹配
    // 双向最长公共子串评分
    let maxLen = 0;
    for (let i = 0; i < ca.length; i++) {
      for (let j = i + 1; j <= ca.length; j++) {
        const sub = ca.slice(i, j);
        if (cb.includes(sub)) maxLen = Math.max(maxLen, sub.length);
      }
    }
    if (maxLen >= 2) return maxLen; // 有2字以上公共串
    return 0;
  };

  return (l1, l2, l3) => {
    if (!l1 && !l2) return null;
    const map = loadCache();
    const cl1 = String(l1 || '').trim();
    const cl2 = String(l2 || '').trim();
    const cl3 = String(l3 || '').trim();

    let bestScore = 0, bestId = null;

    const tryMatch = (testL1, testL2, testL3) => {
      for (const [ml1, l2map] of Object.entries(map)) {
        const s1 = isMatch(testL1, ml1);
        if (!s1) continue;
        for (const [ml2, targetId] of Object.entries(l2map)) {
          const s2 = isMatch(testL2, ml2);
          if (!s2) continue;
          const score = s1 + s2;
          if (score > bestScore) {
            bestScore = score;
            bestId = targetId;
          }
        }
        // 如果只有一级匹配，也记录下来
        if (!testL2) {
          const firstL2Id = Object.values(l2map)[0];
          if (s1 > bestScore && firstL2Id) {
            bestScore = s1;
            bestId = firstL2Id;
          }
        }
      }
    };

    // 策略1：三级类目匹配（优先）
    if (cl1 && cl2 && cl3) tryMatch(cl1, cl2, cl3);
    // 策略2：二级类目匹配
    if (!bestId && cl1 && cl2) tryMatch(cl1, cl2);
    // 策略3：仅一级类目匹配
    if (!bestId && cl1) tryMatch(cl1, '');

    return bestId;
  };
})();

// ==================== 分类接口 ====================

/** 获取分类树 */
router.get('/categories', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, name, parent_id, sort_order
       FROM product_categories
       ORDER BY sort_order, id`
    ).all();

    const map = {};
    const roots = [];
    rows.forEach(r => {
      map[r.id] = { ...r, children: [] };
    });
    rows.forEach(r => {
      if (r.parent_id && map[r.parent_id]) {
        map[r.parent_id].children.push(map[r.id]);
      } else if (!r.parent_id) {
        roots.push(map[r.id]);
      }
    });

    res.json({ success: true, data: roots });
  } catch (err) {
    console.error('[categories]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 商品 CRUD ====================

/** 获取商品列表（分页 + 筛选 + 排序） */
router.get('/', (req, res) => {
  try {
    const {
      page = 1, pageSize = 20,
      category_id, brand, keyword,
      sort = 'sort_order', order = 'asc',
      status,
      cr_l1, cr_l2, cr_l3
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    const limit = parseInt(pageSize);

    let where = ['1=1'];
    let params = [];

    if (status) {
      where.push('p.status = ?');
      params.push(status);
    }
    if (category_id) {
      // 查询该分类及其所有子分类（SQLite 支持递归 CTE）
      const subIds = db.prepare(
        `WITH RECURSIVE sub AS (
          SELECT id FROM product_categories WHERE id = ?
          UNION ALL
          SELECT c.id FROM product_categories c JOIN sub ON c.parent_id = sub.id
        ) SELECT id FROM sub`
      ).all(parseInt(category_id));

      const ids = subIds.map(r => r.id);
      if (ids.length > 0) {
        where.push(`p.category_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
    }
    // 客户类目筛选（按客户导入的一/二/三级）
    if (cr_l1) {
      where.push('p.cr_category_l1 = ?');
      params.push(cr_l1);
    }
    if (cr_l2) {
      where.push('p.cr_category_l2 = ?');
      params.push(cr_l2);
    }
    if (cr_l3) {
      where.push('p.cr_category_l3 = ?');
      params.push(cr_l3);
    }
    if (brand) {
      where.push('p.brand LIKE ?');
      params.push(`%${brand}%`);
    }
    if (keyword) {
      where.push('(p.name LIKE ? OR p.brand LIKE ? OR p.model LIKE ? OR p.cr_sku LIKE ? OR p.product_code LIKE ? OR p.barcode LIKE ? OR p.specification LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const whereClause = where.join(' AND ');

    // 总数
    const countResult = db.prepare(
      `SELECT COUNT(*) as total FROM products p WHERE ${whereClause}`
    ).get(...params);
    const total = countResult.total;

    // 排序映射
    const sortMap = {
      'price': 'p.price',
      'created_at': 'p.created_at',
      'view_count': 'p.view_count',
      'sort_order': 'p.sort_order',
    };
    const sortCol = sortMap[sort] || 'p.sort_order';
    const sortDir = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    // 数据
    const rows = db.prepare(
      `SELECT p.id, p.name, p.price, p.original_price, p.cr_price,
              p.status, p.category_id,
              p.main_image, p.main_images, p.detail_images,
              p.brand, p.model, p.unit, p.barcode,
              p.jd_category_l1, p.jd_category_l2, p.jd_category_l3,
              p.cr_category_l1, p.cr_category_l2, p.cr_category_l3, p.cr_sku,
              p.product_code, p.approval_status,
              p.display_name, p.invoice_name, p.description, p.specification,
              p.supplier_sku, p.supplier_remark, p.delivery_cycle, p.shipping_cycle,
              p.product_length, p.product_width, p.product_height, p.weight, p.weight_unit,
              p.warranty_period, p.origin_code, p.min_order_qty,
              p.return_type, p.return_period, p.exchange_type, p.exchange_period,
              p.unit_name, p.unit_code, p.is_xinchuang,
              p.sub_category_code, p.record_type, p.record_number,
              p.tag_price, p.shelf_life, p.guide_price,
              p.source_platform, p.view_count, p.created_at,
              p.product_alias, p.stock, p.shop_name, p.source_url, p.link_price,
              c.name as category_name,
              (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id AND pi.image_type = 'main' ORDER BY pi.sort_order, pi.id LIMIT 1) as first_main_image
       FROM products p
       LEFT JOIN product_categories c ON p.category_id = c.id
       WHERE ${whereClause}
       ORDER BY ${sortCol} ${sortDir}, p.id DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    // 规范化状态字段：空字符串/null 视为 inactive
    rows.forEach(row => {
      row.status = row.status || 'inactive';
    });

    // 构建三级分类路径（例如：个人防护 / 手部防护 / 防割手套）
    const catIds = [...new Set(rows.map(r => r.category_id).filter(Boolean))];
    const catPathMap = {};
    if (catIds.length > 0) {
      const allCats = db.prepare('SELECT id, name, parent_id FROM product_categories').all();
      const catById = {};
      allCats.forEach(c => { catById[c.id] = c; });
      catIds.forEach(cid => {
        const path = [];
        let current = catById[cid];
        while (current) {
          path.unshift(current.name);
          current = current.parent_id ? catById[current.parent_id] : null;
        }
        catPathMap[cid] = path.join(' / ');
      });
    }
    rows.forEach(row => {
      row.category_path = row.category_id ? (catPathMap[row.category_id] || row.category_name || '') : '';
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        page: parseInt(page),
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[products list]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 获取单个商品详情 */
router.get('/:id', (req, res) => {
  try {
    const row = db.prepare(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN product_categories c ON p.category_id = c.id
       WHERE p.id = ?`
    ).get(parseInt(req.params.id));

    if (!row) {
      return res.status(404).json({ success: false, error: '商品不存在' });
    }

    // 构建三级分类路径
    if (row.category_id) {
      const path = [];
      let current = db.prepare('SELECT id, name, parent_id FROM product_categories WHERE id = ?').get(row.category_id);
      while (current) {
        path.unshift(current.name);
        current = current.parent_id ? db.prepare('SELECT id, name, parent_id FROM product_categories WHERE id = ?').get(current.parent_id) : null;
      }
      row.category_path = path.join(' / ');
    }

    // 规范化状态字段
    row.status = row.status || 'inactive';

    // 解析 JSON 字段
    const jsonFields = ['images', 'main_images', 'detail_images', 'specs', 'params', 'attributes'];
    for (const key of jsonFields) {
      try {
        row[key] = typeof row[key] === 'string'
          ? JSON.parse(row[key]) : row[key] || [];
      } catch { row[key] = []; }
    }

    // 兜底：从 product_images 表补充主图/详情图
    const prodImages = db.prepare(
      `SELECT image_url, image_type FROM product_images WHERE product_id = ? ORDER BY sort_order, id`
    ).all(row.id) || [];
    const extraMain = prodImages.filter(pi => pi.image_type === 'main').map(pi => pi.image_url);
    const extraDetail = prodImages.filter(pi => pi.image_type === 'detail').map(pi => pi.image_url);
    if (!row.main_image && extraMain.length > 0) row.main_image = extraMain[0];
    row.main_images = Array.from(new Set([...row.main_images, ...extraMain]));
    row.detail_images = Array.from(new Set([...row.detail_images, ...extraDetail]));

    // 增加浏览次数
    db.prepare('UPDATE products SET view_count = view_count + 1 WHERE id = ?').run(row.id);

    res.json({ success: true, data: row });
  } catch (err) {
    console.error('[product detail]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 新增商品 */
router.post('/', (req, res) => {
  try {
    const {
      name, display_name, invoice_name, category_id,
      price, original_price, link_price, suggested_price, cr_price,
      barcode,
      tax_code, tax_rate, brand, model, shop_name, shop_id, jd_item_id, jd_category,
      supplier_sku, supplier_remark, restricted_note,
      images, main_images, detail_images, specs, params, attributes,
      description, packaging, after_sales, promotion, delivery,
      weight, unit, stock, sales_count, rating, review_count,
      source_url, source_platform, sort_order, status,
      cr_sku, cr_category_l1, cr_category_l2, cr_category_l3,
      jd_category_l1, jd_category_l2, jd_category_l3,
      // ====== 新模板字段 ======
      approval_status, product_alias, delivery_cycle, shipping_cycle, min_order_qty,
      specification, product_length, product_width, product_height,
      warranty_period, weight_unit, origin_code,
      return_type, return_period, exchange_type, exchange_period,
      unit_name, unit_code, is_xinchuang, product_code,
      sub_category_code, record_type, record_number, tag_price, shelf_life, guide_price
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: '商品名称不能为空' });
    }

    // 自动根据国铁类目匹配 category_id（优先使用前端传的 category_id）
    let mappedCategoryId = category_id || null;
    if (!mappedCategoryId) {
      mappedCategoryId = autoMapCategory(cr_category_l1, cr_category_l2, cr_category_l3) || null;
    }

    const allImages = main_images || images || [];
    const mainImage = (Array.isArray(allImages) && allImages.length > 0) ? allImages[0] : '';
    const safeJson = (v) => v ? JSON.stringify(v) : null;

    const result = db.prepare(
      `INSERT INTO products (
        name, display_name, invoice_name, category_id,
        price, original_price, link_price, suggested_price, cr_price,
        barcode,
        tax_code, tax_rate, brand, model, shop_name, shop_id, jd_item_id, jd_category,
        supplier_sku, supplier_remark, restricted_note,
        main_image, images, main_images, detail_images, specs, params, attributes,
        description, packaging, after_sales, promotion, delivery,
        weight, unit, stock, sales_count, rating, review_count,
        source_url, source_platform, sort_order, status,
        cr_sku, cr_category_l1, cr_category_l2, cr_category_l3,
        jd_category_l1, jd_category_l2, jd_category_l3,
        approval_status, product_alias, delivery_cycle, shipping_cycle, min_order_qty,
        specification, product_length, product_width, product_height,
        warranty_period, weight_unit, origin_code,
        return_type, return_period, exchange_type, exchange_period,
        unit_name, unit_code, is_xinchuang, product_code,
        sub_category_code, record_type, record_number, tag_price, shelf_life, guide_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name.trim(),
      display_name || name.trim(),
      invoice_name || name.trim(),
      mappedCategoryId,
      price || null,
      original_price || null,
      link_price || null,
      suggested_price || null,
      cr_price || null,
      barcode || '',
      tax_code || '',
      tax_rate || '',
      brand || '',
      model || '',
      shop_name || '',
      shop_id || '',
      jd_item_id || '',
      jd_category || '',
      supplier_sku || '',
      supplier_remark || '',
      restricted_note || '',
      mainImage,
      safeJson(images),
      safeJson(main_images),
      safeJson(detail_images),
      safeJson(specs),
      safeJson(params),
      safeJson(attributes),
      description || '',
      packaging || '',
      after_sales || '',
      promotion || '',
      delivery || '',
      weight || null,
      unit || '',
      stock || 0,
      sales_count || 0,
      rating || null,
      review_count || 0,
      source_url || '',
      source_platform || 'manual',
      sort_order || 0,
      status || 'inactive',
      cr_sku || '',
      cr_category_l1 || '',
      cr_category_l2 || '',
      cr_category_l3 || '',
      jd_category_l1 || '',
      jd_category_l2 || '',
      jd_category_l3 || '',
      approval_status || '',
      product_alias || '',
      delivery_cycle || '',
      shipping_cycle || '',
      min_order_qty || '',
      specification || '',
      product_length || '',
      product_width || '',
      product_height || '',
      warranty_period || '',
      weight_unit || '',
      origin_code || '',
      return_type || '',
      return_period || '',
      exchange_type || '',
      exchange_period || '',
      unit_name || '',
      unit_code || '',
      is_xinchuang || '',
      product_code || '',
      sub_category_code || '',
      record_type || '',
      record_number || '',
      tag_price || null,
      shelf_life || '',
      guide_price || null,
    );

    res.status(201).json({
      success: true,
      data: { id: result.lastInsertRowid, name: name.trim() },
      message: '商品添加成功',
    });
  } catch (err) {
    console.error('[product create]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 更新商品 */
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    // 上架前校验：单品编码不能为空
    if (body.status === 'active') {
      const product = db.prepare('SELECT product_code FROM products WHERE id = ?').get(id);
      if (!product) return res.status(404).json({ success: false, error: '商品不存在' });
      const currentCode = body.product_code !== undefined ? body.product_code : product.product_code;
      if (!currentCode || String(currentCode).trim() === '') {
        return res.status(400).json({ success: false, error: '上架前请先在"商品信息填写"中填写「单品编码」' });
      }
    }

    const updates = [];
    const params = [];

    const setText = (field, val) => { updates.push(`${field} = ?`); params.push(val); };
    const setReal = (field, val) => { updates.push(`${field} = ?`); params.push(val === '' || val === undefined ? null : val); };
    const setInt = (field, val) => { updates.push(`${field} = ?`); params.push(parseInt(val) || 0); };
    const setJson = (field, val) => { updates.push(`${field} = ?`); params.push(val ? JSON.stringify(val) : null); };

    if (body.name !== undefined) setText('name', body.name.trim());
    if (body.display_name !== undefined) setText('display_name', body.display_name.trim());
    if (body.invoice_name !== undefined) setText('invoice_name', body.invoice_name.trim());
    if (body.category_id !== undefined) setText('category_id', body.category_id || null);
    if (body.price !== undefined) setReal('price', body.price);
    if (body.original_price !== undefined) setReal('original_price', body.original_price);
    if (body.link_price !== undefined) setReal('link_price', body.link_price);
    if (body.suggested_price !== undefined) setReal('suggested_price', body.suggested_price);
    if (body.cr_price !== undefined) setReal('cr_price', body.cr_price);
    if (body.tax_code !== undefined) setText('tax_code', body.tax_code);
    if (body.tax_rate !== undefined) setText('tax_rate', body.tax_rate);
    if (body.brand !== undefined) setText('brand', body.brand);
    if (body.model !== undefined) setText('model', body.model);
    if (body.shop_name !== undefined) setText('shop_name', body.shop_name);
    if (body.shop_id !== undefined) setText('shop_id', body.shop_id);
    if (body.jd_item_id !== undefined) setText('jd_item_id', body.jd_item_id);
    if (body.jd_category !== undefined) setText('jd_category', body.jd_category);
    if (body.supplier_sku !== undefined) setText('supplier_sku', body.supplier_sku);
    if (body.supplier_remark !== undefined) setText('supplier_remark', body.supplier_remark);
    if (body.restricted_note !== undefined) setText('restricted_note', body.restricted_note);
    if (body.description !== undefined) setText('description', body.description);
    if (body.packaging !== undefined) setText('packaging', body.packaging);
    if (body.after_sales !== undefined) setText('after_sales', body.after_sales);
    if (body.promotion !== undefined) setText('promotion', body.promotion);
    if (body.delivery !== undefined) setText('delivery', body.delivery);
    if (body.weight !== undefined) setReal('weight', body.weight);
    if (body.unit !== undefined) setText('unit', body.unit);
    if (body.stock !== undefined) setInt('stock', body.stock);
    if (body.sales_count !== undefined) setInt('sales_count', body.sales_count);
    if (body.rating !== undefined) setReal('rating', body.rating);
    if (body.review_count !== undefined) setInt('review_count', body.review_count);
    if (body.source_url !== undefined) setText('source_url', body.source_url);
    if (body.source_platform !== undefined) setText('source_platform', body.source_platform);
    if (body.status !== undefined) setText('status', body.status);
    if (body.sort_order !== undefined) setInt('sort_order', body.sort_order);
    if (body.cr_sku !== undefined) setText('cr_sku', body.cr_sku);
    if (body.cr_category_l1 !== undefined) setText('cr_category_l1', body.cr_category_l1);
    if (body.cr_category_l2 !== undefined) setText('cr_category_l2', body.cr_category_l2);
    if (body.cr_category_l3 !== undefined) setText('cr_category_l3', body.cr_category_l3);
    if (body.barcode !== undefined) setText('barcode', body.barcode);
    if (body.jd_category_l1 !== undefined) setText('jd_category_l1', body.jd_category_l1);
    if (body.jd_category_l2 !== undefined) setText('jd_category_l2', body.jd_category_l2);
    if (body.jd_category_l3 !== undefined) setText('jd_category_l3', body.jd_category_l3);
    // ====== 新模板字段 ======
    if (body.approval_status !== undefined) setText('approval_status', body.approval_status);
    if (body.product_alias !== undefined) setText('product_alias', body.product_alias);
    if (body.delivery_cycle !== undefined) setText('delivery_cycle', body.delivery_cycle);
    if (body.shipping_cycle !== undefined) setText('shipping_cycle', body.shipping_cycle);
    if (body.min_order_qty !== undefined) setText('min_order_qty', body.min_order_qty);
    if (body.specification !== undefined) setText('specification', body.specification);
    if (body.product_length !== undefined) setText('product_length', body.product_length);
    if (body.product_width !== undefined) setText('product_width', body.product_width);
    if (body.product_height !== undefined) setText('product_height', body.product_height);
    if (body.warranty_period !== undefined) setText('warranty_period', body.warranty_period);
    if (body.weight_unit !== undefined) setText('weight_unit', body.weight_unit);
    if (body.origin_code !== undefined) setText('origin_code', body.origin_code);
    if (body.return_type !== undefined) setText('return_type', body.return_type);
    if (body.return_period !== undefined) setText('return_period', body.return_period);
    if (body.exchange_type !== undefined) setText('exchange_type', body.exchange_type);
    if (body.exchange_period !== undefined) setText('exchange_period', body.exchange_period);
    if (body.unit_name !== undefined) setText('unit_name', body.unit_name);
    if (body.unit_code !== undefined) setText('unit_code', body.unit_code);
    if (body.is_xinchuang !== undefined) setText('is_xinchuang', body.is_xinchuang);
    if (body.product_code !== undefined) setText('product_code', body.product_code);
    // ====== 两步模板第一步新增字段 ======
    if (body.sub_category_code !== undefined) setText('sub_category_code', body.sub_category_code);
    if (body.record_type !== undefined) setText('record_type', body.record_type);
    if (body.record_number !== undefined) setText('record_number', body.record_number);
    if (body.tag_price !== undefined) setReal('tag_price', body.tag_price);
    if (body.shelf_life !== undefined) setText('shelf_life', body.shelf_life);
    if (body.guide_price !== undefined) setReal('guide_price', body.guide_price);

    if (body.images !== undefined || body.main_images !== undefined) {
      const allImages = body.main_images || body.images || [];
      const mainImage = (Array.isArray(allImages) && allImages.length > 0) ? allImages[0] : '';
      setText('main_image', mainImage);
      if (body.images !== undefined) setJson('images', body.images);
      if (body.main_images !== undefined) setJson('main_images', body.main_images);
    }
    if (body.detail_images !== undefined) setJson('detail_images', body.detail_images);
    if (body.specs !== undefined) setJson('specs', body.specs);
    if (body.params !== undefined) setJson('params', body.params);
    if (body.attributes !== undefined) setJson('attributes', body.attributes);

    // 自动映射分类：如果国铁类目被更新但 category_id 没被显式设置，则自动匹配
    if (body.category_id === undefined && (body.cr_category_l1 !== undefined || body.cr_category_l2 !== undefined)) {
      let l1 = body.cr_category_l1, l2 = body.cr_category_l2, l3 = body.cr_category_l3;
      if (l1 === undefined || l2 === undefined) {
        const existing = db.prepare('SELECT cr_category_l1, cr_category_l2, cr_category_l3 FROM products WHERE id = ?').get(parseInt(id));
        if (existing) {
          l1 = l1 !== undefined ? l1 : existing.cr_category_l1;
          l2 = l2 !== undefined ? l2 : existing.cr_category_l2;
          l3 = l3 !== undefined ? l3 : existing.cr_category_l3;
        }
      }
      const mappedId = autoMapCategory(l1 || '', l2 || '', l3 || '');
      if (mappedId) {
        updates.push('category_id = ?');
        params.push(mappedId);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: '没有需要更新的字段' });
    }

    params.push(parseInt(id));
    const result = db.prepare(
      `UPDATE products SET ${updates.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`
    ).run(...params);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: '商品不存在' });
    }

    res.json({ success: true, message: '商品更新成功' });
  } catch (err) {
    console.error('[product update]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 删除商品 */
router.delete('/:id', (req, res) => {
  try {
    const result = db.prepare(
      'DELETE FROM products WHERE id = ?'
    ).run(parseInt(req.params.id));

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: '商品不存在' });
    }

    res.json({ success: true, message: '商品删除成功' });
  } catch (err) {
    console.error('[product delete]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====== 批量删除商品 ======
router.post('/batch-delete', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: '请提供要删除的商品ID列表' });
    }
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM products WHERE id IN (${placeholders})`).run(...ids);
    res.json({ success: true, deleted: result.changes, message: `已删除 ${result.changes} 个商品` });
  } catch (err) {
    console.error('[batch delete]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====== 批量上架/下架商品 ======
router.post('/batch-status', (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: '请提供要操作的商品ID列表' });
    }
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ success: false, error: '无效状态，请传 active 或 inactive' });
    }

    // 上架前校验：所有选中商品的单品编码不能为空
    if (status === 'active') {
      const placeholders = ids.map(() => '?').join(',');
      const noCodeProducts = db.prepare(
        `SELECT id, name FROM products WHERE id IN (${placeholders}) AND (product_code IS NULL OR TRIM(product_code) = '')`
      ).all(...ids);
      if (noCodeProducts.length > 0) {
        const names = noCodeProducts.map(p => `"${p.name}"`).join('、');
        return res.status(400).json({
          success: false,
          error: `以下商品未填写「单品编码」，无法上架：${names}。请先编辑填写单品编码后再上架。`
        });
      }
    }

    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(
      `UPDATE products SET status = ?, updated_at = datetime('now','localtime') WHERE id IN (${placeholders})`
    ).run(status, ...ids);

    const actionText = status === 'active' ? '上架' : '下架';
    res.json({
      success: true,
      updated: result.changes,
      message: `已${actionText} ${result.changes} 个商品`
    });
  } catch (err) {
    console.error('[batch status]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== Excel 表格批量导入 ====================

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB 支持大批量图片
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .xlsx / .xls / .csv 格式的表格文件'));
    }
  },
});

/** 表格列名 → 数据库字段映射（按指定顺序） */
const COLUMN_MAP = {
  '品牌': 'brand',
  '商品名称': 'name',
  '型号': 'model',
  '单位': 'unit',
  '条码': 'barcode',
  '国铁售价': 'cr_price',
  '实际京东价': 'price',
  '国铁一级类目': 'cr_category_l1',
  '国铁二级类目': 'cr_category_l2',
  '国铁三级类目': 'cr_category_l3',
  '京东一级类目': 'jd_category_l1',
  '京东二级类目': 'jd_category_l2',
  '京东三级类目': 'jd_category_l3',
  '主图1': 'main1',
  '主图2': 'main2',
  '主图3': 'main3',
  '主图4': 'main4',
  '主图5': 'main5',
  '详情图1': 'detail1',
  '详情图2': 'detail2',
  '详情图3': 'detail3',
  '详情图4': 'detail4',
  '详情图5': 'detail5',
  '详情图6': 'detail6',
  '国铁SKU': 'cr_sku',
};

// ====== 第一步导入：商品基础信息（Template 1） ======
const STEP1_COL_MAP = {
  '小类分类编码（必填）': 'sub_category_code',
  '品牌名称（必填）': 'brand',
  '货号/型号(必填，最多37字)': 'model',
  '商品展示名称(必填，最多100字)': 'display_name',
  '商品开票名称(必填，最多40字)': 'invoice_name',
  '销售单位(必填)': 'unit',
  '商城展示价（必填）': 'price',
  '备案号类型(风险商品必填)': 'record_type',
  '备案号(风险商品必填)': 'record_number',
  '供应商SKU编码（最多50字）': 'supplier_sku',
  '供应商商品备注（最多100字）': 'supplier_remark',
  '吊牌价': 'tag_price',
  '商品说明': 'description',
  '重量(KG)': 'weight',
  '长(cm)': 'product_length',
  '宽(cm)': 'product_width',
  '高(cm)': 'product_height',
  '条形码': 'barcode',
  '保质期（若没有保质期填-1）': 'shelf_life',
  '商品规格（最多40字）': 'specification',
  '销售指导价(>0数字，最多2位小数)': 'guide_price',
};

router.post('/import-step1', excelUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传 Excel 文件' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (rows.length === 0) return res.status(400).json({ success: false, error: '表格中没有数据' });

    // ---------- 解析内嵌图片 ----------
    const { images: embeddedImages, error: imgParseError } = parseImagesFromXlsx(req.file.buffer);
    if (imgParseError) console.warn('[Step1 Import] 图片解析警告:', imgParseError);
    console.log(`[Step1 Import] 解析到 ${embeddedImages.length} 张内嵌图片`);
    // 表头占 1 行，数据从 1 开始
    const imageRowMap = groupImagesByDataRow(embeddedImages, 1);

    const baseDir = pathLib.join(__dirname, '..', '..', 'uploads', 'products');
    fs.mkdirSync(baseDir, { recursive: true });

    const getVal = (row, key) => {
      const v = row[key];
      return v !== undefined && v !== null ? String(v).trim() : '';
    };

    const insertStmt = db.prepare(
      `INSERT INTO products (name, display_name, invoice_name, brand, model, unit,
        price, sub_category_code, record_type, record_number, supplier_sku,
        supplier_remark, tag_price, description, weight, product_length,
        product_width, product_height, barcode, shelf_life, specification,
        guide_price, cr_sku, product_code, source_platform, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', 'inactive')`
    );

    const insertImageStmt = db.prepare(
      'INSERT INTO product_images (product_id, image_url, original_url, image_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    const updateProductImagesStmt = db.prepare(
      'UPDATE products SET main_image = ?, main_images = ?, detail_images = ? WHERE id = ?'
    );

    let created = 0; const errors = []; const createdSkus = [];
    let totalImages = 0;
    const insertTx = db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const seq = parseInt(getVal(row, '序号(必填)')) || (i + 1);
        const vals = {};
        for (const [h, c] of Object.entries(STEP1_COL_MAP)) vals[c] = getVal(row, h);
        const name = vals.display_name || vals.invoice_name || '未命名商品';
        // 单品编码仅使用模板中的单品编码字段，不再用品牌-型号兜底生成
        const productCode = getVal(row, '单品编码');
        // cr_sku：优先查找同条码已有产品的真实 SKU，否则自动生成品牌-型号
        let autoCrSku = '';
        if (vals.barcode) {
          const existSku = db.prepare(
            "SELECT cr_sku FROM products WHERE barcode = ? AND cr_sku != '' AND cr_sku NOT LIKE '%-%' ORDER BY id DESC LIMIT 1"
          ).get(vals.barcode);
          autoCrSku = existSku ? existSku.cr_sku : '';
        }
        if (!autoCrSku) {
          autoCrSku = (vals.brand && vals.model) ? `${vals.brand}-${vals.model}` : '';
        }
        try {
          const result = insertStmt.run(
            name, vals.display_name, vals.invoice_name,
            vals.brand, vals.model, vals.unit,
            vals.price || null, vals.sub_category_code,
            vals.record_type, vals.record_number,
            vals.supplier_sku, vals.supplier_remark,
            vals.tag_price || null, vals.description,
            vals.weight || null, vals.product_length,
            vals.product_width, vals.product_height,
            vals.barcode, vals.shelf_life,
            vals.specification, vals.guide_price || null, autoCrSku, productCode
          );
          const productId = result.lastInsertRowid;

          // 处理该行的内嵌图片（按 data 行号匹配）
          const rowImages = imageRowMap.get(i) || [];
          const mainUrls = [];
          const detailUrls = [];
          if (rowImages.length > 0) {
            const productImgDir = pathLib.join(baseDir, String(productId));
            fs.mkdirSync(productImgDir, { recursive: true });
            // 取条形码作为图片命名前缀，没有则用 productId
            const baseCode = (vals.barcode || String(productId)).replace(/[\/\\:*?"<>|]/g, '_').substring(0, 30);
            rowImages.forEach((img, imgIdx) => {
              try {
                // 与 import-excel-v2 保持一致：前 5 张为主图(11~15)，之后为详情图(21~26)
                const imgType = imgIdx < 5 ? 'main' : 'detail';
                const sortOrder = imgIdx < 5 ? imgIdx + 1 : imgIdx - 4;
                const suffix = imgIdx < 5 ? (11 + imgIdx) : (21 + (imgIdx - 5));
                const filename = `${baseCode}_${suffix}${img.ext || '.png'}`;
                fs.writeFileSync(pathLib.join(productImgDir, filename), img.buffer);
                const localUrl = `/uploads/products/${productId}/${filename}`;
                insertImageStmt.run(productId, localUrl, null, imgType, sortOrder);
                if (imgType === 'main') mainUrls.push(localUrl); else detailUrls.push(localUrl);
                totalImages++;
              } catch (imgErr) {
                console.error(`[Step1 Import] 保存图片失败 (商品 ${name}):`, imgErr.message);
              }
            });
            if (mainUrls.length > 0 || detailUrls.length > 0) {
              updateProductImagesStmt.run(
                mainUrls[0] || '',
                JSON.stringify(mainUrls),
                JSON.stringify(detailUrls),
                productId
              );
            }
          }

          createdSkus.push({ seq, productCode, brand: vals.brand, model: vals.model, name, imageCount: rowImages.length });
          created++;
        } catch (e) { errors.push(`第${seq}行: ${e.message}`); }
      }
    });
    insertTx();
    res.json({ success: true, created, errors, total: rows.length, skus: createdSkus, totalImages });
  } catch (err) { console.error('[Step1 Import]', err.message); res.status(500).json({ success: false, error: err.message }); }
});

// ====== 第二步导入：商品补充信息（Template 2） ======
const STEP2_COL_MAP = {
  '单品编码(必填)': 'product_code',   // 单品编码需手动填入，独立字段
  'sku编号(必填)': 'cr_sku',          // sku编号写入 cr_sku（兼容旧模板）
  '单品编码': 'product_code',         // 兼容不带(必填)后缀的旧模板
  '商品尚未新增审核通过(是，否)': 'approval_status',
  '专区上架价格(必填)': 'cr_price',
  '客户大类(填写名称)(必填)': 'cr_category_l1',
  '客户中类(填写名称)(必填)': 'cr_category_l2',
  '客户小类(填写名称)(必填)': 'cr_category_l3',
  '一级分类(填写编码)(必填)': 'jd_category_l1',
  '二级分类(填写编码)(必填)': 'jd_category_l2',
  '三级分类(填写编码)(必填)': 'jd_category_l3',
  '条形码（69码）(必填)': 'barcode',
  '重量（kg）(必填)': 'weight',
  '总库存(必填)': 'stock',
  '电商名称(必填)': 'shop_name',
  '比价链接(必填)': 'source_url',
  '比价链接价格(必填)': 'link_price',
  '包装单位(必填)': 'unit',
  '商品别名(选填)': 'product_alias',
  '品牌名称(必填)': 'brand',
  '预计到货周期（天）(必填)': 'delivery_cycle',
  '预计发货周期（天）(必填)': 'shipping_cycle',
  '起订量(必填)': 'min_order_qty',
  '货号/型号(必填)': 'model',
  '规格(必填)': 'specification',
  '长（cm）(必填)': 'product_length',
  '宽（cm）(必填)': 'product_width',
  '高（cm）(必填)': 'product_height',
  '商品质保期（月）(必填)': 'warranty_period',
  '重量单位(必填)': 'weight_unit',
  '产地三级编码(必填)': 'origin_code',
  '退货类型(必填)': 'return_type',
  '退货时长（日）(必填)': 'return_period',
  '换货类型(必填)': 'exchange_type',
  '换货时长（日）(必填)': 'exchange_period',
  '单位名称(必填)': 'unit_name',
  '单位编码(必填)': 'unit_code',
  '是否信创商品(选填)': 'is_xinchuang',
};

router.post('/import-step2', excelUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传 Excel 文件' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (rows.length === 0) return res.status(400).json({ success: false, error: '表格中没有数据' });

    const getVal = (row, key) => {
      const v = row[key];
      return v !== undefined && v !== null ? String(v).trim() : '';
    };

    // 多键匹配：sku编号(cr_sku) → 条码 → 品牌+型号（取最新产品）
    const findProductByCrSku = db.prepare('SELECT id FROM products WHERE cr_sku = ? AND cr_sku != \'\' ORDER BY id DESC LIMIT 1');
    const findProductByBarcode = db.prepare('SELECT id FROM products WHERE barcode = ? ORDER BY id DESC LIMIT 1');
    const findProductByBrandModel = db.prepare(
      "SELECT id FROM products WHERE brand||'-'||model = ? OR brand||'-'||model = ?||'-'||? ORDER BY id DESC LIMIT 1");
    const updateStmt = db.prepare(
      `UPDATE products SET
        cr_sku = CASE WHEN ? != '' THEN ? ELSE cr_sku END,
        product_code = CASE WHEN ? != '' THEN ? ELSE product_code END,
        approval_status = ?, cr_price = ?,
        cr_category_l1 = ?, cr_category_l2 = ?, cr_category_l3 = ?,
        jd_category_l1 = ?, jd_category_l2 = ?, jd_category_l3 = ?,
        category_id = ?,
        barcode = ?, weight = ?, stock = ?, shop_name = ?,
        source_url = ?, link_price = ?, unit = ?, product_alias = ?,
        brand = ?, delivery_cycle = ?, shipping_cycle = ?, min_order_qty = ?,
        model = ?, specification = ?, product_length = ?, product_width = ?,
        product_height = ?, warranty_period = ?, weight_unit = ?,
        origin_code = ?, return_type = ?, return_period = ?,
        exchange_type = ?, exchange_period = ?, unit_name = ?, unit_code = ?,
        is_xinchuang = ?
       WHERE id = ?`
    );

    let updated = 0, skipped = 0; const errors = []; const details = [];
    const updateTx = db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const seq = parseInt(getVal(row, '序号(必填)')) || (i + 1);
        const productCode = getVal(row, '单品编码') || getVal(row, '单品编码(必填)');
        const crSku = getVal(row, 'sku编号(必填)');

        // 解析所有字段
        const vals = {};
        for (const [h, c] of Object.entries(STEP2_COL_MAP)) vals[c] = getVal(row, h);

        // sku编号和单品编码是两个独立字段，不可混淆
        // 单品编码在Step1为空，Step2时由用户手动填入后写入product_code
        // 匹配逻辑：用 sku编号(cr_sku) → 条码 → 品牌+型号

        // 多键匹配：条码 → 品牌+型号 → cr_sku
        // Step1自动生成 cr_sku="品牌-型号"，Step2的sku编号即将更新到 cr_sku，不能先按cr_sku匹配
        let found = undefined;
        let matchKey = '';
        if (vals.barcode) {
          found = findProductByBarcode.get(vals.barcode);
          matchKey = 'barcode';
        }
        if (!found && vals.brand && vals.model) {
          found = findProductByBrandModel.get(`${vals.brand}-${vals.model}`, vals.brand, vals.model);
          matchKey = 'brand_model';
        }
        if (!found && crSku) {
          found = findProductByCrSku.get(crSku);
          matchKey = 'cr_sku';
        }
        if (!found) {
          skipped++;
          errors.push(`第${seq}行: sku编号"${crSku}"、条码和品牌+型号均未匹配到商品`);
          details.push({ seq, productCode, crSku, status: 'skipped', reason: '未匹配到商品' });
          continue;
        }

        // 自动映射分类：根据国铁类目(cr_category)匹配预定义分类
        if (vals.cr_category_l1 || vals.cr_category_l2 || vals.cr_category_l3) {
          let mapped = autoMapCategory(
            vals.cr_category_l1, vals.cr_category_l2, vals.cr_category_l3);
          // 国铁类目映射失败时，尝试用京东类目编码进行匹配
          if (!mapped && (vals.jd_category_l1 || vals.jd_category_l2)) {
            mapped = autoMapCategory(
              vals.jd_category_l1, vals.jd_category_l2, vals.jd_category_l3);
          }
          if (mapped) vals.category_id = mapped;
        }

        try {
          updateStmt.run(
            crSku, crSku,  // cr_sku
            productCode, productCode,  // product_code（单品编码，独立字段）
            vals.approval_status, vals.cr_price || null,
            vals.cr_category_l1, vals.cr_category_l2, vals.cr_category_l3,
            vals.jd_category_l1, vals.jd_category_l2, vals.jd_category_l3,
            vals.category_id || null,
            vals.barcode, vals.weight || null, vals.stock || 0, vals.shop_name,
            vals.source_url, vals.link_price || null, vals.unit, vals.product_alias,
            vals.brand, vals.delivery_cycle, vals.shipping_cycle, vals.min_order_qty,
            vals.model, vals.specification, vals.product_length, vals.product_width,
            vals.product_height, vals.warranty_period, vals.weight_unit,
            vals.origin_code, vals.return_type, vals.return_period,
            vals.exchange_type, vals.exchange_period, vals.unit_name, vals.unit_code,
            vals.is_xinchuang, found.id
          );
          updated++;
          details.push({ seq, productCode, crSku, status: 'updated', matchKey, id: found.id });
        } catch (e) {
          errors.push(`第${seq}行: ${e.message}`);
          details.push({ seq, productCode, crSku, status: 'error', reason: e.message });
        }
      }
    });
    updateTx();
    res.json({ success: true, updated, skipped, errors, total: rows.length, details });
  } catch (err) { console.error('[Step2 Import]', err.message); res.status(500).json({ success: false, error: err.message }); }
});

// ====== Step 2 预览接口：查看匹配情况（不实际更新） ======
router.post('/import-step2/preview', excelUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传 Excel 文件' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (rows.length === 0) return res.status(400).json({ success: false, error: '表格中没有数据' });

    const getVal = (row, key) => {
      const v = row[key];
      return v !== undefined && v !== null ? String(v).trim() : '';
    };

    const findProductByCode = db.prepare('SELECT id, name, product_code FROM products WHERE product_code = ? ORDER BY id DESC LIMIT 1');
    const findProductByBarcode = db.prepare('SELECT id, name, product_code FROM products WHERE barcode = ? ORDER BY id DESC LIMIT 1');
    const findProductByBrandModel = db.prepare(
      "SELECT id, name, product_code FROM products WHERE brand||'-'||model = ? ORDER BY id DESC LIMIT 1");

    const details = []; let matchedCount = 0, unmatchedCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const seq = parseInt(getVal(row, '序号(必填)')) || (i + 1);
      const productCode = getVal(row, '单品编码');
      const crSku = getVal(row, 'sku编号(必填)');
      const brand = getVal(row, '品牌名称(必填)');
      const model = getVal(row, '货号/型号(必填)');
      const barcode = getVal(row, '条形码（69码）(必填)');
      const inputCode = productCode || crSku;

      let found, matchKey;
      found = inputCode ? findProductByCode.get(inputCode) : undefined;
      matchKey = '单品编码/sku编号';
      if (!found && barcode) {
        found = findProductByBarcode.get(barcode);
        matchKey = '条码';
      }
      if (!found && brand && model) {
        found = findProductByBrandModel.get(`${brand}-${model}`);
        matchKey = '品牌+型号';
      }

      details.push({
        seq,
        productCode,
        crSku,
        brand,
        matched: !!found,
        matchKey: found ? matchKey : undefined,
        productName: found ? found.name : undefined,
        productId: found ? found.id : undefined,
      });
      if (found) matchedCount++;
      else unmatchedCount++;
    }

    res.json({ success: true, total: rows.length, matchedCount, unmatchedCount, details });
  } catch (err) { console.error('[Step2 Preview]', err.message); res.status(500).json({ success: false, error: err.message }); }
});

/**
 * POST /api/products/import-excel-v2
 * Excel 批量导入（含内嵌图片解析）
 *
 * 支持 Excel 单元格中插入的图片对象（非URL文本）
 * 解析 xlsx ZIP 结构，提取 xl/media/ 图片并映射到对应商品行
 *
 * FormData:
 *   - file: 原始 xlsx 文件（required）
 *   - data: JSON 字符串数组，编辑后的行数据（optional，不传则直接从 xlsx 解析）
 *
 * 支持的图片格式: jpg, jpeg, png, webp, gif
 */
router.post('/import-excel-v2', excelUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请上传 Excel 文件' });
    }

    // ---------- 1. 解析编辑后的数据（JSON） ----------
    let rows = [];
    if (req.body.data) {
      try {
        rows = JSON.parse(req.body.data);
        if (!Array.isArray(rows)) {
          return res.status(400).json({ success: false, error: 'data 格式错误，应为 JSON 数组' });
        }
      } catch (e) {
        return res.status(400).json({ success: false, error: 'data JSON 解析失败: ' + e.message });
      }
    }

    // 如果没传 data，从 xlsx 本身解析
    if (rows.length === 0) {
      try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      } catch (e) {
        return res.status(400).json({ success: false, error: 'Excel 数据解析失败: ' + e.message });
      }
    }

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Excel 中没有商品数据' });
    }

    // ---------- 2. 解析内嵌图片 ----------
    const COL_TO_DB = {
      '品牌': 'brand',
      '商品名称': 'name',
      '型号': 'model',
      '单位': 'unit',
      '条码': 'barcode',
      '国铁售价': 'cr_price',
      '实际京东价': 'price',
      '国铁一级类目': 'cr_category_l1',
      '国铁二级类目': 'cr_category_l2',
      '国铁三级类目': 'cr_category_l3',
      '京东一级类目': 'jd_category_l1',
      '京东二级类目': 'jd_category_l2',
      '京东三级类目': 'jd_category_l3',
    };

    const { images, error: imgParseError } = parseImagesFromXlsx(req.file.buffer);
    if (imgParseError) {
      console.warn('[ImportV2] 图片解析警告:', imgParseError);
    }

    console.log(`[ImportV2] 解析到 ${images.length} 张内嵌图片`);

    // 按数据行分组（表头占1行）
    const imageRowMap = groupImagesByDataRow(images, 1);

    // ---------- 3. 保存图片到本地 & 插入商品 ----------
    const baseDir = pathLib.join(__dirname, '..', '..', 'uploads', 'products');
    fs.mkdirSync(baseDir, { recursive: true });

    let inserted = [];
    let failed = [];
    let totalSavedImages = 0;

    // 检测是否为新模板（通过第一行数据的字段名判断）
    const firstRow = rows[0] || {};
    const isNewTemplate = (() => {
      const keys = Object.keys(firstRow);
      return keys.some(k => k.includes('sku编号') || k.includes('客户大类') || k.includes('序号'));
    })();

    const insertStmt = isNewTemplate ? db.prepare(`
      INSERT INTO products (
        name, display_name, brand, model, unit, barcode, cr_sku,
        cr_price, price, link_price,
        cr_category_l1, cr_category_l2, cr_category_l3,
        jd_category_l1, jd_category_l2, jd_category_l3,
        shop_name, source_url, weight, stock,
        approval_status, product_alias, delivery_cycle, shipping_cycle, min_order_qty,
        specification, product_length, product_width, product_height,
        warranty_period, weight_unit, origin_code,
        return_type, return_period, exchange_type, exchange_period,
        unit_name, unit_code, is_xinchuang, product_code,
        main_image, main_images, detail_images, status, source_platform, category_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `) : db.prepare(`
      INSERT INTO products (
        name, display_name, brand, model, unit, barcode, cr_sku,
        cr_price, price,
        cr_category_l1, cr_category_l2, cr_category_l3,
        jd_category_l1, jd_category_l2, jd_category_l3,
        main_image, main_images, detail_images, status, source_platform, category_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertImageStmt = db.prepare(
      'INSERT INTO product_images (product_id, image_url, original_url, image_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    );

    const insertTransaction = db.transaction((productRows) => {
      const insertedIds = [];

      for (let i = 0; i < productRows.length; i++) {
        const row = productRows[i];
        try {
          let name, displayName, brand, model, unit, barcode, crPrice, price, linkPrice;
          let crL1, crL2, crL3, jdL1, jdL2, jdL3;
          let shopName, sourceUrl, weight, stock;
          let params, mappedCategoryId;

          if (isNewTemplate) {
            const productCodeVal = String(row['sku编号(必填)'] || row['单品编码'] || '').trim();
            crL1 = String(row['客户大类(填写名称)(必填)'] || row['cr_category_l1'] || '');
            crL2 = String(row['客户中类(填写名称)(必填)'] || row['cr_category_l2'] || '');
            crL3 = String(row['客户小类(填写名称)(必填)'] || row['cr_category_l3'] || '');
            jdL1 = String(row['一级分类(填写编码)(必填)'] || row['jd_category_l1'] || '');
            jdL2 = String(row['二级分类(填写编码)(必填)'] || row['jd_category_l2'] || '');
            jdL3 = String(row['三级分类(填写编码)(必填)'] || row['jd_category_l3'] || '');
            mappedCategoryId = autoMapCategory(crL1, crL2, crL3);

            name = productCodeVal || String(row['品牌名称(必填)'] || '') || '新品';
            displayName = name;
            brand = String(row['品牌名称(必填)'] || row['brand'] || '');
            model = String(row['货号/型号(必填)'] || row['model'] || '');
            unit = String(row['包装单位(必填)'] || row['unit'] || '');
            barcode = String(row['条形码（69码）(必填)'] || row['barcode'] || '');
            crPrice = parseFloat(row['专区上架价格(必填)'] || row['cr_price'] || 0) || 0;
            price = crPrice;
            linkPrice = parseFloat(row['比价链接价格(必填)'] || row['link_price'] || 0) || 0;
            shopName = String(row['电商名称(必填)'] || row['shop_name'] || '');
            sourceUrl = String(row['比价链接(必填)'] || row['source_url'] || '');
            weight = parseFloat(row['重量（kg）(必填)'] || row['weight'] || 0) || null;
            stock = parseInt(row['总库存(必填)'] || row['stock'] || 0) || 0;

            params = [
              name, displayName, brand, model, unit, barcode, '', // cr_sku 留空
              crPrice, price, linkPrice,
              crL1, crL2, crL3, jdL1, jdL2, jdL3,
              shopName, sourceUrl, weight, stock,
              String(row['商品尚未新增审核通过(是，否)'] || ''),
              String(row['商品别名(选填)'] || ''),
              String(row['预计到货周期（天）(必填)'] || ''),
              String(row['预计发货周期（天）(必填)'] || ''),
              String(row['起订量(必填)'] || ''),
              String(row['规格(必填)'] || ''),
              String(row['长（cm）(必填)'] || ''),
              String(row['宽（cm）(必填)'] || ''),
              String(row['高（cm）(必填)'] || ''),
              String(row['商品质保期（月）(必填)'] || ''),
              String(row['重量单位(必填)'] || ''),
              String(row['产地三级编码(必填)'] || ''),
              String(row['退货类型(必填)'] || ''),
              String(row['退货时长（日）(必填)'] || ''),
              String(row['换货类型(必填)'] || ''),
              String(row['换货时长（日）(必填)'] || ''),
              String(row['单位名称(必填)'] || ''),
              String(row['单位编码(必填)'] || ''),
              String(row['是否信创商品(选填)'] || ''),
              productCodeVal,
              '', '[]', '[]', 'inactive', 'excel_import', mappedCategoryId,
            ];
          } else {
            name = String(row['商品名称'] || row['name'] || '').trim();
            if (!name) {
              failed.push({ row: i + 1, error: '商品名称为空' });
              continue;
            }

            crL1 = String(row['国铁一级类目'] || row['cr_category_l1'] || '');
            crL2 = String(row['国铁二级类目'] || row['cr_category_l2'] || '');
            crL3 = String(row['国铁三级类目'] || row['cr_category_l3'] || '');
            mappedCategoryId = autoMapCategory(crL1, crL2, crL3);

            params = [
              name,
              String(row['商品名称'] || row['name'] || ''),
              String(row['品牌'] || row['brand'] || ''),
              String(row['型号'] || row['model'] || ''),
              String(row['单位'] || row['unit'] || ''),
              String(row['条码'] || row['barcode'] || ''),
              String(row['国铁SKU'] || row['cr_sku'] || ''),
              parseFloat(row['国铁售价'] || row['cr_price'] || 0) || 0,
              parseFloat(row['实际京东价'] || row['price'] || 0) || 0,
              crL1, crL2, crL3,
              String(row['京东一级类目'] || row['jd_category_l1'] || ''),
              String(row['京东二级类目'] || row['jd_category_l2'] || ''),
              String(row['京东三级类目'] || row['jd_category_l3'] || ''),
              '', '[]', '[]', 'inactive', 'excel_import', mappedCategoryId,
            ];
          }

          const result = insertStmt.run(...params);
          const productId = result.lastInsertRowid;
          barcode = barcode || String(row['条码'] || row['barcode'] || productId).trim();

          // ---------- 处理该行的内嵌图片 ----------
          const rowImages = imageRowMap.get(i) || [];
          const mainUrls = [];
          const detailUrls = [];

          if (rowImages.length > 0) {
            const productImgDir = pathLib.join(baseDir, String(productId));
            fs.mkdirSync(productImgDir, { recursive: true });

            rowImages.forEach((img, imgIdx) => {
              try {
                // 图片命名规则：编号+11~15（主图），编号+21~26（详情图）
                const safeBarcode = barcode.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 30);
                const imgType = imgIdx < 5 ? 'main' : 'detail';
                const sortOrder = imgIdx < 5 ? imgIdx + 1 : imgIdx - 4;
                const suffix = imgIdx < 5 ? (11 + imgIdx) : (21 + (imgIdx - 5));
                const filename = `${safeBarcode}_${suffix}${img.ext}`;
                const filePath = pathLib.join(productImgDir, filename);
                fs.writeFileSync(filePath, img.buffer);

                const localUrl = `/uploads/products/${productId}/${filename}`;

                insertImageStmt.run(productId, localUrl, null, imgType, sortOrder);

                if (imgType === 'main') {
                  mainUrls.push(localUrl);
                } else {
                  detailUrls.push(localUrl);
                }

                totalSavedImages++;
              } catch (imgErr) {
                console.error(`[ImportV2] 保存图片失败 (商品 ${name}):`, imgErr.message);
              }
            });

            // 更新产品的图片字段
            const mainImage = mainUrls.length > 0 ? mainUrls[0] : '';
            db.prepare(
              'UPDATE products SET main_image = ?, main_images = ?, detail_images = ? WHERE id = ?'
            ).run(
              mainImage,
              JSON.stringify(mainUrls),
              JSON.stringify(detailUrls),
              productId
            );
          }

          inserted.push({
            id: productId,
            name,
            imageCount: rowImages.length,
          });
          insertedIds.push(productId);
        } catch (rowErr) {
          console.error(`[ImportV2] 行 ${i + 1} 插入失败:`, rowErr.message);
          failed.push({ row: i + 1, error: rowErr.message });
        }
      }

      return insertedIds;
    });

    const insertedIds = insertTransaction(rows);

    res.json({
      success: true,
      data: {
        total: rows.length,
        inserted: inserted.length,
        failed: failed.length,
        totalImages: images.length,
        savedImages: totalSavedImages,
        products: inserted,
        errors: failed,
      },
      message: `导入完成: ${inserted.length} 个商品, ${totalSavedImages} 张图片`,
    });
  } catch (err) {
    console.error('[ImportV2]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
