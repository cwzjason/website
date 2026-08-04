// ===== 出入库概览模块 =====
var _stockRange = null;
var _stockChart = null;
var _stockTheme = 'default';

function initStockPanel() {
  if (!window.ALL_DATA || Object.keys(window.ALL_DATA).length === 0) {
    setTimeout(initStockPanel, 400);
    return;
  }
  if (!_stockRange) {
    var end = new Date();
    var start = new Date();
    start.setDate(end.getDate() - 6);
    _stockRange = { start: start, end: end };
  }
  updateStockDateText();
  renderStockPanel();
  initStockThemeButtons();
}

function updateStockDateText() {
  if (!_stockRange) return;
  var s = _fmtYMD(_stockRange.start);
  var e = _fmtYMD(_stockRange.end);
  var t = document.getElementById('stockDateRangeText');
  if (t) t.textContent = s + '  -  ' + e;
}

function initStockThemeButtons() {
  document.querySelectorAll('.stock-theme-btn').forEach(function(btn) {
    if (btn.dataset.tbInit) return;
    btn.dataset.tbInit = '1';
    btn.addEventListener('click', function() {
      document.querySelectorAll('.stock-theme-btn').forEach(function(b){ b.classList.remove('active'); });
      this.classList.add('active');
      _stockTheme = this.dataset.theme;
      renderStockPanel();
    });
  });
  var dateInput = document.getElementById('stockDateRange');
  if (dateInput && !dateInput.dataset.dInit) {
    dateInput.dataset.dInit = '1';
    dateInput.addEventListener('click', openStockDateModal);
  }
}

function openStockDateModal() {
  if (document.getElementById('stockDateModal')) return;
  var modal = document.createElement('div');
  modal.className = 'stock-date-modal-bg';
  modal.id = 'stockDateModal';
  var s = _fmtYMD(_stockRange.start);
  var e = _fmtYMD(_stockRange.end);
  modal.innerHTML = '<div class="stock-date-modal">' +
    '<h4>选择日期范围</h4>' +
    '<div class="preset-row">' +
    '<span class="preset-btn" data-preset="today">今天</span>' +
    '<span class="preset-btn" data-preset="week">最近7天</span>' +
    '<span class="preset-btn" data-preset="month">最近30天</span>' +
    '<span class="preset-btn" data-preset="quarter">最近90天</span>' +
    '</div>' +
    '<div class="modal-row"><label>开始日期</label><input type="date" id="sdmStart" value="' + s + '"/></div>' +
    '<div class="modal-row"><label>结束日期</label><input type="date" id="sdmEnd" value="' + e + '"/></div>' +
    '<div class="modal-actions">' +
    '<button class="cancel-btn">取消</button>' +
    '<button class="primary">确定</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(modal);
  modal.querySelectorAll('.preset-btn').forEach(function(p) {
    p.addEventListener('click', function() {
      var end = new Date();
      var start = new Date();
      var p2 = this.dataset.preset;
      if (p2 === 'today') { /* start = end */ }
      else if (p2 === 'week') { start.setDate(end.getDate() - 6); }
      else if (p2 === 'month') { start.setDate(end.getDate() - 29); }
      else if (p2 === 'quarter') { start.setDate(end.getDate() - 89); }
      document.getElementById('sdmStart').value = _fmtYMD(start);
      document.getElementById('sdmEnd').value = _fmtYMD(end);
    });
  });
  modal.querySelector('.cancel-btn').addEventListener('click', function() { document.body.removeChild(modal); });
  modal.querySelector('.primary').addEventListener('click', function() {
    var ns = document.getElementById('sdmStart').value;
    var ne = document.getElementById('sdmEnd').value;
    if (ns && ne) {
      _stockRange = { start: _parseDateVal(ns), end: _parseDateVal(ne) };
      updateStockDateText();
      renderStockPanel();
    }
    document.body.removeChild(modal);
  });
  modal.addEventListener('click', function(ev) {
    if (ev.target === modal) document.body.removeChild(modal);
  });
}

window.exportStockData = function() {
  var data = _computeStockData();
  if (!data || !data.allDates.length) {
    alert('暂无数据');
    return;
  }
  var csv = '日期,本月出库,上月出库\n';
  for (var i = 0; i < data.allDates.length; i++) {
    csv += data.allDates[i].label + ',' + data.currentOut[i] + ',' + data.lastOut[i] + '\n';
  }
  var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = '出入库概览_' + _fmtYMD(new Date()) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
};

function _computeStockData() {
  var outKeys = ['出库数量', '出库件数', '出库', '实际出库数量', '出库合计'];
  var inKeys = ['入库数量', '入库件数', '入库', '实际入库数量', '入库合计'];
  var dateKeys = ['日期', '订单日期', '下单日期', '采购日期', '出库日期', '入库日期'];

  function findField(row, keys) {
    for (var k in row) {
      for (var i = 0; i < keys.length; i++) {
        if (k === keys[i] || k.indexOf(keys[i]) !== -1) {
          return { key: k, val: row[k] };
        }
      }
    }
    return null;
  }
  function findDateField(row) {
    for (var k in row) {
      for (var i = 0; i < dateKeys.length; i++) {
        if (k === dateKeys[i] || k.indexOf(dateKeys[i]) !== -1) {
          return { key: k, val: row[k] };
        }
      }
    }
    return null;
  }

  var currentByDay = {};
  var lastByDay = {};

  var rangeStart = _stockRange.start;
  var rangeEnd = _stockRange.end;
  var rangeDays = Math.floor((rangeEnd - rangeStart) / 86400000) + 1;

  var lastEnd = new Date(rangeStart);
  lastEnd.setDate(lastEnd.getDate() - 1);
  var lastStart = new Date(lastEnd);
  lastStart.setDate(lastStart.getDate() - (rangeDays - 1));

  function fillFromTable(tblName) {
    var tbl = window.ALL_DATA[tblName];
    if (!tbl || !tbl.rows) return;
    for (var i = 0; i < tbl.rows.length; i++) {
      var row = tbl.rows[i];
      var df = findDateField(row);
      if (!df) continue;
      var d = _parseDateVal(df.val);
      if (!d) continue;
      var of = findField(row, outKeys);
      var inf = findField(row, inKeys);
      var outV = of ? (parseFloat(of.val) || 0) : 0;
      var inV = inf ? (parseFloat(inf.val) || 0) : 0;
      if (outV === 0 && inV === 0) continue;
      if (d >= rangeStart && d <= rangeEnd) {
        var key = _fmtYMD(d);
        if (!currentByDay[key]) currentByDay[key] = { out: 0, in: 0 };
        currentByDay[key].out += outV;
        currentByDay[key].in += inV;
      } else if (d >= lastStart && d <= lastEnd) {
        var key2 = _fmtYMD(d);
        if (!lastByDay[key2]) lastByDay[key2] = { out: 0, in: 0 };
        lastByDay[key2].out += outV;
        lastByDay[key2].in += inV;
      }
    }
  }

  for (var tn in window.ALL_DATA) fillFromTable(tn);

  var allDates = [];
  var cur = new Date(rangeStart);
  while (cur <= rangeEnd) {
    allDates.push({ label: _fmtYMD(cur), date: new Date(cur) });
    cur.setDate(cur.getDate() + 1);
  }
  var lastDates = [];
  var cur2 = new Date(lastStart);
  while (cur2 <= lastEnd) {
    lastDates.push({ label: _fmtYMD(cur2), date: new Date(cur2) });
    cur2.setDate(cur2.getDate() + 1);
  }

  var currentOut = allDates.map(function(d) { return (currentByDay[d.label] && currentByDay[d.label].out) || 0; });
  var currentIn = allDates.map(function(d) { return (currentByDay[d.label] && currentByDay[d.label].in) || 0; });
  var lastOut = lastDates.map(function(d) { return (lastByDay[d.label] && lastByDay[d.label].out) || 0; });
  var lastIn = lastDates.map(function(d) { return (lastByDay[d.label] && lastByDay[d.label].in) || 0; });

  var sumCurrentOut = currentOut.reduce(function(a, b) { return a + b; }, 0);
  var sumCurrentIn = currentIn.reduce(function(a, b) { return a + b; }, 0);
  var sumLastOut = lastOut.reduce(function(a, b) { return a + b; }, 0);
  var sumLastIn = lastIn.reduce(function(a, b) { return a + b; }, 0);

  return {
    allDates: allDates,
    currentOut: currentOut,
    currentIn: currentIn,
    lastOut: lastOut,
    lastIn: lastIn,
    sumCurrentOut: sumCurrentOut,
    sumCurrentIn: sumCurrentIn,
    sumLastOut: sumLastOut,
    sumLastIn: sumLastIn
  };
}

function renderStockPanel() {
  var canvas = document.getElementById('stockChart');
  if (!canvas) return;
  var data = _computeStockData();
  if (!data) return;

  var colors = {
    default: { cur: '#0052d9', last: '#a8c5e8', bg: '#fff', grid: '#f5f5f5', tick: '#94a3b8' },
    dark: { cur: '#4096ff', last: '#5a6680', bg: '#1e293b', grid: 'rgba(255,255,255,0.06)', tick: '#94a3b8' },
    colorful: { cur: '#ff7a45', last: '#40c057', bg: '#fff', grid: '#f5f5f5', tick: '#94a3b8' }
  };
  var c = colors[_stockTheme] || colors.default;

  var labelStep = Math.max(1, Math.floor(data.allDates.length / 10));
  var labels = data.allDates.map(function(d, i) {
    if (i % labelStep === 0) return d.label.slice(5);
    return '';
  });

  var ctx = canvas.getContext('2d');
  if (_stockChart) {
    _stockChart.destroy();
    _stockChart = null;
  }

  _stockChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: '本月', data: data.currentOut, backgroundColor: c.cur, borderRadius: 2, maxBarThickness: 18 },
        { label: '上月', data: data.lastOut, backgroundColor: c.last, borderRadius: 2, maxBarThickness: 18 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          padding: 10,
          cornerRadius: 4,
          titleFont: { size: 11 },
          bodyFont: { size: 11 },
          callbacks: {
            title: function(items) {
              return data.allDates[items[0].dataIndex].label;
            },
            label: function(ctx) {
              return ctx.dataset.label + ': ' + (ctx.parsed.y || 0).toLocaleString('zh-CN');
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, color: c.tick, maxRotation: 0 },
          border: { display: false }
        },
        y: {
          beginAtZero: true,
          grid: { color: c.grid, drawBorder: false },
          ticks: { font: { size: 10 }, color: c.tick, padding: 6 },
          border: { display: false }
        }
      }
    }
  });

  // 更新右侧统计数字
  var outV = document.getElementById('stockOutValue');
  var inV = document.getElementById('stockInValue');
  var outT = document.getElementById('stockOutTrend');
  var inT = document.getElementById('stockInTrend');
  if (outV) outV.textContent = data.sumCurrentOut.toLocaleString('zh-CN');
  if (inV) inV.textContent = data.sumCurrentIn.toLocaleString('zh-CN');

  function trendBadge(badge, current, last) {
    if (last === 0) {
      badge.className = 'trend-badge';
      badge.textContent = '—';
      return;
    }
    var pct = ((current - last) / last) * 100;
    if (pct >= 0) {
      badge.className = 'trend-badge up';
      badge.textContent = ' ' + pct.toFixed(1) + '%';
    } else {
      badge.className = 'trend-badge down';
      badge.textContent = ' ' + Math.abs(pct).toFixed(1) + '%';
    }
  }
  if (outT) {
    var b = outT.querySelector('.trend-badge');
    if (b) trendBadge(b, data.sumCurrentOut, data.sumLastOut);
  }
  if (inT) {
    var b2 = inT.querySelector('.trend-badge');
    if (b2) trendBadge(b2, data.sumCurrentIn, data.sumLastIn);
  }
}
