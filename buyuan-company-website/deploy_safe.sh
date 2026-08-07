#!/bin/bash
# 安全部署脚本 - 每次部署前先同步，防止覆盖他人修改
# 用法: bash deploy_safe.sh <要替换的文件列表>

cd /www/wwwroot/buyuan-company-website

echo "========================================="
echo "  安全部署检查 - $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# 1. 检查是否有未提交的修改（说明别人刚改过）
UNCOMMITTED=$(git status --porcelain | grep -v '^??' | wc -l)
if [ "$UNCOMMITTED" -gt 0 ]; then
    echo "⚠️  发现 $UNCOMMITTED 个未提交的修改（可能有人在同时编辑）:"
    git status --porcelain | grep -v '^??' | head -10
    echo ""
    echo "正在自动备份当前版本..."
    git add -A
    git commit -m "自动备份 - $(date '+%Y-%m-%d %H:%M:%S')" 2>/dev/null || true
fi

# 2. 显示最近3次提交（方便追溯谁改了什么）
echo ""
echo "📋 最近修改记录:"
git log --oneline -5
echo ""

# 3. 备份当前文件（最后一次兜底）
for f in "$@"; do
    if [ -f "$f" ]; then
        cp "$f" "${f}.last_good_$(date +%Y%m%d_%H%M%S)"
        echo "📦 已备份: $f"
    fi
done

echo ""
echo "✅ 安全检查完成，可以开始部署"
echo "   如果部署出错，用以下命令恢复:"
echo "   git log --oneline  (查看历史)"
echo "   git checkout HEAD~1 -- <文件名>  (恢复上一版本)"
