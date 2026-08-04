-- ============================================
-- 埠勤商贸 业务管理系统 - 数据库初始化脚本
-- 日期: 2026-07-24
-- 数据库: MariaDB 10.11+
-- ============================================

-- 创建数据库
CREATE DATABASE IF NOT EXISTS `buqin_business`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `buqin_business`;

-- ============================================
-- 1. 销售表
-- ============================================
CREATE TABLE IF NOT EXISTS `销售表` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `编号`       VARCHAR(100)  NOT NULL DEFAULT '',
  `订单编号`   VARCHAR(200)  NOT NULL DEFAULT '',
  `订单日期`   VARCHAR(50)   DEFAULT '',
  `收料单位`   VARCHAR(300)  DEFAULT '',
  `供应商名称` VARCHAR(300)  DEFAULT '',
  `单品编码`   VARCHAR(100)  DEFAULT '',
  `商品名称`   VARCHAR(300)  DEFAULT '',
  `品牌`       VARCHAR(200)  DEFAULT '',
  `单位`       VARCHAR(50)   DEFAULT '',
  `数量`       VARCHAR(50)   DEFAULT '',
  `单价（含税）`     VARCHAR(50) DEFAULT '',
  `订单小计（含税）` VARCHAR(50) DEFAULT '',
  `业绩归属`   VARCHAR(100)  DEFAULT '',
  `备注`       TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_编号 (`编号`),
  INDEX idx_订单编号 (`订单编号`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 2. 采购成本表
-- ============================================
CREATE TABLE IF NOT EXISTS `采购成本表` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `编号`           VARCHAR(100)  NOT NULL DEFAULT '',
  `订单编号`       VARCHAR(200)  NOT NULL DEFAULT '',
  `订单日期`       VARCHAR(50)   DEFAULT '',
  `单品编码`       VARCHAR(100)  DEFAULT '',
  `商品名称`       VARCHAR(300)  DEFAULT '',
  `品牌`           VARCHAR(200)  DEFAULT '',
  `单位`           VARCHAR(50)   DEFAULT '',
  `数量`           VARCHAR(50)   DEFAULT '',
  `不含税单价`     VARCHAR(50)   DEFAULT '',
  `税率`           VARCHAR(50)   DEFAULT '',
  `含税单价`       VARCHAR(50)   DEFAULT '',
  `成本小计（含税）` VARCHAR(50) DEFAULT '',
  `实际采购品牌`   VARCHAR(300)  DEFAULT '',
  `采购定金`       VARCHAR(50)   DEFAULT '',
  `采购尾款`       VARCHAR(50)   DEFAULT '',
  `供货商名称`     VARCHAR(300)  DEFAULT '',
  `联系人`         VARCHAR(100)  DEFAULT '',
  `联系电话`       VARCHAR(100)  DEFAULT '',
  `发货地址`       VARCHAR(500)  DEFAULT '',
  `物流信息`       VARCHAR(500)  DEFAULT '',
  `备注`           TEXT,
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_编号 (`编号`),
  INDEX idx_订单编号 (`订单编号`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 3. 收款表
-- ============================================
CREATE TABLE IF NOT EXISTS `收款表` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `编号`             VARCHAR(100)  NOT NULL DEFAULT '',
  `订单编号`         VARCHAR(200)  NOT NULL DEFAULT '',
  `单品编码`         VARCHAR(100)  DEFAULT '',
  `订单日期`         VARCHAR(50)   DEFAULT '',
  `收料单位`         VARCHAR(300)  DEFAULT '',
  `供应商名称`       VARCHAR(300)  DEFAULT '',
  `订单小计（含税）` VARCHAR(50)   DEFAULT '',
  `折扣率`           VARCHAR(50)   DEFAULT '',
  `服务费`           VARCHAR(50)   DEFAULT '',
  `开票金额`         VARCHAR(50)   DEFAULT '',
  `实收金额`         VARCHAR(50)   DEFAULT '',
  `成本小计（含税）` VARCHAR(50)   DEFAULT '',
  `毛利`             VARCHAR(50)   DEFAULT '',
  `税率`             VARCHAR(50)   DEFAULT '',
  `税额`             VARCHAR(50)   DEFAULT '',
  `净收入`           VARCHAR(50)   DEFAULT '',
  `回款金额`         VARCHAR(50)   DEFAULT '',
  `回款日期`         VARCHAR(50)   DEFAULT '',
  `备注`             TEXT,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_编号 (`编号`),
  INDEX idx_订单编号 (`订单编号`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. 费用表
-- ============================================
CREATE TABLE IF NOT EXISTS `费用表` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `编号`       VARCHAR(100)  NOT NULL DEFAULT '',
  `订单编号`   VARCHAR(200)  NOT NULL DEFAULT '',
  `订单日期`   VARCHAR(50)   DEFAULT '',
  `收料单位`   VARCHAR(300)  DEFAULT '',
  `单品编码`   VARCHAR(100)  DEFAULT '',
  `报销日期`   VARCHAR(50)   DEFAULT '',
  `物流费`     VARCHAR(50)   DEFAULT '',
  `搬运费`     VARCHAR(50)   DEFAULT '',
  `安装费`     VARCHAR(50)   DEFAULT '',
  `业务费`     VARCHAR(50)   DEFAULT '',
  `招待费`     VARCHAR(50)   DEFAULT '',
  `交通费`     VARCHAR(50)   DEFAULT '',
  `住宿费`     VARCHAR(50)   DEFAULT '',
  `误餐费`     VARCHAR(50)   DEFAULT '',
  `借支`       VARCHAR(50)   DEFAULT '',
  `其他`       VARCHAR(50)   DEFAULT '',
  `备注`       TEXT,
  `费用小计`   VARCHAR(50)   DEFAULT '',
  `报销人`     VARCHAR(100)  DEFAULT '',
  `审批人`     VARCHAR(100)  DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_编号 (`编号`),
  INDEX idx_订单编号 (`订单编号`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. 利润表
-- ============================================
CREATE TABLE IF NOT EXISTS `利润表` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `编号`       VARCHAR(100)  NOT NULL DEFAULT '',
  `订单编号`   VARCHAR(200)  NOT NULL DEFAULT '',
  `订单日期`   VARCHAR(50)   DEFAULT '',
  `收料单位`   VARCHAR(300)  DEFAULT '',
  `单品编码`   VARCHAR(100)  DEFAULT '',
  `净收入`     VARCHAR(50)   DEFAULT '',
  `费用小计`   VARCHAR(50)   DEFAULT '',
  `利润`       VARCHAR(50)   DEFAULT '',
  `业绩归属`   VARCHAR(100)  DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_编号 (`编号`),
  INDEX idx_订单编号 (`订单编号`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 6. 每日流水
-- ============================================
CREATE TABLE IF NOT EXISTS `每日流水` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `日期`       VARCHAR(50)   DEFAULT '',
  `订单编号`   VARCHAR(200)  DEFAULT '',
  `分类`       VARCHAR(100)  DEFAULT '',
  `费用明细`   VARCHAR(500)  DEFAULT '',
  `支出`       VARCHAR(50)   DEFAULT '',
  `收入`       VARCHAR(50)   DEFAULT '',
  `银行余额`   VARCHAR(50)   DEFAULT '',
  `备注`       TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_日期 (`日期`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 7. 承包确认单
-- ============================================
CREATE TABLE IF NOT EXISTS `承包确认单` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `月份`       VARCHAR(50)   DEFAULT '',
  `姓名`       VARCHAR(100)  DEFAULT '',
  `总利润`     VARCHAR(50)   DEFAULT '',
  `承包费`     VARCHAR(50)   DEFAULT '',
  `助理工资`   VARCHAR(50)   DEFAULT '',
  `补助`       VARCHAR(50)   DEFAULT '',
  `应得`       VARCHAR(50)   DEFAULT '',
  `备注`       TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_月份姓名 (`月份`, `姓名`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 8. 客户统计表
-- ============================================
CREATE TABLE IF NOT EXISTS `客户统计表` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `编号`             VARCHAR(100)  NOT NULL DEFAULT '',
  `订单编号`         VARCHAR(200)  NOT NULL DEFAULT '',
  `订单日期`         VARCHAR(50)   DEFAULT '',
  `收料单位`         VARCHAR(300)  DEFAULT '',
  `单品编码`         VARCHAR(100)  DEFAULT '',
  `下单姓名`         VARCHAR(100)  DEFAULT '',
  `下单人职务`       VARCHAR(100)  DEFAULT '',
  `下单人电话`       VARCHAR(100)  DEFAULT '',
  `收货人`           VARCHAR(100)  DEFAULT '',
  `收货人联系方式`   VARCHAR(100)  DEFAULT '',
  `收货地址`         VARCHAR(500)  DEFAULT '',
  `客户分级`         VARCHAR(50)   DEFAULT '',
  `备注`             TEXT,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_编号 (`编号`),
  INDEX idx_订单编号 (`订单编号`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 9. 平台结算折扣率
-- ============================================
CREATE TABLE IF NOT EXISTS `平台结算折扣率` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `平台名称`   VARCHAR(200)  DEFAULT '',
  `结算周期`   VARCHAR(100)  DEFAULT '',
  `折扣率`     VARCHAR(50)   DEFAULT '',
  `备注`       TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_平台 (`平台名称`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 表元数据（版本号管理，用于同步检测）
-- ============================================
CREATE TABLE IF NOT EXISTS `table_meta` (
  `table_name`  VARCHAR(100) PRIMARY KEY,
  `version`     BIGINT DEFAULT 0,
  `updated_at`  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 初始化所有表的版本号为 0
INSERT IGNORE INTO `table_meta` (`table_name`, `version`) VALUES
('销售表', 0),
('采购成本表', 0),
('收款表', 0),
('费用表', 0),
('利润表', 0),
('每日流水', 0),
('承包确认单', 0),
('客户统计表', 0),
('平台结算折扣率', 0);

-- ============================================
-- 完成
-- ============================================
SELECT '数据库初始化完成！共创建 9 张业务表 + 1 张元数据表。' AS message;
