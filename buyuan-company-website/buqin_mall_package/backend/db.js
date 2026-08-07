/**
 * 埠勤商贸 - SQLite 数据库模块
 * 使用 better-sqlite3 实现本地零配置数据库
 */
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();
const newCategories = require('./categories-seed');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'buqin.db');

const db = new Database(dbPath);

// 启用 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
// 启用外键约束
db.pragma('foreign_keys = ON');

console.log('[DB] SQLite 数据库已就绪:', dbPath);

// 初始化表结构
function initDatabase() {
  db.exec(`
    -- 商品分类表
    CREATE TABLE IF NOT EXISTS product_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      parent_id  INTEGER DEFAULT NULL,
      icon       TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      is_active  INTEGER DEFAULT 1 CHECK(is_active IN (0,1)),
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (parent_id) REFERENCES product_categories(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cat_parent ON product_categories(parent_id);
    CREATE INDEX IF NOT EXISTS idx_cat_sort ON product_categories(sort_order);

    -- 商品表（京东/供应商完整信息字段）
    CREATE TABLE IF NOT EXISTS products (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,                    -- 商品名称（内部管理）
      display_name    TEXT DEFAULT '',                  -- 商品展示名称
      invoice_name    TEXT DEFAULT '',                  -- 商品开票名称
      category_id     INTEGER DEFAULT NULL,
      price           REAL DEFAULT NULL,                -- 商城展示价/实际京东价
      original_price  REAL DEFAULT NULL,                -- 京东原价
      link_price      REAL DEFAULT NULL,                -- 链接价格
      suggested_price REAL DEFAULT NULL,                -- 建议面价
      cr_price        REAL DEFAULT NULL,                -- 国铁售价
      tax_code        TEXT DEFAULT '',                  -- 税收分类编码
      tax_rate        TEXT DEFAULT '',                  -- 税率
      brand           TEXT DEFAULT '',                  -- 品牌
      model           TEXT DEFAULT '',                  -- 型号
      barcode         TEXT DEFAULT '',                  -- 条码
      shop_name       TEXT DEFAULT '',                  -- 店铺名称
      shop_id         TEXT DEFAULT '',                  -- 店铺ID
      jd_item_id      TEXT DEFAULT '',                  -- 京东商品编号
      jd_category     TEXT DEFAULT '',                  -- 京东类目路径（旧）
      jd_category_l1  TEXT DEFAULT '',                  -- 京东一级类目
      jd_category_l2  TEXT DEFAULT '',                  -- 京东二级类目
      jd_category_l3  TEXT DEFAULT '',                  -- 京东三级类目
      supplier_sku    TEXT DEFAULT '',                  -- 供应商SKU编号
      supplier_remark TEXT DEFAULT '',                  -- 供应商商品备注
      restricted_note TEXT DEFAULT '',                  -- 限制品说明
      main_image      TEXT DEFAULT '',                  -- 首张主图（列表用）
      images          TEXT DEFAULT NULL,                -- 全部图片（兼容旧数据）
      main_images     TEXT DEFAULT NULL,                -- 商品主图JSON数组
      detail_images   TEXT DEFAULT NULL,                -- 商品详情图JSON数组
      specs           TEXT DEFAULT NULL,                -- 规格参数JSON
      params          TEXT DEFAULT NULL,                -- 详细参数JSON（京东参数表）
      attributes      TEXT DEFAULT NULL,                -- 商品说明/属性JSON
      description     TEXT DEFAULT '',                  -- 商品详情富文本/说明
      packaging       TEXT DEFAULT '',                  -- 包装清单
      after_sales     TEXT DEFAULT '',                  -- 售后服务
      promotion       TEXT DEFAULT '',                  -- 促销信息
      delivery        TEXT DEFAULT '',                  -- 配送信息
      weight          REAL DEFAULT NULL,                -- 重量
      unit            TEXT DEFAULT '',                  -- 单位
      stock           INTEGER DEFAULT 0,                -- 库存
      sales_count     INTEGER DEFAULT 0,                -- 销量
      rating          REAL DEFAULT NULL,                -- 评分
      review_count    INTEGER DEFAULT 0,                -- 评价数
      source_url      TEXT DEFAULT '',
      source_platform TEXT DEFAULT 'manual',
      cr_sku          TEXT DEFAULT '',
      cr_category_l1  TEXT DEFAULT '',
      cr_category_l2  TEXT DEFAULT '',
      cr_category_l3  TEXT DEFAULT '',
      status          TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      sort_order      INTEGER DEFAULT 0,
      view_count      INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now','localtime')),
      updated_at      TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prod_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_prod_status ON products(status);
    CREATE INDEX IF NOT EXISTS idx_prod_sort ON products(sort_order);
    CREATE INDEX IF NOT EXISTS idx_prod_created ON products(created_at);

    -- updated_at 自动更新触发器
    CREATE TRIGGER IF NOT EXISTS trg_products_updated_at
      AFTER UPDATE ON products
      FOR EACH ROW
    BEGIN
      UPDATE products SET updated_at = datetime('now','localtime') WHERE id = OLD.id;
    END;
  `);

  // 迁移：为旧数据库添加完整字段（ALTER TABLE ADD COLUMN 对已有库安全）
  const migrations = [
    'ALTER TABLE products ADD COLUMN display_name TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN invoice_name TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN link_price REAL DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN suggested_price REAL DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN tax_code TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN tax_rate TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN shop_name TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN shop_id TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN jd_item_id TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN jd_category TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN supplier_sku TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN supplier_remark TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN restricted_note TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN main_images TEXT DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN detail_images TEXT DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN params TEXT DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN attributes TEXT DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN packaging TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN after_sales TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN promotion TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN delivery TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN weight REAL DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN unit TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN model TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN sales_count INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN rating REAL DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN review_count INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN barcode TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN jd_category_l1 TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN jd_category_l2 TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN jd_category_l3 TEXT DEFAULT \'\'',
    // ====== 商品信息填写模板新增字段 ======
    'ALTER TABLE products ADD COLUMN approval_status TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN product_alias TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN delivery_cycle TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN shipping_cycle TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN min_order_qty TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN specification TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN product_length TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN product_width TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN product_height TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN warranty_period TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN weight_unit TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN origin_code TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN return_type TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN return_period TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN exchange_type TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN exchange_period TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN unit_name TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN unit_code TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN is_xinchuang TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN product_code TEXT DEFAULT \'\'',
    // ====== 两步模板第一步新增字段 ======
    'ALTER TABLE products ADD COLUMN sub_category_code TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN record_type TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN record_number TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN tag_price REAL DEFAULT NULL',
    'ALTER TABLE products ADD COLUMN shelf_life TEXT DEFAULT \'\'',
    'ALTER TABLE products ADD COLUMN guide_price REAL DEFAULT NULL',
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (err) {
      // 重复添加列会报错，忽略即可
      if (!err.message.includes('duplicate column')) {
        console.warn('[DB] 迁移跳过:', err.message);
      }
    }
  }
  console.log('[DB] 商品表字段迁移完成');

  // 迁移完成后再创建依赖新字段的索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prod_brand ON products(brand);
    CREATE INDEX IF NOT EXISTS idx_prod_jd_item ON products(jd_item_id);
  `);

  // ====== 商品图片独立表（v2.0） ======
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_images (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id   INTEGER NOT NULL,
      image_url    TEXT NOT NULL,                              -- 本地/COS地址
      original_url TEXT,                                       -- 京东原始URL
      image_type   TEXT NOT NULL DEFAULT 'main',               -- main / detail / attribute
      sort_order   INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pimg_product ON product_images(product_id);
    CREATE INDEX IF NOT EXISTS idx_pimg_type   ON product_images(image_type);

    -- 京东导入日志表
    CREATE TABLE IF NOT EXISTS jd_import_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      product_url  TEXT NOT NULL,
      product_id   INTEGER,
      status       TEXT DEFAULT 'success',
      error_msg    TEXT,
      main_count   INTEGER DEFAULT 0,
      detail_count INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_jdlog_product ON jd_import_logs(product_id);
  `);

  // ====== 批量图片导入任务表 ======
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_image_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT DEFAULT '',
      sku_count    INTEGER DEFAULT 0,
      status       TEXT DEFAULT 'pending' CHECK(status IN ('pending','uploading','completed','cancelled')),
      created_at   TEXT DEFAULT (datetime('now','localtime')),
      updated_at   TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS batch_image_session_skus (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        INTEGER NOT NULL,
      sku_code          TEXT NOT NULL,
      seq               INTEGER DEFAULT 0,
      product_id        INTEGER DEFAULT NULL,
      product_name      TEXT DEFAULT '',
      main_count        INTEGER DEFAULT 0,
      detail_count      INTEGER DEFAULT 0,
      screenshot_count  INTEGER DEFAULT 0,
      status            TEXT DEFAULT 'pending' CHECK(status IN ('pending','matched','partial','unmatched')),
      FOREIGN KEY (session_id) REFERENCES batch_image_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_bis_session ON batch_image_session_skus(session_id);
    CREATE INDEX IF NOT EXISTS idx_bis_sku    ON batch_image_session_skus(sku_code);
  `);

  console.log('[DB] 商品图片表 & 导入日志表 & 批量图片导入表已就绪');

  // ====== 类目表迁移：检测新旧分类结构变化，自动刷新 ======
  const catCount = db.prepare('SELECT COUNT(*) as cnt FROM product_categories').get();
  const needReseed = catCount.cnt > 0 && catCount.cnt !== newCategories.length;

  if (needReseed) {
    console.log(`[DB] 检测到类目录更新（旧 ${catCount.cnt} 条 → 新 ${newCategories.length} 条），开始迁移...`);
    db.prepare('UPDATE products SET category_id = NULL').run();
    db.prepare('DELETE FROM product_categories').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name='product_categories'").run();
    console.log('[DB] 旧分类已清除，商品 category_id 已重置。将导入新类目...');
  }

  // 预置分类数据
  const finalCount = db.prepare('SELECT COUNT(*) as cnt FROM product_categories').get();
  if (finalCount.cnt === 0) {
    const insert = db.prepare(`
      INSERT INTO product_categories (id, name, parent_id, icon, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((cats) => {
      for (const cat of cats) {
        insert.run(...cat);
      }
    });

    insertMany(newCategories);
    console.log('[DB] 已初始化 ' + newCategories.length + ' 个预设分类（14个一级类目）');
  }
}

initDatabase();

module.exports = db;
