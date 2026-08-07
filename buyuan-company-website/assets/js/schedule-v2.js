const API='';
let cur='s',cf='all',data=[],miniDate=new Date();
const mod={
 s:{api:'/api/schedules',label:'日程',icon:'📅',
  fd:[{n:'title',l:'标题',t:'text'},{n:'start_time',l:'开始时间',t:'datetime-local'},{n:'end_time',l:'结束时间',t:'datetime-local'},{n:'description',l:'描述',t:'textarea'},{n:'type',l:'类型',t:'select',o:['会议','任务','提醒','个人']},{n:'priority',l:'优先级',t:'select',o:['高','中','低']},{n:'location',l:'地点',t:'text'},{n:'person',l:'参与人',t:'text'}],
  fl:['all','today','upcoming','已完成']},
 t:{api:'/api/tasks',label:'任务',icon:'✅',
  fd:[{n:'title',l:'标题',t:'text'},{n:'description',l:'描述',t:'textarea'},{n:'priority',l:'优先级',t:'select',o:['高','中','低']},{n:'due_date',l:'截止日期',t:'date'}],
  fl:['all','待办','已完成']},
 i:{api:'/api/inspirations',label:'灵感',icon:'💡',
  fd:[{n:'title',l:'标题',t:'text'},{n:'description',l:'内容',t:'textarea'},{n:'tags',l:'标签(逗号分隔)',t:'text'}],fl:['all']},
 a:{api:'/api/applications',label:'申请',icon:'📋',
  fd:[{n:'title',l:'标题',t:'text'},{n:'description',l:'描述',t:'textarea'},{n:'applicant',l:'申请人',t:'text'}],
  fl:['all','pending','pass','reject','revoked']},
 e:{api:'/api/expenses',label:'报销',icon:'💰',
  fd:[{n:'title',l:'标题',t:'text'},{n:'description',l:'描述',t:'textarea'},{n:'amount',l:'金额',t:'number'},{n:'category',l:'类别',t:'select',o:['差旅','餐饮','办公','交通','其他']},{n:'expense_date',l:'日期',t:'date'}],
  fl:['all','pending','pass','reject','revoked']},
 ap:{api:'/api/approval',label:'审批',icon:'✔️',fd:[],fl:['pending','my']}
};
// === Init & Switch ===
function init(){
  let tb=document.getElementById('tabBar');
  let h='';
  for(let k in mod){
    let m=mod[k];
    h+=`<button class="tab-btn${k===cur?' active':''}" data-module="${k}" onclick="sw('${k}')">${m.icon} ${m.label}</button>`;
  }
  tb.innerHTML=h;
  sw('s');
}
function sw(m){
  cur=m;cf='all';data=[];
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.module===m));
  if(m==='s'){ensureCalCss(true);renderScheduleCalendar();}
  else{ensureCalCss(false);ld();}
}
function ensureCalCss(on){let id='cal-css';let l=document.getElementById(id);if(on&&!l){let k=document.createElement('link');k.id=id;k.rel='stylesheet';k.href='/assets/css/schedule-calendar.css?v=20260807e';document.head.appendChild(k);}else if(!on&&l){l.remove();}}
function refresh(){ld();}
// === Data Loading ===
async function ld(){
  if(cur==='ap'){renderApproval();return;}
  let m=mod[cur];
  try{
    let url=m.api;
    let r=await fetch(url);
    let d=await r.json();
    data=d.data||[];
    renderModule(data);
  }catch(e){
    document.getElementById('mainContent').innerHTML=`<div class="empty-state"><p>加载失败: ${e.message}</p></div>`;
  }
}
// === Toast ===
function toast(msg,type='success'){
  let c=document.getElementById('toastContainer');
  let d=document.createElement('div');
  d.className=`toast toast-${type}`;
  d.textContent=msg;
  c.appendChild(d);
  setTimeout(()=>{d.style.opacity='0';d.style.transition='opacity .3s';setTimeout(()=>d.remove(),300)},2000);
}
// === Modal ===
function modal(title,content,onSave){
  let h=`<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal"><h3>${title}</h3>${content}<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" id="msb">保存</button></div></div></div>`;
  document.getElementById('modalContainer').innerHTML=h;
  document.getElementById('msb').onclick=()=>{if(onSave()!==false)closeModal();};
}
function closeModal(){document.getElementById('modalContainer').innerHTML='';}
// === Create ===
function openCreate(){
  let m=mod[cur];
  let fh='';
  m.fd.forEach(f=>{
    if(f.t==='textarea')fh+=`<div class="form-group"><label>${f.l}</label><textarea id="f_${f.n}" rows="3"></textarea></div>`;
    else if(f.t==='select'){
      fh+=`<div class="form-group"><label>${f.l}</label><select id="f_${f.n}"><option value="">请选择</option>`;
      f.o.forEach(o=>{fh+=`<option value="${o}">${o}</option>`;});
      fh+=`</select></div>`;
    }else fh+=`<div class="form-group"><label>${f.l}</label><input type="${f.t}" id="f_${f.n}"></div>`;
  });
  modal(`新建${m.label}`,fh,()=>{
    let body={};
    m.fd.forEach(f=>{let el=document.getElementById('f_'+f.n);if(el&&el.value)body[f.n]=el.value;});
    if(!body.title){toast('请填写标题','error');return false;}
    return createItem(body);
  });
}
// === CRUD ===
async function createItem(body){
  try{
    let m=mod[cur];
    let r=await fetch(m.api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    let d=await r.json();
    if(d.success){toast('创建成功');ld();}else toast(d.error||'创建失败','error');
  }catch(e){toast('创建失败: '+e.message,'error');}
}
async function del(id){
  if(!confirm('确定删除？'))return;
  try{
    let m=mod[cur];
    let r=await fetch(m.api+'/'+id,{method:'DELETE'});
    let d=await r.json();
    if(d.success){toast('已删除');ld();}else toast(d.error||'删除失败','error');
  }catch(e){toast('删除失败: '+e.message,'error');}
}
async function upStatus(id,status){
  try{
    let m=mod[cur];
    let r=await fetch(m.api+'/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
    let d=await r.json();
    if(d.success){toast('状态更新');ld();}else toast(d.error||'更新失败','error');
  }catch(e){toast('更新失败: '+e.message,'error');}
}
function sl(s){var m={pending:'审批中',pass:'已通过',reject:'已驳回',revoked:'已撤回','待办':'待办','已完成':'已完成'};return m[s]||s;}
function renderModule(data){
  if(cur==='s')renderSchedules(data);
  else if(cur==='t')renderTasks(data);
  else if(cur==='i')renderInspirations(data);
  else if(cur==='a')renderApplications(data);
  else if(cur==='e')renderExpenses(data);
}
// === Render: Schedules ===
function renderSchedules(data){
  let m=mod.s;
  let fd=data;
  if(cf==='已完成')fd=data.filter(d=>d.status==='已完成');
  else if(cf==='today'){let t=new Date().toISOString().split('T')[0];fd=data.filter(d=>d.start_time&&d.start_time.startsWith(t));}
  let gr={};fd.forEach(d=>{let k=d.start_time?d.start_time.split('T')[0]:'无日期';if(!gr[k])gr[k]=[];gr[k].push(d);});
  let ks=Object.keys(gr).sort();
  let h=`<div class="section-header"><h2>日程</h2><button class="btn btn-primary" onclick="openCreate()">+ 新建</button></div>`;
  h+=renderMiniCal();
  h+=`<div class="filter-bar">`;
  m.fl.forEach(f=>h+=`<button class="filter-btn${cf===f?' active':''}" onclick="cf='${f}';ld()">${f==='all'?'全部':f}</button>`);
  h+=`</div>`;
  if(ks.length===0)h+=`<div class="empty-state"><p>暂无日程</p></div>`;
  else ks.forEach(k=>{h+=`<div class="schedule-group"><div class="schedule-date">${k}</div>`;gr[k].forEach(d=>h+=renderSItem(d));h+=`</div>`;});
  document.getElementById('mainContent').innerHTML=h;
}
function renderSItem(d){
  let tBadge=d.type?`<span class="badge badge-todo">${d.type}</span>`:'';
  let sBadge=d.status==='已完成'?`<span class="badge badge-done">已完成</span>`:'';
  let tm=d.start_time?new Date(d.start_time).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  let et=d.end_time?' - '+new Date(d.end_time).toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
  let cls=d.status==='已完成'?' list-item done':'list-item';
  return `<div class="${cls}"><div class="item-info"><div class="item-title">${d.title}</div><div class="item-meta"><span>${tm}${et}</span>${tBadge}${sBadge}${d.location?`<span>${d.location}</span>`:''}</div></div><div class="item-actions"><button class="btn btn-sm btn-ghost" onclick="upStatus(${d.id},'已完成')">✓</button><button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="del(${d.id})">✕</button></div></div>`;
}
// === Render: Tasks ===
function renderTasks(data){
  let m=mod.t;
  let fd=data;
  if(cf==='待办')fd=data.filter(d=>d.status!=='已完成');
  else if(cf==='已完成')fd=data.filter(d=>d.status==='已完成');
  let todo=data.filter(d=>d.status!=='已完成').length;
  let done=data.length-todo;
  let h=`<div class="section-header"><h2>任务</h2><button class="btn btn-primary" onclick="openCreate()">+ 新建</button></div>`;
  h+=`<div class="stats-bar"><div class="stat-card"><div class="count">${todo}</div><div class="label">待办</div></div><div class="stat-card"><div class="count">${done}</div><div class="label">已完成</div></div></div>`;
  h+=`<div class="filter-bar">`;
  m.fl.forEach(f=>h+=`<button class="filter-btn${cf===f?' active':''}" onclick="cf='${f}';ld()">${f==='all'?'全部':f}</button>`);
  h+=`</div>`;
  if(fd.length===0)h+=`<div class="empty-state"><p>暂无任务</p></div>`;
  else fd.forEach(d=>h+=renderTItem(d));
  document.getElementById('mainContent').innerHTML=h;
}
function renderTItem(d){
  let isDone=d.status==='已完成';
  let due=d.due_date?new Date(d.due_date+'T00:00:00').toLocaleDateString('zh-CN',{month:'short',day:'numeric'}):'';
  let p=d.priority;
  let pBadge=p==='高'?`<span class="badge" style="background:rgba(255,59,48,.12);color:var(--red)">高</span>`:p==='中'?`<span class="badge" style="background:rgba(255,149,0,.12);color:var(--orange)">中</span>`:p?`<span class="badge" style="background:rgba(142,142,147,.12);color:#8e8e93">${p}</span>`:'';
  return `<div class="list-item${isDone?' done':''}"><div class="check${isDone?' checked':''}" onclick="upStatus(${d.id},'${isDone?'待办':'已完成'}')"></div><div class="item-info"><div class="item-title">${d.title}</div><div class="item-meta">${due?`<span>📅 ${due}</span>`:''}${pBadge}</div></div><div class="item-actions"><button class="btn btn-sm btn-ghost" onclick="openEdit(${d.id})">✎</button><button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="del(${d.id})">✕</button></div></div>`;
}
// === Render: Inspirations ===
function renderInspirations(data){
  let h=`<div class="section-header"><h2>灵感</h2><button class="btn btn-primary" onclick="openCreate()">+ 新建</button></div>`;
  if(!data||data.length===0)h+=`<div class="empty-state"><p>暂无灵感</p></div>`;
  else{h+=`<div class="card-grid">`;data.forEach(d=>h+=renderIItem(d));h+=`</div>`;}
  document.getElementById('mainContent').innerHTML=h;
}
function renderIItem(d){
  let tags='';if(d.tags)d.tags.split(',').forEach(t=>{if(t.trim())tags+=`<span class="tag">${t.trim()}</span>`;});
  let date=d.created_at?new Date(d.created_at).toLocaleDateString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  return `<div class="card"><h3>${d.title}</h3>${d.description?`<p>${d.description.substring(0,100)}${d.description.length>100?'...':''}</p>`:''}${tags}<div class="card-footer"><span style="font-size:12px;color:var(--text-tertiary)">${date}</span><div><button class="btn btn-sm btn-ghost" onclick="del(${d.id})">删除</button></div></div></div>`;
}
// === Render: Applications ===
function renderApplications(data){
  let m=mod.a;
  let fd=data;if(cf!=='all')fd=data.filter(d=>d.status===cf);
  let st={pending:0,pass:0,reject:0};data.forEach(d=>{if(st[d.status]!==undefined)st[d.status]++;});
  let h=`<div class="section-header"><h2>申请</h2><button class="btn btn-primary" onclick="openCreate()">+ 新建</button></div>`;
  h+=`<div class="stats-bar"><div class="stat-card"><div class="count">${st.pending}</div><div class="label">审批中</div></div><div class="stat-card"><div class="count">${st.pass}</div><div class="label">已通过</div></div><div class="stat-card"><div class="count">${st.reject}</div><div class="label">已驳回</div></div></div>`;
  h+=`<div class="filter-bar">`;m.fl.forEach(f=>h+=`<button class="filter-btn${cf===f?' active':''}" onclick="cf='${f}';ld()">${f==='all'?'全部':sl(f)}</button>`);h+=`</div>`;
  if(fd.length===0)h+=`<div class="empty-state"><p>暂无申请</p></div>`;else fd.forEach(d=>h+=renderAItem(d));
  document.getElementById('mainContent').innerHTML=h;
}
function renderAItem(d){
  return `<div class="list-item"><div class="item-info"><div class="item-title">${d.title}</div><div class="item-meta"><span class="badge badge-${d.status}">${sl(d.status)}</span>${d.applicant?`<span>申请人: ${d.applicant}</span>`:''}${d.approve_comment?`<span>备注: ${d.approve_comment}</span>`:''}</div></div><div class="item-actions"><button class="btn btn-sm btn-ghost" onclick="del(${d.id})">删除</button></div></div>`;
}
// === Render: Expenses ===
function renderExpenses(data){
  let m=mod.e;
  let fd=data;if(cf!=='all')fd=data.filter(d=>d.status===cf);
  let tot=0,st={pending:0,pass:0,reject:0};data.forEach(d=>{tot+=Number(d.amount||0);if(st[d.status]!==undefined)st[d.status]++;});
  let h=`<div class="section-header"><h2>报销</h2><button class="btn btn-primary" onclick="openCreate()">+ 新建</button></div>`;
  h+=`<div class="stats-bar"><div class="stat-card"><div class="count">¥${tot.toFixed(2)}</div><div class="label">总计金额</div></div><div class="stat-card"><div class="count">${st.pending}</div><div class="label">审批中</div></div><div class="stat-card"><div class="count">${st.pass}</div><div class="label">已通过</div></div></div>`;
  h+=`<div class="filter-bar">`;m.fl.forEach(f=>h+=`<button class="filter-btn${cf===f?' active':''}" onclick="cf='${f}';ld()">${f==='all'?'全部':sl(f)}</button>`);h+=`</div>`;
  if(fd.length===0)h+=`<div class="empty-state"><p>暂无报销</p></div>`;else fd.forEach(d=>h+=renderEItem(d));
  document.getElementById('mainContent').innerHTML=h;
}
function renderEItem(d){
  return `<div class="list-item"><div class="item-info"><div class="item-title">${d.title}</div><div class="item-meta">${d.amount?`<span style="font-weight:600;color:var(--accent)">¥${Number(d.amount).toFixed(2)}</span>`:''}<span class="badge badge-${d.status}">${sl(d.status)}</span>${d.category?`<span>类别: ${d.category}</span>`:''}</div></div><div class="item-actions"><button class="btn btn-sm btn-ghost" onclick="del(${d.id})">删除</button></div></div>`;
}
// === Render: Approval ===
async function renderApproval(){
  document.getElementById('mainContent').innerHTML=`<div class="section-header"><h2>审批管理</h2></div><div style="text-align:center;padding:40px;color:var(--text-tertiary)">加载中...</div>`;
  try{
    let pd=[],md=[];
    let pr=await fetch('/api/approval/pending').then(r=>r.json());if(pr.success)pd=pr.data||[];
    let mr=await fetch('/api/approval/my').then(r=>r.json());if(mr.success)md=mr.data||[];
    let h=`<div class="section-header"><h2>审批管理</h2></div>`;
    h+=`<div class="filter-bar"><button class="filter-btn${cf==='pending'?' active':''}" onclick="cf='pending';renderApproval()">待审批 (${pd.length})</button><button class="filter-btn${cf==='my'?' active':''}" onclick="cf='my';renderApproval()">我的申请 (${md.length})</button></div>`;
    if(cf==='pending'){
      if(pd.length===0)h+=`<div class="empty-state"><p>暂无待审批</p></div>`;
      else{h+=`<div style="margin-bottom:8px"><button class="btn btn-sm btn-primary" onclick="batchApproval()">全部通过</button></div>`;pd.forEach(d=>h+=renderApItem(d,'pending'));}
    }else{
      if(md.length===0)h+=`<div class="empty-state"><p>暂无申请记录</p></div>`;
      else md.forEach(d=>h+=renderApItem(d,'my'));
    }
    document.getElementById('mainContent').innerHTML=h;
  }catch(e){document.getElementById('mainContent').innerHTML=`<div class="section-header"><h2>审批管理</h2></div><div class="empty-state"><p>加载失败: ${e.message}</p></div>`;}
}
function renderApItem(d,mode){
  let tl=d.item_type==='apply'?'申请':'报销';
  let amt=d.amount?`<span style="font-weight:600;color:var(--accent)">¥${Number(d.amount).toFixed(2)}</span>`:'';
  let act='';
  if(mode==='pending')act=`<button class="btn btn-sm btn-primary" onclick="doApproval('${d.item_type}',${d.id})">通过</button><button class="btn btn-sm btn-danger" onclick="doReject('${d.item_type}',${d.id})">驳回</button>`;
  else if(mode==='my'&&d.status==='pending')act=`<button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="doRevoke('${d.item_type}',${d.id})">撤回</button>`;
  return `<div class="list-item"><div class="item-info"><div class="item-title">[${tl}] ${d.title}</div><div class="item-meta">${amt}<span class="badge badge-${d.status}">${sl(d.status)}</span>${d.description?`<span>${d.description.substring(0,50)}</span>`:''}</div></div><div class="item-actions" style="opacity:1">${act}</div></div>`;
}
// === Approval Actions ===
async function doApproval(type,id){
  let cmt=prompt('审批意见(可选):')||'';
  try{
    let r=await fetch('/api/approval/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_type:type,item_id:id,comment:cmt})});
    let d=await r.json();
    if(d.success){toast('已通过');renderApproval();}else toast(d.error||'操作失败','error');
  }catch(e){toast('操作失败','error');}
}
async function doReject(type,id){
  let cmt=prompt('驳回理由:')||'';
  if(!cmt.trim()){toast('请填写驳回理由','error');return;}
  try{
    let r=await fetch('/api/approval/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_type:type,item_id:id,comment:cmt})});
    let d=await r.json();
    if(d.success){toast('已驳回');renderApproval();}else toast(d.error||'操作失败','error');
  }catch(e){toast('操作失败','error');}
}
async function doRevoke(type,id){
  if(!confirm('确定撤回？'))return;
  try{
    let r=await fetch('/api/approval/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_type:type,item_id:id})});
    let d=await r.json();
    if(d.success){toast('已撤回');renderApproval();}else toast(d.error||'操作失败','error');
  }catch(e){toast('操作失败','error');}
}
async function batchApproval(){
  if(!confirm('确定全部通过？'))return;
  try{
    let pr=await fetch('/api/approval/pending').then(r=>r.json());
    let items=(pr.data||[]).map(d=>({item_type:d.item_type,item_id:d.id}));
    if(items.length===0){toast('没有待审批项','error');return;}
    let r=await fetch('/api/approval/batch-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});
    let d=await r.json();
    if(d.success){toast('已全部通过');renderApproval();}else toast(d.error||'操作失败','error');
  }catch(e){toast('操作失败','error');}
}
// === Mini Calendar ===
function renderMiniCal(){
  let y=miniDate.getFullYear(),m=miniDate.getMonth();
  let fd=new Date(y,m,1).getDay();
  let dim=new Date(y,m+1,0).getDate();
  let pd=new Date(y,m,0).getDate();
  let ms='一月 二月 三月 四月 五月 六月 七月 八月 九月 十月 十一月 十二月'.split(' ');
  let h=`<div class="mini-cal"><div class="mini-cal-header"><button onclick="miniDate=new Date(miniDate.getFullYear(),miniDate.getMonth()-1,1);ld()">‹</button><span>${ms[m]} ${y}</span><button onclick="miniDate=new Date(miniDate.getFullYear(),miniDate.getMonth()+1,1);ld()">›</button></div><div class="mini-cal-grid">`;
  '日 一 二 三 四 五 六'.split(' ').forEach(d=>h+=`<div class="mini-cal-day-name">${d}</div>`);
  let today=new Date().toDateString();
  for(let i=0;i<fd;i++)h+=`<div class="mini-cal-day other">${pd-fd+i+1}</div>`;
  for(let d=1;d<=dim;d++){let dt=new Date(y,m,d).toDateString();let cls='mini-cal-day';if(dt===today)cls+=' today';h+=`<div class="${cls}" onclick="selDate(${y},${m},${d})">${d}</div>`;}
  let rem=42-fd-dim;for(let i=1;i<=rem;i++)h+=`<div class="mini-cal-day other">${i}</div>`;
  h+=`</div></div>`;
  return h;
}
function selDate(y,m,d){cf='today';miniDate=new Date(y,m,d);ld();}
// === Edit ===
function openEdit(id){
  let item=data.find(d=>d.id===id);if(!item)return;
  let m=mod[cur];let fh='';
  m.fd.forEach(f=>{
    let val=item[f.n]||'';
    let ft=f.t==='datetime-local'?'datetime-local':f.t;
    if(f.t==='textarea')fh+=`<div class="form-group"><label>${f.l}</label><textarea id="f_${f.n}" rows="3">${val}</textarea></div>`;
    else if(f.t==='select'){fh+=`<div class="form-group"><label>${f.l}</label><select id="f_${f.n}">`;f.o.forEach(o=>fh+=`<option value="${o}"${val===o?' selected':''}>${o}</option>`);fh+=`</select></div>`;}
    else fh+=`<div class="form-group"><label>${f.l}</label><input type="${ft}" id="f_${f.n}" value="${val}">`;
  });
  modal(`编辑${m.label}`,fh,async()=>{
    let body={};m.fd.forEach(f=>{let el=document.getElementById('f_'+f.n);if(el)body[f.n]=el.value;});
    try{
      let r=await fetch(m.api+'/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      let d=await r.json();
      if(d.success){toast('已更新');ld();}else toast(d.error||'更新失败','error');
    }catch(e){toast('更新失败: '+e.message,'error');}
  });
}
// === Init ===
window.addEventListener('DOMContentLoaded',init);
