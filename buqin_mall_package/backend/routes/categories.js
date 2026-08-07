const express = require('express');
const router = express.Router();
const db = require('../db');

// 获取分类树（两级）
router.get('/', (req, res) => {
  try {
    const l1 = db.prepare('SELECT * FROM product_categories WHERE parent_id IS NULL ORDER BY sort_order').all();
    const result = l1.map(item => {
      const l2 = db.prepare('SELECT * FROM product_categories WHERE parent_id=? ORDER BY sort_order').all(item.id);
      item.children = l2.map(child => {
        child.children = []; // 无三级类目
        return child;
      });
      return item;
    });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取所有二级分类（用于下拉选择等）
router.get('/leaves', (req, res) => {
  try {
    const leaves = db.prepare(`
      SELECT c2.id, c2.name, c1.name as parent_name
      FROM product_categories c2
      JOIN product_categories c1 ON c2.parent_id = c1.id
      WHERE c1.parent_id IS NULL
      ORDER BY c1.sort_order, c2.sort_order
    `).all();
    res.json({ success: true, data: leaves });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ====== 客户类目树（基于 product_categories 完整分类 + 商品数量统计）======
router.get('/customer', (req, res) => {
  try {
    // 1. 按商品 cr_category 文本统计数量
    const countRows = db.prepare(`
      SELECT cr_category_l1 as l1, cr_category_l2 as l2, COUNT(*) as cnt
      FROM products
      WHERE status = 'active'
        AND (cr_category_l1 IS NOT NULL AND cr_category_l1 != '')
      GROUP BY cr_category_l1, cr_category_l2
    `).all();

    const countByL1 = new Map();
    const countByL2 = new Map();
    for (const r of countRows) {
      const l1Key = String(r.l1 || '').trim();
      const l2Key = String(r.l2 || '').trim();
      if (!l1Key) continue;
      countByL1.set(l1Key, (countByL1.get(l1Key) || 0) + r.cnt);
      if (l2Key) {
        countByL2.set(l2Key, (countByL2.get(l2Key) || 0) + r.cnt);
      }
    }

    // 2. 从 product_categories 读取完整 2 级树
    const l1Rows = db.prepare(`
      SELECT id, name, icon, sort_order
      FROM product_categories
      WHERE parent_id IS NULL
      ORDER BY sort_order, id
    `).all();

    const result = l1Rows.map(l1 => {
      const l2Rows = db.prepare(`
        SELECT id, name, sort_order
        FROM product_categories
        WHERE parent_id = ?
        ORDER BY sort_order, id
      `).all(l1.id);

      const children = l2Rows.map(l2 => ({
        id: 'l2:' + l1.id + ':' + l2.id,
        name: l2.name,
        l1: l1.name,
        l2: l2.name,
        count: countByL2.get(l2.name) || 0,
        children: []
      }));

      return {
        id: 'l1:' + l1.id,
        name: l1.name,
        l1: l1.name,
        icon: l1.icon || '📂',
        count: countByL1.get(l1.name) || children.reduce((s, c) => s + (c.count || 0), 0),
        children
      };
    });

    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
