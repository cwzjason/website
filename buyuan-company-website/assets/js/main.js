(function(){
  // 从 localStorage 读取用户信息
  var user = null;
  try {
    var raw = localStorage.getItem('buqin_user');
    if (raw) user = JSON.parse(raw);
  } catch(e) {}

  // 显示用户名
  var userEl = document.getElementById('currentUser');
  if (userEl) {
    if (user && user.name) {
      userEl.textContent = user.name;
    } else {
      userEl.textContent = '未登录';
    }
  }

  // 退出登录
  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function(e){
      e.preventDefault();
      localStorage.removeItem('buqin_user');
      localStorage.removeItem('buqin_token');
      window.location.href = 'index.html';
    });
  }

  // 暴露给全局
  window.getCurrentUser = function(){
    try {
      var r = localStorage.getItem('buqin_user');
      return r ? JSON.parse(r) : null;
    } catch(e) { return null; }
  };
})();
