var autoFilledFields={};
var _fileDropInited=false;
function initFileDrop(){
 if(_fileDropInited)return;
 var zone=document.getElementById("fileDropZone")
 var input=document.getElementById("fileInput")
 if(!zone||!input)return
 zone.addEventListener("dragover",function(e){e.preventDefault();zone.classList.add("drag-over")})
 zone.addEventListener("dragleave",function(){zone.classList.remove("drag-over")})
 zone.addEventListener("drop",function(e){e.preventDefault();zone.classList.remove("drag-over");if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0])})
 zone.addEventListener("click",function(){input.click()})
 input.addEventListener("change",function(){if(input.files[0])handleFile(input.files[0])})
 _fileDropInited=true;
}
function handleFile(file){
 var ext=file.name.split(".").pop().toLowerCase()
 var allowed=["xls","xlsx","csv"]
 if(allowed.indexOf(ext)===-1){showToast("不支持的文件格式: "+ext+"，请上传 Excel 或 CSV 文件","error");return}
 parseFile(file)
}
function readFileAs(file,type){
 return new Promise(function(resolve,reject){
  var reader=new FileReader();
  reader.onload=function(e){resolve(e.target.result)};
  reader.onerror=function(e){reject(e)};
  if(type==="binary") reader.readAsBinaryString(file);
  else reader.readAsArrayBuffer(file);
 })
}
async function parseFile(file){
 var ld=document.getElementById("parseLoading")
 var ok=document.getElementById("parseSuccess")
 var er=document.getElementById("parseError")
 var zn=document.getElementById("fileDropZone")
 ld.style.display="flex";ok.style.display="none";er.style.display="none"
 zn.classList.add("loading")
 try{
  var ext=file.name.split(".").pop().toLowerCase()
  var jsonData;
  if(ext==="csv"){
   var text=await readFileAs(file);
   jsonData=csvParse(text);
  }else{
   var data=await readFileAs(file,"binary");
   var workbook=XLSX.read(data,{type:"binary"});
   var firstSheet=workbook.SheetNames[0];
   var worksheet=workbook.Sheets[firstSheet];
   jsonData=XLSX.utils.sheet_to_json(worksheet);
  }
  if(!jsonData||jsonData.length===0){
   ld.style.display="none";zn.classList.remove("loading")
   er.textContent="文件中没有找到数据，请检查文件内容";
   er.style.display="block"
   showToast("文件中没有数据","warning")
   return;
  }
  // 拿到 Excel 第一行的列名
  var firstRow=jsonData[0];
  var fileHeaders=Object.keys(firstRow);
  // 拿到表单已有的字段名
  var inps=document.querySelectorAll("#formFields input,#formFields textarea,#formFields select");
  var formHeaders=[];
  for(var i=0;i<inps.length;i++){
   var hdr=inps[i].getAttribute("data-header");
   if(hdr&&!inps[i].disabled) formHeaders.push(hdr);
  }
  // 匹配逻辑：精确匹配 > 去空格匹配 > 包含匹配
  var matched={};
  var unmatchedFile=[];
  for(var j=0;j<fileHeaders.length;j++){
   var fh=fileHeaders[j];
   var found=false;
   // 1) 精确匹配
   for(var k=0;k<formHeaders.length;k++){
    if(formHeaders[k]===fh){matched[formHeaders[k]]=String(firstRow[fh]||"");found=true;break}
   }
   if(found)continue;
   // 2) 去空格、去括号后匹配
   var fhClean=fh.replace(/\s+/g,"").replace(/[（）()]/g,"");
   for(var k=0;k<formHeaders.length;k++){
    var formClean=formHeaders[k].replace(/\s+/g,"").replace(/[（）()]/g,"");
    if(formClean===fhClean){matched[formHeaders[k]]=String(firstRow[fh]||"");found=true;break}
   }
   if(found)continue;
   // 3) 包含匹配（文件列名包含表单字段名 或 反之）
   for(var k=0;k<formHeaders.length;k++){
    if(fh.indexOf(formHeaders[k])>=0){matched[formHeaders[k]]=String(firstRow[fh]||"");found=true;break}
    if(formHeaders[k].indexOf(fh)>=0){matched[formHeaders[k]]=String(firstRow[fh]||"");found=true;break}
   }
   if(!found)unmatchedFile.push(fh);
  }
  var count=Object.keys(matched).length;
  ld.style.display="none";zn.classList.remove("loading")
  if(count===0){
   er.textContent="未能匹配到任何字段。文件列名："+fileHeaders.join("、")+"；请确保列名与表单字段名一致";
   er.style.display="block"
   showToast("未能匹配字段，请检查Excel列名","warning")
  }else{
   applyParsedFields(matched);
   document.getElementById("parseCount").textContent=count;
   zn.classList.add("has-data");ok.style.display="flex";
   var msg="已解析并匹配 "+count+" 个字段";
   if(unmatchedFile.length>0) msg+="（未匹配列："+unmatchedFile.join("、")+"）";
   showToast(msg,"success")
  }
 }catch(e){
  ld.style.display="none";zn.classList.remove("loading")
  er.textContent="文件解析失败："+(e.message||"未知错误");er.style.display="block"
  showToast("文件解析失败，请检查文件格式","error")
 }
}
function csvParse(text){
 var lines=text.replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n").filter(function(l){return l.trim()})
 if(lines.length<2)return[];
 var headers=parseCSVLine(lines[0]);
 var rows=[];
 for(var i=1;i<lines.length;i++){
  var vals=parseCSVLine(lines[i]);
  var obj={};
  for(var j=0;j<headers.length;j++){
   obj[headers[j]]=vals[j]||"";
  }
  rows.push(obj);
 }
 return rows;
}
function parseCSVLine(line){
 var result=[];
 var current="";
 var inQuotes=false;
 for(var i=0;i<line.length;i++){
  var ch=line[i];
  if(ch==='"'){
   if(inQuotes&&i+1<line.length&&line[i+1]==='"'){current+='"';i++}
   else{inQuotes=!inQuotes}
  }else if(ch===','&&!inQuotes){
   result.push(current);current="";
  }else{current+=ch}
 }
 result.push(current);
 return result;
}
function applyParsedFields(fields){
 var inps=document.querySelectorAll("#formFields input,#formFields textarea,#formFields select")
 for(var i=0;i<inps.length;i++){
  var inp=inps[i];var hdr=inp.getAttribute("data-header")
  if(!hdr||inp.disabled)continue
  if(fields.hasOwnProperty(hdr)){
   var val=fields[hdr];autoFilledFields[hdr]=val
   if(inp.type==="date"){
    var nd=normalizeDate(String(val));
    if(nd)inp.value=nd;
   }else{inp.value=val}
   inp.style.borderColor="#22c55e";inp.style.backgroundColor="#f0fdf4"
  }
 }
}
function clearAutoFill(){
 var zn=document.getElementById("fileDropZone")
 var ok=document.getElementById("parseSuccess")
 var er=document.getElementById("parseError")
 var inps=document.querySelectorAll("#formFields input,#formFields textarea,#formFields select")
 for(var i=0;i<inps.length;i++){
  var inp=inps[i];var hdr=inp.getAttribute("data-header")
  if(hdr&&autoFilledFields.hasOwnProperty(hdr)){
   inp.value="";inp.style.borderColor="";inp.style.backgroundColor=""
  }
 }
 autoFilledFields={}
 zn.classList.remove("has-data")
 ok.style.display="none";er.style.display="none"
}
