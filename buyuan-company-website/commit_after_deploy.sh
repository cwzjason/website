#!/bin/bash
# 部署后提交脚本 - 记录每次部署
cd /www/wwwroot/buyuan-company-website

if [ -z "$1" ]; then
    MSG="部署更新 - $(date '+%Y-%m-%d %H:%M:%S')"
else
    MSG="$1 - $(date '+%Y-%m-%d %H:%M:%S')"
fi

git add -A
git commit -m "$MSG" 2>/dev/null || echo "没有变化需要提交"

echo "📝 已提交: $MSG"
echo "📊 当前版本: $(git log --oneline -1)"
