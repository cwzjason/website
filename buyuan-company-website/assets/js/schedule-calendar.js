var CALENDAR_HTML='<!-- ===== 主体布局 ===== -->\n<div class="app-shell">\n\n  <!-- 左侧边栏 -->\n  <aside class="sidebar">\n    <!-- 新建按钮 -->\n    <button class="btn-create" id="btnCreate">\n      <span class="plus-circle">+</span> 新建日程\n    </button>\n\n    <!-- 迷你日历 -->\n    <div class="mini-cal" id="miniCal">\n      <div class="mini-cal-header">\n        <button class="mini-cal-nav" id="calPrev">◀</button>\n        <span class="mini-cal-month" id="calMonthLabel"></span>\n        <button class="mini-cal-nav" id="calNext">▶</button>\n      </div>\n      <div class="mini-cal-weekdays">\n        <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>\n      </div>\n      <div class="mini-cal-days" id="calDays"></div>\n    </div>\n\n    <!-- 筛选标签 -->\n    <div>\n      <div class="legend-title">筛选</div>\n      <div class="legend-item" data-filter="all">\n        <span class="legend-dot" style="background:var(--cal-blue)"></span> 全部日程\n        <span class="legend-count" id="cntAll">0</span>\n      </div>\n      <div class="legend-item" data-filter="today">\n        <span class="legend-dot" style="background:var(--cal-blue)"></span> 今天\n        <span class="legend-count" id="cntToday">0</span>\n      </div>\n      <div class="legend-item" data-filter="待办">\n        <span class="legend-dot" style="background:var(--cal-orange)"></span> 待办\n        <span class="legend-count" id="cntPending">0</span>\n      </div>\n      <div class="legend-item" data-filter="已完成">\n        <span class="legend-dot" style="background:var(--cal-green)"></span> 已完成\n        <span class="legend-count" id="cntDone">0</span>\n      </div>\n    </div>\n\n    <div>\n      <div class="legend-title">类型</div>\n      <div class="legend-item" data-filter="会议">\n        <span class="legend-dot" style="background:var(--cal-blue)"></span> 会议\n      </div>\n      <div class="legend-item" data-filter="任务">\n        <span class="legend-dot" style="background:var(--cal-green)"></span> 任务\n      </div>\n      <div class="legend-item" data-filter="提醒">\n        <span class="legend-dot" style="background:var(--cal-orange)"></span> 提醒\n      </div>\n    </div>\n  </aside>\n\n  <!-- 主内容区 -->\n  <main class="main-area">\n    <div class="main-header">\n      <h2 id="listTitle">全部日程</h2>\n    </div>\n    <div class="event-scroll" id="eventScroll">\n      <div class="spinner"></div>\n    </div>\n  </main>\n</div>\n\n<!-- ===== 新建弹窗 ===== -->\n<div class="modal-overlay" id="modalOverlay">\n  <div class="modal">\n    <h3>新建日程</h3>\n    <textarea id="schInput" placeholder="例如：明天下午3点和张三在会议室讨论项目方案&#10;或输入具体时间：7月30日 14:00 产品评审"></textarea>\n    <div class="modal-hint">支持自然语言，AI 自动识别时间、地点、人物</div>\n    <div class="ai-preview-box" id="schPreview"></div>\n    <div class="modal-actions">\n      <button class="btn btn-secondary" id="btnCancel">取消</button>\n      <button class="btn btn-primary" id="btnAdd">+ 添加日程</button>\n    </div>\n  </div>\n</div>\n\n<script src="/assets/js/auth-guard.js"></script>';
(function() {
  'use strict';
  var API = '/api';
  var schedules = [], currentFilter = 'all', selectedDate = null;

  // DOM
  var elScroll, elTitle, elModal, elInput, elPreview, elBtnAdd, elBtnCancel;
  var elCalDays, elCalMonthLabel, elCalNav;

  function $(s) { return document.getElementById(s); }

  /* ===== 数据加载 ===== */
  function load() {
    elScroll.innerHTML = '<div class="spinner"></div>';
    fetch(API + '/schedules?_=' + Date.now())
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (j.success) { schedules = j.data || []; renderAll(); }
        else elScroll.innerHTML = '<div class="empty-state"><span class="empty-ico">⚠️</span><h3>加载失败</h3></div>';
      })
      .catch(function() {
        elScroll.innerHTML = '<div class="empty-state"><span class="empty-ico">⚠️</span><h3>网络错误</h3></div>';
      });
  }

  /* ===== 筛选 ===== */
  function getFiltered() {
    var now = new Date();
    var todayStr = now.toDateString();
    return schedules.filter(function(s) {
      if (currentFilter === 'all') return true;
      if (currentFilter === 'today') {
        if (!s.start_time) return false;
        return new Date(s.start_time).toDateString() === todayStr;
      }
      if (currentFilter === '待办' || currentFilter === '已完成') return s.status === currentFilter;
      return s.type === currentFilter;
    });
  }

  /* ===== 按日期分组 ===== */
  function groupByDate(list) {
    var map = {};
    list.forEach(function(s) {
      var key;
      if (s.start_time) {
        var d = new Date(s.start_time);
        key = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
      } else {
        key = 'no-date';
      }
      if (!map[key]) map[key] = [];
      map[key].push(s);
    });
    // 排序：有日期的按时间排，无日期的排最后
    var keys = Object.keys(map).sort(function(a, b) {
      if (a === 'no-date') return 1;
      if (b === 'no-date') return -1;
      return a.localeCompare(b);
    });
    return keys.map(function(k) {
      var items = map[k].sort(function(a, b) {
        if (!a.start_time) return 1;
        if (!b.start_time) return -1;
        return a.start_time.localeCompare(b.start_time);
      });
      return { date: k, items: items };
    });
  }

  /* ===== 渲染事件列表 ===== */
  function renderEventList() {
    var filtered = getFiltered();

    // 如果选了日历中的某一天，只显示当天
    if (selectedDate) {
      filtered = filtered.filter(function(s) {
        if (!s.start_time) return false;
        var d = new Date(s.start_time);
        var k = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
        return k === selectedDate;
      });
      var sd = new Date(selectedDate + 'T00:00:00');
      elTitle.textContent = sd.getFullYear() + '年' + (sd.getMonth()+1) + '月' + sd.getDate() + '日';
    } else {
      if (currentFilter === 'all') elTitle.textContent = '全部日程';
      else if (currentFilter === 'today') elTitle.textContent = '今日日程';
      else if (currentFilter === '待办') elTitle.textContent = '待办日程';
      else if (currentFilter === '已完成') elTitle.textContent = '已完成日程';
      else elTitle.textContent = currentFilter + ' · 日程';
    }

    if (!filtered.length) {
      elScroll.innerHTML = '<div class="empty-state"><span class="empty-ico">📋</span><h3>暂无日程</h3><p>点击左侧「新建日程」按钮添加</p></div>';
      return;
    }

    var groups = groupByDate(filtered);
    var html = '';
    var now = new Date();
    var weekNames = ['周日','周一','周二','周三','周四','周五','周六'];

    groups.forEach(function(g) {
      var title, isWeekend = false;
      if (g.date === 'no-date') {
        title = '无日期';
      } else {
        var d = new Date(g.date + 'T00:00:00');
        var dow = d.getDay();
        isWeekend = (dow === 0 || dow === 6);
        var month = d.getMonth() + 1;
        var day = d.getDate();
        var todayStr = now.toDateString();
        var isToday = d.toDateString() === todayStr;
        title = month + '月' + day + '日 ' + weekNames[dow] + (isToday ? ' · 今天' : '');
      }

      html += '<div class="date-group">';
      html += '<div class="date-group-header">';
      html += '<div class="date-group-num' + (isWeekend ? ' weekend' : '') + '">' +
        (g.date !== 'no-date' ? g.date.split('-')[2] : '--') + '</div>';
      html += '<span class="date-group-label">' + esc(title) +
        '<small>' + g.items.length + '条</small></span>';
      html += '</div>';

      g.items.forEach(function(s) {
        var colorClass = getColorClass(s);
        var doneClass = s.status === '已完成' ? ' done' : '';
        var dt = s.start_time ? new Date(s.start_time) : null;
        var timeStr = dt ? ('0'+dt.getHours()).slice(-2) + ':' + ('0'+dt.getMinutes()).slice(-2) : '--:--';
        var duration = '';
        if (s.end_time) {
          var edt = new Date(s.end_time);
          var em = ('0'+edt.getHours()).slice(-2) + ':' + ('0'+edt.getMinutes()).slice(-2);
          duration = em;
        }

        html += '<div class="event-card ' + colorClass + doneClass + '" data-id="' + s.id + '">';
        html += '<div class="event-time-col"><div class="event-time">' + timeStr + '</div>' +
          (duration ? '<div class="event-duration">- ' + duration + '</div>' : '') + '</div>';
        html += '<div class="event-body">';
        html += '<div class="event-title">' + esc(s.title) + '</div>';
        html += '<div class="event-meta">';
        if (s.type) html += '<span>📌 ' + esc(s.type) + '</span>';
        if (s.priority === '高') html += '<span style="color:var(--cal-red)">⚠ 紧急</span>';
        if (s.person) html += '<span>👤 ' + esc(s.person) + '</span>';
        if (s.location) html += '<span>📍 ' + esc(s.location) + '</span>';
        html += '</div></div>';
        html += '<div class="event-actions">';
        if (s.status === '待办') {
          html += '<button class="event-act done-btn" data-act="done" data-id="' + s.id + '" title="完成">✓</button>';
        } else {
          html += '<button class="event-act" data-act="undo" data-id="' + s.id + '" title="恢复">↩</button>';
        }
        html += '<button class="event-act del-btn" data-act="del" data-id="' + s.id + '" title="删除">✕</button>';
        html += '</div></div>';
      });
      html += '</div>';
    });

    elScroll.innerHTML = html;
    bindCardEvents();
  }

  function getColorClass(s) {
    if (s.status === '已完成') return 'color-green';
    if (s.priority === '高') return 'color-red';
    if (s.type === '会议') return 'color-blue';
    if (s.type === '任务') return 'color-green';
    if (s.type === '提醒') return 'color-orange';
    return 'color-purple';
  }

  function bindCardEvents() {
    elScroll.querySelectorAll('.event-act').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var act = btn.dataset.act, id = btn.dataset.id;
        if (act === 'done') updateStatus(id, '已完成');
        else if (act === 'undo') updateStatus(id, '待办');
        else if (act === 'del') delSchedule(id);
      });
    });
  }

  /* ===== 迷你日历 ===== */
  var calYear, calMonth;

  function renderMiniCal() {
    var today = new Date();
    var year = calYear, month = calMonth;
    elCalMonthLabel.textContent = year + '年 ' + (month+1) + '月';

    var firstDay = new Date(year, month, 1);
    var lastDay = new Date(year, month + 1, 0);
    var startDow = firstDay.getDay(); // 0=Sun
    startDow = startDow === 0 ? 6 : startDow - 1; // 转为周一起始
    var totalDays = lastDay.getDate();

    // 收集有事件的日期
    var eventDates = {};
    schedules.forEach(function(s) {
      if (!s.start_time) return;
      var d = new Date(s.start_time);
      if (s.status === '已完成') return;
      var k = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
      eventDates[k] = true;
    });

    var html = '';
    // 填充上月
    var prevLast = new Date(year, month, 0).getDate();
    for (var i = startDow - 1; i >= 0; i--) {
      html += '<div class="mini-day other-month">' + (prevLast - i) + '</div>';
    }
    // 本月
    for (var d = 1; d <= totalDays; d++) {
      var dateKey = year + '-' + pad(month+1) + '-' + pad(d);
      var classes = ['mini-day'];
      var dd = new Date(year, month, d);
      if (dd.toDateString() === today.toDateString()) classes.push('today');
      if (dateKey === selectedDate && dd.toDateString() !== today.toDateString()) classes.push('selected');
      if (eventDates[dateKey]) classes.push('has-events');
      html += '<div class="' + classes.join(' ') + '" data-date="' + dateKey + '">' + d + '</div>';
    }
    // 填充下月
    var remaining = 42 - (startDow + totalDays); // 最多6行
    for (var n = 1; n <= remaining; n++) {
      html += '<div class="mini-day other-month">' + n + '</div>';
    }

    elCalDays.innerHTML = html;

    // 绑定点击
    elCalDays.querySelectorAll('.mini-day:not(.other-month)').forEach(function(el) {
      el.addEventListener('click', function() {
        var date = el.dataset.date;
        selectedDate = (selectedDate === date) ? null : date;
        renderMiniCal();
        renderEventList();
      });
    });
  }

  function renderAll() {
    renderMiniCal();
    renderEventList();
    updateSidebarCounts();
  }

  function updateSidebarCounts() {
    var todayStr = new Date().toDateString();
    var total = schedules.length;
    var pending = schedules.filter(function(s) { return s.status === '待办'; }).length;
    var done = schedules.filter(function(s) { return s.status === '已完成'; }).length;
    var today = schedules.filter(function(s) {
      if (!s.start_time) return false;
      return new Date(s.start_time).toDateString() === todayStr;
    }).length;
    $('cntAll').textContent = total;
    $('cntToday').textContent = today;
    $('cntPending').textContent = pending;
    $('cntDone').textContent = done;
  }

  /* ===== 操作 ===== */
  function updateStatus(id, status) {
    fetch(API + '/schedules/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status })
    }).then(function() { load(); }).catch(function() { alert('操作失败'); });
  }

  function delSchedule(id) {
    if (!confirm('确认删除这条日程？')) return;
    fetch(API + '/schedules/' + id, { method: 'DELETE' })
      .then(function() { load(); }).catch(function() { alert('删除失败'); });
  }

  function addSchedule() {
    var t = elInput.value.trim();
    if (!t) return;
    elBtnAdd.disabled = true;
    elBtnAdd.textContent = '⏳ AI 解析中...';
    fetch(API + '/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t })
    }).then(function(r) { return r.json(); })
      .then(function(j) {
        if (j.success) { closeModal(); load(); }
        else alert('添加失败: ' + (j.error || ''));
      }).catch(function() { alert('网络错误'); })
      .finally(function() {
        elBtnAdd.disabled = false;
        elBtnAdd.textContent = '+ 添加日程';
      });
  }

  function closeModal() {
    elModal.classList.remove('show');
    elInput.value = '';
    elPreview.style.display = 'none';
  }

  /* ===== AI 预览 ===== */
  var previewTimer;
  elInput && elInput.addEventListener('input', function() {
    if (!elInput) return;
    clearTimeout(previewTimer);
    var t = elInput.value.trim();
    if (!t || t.length < 3) { elPreview.style.display = 'none'; return; }
    previewTimer = setTimeout(function() {
      fetch(API + '/schedules/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t })
      }).then(function(r) { return r.json(); })
        .then(function(j) {
          if (j.success && j.data) {
            var d = j.data;
            elPreview.style.display = 'block';
            elPreview.innerHTML = '<div class="pre-title">AI 预览 · ' + esc(d.title) + '</div>' +
              (d.start_time ? '⏰ ' + d.start_time.replace('T', ' ') : '') +
              (d.type ? ' · 📌 ' + d.type : '') +
              (d.priority === '高' ? ' · ⚠ 紧急' : '') +
              (d.person ? ' · 👤 ' + d.person : '') +
              (d.location ? ' · 📍 ' + d.location : '');
          }
        });
    }, 400);
  });

  /* ===== 键盘 ===== */
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && elModal.classList.contains('show')) { closeModal(); }
  });


  /* ===== 工具函数 ===== */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  /* ===== 初始化 ===== */
  window.renderScheduleCalendar=function(){var mc=document.getElementById('mainContent');if(!mc)return;mc.innerHTML=CALENDAR_HTML;currentFilter='all';selectedDate=null;
    elScroll = $('eventScroll');
    elTitle = $('listTitle');
    elModal = $('modalOverlay');
    elInput = $('schInput');
    elPreview = $('schPreview');
    elBtnAdd = $('btnAdd');
    elBtnCancel = $('btnCancel');

    elBtnAdd && elBtnAdd.addEventListener('click', addSchedule);
    elBtnCancel && elBtnCancel.addEventListener('click', closeModal);
    elCalDays = $('calDays');
    elCalMonthLabel = $('calMonthLabel');

    var now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();

    // 新建按钮
    $('btnCreate').addEventListener('click', function() {
      elModal.classList.add('show');
      setTimeout(function() { elInput.focus(); }, 100);
    });

    // 弹窗遮罩点击关闭
    elModal.addEventListener('click', function(e) {
      if (e.target === elModal) closeModal();
    });

    // 日历导航
    $('calPrev').addEventListener('click', function() {
      calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
      renderMiniCal();
    });
    $('calNext').addEventListener('click', function() {
      calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
      renderMiniCal();
    });

    // 侧边栏筛选
    document.querySelectorAll('.sidebar .legend-item').forEach(function(el) {
      el.addEventListener('click', function() {
        currentFilter = el.dataset.filter;
        selectedDate = null;
        renderMiniCal();
        renderEventList();
      });
    });

    // 标题点击清除筛选
    elTitle.addEventListener('click', function() {
      if (selectedDate) { selectedDate = null; currentFilter = 'all'; renderAll(); }
    });
    elTitle.style.cursor = 'pointer';
    elTitle.title = '点击清除日期筛选';

    load();
};
})();