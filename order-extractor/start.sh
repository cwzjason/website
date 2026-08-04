#!/bin/bash
# 订单信息提取与汇总系统 - 一键启动脚本

set -e

echo "========================================="
echo "  订单信息提取与汇总系统"
echo "========================================="
echo ""

# 检查Python
if ! command -v python3 &> /dev/null; then
    echo "❌ 未找到Python3，请先安装Python 3.9+"
    exit 1
fi

echo "✅ Python版本: $(python3 --version)"

# 创建虚拟环境（可选）
if [ ! -d "venv" ]; then
    echo "📦 创建虚拟环境..."
    python3 -m venv venv
fi

# 激活虚拟环境
source venv/bin/activate

# 安装依赖
echo "📦 安装依赖..."
pip install -r requirements.txt -q

# 检查配置文件
if [ ! -f "config.py" ]; then
    echo "❌ 未找到config.py配置文件"
    exit 1
fi

# 检查API密钥配置
if grep -q "your-api-key-here" config.py; then
    echo "⚠️  警告: 请先在config.py中配置AI_API_KEY"
    echo "   系统将以规则匹配模式运行（准确率较低）"
    echo ""
fi

# 创建必要的目录
mkdir -p uploads

# 启动服务
echo ""
echo "🚀 启动服务..."
echo "   访问地址: http://localhost:5050"
echo "   按 Ctrl+C 停止服务"
echo ""

python3 app.py
