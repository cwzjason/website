# 布源科技 - 公司官网 + 腾讯混元 HY3 API

布源科技企业官方网站，集成腾讯混元 HY3 大模型对话 API。

---

## 访问地址

**在线网址：** http://152.136.161.179/

---

## 技术架构

| 层级 | 技术 |
|------|------|
| 前端 | HTML5 + CSS3 + JavaScript（响应式设计） |
| 后端 | Node.js + Express |
| AI | 腾讯混元 HY3（TokenHub） |
| 服务器 | 腾讯云 Lighthouse 北京 |
| 进程管理 | PM2 |

---

## 页面结构

- `index.html` - 首页
- `about.html` - 关于我们
- `products.html` - 产品服务
- `contact.html` - 联系我们

---

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/hunyuan/status` | 检查 API 配置状态 |
| POST | `/api/hunyuan/chat` | 腾讯混元 HY3 对话 |

### HY3 对话示例

```bash
curl -X POST http://152.136.161.179/api/hunyuan/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "你好"}],
    "temperature": 0.9
  }'
```

---

## 环境变量

```bash
export TENCENT_TOKENHUB_API_KEY="你的TokenHub API Key"
```

获取方式：https://console.cloud.tencent.com/tokenhub/apikey

---

## 常用维护命令

```bash
# 进入项目目录
cd /www/wwwroot/buyuan-company-website

# 查看服务状态
pm2 status

# 重启服务
pm2 restart buyuan-website

# 查看日志
pm2 logs buyuan-website
```
