# 订单信息提取与汇总系统 - Flask后端API服务

import os
import json
import tempfile
import requests
from datetime import datetime
from functools import wraps

from flask import Flask, request, jsonify, send_file, render_template
from flask_cors import CORS
from werkzeug.utils import secure_filename

from config import (
    SERVER_HOST, SERVER_PORT, UPLOAD_FOLDER, 
    MAX_FILE_SIZE_MB, ORDER_FIELDS_A, ORDER_FIELDS_B, PLATFORMS,
    WECOM_WEBHOOK_URL, WECOM_TOKEN, WECOM_ENCODING_AES_KEY,
    WECOM_CORP_ID, WECOM_APP_SECRET, TEMPLATE_B_PLATFORMS,
    get_ai_api_key, SETTINGS_FILE, AI_API_URL, AI_MODEL
)
from pdf_extractor import extract_order_from_pdf, PDFParser, OrderAIExtractor
from order_manager import order_manager

app = Flask(__name__)
CORS(app)

app.config['MAX_CONTENT_LENGTH'] = MAX_FILE_SIZE_MB * 1024 * 1024

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


# ============ API密钥验证（可选） ============
API_KEY = os.environ.get("API_KEY", "order-admin-2024")

def require_api_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        key = request.headers.get("X-API-Key", "") or request.args.get("api_key", "")
        if API_KEY and key != API_KEY:
            return jsonify({"error": "未授权访问"}), 401
        return f(*args, **kwargs)
    return decorated


# ============ 订单管理 API ============

@app.route("/api/health", methods=["GET"])
def health():
    """健康检查"""
    return jsonify({
        "status": "ok",
        "time": datetime.now().isoformat(),
        "version": "1.0.0",
        "api_key_configured": bool(get_ai_api_key())
    })


# ============ 系统设置 API ============

@app.route("/api/settings", methods=["GET"])
@require_api_key
def get_settings():
    """获取当前系统设置"""
    current_key = get_ai_api_key()
    masked_key = ""
    if current_key and len(current_key) > 8:
        masked_key = current_key[:4] + "****" + current_key[-4:]
    elif current_key:
        masked_key = current_key[:2] + "****"
    
    return jsonify({
        "tokenhub_api_key": masked_key,
        "has_key": bool(current_key),
        "api_url": AI_API_URL,
        "model": AI_MODEL
    })


@app.route("/api/settings", methods=["POST"])
@require_api_key
def save_settings():
    """保存系统设置"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "请提供设置数据"}), 400
    
    api_key = data.get("tokenhub_api_key", "").strip()
    if not api_key:
        return jsonify({"error": "API Key 不能为空"}), 400
    
    settings = {}
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                settings = json.load(f)
        except Exception:
            pass
    
    settings["tokenhub_api_key"] = api_key
    try:
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "message": "API Key 已保存，下次识别生效"})
    except Exception as e:
        return jsonify({"error": f"保存失败: {str(e)}"}), 500


@app.route("/api/settings/test", methods=["POST"])
@require_api_key
def test_api_key():
    """测试 API Key 连接"""
    key_to_test = get_ai_api_key()
    
    if not key_to_test:
        return jsonify({"success": False, "error": "尚未配置 API Key"}), 400
    
    try:
        resp = requests.post(
            AI_API_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key_to_test}"
            },
            json={
                "model": AI_MODEL,
                "messages": [{"role": "user", "content": "回复OK"}],
                "max_tokens": 10
            },
            timeout=30
        )
        if resp.status_code == 200:
            return jsonify({"success": True, "message": "API Key 验证成功！连接正常"})
        else:
            detail = resp.text[:300]
            return jsonify({"success": False, "error": f"HTTP {resp.status_code}: {detail}"})
    except Exception as e:
        return jsonify({"success": False, "error": f"连接失败: {str(e)}"})


# ============ 分步提取 API（两步走：先提取文本，再解析数据） ============

@app.route("/api/pdf/extract-text", methods=["POST"])
@require_api_key
def step1_extract_text():
    """Step 1: 上传PDF，提取内嵌文本（不使用OCR），保存TXT供用户查看"""
    if 'file' not in request.files:
        return jsonify({"error": "请上传PDF文件"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "文件名为空"}), 400
    
    if not file.filename.lower().endswith('.pdf'):
        return jsonify({"error": "仅支持PDF文件格式"}), 400
    
    # 保存上传的PDF文件
    filename = secure_filename(file.filename)
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    saved_name = f"{timestamp}_{filename}"
    filepath = os.path.join(UPLOAD_FOLDER, saved_name)
    file.save(filepath)
    
    try:
        # 提取内嵌文本（不使用OCR）
        parser = PDFParser()
        full_text = parser.extract_full_text(filepath)
        
        # 保存为TXT文件
        txt_path = parser.save_text_file(filepath, full_text)
        txt_filename = os.path.basename(txt_path)
        
        # 保留PDF文件，供Step2用HY3多模态识别
        
        return jsonify({
            "success": True,
            "message": f"文本提取成功，共 {len(full_text)} 字符",
            "step": 1,
            "pdf_filename": saved_name,
            "txt_filename": txt_filename,
            "txt_download_url": f"/api/txt/download/{txt_filename}",
            "content": full_text,
            "size": len(full_text)
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        # 清理PDF
        try:
            os.remove(filepath)
        except:
            pass
        return jsonify({"success": False, "error": f"文本提取失败: {str(e)}"}), 500


@app.route("/api/pdf/parse-txt", methods=["POST"])
@require_api_key
def step2_parse_txt():
    """Step 2: HY3多模态识别 + 规则解析，从PDF提取结构化订单数据"""
    data = request.get_json(silent=True)
    if not data:
        data = request.form
    
    txt_filename = (data.get("txt_filename") or "").strip()
    pdf_filename = (data.get("pdf_filename") or "").strip()
    platform = (data.get("platform") or "其他").strip()
    use_ai = str(data.get("use_ai", "true")).lower() == "true"
    
    if not txt_filename:
        return jsonify({"error": "请提供txt_filename参数（Step1返回的文件名）"}), 400
    
    if platform not in PLATFORMS:
        platform = "其他"
    
    # 安全检查
    safe_txt = "".join(c for c in txt_filename if c.isalnum() or c in "._-")
    if safe_txt != txt_filename:
        return jsonify({"error": "无效的文件名"}), 400
    
    txt_path = os.path.join(UPLOAD_FOLDER, txt_filename)
    if not os.path.exists(txt_path):
        return jsonify({"error": f"TXT文件不存在: {txt_filename}"}), 404
    
    # 检查PDF是否存在（用于HY3视觉识别）
    pdf_path = None
    if pdf_filename:
        safe_pdf = "".join(c for c in pdf_filename if c.isalnum() or c in "._-")
        if safe_pdf == pdf_filename:
            candidate = os.path.join(UPLOAD_FOLDER, pdf_filename)
            if os.path.exists(candidate):
                pdf_path = candidate
    
    try:
        # 读取TXT内容
        with open(txt_path, 'r', encoding='utf-8') as f:
            full_text = f.read()
        
        # 提取内嵌文本用于规则解析（去掉TXT头部注释行）
        text_for_rules = full_text
        # 跳过文件开头的 # 注释行（由 save_text_file 写入的元信息）
        lines = full_text.split('\n')
        content_lines = [l for l in lines if not l.startswith('#')]
        text_for_rules = '\n'.join(content_lines).strip()
        
        if not text_for_rules:
            text_for_rules = full_text
        
        print(f"[Step2] 规则解析用文本长度: {len(text_for_rules)} 字符")
        
        # 1. 先用规则提取
        order_rows = OrderAIExtractor.extract_with_rule_fallback(text_for_rules, platform)
        print(f"[Step2] 规则提取返回 {len(order_rows)} 条记录")
        
        # 2. HY3多模态识别（直接分析PDF页面图片）
        if use_ai and pdf_path:
            current_key = get_ai_api_key()
            if current_key and "your-tokenhub-key" not in current_key:
                print(f"[Step2] 启动HY3多模态识别，平台: {platform}")
                parser = PDFParser()
                images_base64 = parser.all_pages_to_images(pdf_path)
                print(f"[Step2] PDF页面数: {len(images_base64)}")
                if images_base64:
                    ai_rows = OrderAIExtractor.extract_with_ai(full_text, images_base64, platform)
                    print(f"[Step2] HY3返回 {len(ai_rows)} 条记录")
                    if ai_rows:
                        order_rows = ai_rows
                        print("[Step2] 采用HY3结果")
                    else:
                        print("[Step2] HY3无结果，保留规则提取结果")
            else:
                print("[Step2] 未配置AI Key，跳过HY3")
        
        # 根据平台选择字段体系
        is_qixin = platform in TEMPLATE_B_PLATFORMS
        field_def = ORDER_FIELDS_B if is_qixin else ORDER_FIELDS_A
        
        result_rows = []
        for row in order_rows:
            complete_row = {field: row.get(field, "") for field in field_def}
            complete_row["平台来源"] = platform
            complete_row["_source_file"] = txt_filename
            complete_row["_processed_at"] = datetime.now().isoformat()
            complete_row["_platform_type"] = "qixin" if is_qixin else "general"
            result_rows.append(complete_row)
        
        # 逐行保存到数据库
        saved_results = []
        for row in result_rows:
            saved = order_manager.add_order(row)
            saved_results.append(saved)
        
        return jsonify({
            "success": True,
            "message": f"解析完成，共提取 {len(saved_results)} 条商品记录",
            "step": 2,
            "orders": saved_results,
            "count": len(saved_results)
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": f"解析失败: {str(e)}"}), 500


# ============ 订单管理 API ============

@app.route("/api/txt/<filename>", methods=["GET"])
@require_api_key
def get_txt_file(filename):
    """获取提取的TXT文本内容"""
    # 安全检查：只允许数字、字母、下划线、短横线、点号
    safe_name = "".join(c for c in filename if c.isalnum() or c in "._-")
    if safe_name != filename:
        return jsonify({"error": "无效的文件名"}), 400
    
    txt_path = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(txt_path):
        return jsonify({"error": "TXT文件不存在或已被清理"}), 404
    
    with open(txt_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    return jsonify({
        "filename": filename,
        "content": content,
        "size": len(content)
    })


@app.route("/api/txt/download/<filename>", methods=["GET"])
def download_txt_file(filename):
    """直接下载TXT文件（无需API Key，通过文件名访问）"""
    safe_name = "".join(c for c in filename if c.isalnum() or c in "._-")
    if safe_name != filename:
        return jsonify({"error": "无效的文件名"}), 400
    
    txt_path = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(txt_path):
        return jsonify({"error": "TXT文件不存在或已被清理"}), 404
    
    return send_file(
        txt_path,
        mimetype='text/plain; charset=utf-8',
        as_attachment=True,
        download_name=filename
    )


@app.route("/api/orders/upload", methods=["POST"])
@require_api_key
def upload_order():
    """上传PDF并提取订单信息"""
    if 'file' not in request.files:
        return jsonify({"error": "请上传PDF文件"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "文件名为空"}), 400
    
    if not file.filename.lower().endswith('.pdf'):
        return jsonify({"error": "仅支持PDF文件格式"}), 400
    
    # 获取平台参数
    platform = request.form.get("platform", "其他").strip()
    if platform not in PLATFORMS:
        platform = "其他"
    
    # 保存文件
    filename = secure_filename(file.filename)
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    saved_name = f"{timestamp}_{filename}"
    filepath = os.path.join(UPLOAD_FOLDER, saved_name)
    file.save(filepath)
    
    try:
        # 提取订单信息（返回 商品行列表 + TXT路径）
        use_ai = request.form.get("use_ai", "true").lower() == "true"
        order_rows, txt_path = extract_order_from_pdf(filepath, platform=platform, use_ai=use_ai)
        
        # 逐行保存到数据库
        results = []
        for row in order_rows:
            result = order_manager.add_order(row)
            results.append(result)
        
        # 清理上传的PDF文件（保留TXT文件）
        try:
            os.remove(filepath)
        except:
            pass
        
        return jsonify({
            "success": True,
            "message": f"订单信息提取成功，共 {len(results)} 条商品记录",
            "orders": results,
            "count": len(results),
            "txt_file": os.path.basename(txt_path) if txt_path else None
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": f"处理失败: {str(e)}"
        }), 500


@app.route("/api/orders", methods=["GET"])
@require_api_key
def list_orders():
    """获取订单列表"""
    page = request.args.get("page", 1, type=int)
    page_size = request.args.get("page_size", 50, type=int)
    search = request.args.get("search", "")
    platform = request.args.get("platform", "")
    
    result = order_manager.get_all_orders(
        page=page, page_size=page_size,
        search=search, platform=platform
    )
    return jsonify(result)


@app.route("/api/orders/<order_id>", methods=["GET"])
@require_api_key
def get_order(order_id):
    """获取单个订单详情"""
    order = order_manager.get_order_by_id(order_id)
    if order is None:
        return jsonify({"error": "订单不存在"}), 404
    return jsonify(order)


@app.route("/api/orders/<order_id>", methods=["PUT"])
@require_api_key
def update_order(order_id):
    """更新订单信息"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "请提供更新数据"}), 400
    
    result = order_manager.update_order(order_id, data)
    if result is None:
        return jsonify({"error": "订单不存在"}), 404
    
    return jsonify({
        "success": True,
        "message": "订单更新成功",
        "order": result
    })


@app.route("/api/orders/<order_id>", methods=["DELETE"])
@require_api_key
def delete_order(order_id):
    """删除订单"""
    success = order_manager.delete_order(order_id)
    if not success:
        return jsonify({"error": "订单不存在"}), 404
    return jsonify({"success": True, "message": "订单已删除"})


@app.route("/api/statistics", methods=["GET"])
@require_api_key
def get_statistics():
    """获取统计数据"""
    stats = order_manager.get_statistics()
    return jsonify(stats)


@app.route("/api/export", methods=["GET"])
@require_api_key
def export_orders():
    """导出订单数据为Excel（按平台分Sheet，格式化输出）
    
    支持 platform 参数：
      - 不传或 "all"：导出全部（国铁商城 + 齐心各一个Sheet）
      - "guotie"：仅导出 国铁商城订单（得力/阳采/德致/其他）
      - "qixin"：仅导出 齐心订单
    """
    platform = request.args.get("platform", "all").strip().lower()
    
    filepath = order_manager.export_excel(platform=platform)
    
    if platform == "guotie":
        name_prefix = "国铁商城订单"
    elif platform == "qixin":
        name_prefix = "齐心订单"
    else:
        name_prefix = "订单汇总"
    
    download_name = f"{name_prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return send_file(
        filepath,
        as_attachment=True,
        download_name=download_name,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


@app.route("/api/batch-upload", methods=["POST"])
@require_api_key
def batch_upload():
    """批量上传PDF"""
    if 'files' not in request.files:
        return jsonify({"error": "请上传PDF文件"}), 400
    
    platform = request.form.get("platform", "其他").strip()
    if platform not in PLATFORMS:
        platform = "其他"
    
    files = request.files.getlist('files')
    results = []
    errors = []
    
    for file in files:
        if not file.filename.lower().endswith('.pdf'):
            errors.append({"file": file.filename, "error": "非PDF文件"})
            continue
        
        filename = secure_filename(file.filename)
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
        saved_name = f"{timestamp}_{filename}"
        filepath = os.path.join(UPLOAD_FOLDER, saved_name)
        file.save(filepath)
        
        try:
            order_rows = extract_order_from_pdf(filepath, platform=platform)
            for row in order_rows:
                result = order_manager.add_order(row)
                results.append(result)
            try:
                os.remove(filepath)
            except:
                pass
        except Exception as e:
            errors.append({"file": filename, "error": str(e)})
    
    return jsonify({
        "success": True,
        "processed": len(results),
        "failed": len(errors),
        "orders": results,
        "errors": errors
    })


# ============ 企业微信 Webhook 接入 ============

@app.route("/api/wecom/callback", methods=["GET"])
def wecom_verify():
    """企业微信URL验证"""
    msg_signature = request.args.get("msg_signature", "")
    timestamp = request.args.get("timestamp", "")
    nonce = request.args.get("nonce", "")
    echostr = request.args.get("echostr", "")
    
    # 简易验证（生产环境需完整实现加解密）
    if WECOM_TOKEN != "your-token":
        try:
            from wecom_crypto import WXBizMsgCrypt
            crypt = WXBizMsgCrypt(WECOM_TOKEN, WECOM_ENCODING_AES_KEY, WECOM_CORP_ID)
            ret, echo_text = crypt.VerifyURL(msg_signature, timestamp, nonce, echostr)
            if ret == 0:
                return echo_text
        except ImportError:
            pass
    
    # 简化验证
    return echostr


@app.route("/api/wecom/callback", methods=["POST"])
def wecom_callback():
    """接收企业微信消息"""
    try:
        data = request.get_json()
        
        # 解析消息
        if "encrypt" in data:
            # 加密消息需要解密
            try:
                from wecom_crypto import WXBizMsgCrypt
                crypt = WXBizMsgCrypt(WECOM_TOKEN, WECOM_ENCODING_AES_KEY, WECOM_CORP_ID)
                # 解密处理...
            except ImportError:
                pass
            return "success"
        
        # 处理明文消息
        msg_type = data.get("MsgType", "")
        
        if msg_type == "text":
            # 文本消息 - 支持查询订单
            content = data.get("Content", "").strip()
            from_user = data.get("FromUserName", "")
            
            if content.startswith("查询") or content.startswith("cx"):
                # 查询订单
                keyword = content.replace("查询", "").replace("cx", "").strip()
                orders = order_manager.get_all_orders(search=keyword)
                reply = _format_orders_for_wecom(orders["data"][:5])
            elif content == "统计" or content == "tj":
                stats = order_manager.get_statistics()
                reply = _format_stats_for_wecom(stats)
            else:
                reply = (
                    "📋 订单管理助手使用说明：\n\n"
                    "1️⃣ 直接发送PDF文件 → 自动识别订单信息\n"
                    "2️⃣ 发送「查询 + 关键词」→ 搜索订单\n"
                    "   例如：查询 张三\n"
                    "3️⃣ 发送「统计」→ 查看汇总数据\n"
                    "4️⃣ 发送「导出」→ 获取Excel汇总表\n"
                )
            
            _send_wecom_reply(from_user, reply)
            return "success"
        
        elif msg_type == "file":
            # 文件消息 - 下载PDF并处理
            media_id = data.get("MediaId", "")
            from_user = data.get("FromUserName", "")
            
            if media_id:
                # 下载文件
                pdf_path = _download_wecom_media(media_id)
                if pdf_path:
                    try:
                        # 企微发送文件默认按"其他"平台处理
                        order_rows = extract_order_from_pdf(pdf_path, platform="其他")
                        results = []
                        for row in order_rows:
                            result = order_manager.add_order(row)
                            results.append(result)
                        reply = f"✅ 订单识别成功！共 {len(results)} 条商品记录\n\n{_format_order_for_wecom(results[0])}"
                        if len(results) > 1:
                            reply += f"\n... 共 {len(results)} 条商品记录"
                    except Exception as e:
                        reply = f"❌ 处理失败：{str(e)}"
                    finally:
                        try:
                            os.remove(pdf_path)
                        except:
                            pass
                    
                    _send_wecom_reply(from_user, reply)
            
            return "success"
    
    except Exception as e:
        print(f"企业微信回调异常: {e}")
        return "success"  # 总是返回success避免重试


def _format_order_for_wecom(order: dict) -> str:
    """格式化订单信息为企业微信消息"""
    is_qixin = order.get('_platform_type') == 'qixin' or order.get('平台来源') == '齐心'
    
    if is_qixin:
        lines = [
            f"📦 采购单号：{order.get('采购单号', 'N/A')}",
            f"📑 合约单号：{order.get('合约单号', 'N/A')}",
            f"📅 发货日期：{order.get('发货日期', 'N/A')}",
            f"🏢 客户名称：{order.get('客户名称', 'N/A')}",
            f"🚚 送方名称：{order.get('送方名称', 'N/A')}",
            f"📋 产品：{order.get('产品名称', 'N/A')}",
            f"💰 金额合计（小写）：¥{order.get('金额合计（小写）', 'N/A')}",
        ]
    else:
        lines = [
            f"📦 采购单编号：{order.get('采购单编号', 'N/A')}",
            f"📅 审批通过时间：{order.get('审批通过时间', 'N/A')}",
            f"🏪 平台来源：{order.get('平台来源', 'N/A')}",
            f"🚚 供应商：{order.get('供应商名称', 'N/A')}",
            f"📋 商品：{order.get('商品名称', 'N/A')}",
            f"💰 合计金额：¥{order.get('合计金额', 'N/A')}",
        ]

    lines.append(f"📍 收货人：{order.get('收货人', 'N/A')} | {order.get('收货人联系方式', 'N/A')}")
    return "\n".join(lines)


def _format_orders_for_wecom(orders: list) -> str:
    """格式化订单列表为企业微信消息"""
    if not orders:
        return "未找到相关订单"
    lines = [f"找到 {len(orders)} 条订单：\n"]
    for i, order in enumerate(orders[:5], 1):
        is_qixin = order.get('_platform_type') == 'qixin'
        if is_qixin:
            order_no = order.get('采购单号', '?')[:15]
            amount = order.get('金额合计（小写）', '?')
        else:
            order_no = order.get('采购单编号', '?')[:15]
            amount = order.get('合计（含税）', '?')
        lines.append(
            f"{i}. [{order.get('平台来源', '?')}] "
            f"{order_no} "
            f"¥{amount}"
        )
    return "\n".join(lines)


def _format_stats_for_wecom(stats: dict) -> str:
    """格式化统计数据"""
    lines = [
        f"📊 订单统计汇总",
        f"━━━━━━━━━━━━━━",
        f"📦 订单总数：{stats.get('订单总数', 0)}",
        f"💰 总金额：¥{stats.get('总金额', 0)}",
    ]
    platform_dist = stats.get('平台分布', {})
    if platform_dist:
        lines.append(f"\n📋 平台分布：")
        for platform, count in platform_dist.items():
            lines.append(f"  • {platform}：{count} 单")
    return "\n".join(lines)


def _send_wecom_reply(to_user: str, content: str):
    """发送企业微信回复消息"""
    if WECOM_APP_SECRET == "your-app-secret":
        print(f"[WeCom Reply] To: {to_user}\n{content}")
        return
    
    try:
        # 获取access_token
        token_url = (
            f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?"
            f"corpid={WECOM_CORP_ID}&corpsecret={WECOM_APP_SECRET}"
        )
        resp = requests.get(token_url)
        access_token = resp.json().get("access_token", "")
        
        # 发送消息
        msg_url = (
            f"https://qyapi.weixin.qq.com/cgi-bin/message/send?"
            f"access_token={access_token}"
        )
        payload = {
            "touser": to_user,
            "msgtype": "text",
            "agentid": 1000002,  # 替换为实际agentid
            "text": {"content": content}
        }
        requests.post(msg_url, json=payload)
    except Exception as e:
        print(f"企业微信回复失败: {e}")


def _download_wecom_media(media_id: str) -> str:
    """下载企业微信临时素材"""
    try:
        token_url = (
            f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?"
            f"corpid={WECOM_CORP_ID}&corpsecret={WECOM_APP_SECRET}"
        )
        resp = requests.get(token_url)
        access_token = resp.json().get("access_token", "")
        
        media_url = (
            f"https://qyapi.weixin.qq.com/cgi-bin/media/get?"
            f"access_token={access_token}&media_id={media_id}"
        )
        
        resp = requests.get(media_url)
        filepath = os.path.join(UPLOAD_FOLDER, f"wecom_{media_id}.pdf")
        with open(filepath, "wb") as f:
            f.write(resp.content)
        return filepath
    except Exception as e:
        print(f"下载企业微信素材失败: {e}")
        return None


# ============ 机器人Webhook快速通道 ============

@app.route("/api/wecom/webhook", methods=["POST"])
def wecom_webhook():
    """
    企业微信群机器人Webhook接收端
    在群聊中 @机器人 并发送PDF文件，自动识别并回复
    """
    try:
        data = request.get_json()
        
        # 群机器人消息格式
        msg_type = data.get("msgtype", data.get("MsgType", ""))
        
        # 处理文件上传
        if "file" in data or "media_id" in data:
            # 下载并处理
            pass
        
        # 通过Webhook回复
        if WECOM_WEBHOOK_URL != "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=your-key-here":
            import requests as req
            req.post(WECOM_WEBHOOK_URL, json={
                "msgtype": "text",
                "text": {
                    "content": "📋 收到您的订单文件，正在识别中...\n请稍候，识别完成后会自动通知您。"
                }
            })
        
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============ 页面路由 ============

@app.route("/", methods=["GET"])
def index():
    """主页面"""
    return render_template("index.html")


# ============ 启动服务（支持ngrok公网穿透） ============

def start_ngrok():
    """启动ngrok隧道，返回公网URL"""
    try:
        from pyngrok import ngrok, conf
        # 尝试从环境变量获取authtoken
        authtoken = os.environ.get("NGROK_AUTH_TOKEN", "")
        if authtoken:
            conf.get_default().auth_token = authtoken
        
        # 建立HTTP隧道
        tunnel = ngrok.connect(SERVER_PORT, "http")
        public_url = tunnel.public_url
        print(f"\n{'='*50}")
        print(f"🌐 公网访问地址: {public_url}")
        print(f"{'='*50}\n")
        return public_url
    except ImportError:
        print("\n💡 提示: 安装 pyngrok 可自动获取公网地址")
        print("   pip install pyngrok")
        print(f"   本地访问: http://localhost:{SERVER_PORT}\n")
        return None
    except Exception as e:
        print(f"\n⚠️ ngrok启动失败: {e}")
        print(f"   本地访问: http://localhost:{SERVER_PORT}\n")
        return None


if __name__ == "__main__":
    import socket
    # 获取本机局域网IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except:
        local_ip = "127.0.0.1"
    
    print(f"\n{'='*50}")
    print(f"  订单信息提取与汇总系统")
    print(f"  本地访问: http://localhost:{SERVER_PORT}")
    print(f"  局域网访问: http://{local_ip}:{SERVER_PORT}")
    print(f"{'='*50}")
    
    # 尝试启动ngrok公网穿透
    public_url = start_ngrok()
    
    if public_url:
        print(f"🎉 分享这个地址给其他人即可使用:")
        print(f"   {public_url}")
        print()
    
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False)
