/**
 * auth.js - 全局准入中间件
 * 拦截所有 /api/* 请求，验证用户是否已通过审批
 */
module.exports = function (db) {
  return function (req, res, next) {
    const openid = req.openid;

    // 无 openid → 需要先走 login 获取身份
    if (!openid) {
      return res.status(401).json({ success: false, error: '未登录', code: 'UNAUTHORIZED' });
    }

    // 查询用户准入状态
    const user = db.prepare('SELECT id, status, is_boss FROM users WHERE id = ?').get(openid);

    if (!user) {
      // 用户不存在 → 需要提交申请
      return res.status(403).json({ success: false, error: '请先提交使用申请', code: 'NOT_APPLIED' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ success: false, error: '您的使用申请正在审批中，请耐心等待', code: 'PENDING' });
    }

    if (user.status === 'rejected') {
      return res.status(403).json({ success: false, error: '您的使用申请未通过审批', code: 'REJECTED' });
    }

    if (user.status !== 'approved') {
      return res.status(403).json({ success: false, error: '未知状态，请联系管理员', code: 'UNKNOWN_STATUS' });
    }

    // 通过 → 注入身份信息
    req.isBoss = !!user.is_boss;
    next();
  };
};
