# 订单信息提取与汇总系统 - 部署指南

## 一、系统架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Web前端界面 │────▶│  Flask API   │────▶│  AI大模型API │
│  (上传PDF)   │     │  服务        │     │  (订单识别)  │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                    ┌──────▼───────┐
                    │ Excel汇总表  │
                    │ orders_summary│
                    └──────────────┘
                           
┌─────────────┐     ┌──────────────┐
│  企业微信    │────▶│ Wecom Callback│
│ (发送PDF)    │     │ (接收+识别)   │
└─────────────┘     └──────────────┘
```

## 二、环境要求

- Python 3.9+
- 可访问AI大模型API（OpenAI / 腾讯混元 等）

## 三、快速开始

### 1. 安装依赖

```bash
cd /path/to/project
pip install -r requirements.txt
```

### 2. 配置API密钥

编辑 `config.py` 文件：

```python
# 选择一种AI服务配置（推荐使用OpenAI兼容接口）
AI_API_URL = "https://api.openai.com/v1/chat/completions"
AI_API_KEY = "sk-your-api-key-here"  # 替换为你的API密钥
AI_MODEL = "gpt-4o-mini"  # 或 gpt-4o, gpt-3.5-turbo
```

**推荐方案：**
- **OpenAI**: 识别准确率高，支持多语言
- **腾讯混元**: 国内访问稳定，中文识别效果好
- **本地模型(如Ollama)**: 数据不出本地，适合敏感订单

### 3. 启动服务

```bash
python app.py
```

服务启动后访问：`http://localhost:5000`

### 4. 使用方式

#### 方式一：Web界面（推荐）
1. 打开浏览器访问 `http://localhost:5000`
2. 拖拽或点击上传PDF文件
3. 点击"开始识别订单信息"
4. 查看识别结果，可手动编辑修正
5. 点击"导出Excel"下载汇总表

#### 方式二：API接口
```bash
# 上传单个PDF
curl -X POST http://localhost:5000/api/orders/upload \
  -H "X-API-Key: order-admin-2024" \
  -F "file=@订单.pdf"

# 获取订单列表
curl http://localhost:5000/api/orders?search=关键词 \
  -H "X-API-Key: order-admin-2024"

# 导出Excel
curl http://localhost:5000/api/export?api_key=order-admin-2024 \
  -o 订单汇总.xlsx
```

## 四、企业微信部署

### 方案一：企业微信应用（推荐，功能完整）

#### 步骤1：创建企业微信应用

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入「应用管理」→「自建」→「创建应用」
3. 填写应用名称（如：订单管理助手）、上传Logo
4. 记录以下信息：
   - Corp ID（企业ID）
   - Agent ID（应用ID）
   - Secret（应用密钥）

#### 步骤2：配置接收消息

1. 在应用详情页 →「接收消息」→「设置API接收」
2. URL填写：`https://你的域名/api/wecom/callback`
3. Token和EncodingAESKey随机生成，记录到config.py
4. 点击保存（需要先启动服务才能验证）

#### 步骤3：配置config.py

```python
WECOM_CORP_ID = "ww1234567890abcdef"      # 企业ID
WECOM_AGENT_ID = "1000002"                # 应用ID  
WECOM_APP_SECRET = "your-app-secret"      # 应用密钥
WECOM_TOKEN = "your-token"                # 接收消息Token
WECOM_ENCODING_AES_KEY = "your-aes-key"   # 消息加密密钥
```

#### 步骤4：部署服务到公网

**选项A：使用CloudBase部署（推荐）**
```bash
# 使用CloudBase一键部署
```

**选项B：使用Docker部署**
```bash
docker build -t order-system .
docker run -d -p 5000:5000 \
  -v $(pwd)/data:/app/data \
  order-system
```

**选项C：使用Nginx反向代理**
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

#### 步骤5：在企业微信中使用

配置完成后，员工可以：
1. 在企业微信中找到「订单管理助手」应用
2. 直接发送PDF文件 → 自动识别并回复订单信息
3. 发送「查询 + 关键词」→ 搜索已有订单
4. 发送「统计」→ 查看汇总数据

### 方案二：群机器人Webhook（快速接入）

如果只需要在群里接收通知，可以使用群机器人：

1. 在企业微信群中 →「群设置」→「群机器人」→「添加机器人」
2. 复制Webhook地址
3. 配置到config.py：
```python
WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
```

## 五、支持的订单类型

系统通过AI识别支持以下平台订单：
- 淘宝/天猫
- 京东
- 拼多多
- 1688
- 抖音
- 微信小程序
- 其他电商平台（通过AI泛化识别）

## 六、数据存储

- 所有订单数据存储在 `orders_summary.xlsx` 中
- 可通过API导出完整Excel文件
- 支持备份和迁移

## 七、常见问题

### Q: AI识别不准确怎么办？
A: 可以手动编辑修正，在Web界面点击✏️按钮修改任何字段。

### Q: 如何处理大批量订单？
A: 支持批量上传，一次最多可上传20个PDF文件。也可通过API批量调用。

### Q: 数据安全如何保障？
A: 
- 使用API Key保护接口
- 可配置HTTPS传输加密
- 支持本地模型部署（数据不出本地）
- PDF处理完即删除，不留存原始文件
