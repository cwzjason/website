#!/usr/bin/env python3
# 企业微信接入配置助手
# 用于快速配置企业微信应用

import json
import requests
import sys

def get_access_token(corp_id, corp_secret):
    """获取企业微信access_token"""
    url = f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={corp_id}&corpsecret={corp_secret}"
    resp = requests.get(url)
    data = resp.json()
    if data.get("errcode") == 0:
        return data["access_token"]
    else:
        print(f"获取token失败: {data}")
        return None

def create_menu(access_token, agent_id, server_url):
    """创建应用菜单"""
    url = f"https://qyapi.weixin.qq.com/cgi-bin/menu/create?access_token={access_token}&agentid={agent_id}"
    
    menu = {
        "button": [
            {
                "name": "📋 订单管理",
                "sub_button": [
                    {
                        "type": "click",
                        "name": "📊 查看统计",
                        "key": "ORDER_STATS"
                    },
                    {
                        "type": "click", 
                        "name": "📥 导出汇总",
                        "key": "ORDER_EXPORT"
                    },
                    {
                        "type": "view",
                        "name": "🌐 打开管理页",
                        "url": server_url
                    }
                ]
            },
            {
                "type": "click",
                "name": "📤 上传订单",
                "key": "ORDER_UPLOAD"
            },
            {
                "type": "click",
                "name": "❓ 使用帮助",
                "key": "ORDER_HELP"
            }
        ]
    }
    
    resp = requests.post(url, json=menu)
    data = resp.json()
    if data.get("errcode") == 0:
        print("✅ 应用菜单创建成功")
    else:
        print(f"❌ 菜单创建失败: {data}")

def test_webhook(webhook_url):
    """测试Webhook发送"""
    payload = {
        "msgtype": "text",
        "text": {
            "content": "✅ 订单管理系统已接入企业微信！\n\n发送PDF文件即可自动识别订单信息。"
        }
    }
    resp = requests.post(webhook_url, json=payload)
    data = resp.json()
    if data.get("errcode") == 0:
        print("✅ Webhook测试消息发送成功")
    else:
        print(f"❌ Webhook发送失败: {data}")

def main():
    print("=" * 50)
    print("  企业微信接入配置助手")
    print("=" * 50)
    print()
    
    # 获取配置
    corp_id = input("企业ID (Corp ID): ").strip()
    agent_id = input("应用ID (Agent ID): ").strip()
    corp_secret = input("应用Secret: ").strip()
    server_url = input("服务地址 (如 https://your-domain.com): ").strip()
    webhook_url = input("群机器人Webhook地址 (可选，直接回车跳过): ").strip()
    
    if not all([corp_id, agent_id, corp_secret, server_url]):
        print("❌ 请填写所有必填项")
        sys.exit(1)
    
    # 生成配置
    import secrets
    import base64
    import hashlib
    
    token = secrets.token_hex(16)
    aes_key = base64.b64encode(secrets.token_bytes(32)).decode()
    
    config = f"""
# ===== 请将以下配置填入 config.py =====

WECOM_CORP_ID = "{corp_id}"
WECOM_AGENT_ID = "{agent_id}"
WECOM_APP_SECRET = "{corp_secret}"
WECOM_TOKEN = "{token}"
WECOM_ENCODING_AES_KEY = "{aes_key}"

# 回调URL: {server_url}/api/wecom/callback
"""
    print(config)
    
    # 获取token并创建菜单
    print("正在配置企业微信应用...")
    access_token = get_access_token(corp_id, corp_secret)
    if access_token:
        create_menu(access_token, agent_id, server_url)
    
    # 测试Webhook
    if webhook_url:
        test_webhook(webhook_url)
    
    print()
    print("=" * 50)
    print("📋 后续步骤：")
    print("=" * 50)
    print(f"1. 将上方配置填入 config.py")
    print(f"2. 在企业微信管理后台设置回调URL: {server_url}/api/wecom/callback")
    print(f"3. 使用Token和AESKey完成验证")
    print(f"4. 启动服务: python app.py")
    print(f"5. 在企业微信中测试发送PDF文件")

if __name__ == "__main__":
    main()
