-- 清理聊天历史中的脏数据（空消息、纯空格消息）
-- 作用：删除修复前 bug 产生的" "空消息，避免显示在聊天界面
-- 用法：sqlite3 data/schedules.db < server/clean-dirty-data.sql

-- 1. 查找匹配的空消息（用于确认）
SELECT id, openid, role, content, created_at
FROM chat_history
WHERE content IS NULL
   OR TRIM(content) = ''
   OR LENGTH(content) < 2;  -- 长度小于 2 字符（基本就是" "或单字符）

-- 2. 删除（取消下一行的注释以执行删除）
-- DELETE FROM chat_history
-- WHERE content IS NULL
--    OR TRIM(content) = ''
--    OR LENGTH(content) < 2;
