/**
 * 鉴权守卫 v3.1 — 心跳 + 自动续期 + 重试
 *
 * 核心机制:
 *   1. 关闭浏览器后自动清空 token + 心跳时间戳（关闭浏览器即登出）
 *   2. 关浏览器前写 closeTimestamp，再打开时检查心跳间隔
 *       — 间隔 <= 15 分钟: 直接恢复，免重新登录
 *       — 间隔 >  15 分钟: 强制重新登录
 *   3. 每 30 秒心跳一次，若 token 剩余 < 1 小时则调 /refresh 续期
 *   4. 续期失败: 最多重试 3 次（5s / 10s / 15s 递增）
 *       — 3 次全失败不踢人，弹出黄色警告条提示保存工作
 *   5. 每次 API 调用成功视为活跃，更新心跳
 *   6. 登录页: 已登录且心跳未超时 → 自动跳转 table.html
 *   7. 仅 table.html 为受保护页，其他页面免登录通行
 */
;(function(){
  'use strict';

  var LOGIN_URL  = '/login.html';
  var TABLE_URL  = '/table.html';
  var API_BASE   = '/api';

  // sessionStorage key
  var KEY_TOKEN      = 'token';
  var KEY_USER       = 'user';
  var KEY_HEARTBEAT  = 'lastHeartbeat';
  var KEY_CLOSE_TS   = 'closeTimestamp';
  var KEY_EXPIRES_AT = 'tokenExpiresAt';

  // 配置
  var HEARTBEAT_INTERVAL  = 30 * 1000;       // 心跳间隔 30s
  var OFFLINE_GRACE       = 15 * 60 * 1000;  // 离线宽限期 15min
  var REFRESH_THRESHOLD   = 60 * 60 * 1000;  // 剩余 < 1h 即续期
  var REFRESH_RETRY_MAX   = 3;
  var REFRESH_RETRY_DELAY = [5000, 10000, 15000]; // 5s / 10s / 15s

  // ==================== 页面判断 ====================

  function isLoginPage() {
    var p = window.location.pathname;
    return p === LOGIN_URL || p.endsWith('/login.html');
  }

  function isTablePage() {
    var p = window.location.pathname;
    return p === TABLE_URL || p.endsWith('/table.html');
  }

  // ==================== Token 工具 ====================

  function getToken() {
    return sessionStorage.getItem(KEY_TOKEN);
  }

  function setToken(token, expiresAt) {
    sessionStorage.setItem(KEY_TOKEN, token);
    sessionStorage.setItem(KEY_EXPIRES_AT, String(expiresAt));
  }

  function getExpiresAt() {
    var v = sessionStorage.getItem(KEY_EXPIRES_AT);
    return v ? parseInt(v, 10) : 0;
  }

  function hasToken() {
    return !!getToken();
  }

  function clearToken() {
    sessionStorage.removeItem(KEY_TOKEN);
    sessionStorage.removeItem(KEY_USER);
    sessionStorage.removeItem(KEY_EXPIRES_AT);
    sessionStorage.removeItem(KEY_HEARTBEAT);
    sessionStorage.removeItem(KEY_CLOSE_TS);
    sessionStorage.clear();
  }

  function getUser() {
    try { return JSON.parse(sessionStorage.getItem(KEY_USER)); } catch(e) { return null; }
  }

  // ==================== 心跳 ====================

  function updateHeartbeat() {
    sessionStorage.setItem(KEY_HEARTBEAT, String(Date.now()));
  }

  function getHeartbeat() {
    var v = sessionStorage.getItem(KEY_HEARTBEAT);
    return v ? parseInt(v, 10) : 0;
  }

  function getCloseTimestamp() {
    var v = sessionStorage.getItem(KEY_CLOSE_TS);
    return v ? parseInt(v, 10) : 0;
  }

  // 判断用户是否是"最近关闭的"（15 分钟内）
  function isRecentlyClosed() {
    var hb    = getHeartbeat();
    var close = getCloseTimestamp();

    // 没有心跳也没有关闭记录 → 有 token 就信任它（首次访问容错）
    if (hb <= 0 && close <= 0) return hasToken();

    var lastActive = Math.max(hb, close);
    var gap = Date.now() - lastActive;
    return gap < OFFLINE_GRACE;
  }

  // ==================== 鉴权核心 ====================

  function redirectToLogin() {
    if (_redirecting) return;
    _redirecting = true;
    clearToken();
    if (!isLoginPage()) {
      window.location.replace(LOGIN_URL);
    }
  }

  function logout() {
    clearToken();
    window.location.replace(LOGIN_URL);
  }

  function validateToken() {
    var t = getToken();
    if (!t) return Promise.resolve(null);
    return fetch(API_BASE + '/auth/validate?_t=' + Date.now(), { cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + t }
    })
    .then(function(r) { return r.json(); })
    .then(function(d) { return (d.valid && d.user) ? d.user : null; })
    .catch(function() { return null; });
  }

  // ==================== Token 续期 ====================

  function refreshToken(retryCount) {
    retryCount = retryCount || 0;
    var t = getToken();
    if (!t) return Promise.resolve(false);

    return fetch(API_BASE + '/auth/refresh', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + t,
        'Content-Type': 'application/json'
      }
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.success && d.token) {
        setToken(d.token, d.expiresAt);
        if (d.user) {
          sessionStorage.setItem(KEY_USER, JSON.stringify(d.user));
        }
        updateHeartbeat();
        console.log('[AuthGuard] Token 已续期');
        return true;
      }
      throw new Error('refresh failed');
    })
    .catch(function(err) {
      console.warn('[AuthGuard] 续期失败 (第' + (retryCount + 1) + '次):', err.message);
      if (retryCount < REFRESH_RETRY_MAX) {
        return new Promise(function(resolve) {
          setTimeout(function() {
            resolve(refreshToken(retryCount + 1));
          }, REFRESH_RETRY_DELAY[retryCount]);
        });
      }
      // 3 次全失败 → 弹警告，不踢人
      showExpiryWarning();
      return false;
    });
  }

  var _warningShown = false;
  var _redirecting = false;

  function showExpiryWarning() {
    if (_warningShown) return;
    _warningShown = true;

    var check = function() {
      var el = document.getElementById('auth-expiry-warning');
      if (el) return;
      if (!document.body) { setTimeout(check, 100); return; }

      var banner = document.createElement('div');
      banner.id = 'auth-expiry-warning';
      banner.style.cssText = [
        'position:fixed;top:0;left:0;right:0;z-index:99999',
        'background:#fff3cd;color:#856404;padding:12px 16px',
        'text-align:center;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif',
        'border-bottom:2px solid #ffc107;box-shadow:0 2px 8px rgba(0,0,0,0.1)'
      ].join(';');
      banner.innerHTML = '<strong>⚠ 登录凭证即将过期</strong> — 网络异常导致无法续期，请尽快保存工作并 <a href="#" onclick="AuthGuard.logout()" style="color:#856404;font-weight:bold;">重新登录</a>';
      document.body.insertBefore(banner, document.body.firstChild);
    };
    check();
  }

  function dismissExpiryWarning() {
    _warningShown = false;
    var el = document.getElementById('auth-expiry-warning');
    if (el) el.remove();
  }

  // 心跳定时器里检查是否需要续期
  function checkAndRefresh() {
    var exp = getExpiresAt();
    if (!exp) return;
    if (exp - Date.now() < REFRESH_THRESHOLD) {
      refreshToken().then(function(ok) {
        if (ok) dismissExpiryWarning();
      });
    }
  }

  // ==================== 页面阻塞式鉴权 ====================

  var _blockTimeout = null;

  function blockPage() {
    // 安全兜底：5秒后强制显示页面，防止永久白屏
    if (_blockTimeout) clearTimeout(_blockTimeout);
    _blockTimeout = setTimeout(function() {
      console.warn('[AuthGuard] 5秒兜底触发，强制显示页面');
      unblockPage();
    }, 5000);

    var s = document.createElement('style');
    s.id = 'auth-block-style';
    s.textContent = 'html.auth-blocking, html.auth-blocking body { visibility: hidden !important; }';
    document.documentElement.appendChild(s);
    document.documentElement.classList.add('auth-blocking');
  }

  function unblockPage() {
    if (_blockTimeout) { clearTimeout(_blockTimeout); _blockTimeout = null; }

    document.documentElement.classList.remove('auth-blocking');
    var s = document.getElementById('auth-block-style');
    if (s) s.remove();
  }

  function setupUserUI(user) {
    var uel = document.getElementById('currentUser');
    if (uel) uel.textContent = user.username || 'admin';
    var lbtn = document.getElementById('logoutBtn');
    if (lbtn) lbtn.addEventListener('click', logout);
  }

  function startHeartbeat() {
    updateHeartbeat();
    setInterval(function() {
      updateHeartbeat();
      checkAndRefresh();
    }, HEARTBEAT_INTERVAL);
  }

  function guardPage() {
    // —————— 登录页 ——————
    if (isLoginPage()) {
      if (!isRecentlyClosed()) {
        clearToken();
        unblockPage();
        return;
      }
      validateToken().then(function(user) {
        if (user) {
          window.location.replace(TABLE_URL);
        } else {
          clearToken();
          unblockPage();
        }
      });
      return;
    }

    // —————— 非 table.html 页 → 免登录通行 ——————
    if (!isTablePage()) {
      unblockPage();
      return;
    }

    // —————— table.html 严格守护 ——————
    // 心跳检查: 关闭超过 15 分钟 → 强制登录
    if (!isRecentlyClosed()) {
      clearToken();
      redirectToLogin();
      return;
    }

    validateToken().then(function(user) {
      if (!user) {
        redirectToLogin();
        return;
      }
      unblockPage();
      setupUserUI(user);
      startHeartbeat();
    });
  }

  // ==================== 全局 fetch 拦截 ====================

  var _origFetch = window.fetch;
  window.fetch = function(url, opts) {
    opts = opts || {};
    var urlStr = typeof url === 'string' ? url : (url.url || '');

    // 自动注入 Authorization（所有页面共享 token）
    if (urlStr.indexOf('/api/') !== -1) {
      var t = getToken();
      if (t) {
        opts.headers = opts.headers || {};
        if (opts.headers instanceof Headers) {
          if (!opts.headers.has('Authorization')) {
            opts.headers.set('Authorization', 'Bearer ' + t);
          }
        } else if (typeof opts.headers === 'object') {
          if (!opts.headers.Authorization && !opts.headers.authorization) {
            opts.headers.Authorization = 'Bearer ' + t;
          }
        }
      }
    }

    return _origFetch.call(this, url, opts).then(function(r) {
      // 401: 仅在 table.html 才触发续期和重定向（排除 refresh 自身避免死循环）
      if (r.status === 401 && isTablePage() && urlStr.indexOf('/auth/refresh') === -1) {
        if (_redirecting) return Promise.reject(new Error('redirecting'));
        return r.clone().json().then(function(d) {
          if (d.code === 'TOKEN_EXPIRED' || d.code === 'TOKEN_INVALID' || d.code === 'UNAUTHORIZED') {
            return refreshToken().then(function(ok) {
              if (!ok) {
                redirectToLogin();
                throw new Error('auth_expired');
              }
            });
          }
        }).catch(function(e) {
          if (e.message === 'auth_expired') throw e;
        }).then(function() {
          return r;
        });
      }

      // 每次成功的 API 调用 → 更新心跳
      if (r.ok && urlStr.indexOf('/api/') !== -1 && urlStr.indexOf('/auth/refresh') === -1) {
        updateHeartbeat();
      }

      return r;
    });
  };

  // ==================== 关闭 / 崩溃检测 ====================

  function onBeforeUnload() {
    sessionStorage.setItem(KEY_CLOSE_TS, String(Date.now()));
    updateHeartbeat();
  }

  // ==================== 导出 ====================

  window.AuthGuard = {
    getToken:      getToken,
    getUser:       getUser,
    clearToken:    clearToken,
    logout:        logout,
    validateToken: validateToken,
    refreshToken:  refreshToken
  };

  // ==================== 初始化 ====================
  // 立即隐藏 table.html 页面，防止未登录时数据泄露
  // 验证通过后 guardPage() 会调用 unblockPage() 显示页面
  if (isTablePage()) {
    blockPage();
  }
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', onBeforeUnload);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guardPage);
  } else {
    guardPage();
  }
})();
