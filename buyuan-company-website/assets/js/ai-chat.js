/**
 * 埠勤商贸 AI 助手 v2
 * 混元 HY3 对话 + 悬浮拖拽按钮 + 会话上下文
 */
(function () {
  const API_BASE = "/api/hunyuan";
  const FAB_ID = "ai-fab";
  const STORAGE_KEY = "buqin_ai_fab_pos";
  const BTN_SIZE = 36;
  const MARGIN = 8;

  let fab, drawer, messagesContainer, input, sendBtn;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let dragMoved = false;

  const DRAWER_STORAGE_KEY = "buqin_ai_drawer_pos";
  let drawerDragging = false;
  let drawerDragStart = { x: 0, y: 0, left: 0, top: 0 };
  let isMaximized = false;
  // ========== 会话上下文（新增） ==========
  let conversationHistory = [];

  // ========== 拖拽逻辑 ==========
  function loadPos() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(e) { return null; } }
  function savePos(x, y) { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y })); }
  function constrain(x, y) {
    const maxX = window.innerWidth - BTN_SIZE - MARGIN;
    const maxY = window.innerHeight - BTN_SIZE - MARGIN;
    return { x: Math.max(MARGIN, Math.min(x, maxX)), y: Math.max(MARGIN, Math.min(y, maxY)) };
  }
  function setPos(x, y) {
    const p = constrain(x, y);
    fab.style.left = p.x + "px";
    fab.style.top = p.y + "px";
    return p;
  }
  function posNearSelect() {
    const searchBox = document.querySelector(".search-box");
    if (searchBox) {
      const r = searchBox.getBoundingClientRect();
      return setPos(r.right + 6, r.top + (r.height / 2) - (BTN_SIZE / 2));
    }
    return setPos(window.innerWidth - BTN_SIZE - 20, 70);
  }
  function onDown(e) {
    e.preventDefault();
    isDragging = true;
    dragMoved = false;
    fab.classList.add("dragging");
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = fab.getBoundingClientRect();
    dragOffset.x = cx - rect.left;
    dragOffset.y = cy - rect.top;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  }
  function onMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = cx - dragOffset.x;
    const dy = cy - dragOffset.y;
    if (Math.abs(dx - fab.getBoundingClientRect().left) > 3 || Math.abs(dy - fab.getBoundingClientRect().top) > 3) {
      dragMoved = true;
    }
    setPos(dx, dy);
  }
  function onUp() {
    if (!isDragging) return;
    isDragging = false;
    fab.classList.remove("dragging");
    const rect = fab.getBoundingClientRect();
    savePos(rect.left, rect.top);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onUp);
  }

  function loadDrawerPos() {
    try { return JSON.parse(localStorage.getItem(DRAWER_STORAGE_KEY)); }
    catch(e) { return null; }
  }
  function saveDrawerPos(x, y) {
    localStorage.setItem(DRAWER_STORAGE_KEY, JSON.stringify({ x, y }));
  }
  function initDrawerPos() {
    var saved = loadDrawerPos();
    if (saved) {
      drawer.style.left = saved.x + "px";
      drawer.style.top = saved.y + "px";
      drawer.style.transform = "none";
    }
  }
  function onDrawerDown(e) {
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();
    drawerDragging = true;
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    var rect = drawer.getBoundingClientRect();
    drawerDragStart = { x: cx, y: cy, left: rect.left, top: rect.top };
    document.addEventListener("mousemove", onDrawerMove);
    document.addEventListener("mouseup", onDrawerUp);
    document.addEventListener("touchmove", onDrawerMove, { passive: false });
    document.addEventListener("touchend", onDrawerUp);
  }
  function onDrawerMove(e) {
    if (!drawerDragging) return;
    e.preventDefault();
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    var nl = drawerDragStart.left + (cx - drawerDragStart.x);
    var nt = drawerDragStart.top + (cy - drawerDragStart.y);
    if (isMaximized) {
      nl = Math.max(0, Math.min(nl, window.innerWidth * 0.1));
      nt = Math.max(0, Math.min(nt, window.innerHeight * 0.06));
    } else {
      nl = Math.max(0, Math.min(nl, window.innerWidth - 400));
      nt = Math.max(0, Math.min(nt, window.innerHeight - 100));
    }
    drawer.style.left = nl + "px";
    drawer.style.top = nt + "px";
    drawer.style.transform = "none";
  }
  function onDrawerUp() {
    if (!drawerDragging) return;
    drawerDragging = false;
    var r = drawer.getBoundingClientRect();
    saveDrawerPos(r.left, r.top);
    document.removeEventListener("mousemove", onDrawerMove);
    document.removeEventListener("mouseup", onDrawerUp);
    document.removeEventListener("touchmove", onDrawerMove);
    document.removeEventListener("touchend", onDrawerUp);
  }

  // ========== 消息渲染 ==========
  function appendMsg(role, content) {
    if (!messagesContainer) return;
    const div = document.createElement("div");
    div.className = "ai-msg " + (role === "user" ? "ai-msg-user" : "ai-msg-ai");
    div.textContent = content;
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  function showLoading() {
    if (!messagesContainer) return null;
    const div = document.createElement("div");
    div.className = "ai-msg ai-msg-ai ai-loading";
    div.innerHTML = '<span class="ai-dot">●</span><span class="ai-dot">●</span><span class="ai-dot">●</span>';
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return div;
  }
  function removeLoading() {
    const el = messagesContainer ? messagesContainer.querySelector(".ai-loading") : null;
    if (el) el.remove();
  }

  // ========== 核心：发送消息（带完整上下文） ==========
  async function sendMessage() {
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    // 如果没有加载表格数据，提示用户
    if (conversationHistory.length === 0) {
      appendMsg("ai", "💡 请先点击「读取当前表格」加载表格数据，然后向我提问。");
      return;
    }

    input.value = "";
    if (sendBtn) sendBtn.disabled = true;

    // 追加用户消息到历史
    conversationHistory.push({ role: "user", content: content });
    appendMsg("user", content);

    const loading = showLoading();
    try {
      const res = await fetch(API_BASE + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: conversationHistory })
      });
      removeLoading();
      if (res.status === 401) {
        appendMsg("ai", "⚠️ 登录已过期，请返回表格页重新登录");
        return;
      }
      const data = await res.json();
      if (data.success && data.reply) {
        conversationHistory.push({ role: "assistant", content: data.reply });
        appendMsg("ai", data.reply);
      } else {
        appendMsg("ai", "⚠️ AI 服务暂时不可用");
      }
    } catch (err) {
      removeLoading();
      appendMsg("ai", "⚠️ 网络错误：" + err.message);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.focus();
    }
  }

  // ========== 加载表格数据到会话（新增） ==========
  window.aiLoadTableData = function(tableName, headers, rows) {
    var rowCount = rows.length;
var overview = "你是埠勤商贸的内部AI员工，仅服务于企业内部数据查询。当前系统包含以下工作表：\n\n";
if (window.ALL_DATA) {
  var names = Object.keys(window.ALL_DATA);
  for (var t = 0; t < names.length; t++) {
    var nm = names[t];
    var hds = window.ALL_DATA[nm].headers || [];
    overview += (t + 1) + ". " + nm + "（字段：" + hds.join("、") + "）\n";
  }
  overview += "\n共 " + names.length + " 张工作表。";
}
overview += "\n\n核心规则：1.你是内部AI员工，只能回答企业内部数据相关问题。外部话题（天气娱乐闲聊等）必须礼貌拒绝。2.用户当前打开的是「" + tableName + "」，你拥有该表完整数据，其他表只有字段结构没有数据行。3.跨表问题时告知用户对应表名和字段，引导切换后点击读取当前表格加载数据。4.统计筛选排序汇总必须逐行核对。";

    var dataText = "以下是「" + tableName + "」的当前数据：\n";
    dataText += "表头字段：" + headers.join(" | ") + "\n";
    dataText += "数据行数：" + rowCount + "\n";
    dataText += "数据内容：\n";
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var rowVals = [];
      for (var j = 0; j < headers.length; j++) {
        var v = row[headers[j]];
        rowVals.push(v !== undefined && v !== null ? String(v) : "");
      }
      dataText += (i + 1) + ". " + rowVals.join(" | ") + "\n";
    }
    conversationHistory = [
      { role: "system", content: overview },
      { role: "user", content: dataText },
      { role: "assistant", content: "好的，公司共 " + Object.keys(window.ALL_DATA||{}).length + " 张工作表。当前「" + tableName + "」（" + rowCount + "行）。请问需要什么帮助？" }
    ];

    // 自动打开抽屉
    if (drawer && !drawer.classList.contains("ai-drawer-open")) {
      drawer.classList.add("ai-drawer-open");
    }

    // 清空消息区，展示加载提示
    if (messagesContainer) messagesContainer.innerHTML = "";
    appendMsg("ai", "📊 已加载「" + tableName + "」数据，共 " + rowCount + " 行。\n请描述您需要的分析，例如：\n• 筛选某地区的订单\n• 统计某产品的销量\n• 按金额排序");
    appendMsg("ai", "👆 数据已就绪，请在下方输入您的问题。");

    if (input) input.focus();
  };

  // ========== 抽屉开关 ==========
  function toggleMaximize() {
    if (!drawer) return;
    isMaximized = !isMaximized;
    var btn = document.getElementById('ai-maximize');
    if (isMaximized) {
      drawer.classList.add('ai-drawer-maximized');
      if (btn) btn.textContent = '\u2750';
      if (btn) btn.title = '\u8fd8\u539f';
    } else {
      drawer.classList.remove('ai-drawer-maximized');
      initDrawerPos();
      if (btn) btn.textContent = '\u25a1';
      if (btn) btn.title = '\u6700\u5927\u5316';
    }
  }
  window.aiToggleMaximize = toggleMaximize;

  function toggleDrawer() {
    if (!drawer) return;
    drawer.classList.toggle("ai-drawer-open");
    if (drawer.classList.contains("ai-drawer-open")) {
      if (messagesContainer && messagesContainer.children.length === 0 && conversationHistory.length === 0) {
        appendMsg("ai", "你好！我是埠勤 AI 助手 🚀，请先点击「读取当前表格」加载数据，然后向我提问。");
      }
      if (input) input.focus();
    }
  }

  // ========== 初始化 ==========
  function init() {
    fab = document.getElementById(FAB_ID);
    drawer = document.getElementById("ai-drawer");
    messagesContainer = document.getElementById("ai-messages");
    input = document.getElementById("ai-input");
    sendBtn = document.getElementById("ai-send");
    if (!fab) { console.error("AI FAB: 找不到按钮"); return; }
    if (drawer) { initDrawerPos(); }
    const saved = loadPos();
    if (saved) { setPos(saved.x, saved.y); }
    else { setTimeout(posNearSelect, 100); }
    fab.addEventListener("mousedown", onDown);
    fab.addEventListener("touchstart", onDown, { passive: false });
    fab.addEventListener("click", function(e) {
      if (dragMoved) { e.preventDefault(); dragMoved = false; return; }
      toggleDrawer();
    });
    const closeBtn = document.getElementById("ai-close");
    if (closeBtn) closeBtn.addEventListener("click", toggleDrawer);
    var dh = drawer ? drawer.querySelector(".ai-drawer-header") : null;
    if (dh) { dh.addEventListener("mousedown", onDrawerDown); dh.addEventListener("touchstart", onDrawerDown, { passive: false }); }
    if (sendBtn) sendBtn.addEventListener("click", sendMessage);
    if (input) {
      input.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      });
    }
    window.addEventListener("resize", function() {
      const r = fab.getBoundingClientRect();
      setPos(r.left, r.top);
    });
    console.log("AI FAB v2 初始化完成");
  }

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); }
  else { init(); }
})();

/**
 * 读取当前激活表格数据到AI会话
 * 供HTML按钮 onclick=readCurrentTable() 调用
 */
window.readCurrentTable = function() {
  const tableName = window.currentTable;
  if (!tableName || !window.ALL_DATA?.[tableName]) {
    alert("当前没有打开的表格");
    return;
  }
  const tableData = window.ALL_DATA[tableName];
  const headers = tableData.headers || [];
  const rows = tableData.rows || [];

  if (typeof window.aiLoadTableData === "function") {
    window.aiLoadTableData(tableName, headers, rows);
  } else {
    alert("AI模块尚未加载，请刷新页面后重试");
  }
};
