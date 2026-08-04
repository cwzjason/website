# 订单信息提取与汇总系统 - 配置文件

import os
import json

# ============ AI服务配置 ============
# 使用腾讯混元 HY3（TokenHub OpenAI 兼容接口）
AI_API_URL = "https://tokenhub.tencentmaas.com/v1/chat/completions"
AI_MODEL = "hy3"
AI_PROVIDER = "hy3"  # hy3（TokenHub OpenAI 兼容）

# API Key 持久化文件（可在网页设置面板中修改）
SETTINGS_FILE = "settings.json"

def get_ai_api_key():
    """动态加载 TokenHub API Key，优先从 settings.json 读取"""
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                settings = json.load(f)
                key = settings.get("tokenhub_api_key", "").strip()
                if key and key != "your-tokenhub-key":
                    return key
        except Exception:
            pass
    env_key = os.environ.get("TENCENT_TOKENHUB_API_KEY", "")
    if env_key and env_key != "your-tokenhub-key":
        return env_key
    return ""

AI_API_KEY = get_ai_api_key()  # 模块加载时初始化

# ============ 企业微信配置 ============
# 企业微信机器人Webhook地址
WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=your-key-here"

# 企业微信应用配置（用于接收消息）
WECOM_CORP_ID = "your-corp-id"
WECOM_AGENT_ID = "your-agent-id" 
WECOM_APP_SECRET = "your-app-secret"
WECOM_TOKEN = "your-token"
WECOM_ENCODING_AES_KEY = "your-aes-key"

# ============ 服务配置 ============
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8081
UPLOAD_FOLDER = "uploads"
DATA_FILE = "orders_summary.xlsx"
MAX_FILE_SIZE_MB = 20

# ============ 平台选项 ============
PLATFORMS = ["得力", "阳采", "德致", "齐心", "其他"]

# 模版分组：得力/阳采/德致/其他 用模版A（国铁商城采购订单），齐心用模版B（齐心销售到货签收单）
TEMPLATE_A_PLATFORMS = ["得力", "阳采", "德致", "其他"]
TEMPLATE_B_PLATFORMS = ["齐心"]

# ============ 模版A（国铁商城/得力/阳采/德致/其他）订单字段定义 ============
# 字段名严格按 订单1.pdf（国铁商城采购订单）模板原生表头设计，不与齐心映射
ORDER_FIELDS_A = [
    "采购单编号",          # 采购单编号
    "需求单编号",          # 需求单编号
    "审批通过时间",        # 审批通过时间
    "收料单位",            # 收料单位
    "所属路局",            # 所属路局
    "单位编号",            # 单位编号
    "供应商名称",          # 供应商名称
    "供应商编码",          # 供应商编码
    "下单人",              # 下单人
    "收货人",              # 收货人
    "收货人联系方式",      # 收货人联系方式
    "收货地址",            # 完整收货地址
    "商品名称",            # 商品名称
    "品牌",                # 品牌
    "单位",                # 单位
    "数量",                # 数量
    "单价（含税）",        # 单价（含税）
    "合计（含税）",        # 当前行小计（单价×数量）
    "合计金额",            # 整个订单的合计金额（订单底部总计，每行相同）
    "发票备注",            # 发票备注
    "订单备注",            # 订单备注/其他备注
    "商品明细JSON"         # 多商品行时的完整明细（JSON格式）
]

# ============ 模版B（齐心）订单字段定义（独立字段体系，不与其他平台映射） ============
# 字段名严格按 DN0202603310131.pdf（深圳齐心集团销售到货签收单）模板原生表头设计
ORDER_FIELDS_B = [
    "采购单号",            # 采购单号（如1260330090500789）
    "发货日期",            # 发货日期
    "客户名称",            # 客户名称
    "客户地址",            # 客户地址
    "收货人",              # 收货人
    "联系人",              # 联系人
    "联系电话",            # 联系电话
    "送方名称",            # 送方名称
    "收货地址",            # 收货地址
    "合约单号",            # 合约单号（如LINK开头）
    "经办人",              # 经办人
    "序号",                # 序号
    "货号",                # 货号
    "产品名称",            # 产品名称（原样提取，不拆分规格）
    "单位",                # 单位
    "数量",                # 数量
    "单价",                # 单价
    "金额",                # 金额
    "金额合计（小写）",      # 金额合计（小写）
    "备注",                # 备注
    "商品明细JSON"         # 多商品行时的完整明细（JSON格式）
]

# 统一字段（兼容旧代码）
ORDER_FIELDS = ORDER_FIELDS_A
