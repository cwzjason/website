# 订单信息提取与汇总系统 - PDF解析模块

import fitz  # PyMuPDF
import os
import re
import json
import requests
from PIL import Image, ImageEnhance, ImageFilter
import io
import base64
import tempfile
from datetime import datetime

from config import (
    AI_API_URL, get_ai_api_key, AI_MODEL, ORDER_FIELDS_A, ORDER_FIELDS_B,
    AI_PROVIDER, TEMPLATE_A_PLATFORMS, TEMPLATE_B_PLATFORMS
)

# 尝试导入备用模型配置
try:
    from config import AI_FALLBACK_MODELS
except ImportError:
    AI_FALLBACK_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash"]

# ============ PaddleOCR 全局实例（惰性加载） ============
_paddle_ocr = None

def _get_ocr():
    """惰性加载 PaddleOCR，避免启动时耗时"""
    global _paddle_ocr
    if _paddle_ocr is None:
        try:
            from paddleocr import PaddleOCR
            # PaddleOCR 3.x: 使用新版API参数
            _paddle_ocr = PaddleOCR(lang='ch', use_angle_cls=True)
            print("[PaddleOCR] 初始化成功")
        except Exception as e:
            print(f"[PaddleOCR] 初始化失败: {e}")
            _paddle_ocr = False
    return _paddle_ocr if _paddle_ocr is not False else None


class PDFParser:
    """PDF文件解析器，提取文本内容"""

    @staticmethod
    def extract_text(pdf_path: str) -> str:
        """从PDF中提取纯文本（多种方式尝试，确保最大限度提取）"""
        doc = fitz.open(pdf_path)
        full_text = []
        for page in doc:
            text = None

            # 方式1: 纯文本提取
            raw_text = page.get_text("text")
            if raw_text and raw_text.strip():
                text = raw_text.strip()

            # 方式2: 按块提取（保留表格结构）
            if not text:
                blocks = page.get_text("blocks")
                if blocks:
                    text = "\n".join([
                        b[4] if isinstance(b, (list, tuple)) and len(b) > 4 else str(b)
                        for b in blocks
                    ])
                    if text and not text.strip():
                        text = None

            # 方式3: 尝试 HTML 提取（保留表格标记）
            if not text:
                html_text = page.get_text("html")
                if html_text and html_text.strip():
                    text = html_text.strip()

            # 方式4: 尝试 dict 提取
            if not text:
                text_dict = page.get_text("dict")
                if text_dict:
                    text = json.dumps(text_dict, ensure_ascii=False)

            if text and text.strip():
                full_text.append(text.strip())
        doc.close()
        return "\n---PAGE---\n".join(full_text)

    @staticmethod
    def extract_text_with_layout(pdf_path: str) -> str:
        """提取文本并保留布局信息（按block提取）"""
        doc = fitz.open(pdf_path)
        blocks_list = []
        for page_num, page in enumerate(doc):
            blocks = page.get_text("blocks")
            page_blocks = []
            for block in blocks:
                text = block[4].strip()
                if text:
                    y_pos = block[1]
                    page_blocks.append((y_pos, text))
            page_blocks.sort(key=lambda x: x[0])
            blocks_list.extend([f"[Page {page_num+1}] {b[1]}" for b in page_blocks])
        doc.close()
        return "\n".join(blocks_list)

    @staticmethod
    def extract_images(pdf_path: str, output_dir: str = "temp_images") -> list:
        """从PDF中提取图片，用于视觉识别"""
        doc = fitz.open(pdf_path)
        image_paths = []
        os.makedirs(output_dir, exist_ok=True)

        for page_num, page in enumerate(doc):
            image_list = page.get_images(full=True)
            for img_index, img in enumerate(image_list):
                xref = img[0]
                base_image = doc.extract_image(xref)
                image_bytes = base_image["image"]
                image_ext = base_image["ext"]

                img_path = os.path.join(
                    output_dir,
                    f"page{page_num+1}_img{img_index+1}.{image_ext}"
                )
                with open(img_path, "wb") as f:
                    f.write(image_bytes)
                image_paths.append(img_path)

        doc.close()
        return image_paths

    @staticmethod
    def page_to_image(pdf_path: str, page_num: int = 0) -> str:
        """将PDF页面转换为图片（用于视觉识别）"""
        doc = fitz.open(pdf_path)
        page = doc[page_num]
        # 使用更高DPI确保文字清晰可识别
        pix = page.get_pixmap(dpi=300)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        doc.close()

        buffer = io.BytesIO()
        img.save(buffer, format="PNG", optimize=True)
        img_base64 = base64.b64encode(buffer.getvalue()).decode()
        return img_base64

    @staticmethod
    def all_pages_to_images(pdf_path: str, max_size_mb: float = 4.0) -> list:
        """将PDF所有页面转为base64图片列表，返回 (base64, mime_type) 元组列表
        自动进行图像预处理（增强对比度+锐化），提升OCR识别率
        
        Args:
            pdf_path: PDF文件路径
            max_size_mb: 单张图片最大大小(MB)，超过则自动降低质量
        """
        doc = fitz.open(pdf_path)
        images = []
        for page_num in range(len(doc)):
            page = doc[page_num]
            # 使用更高DPI确保文字清晰可识别
            pix = page.get_pixmap(dpi=300)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            
            # 图片预处理：增强对比度 + 锐化，让文字更清晰
            enhancer = ImageEnhance.Contrast(img)
            img = enhancer.enhance(1.2)  # 适度增强对比度
            img = img.filter(ImageFilter.SHARPEN)  # 锐化边缘
            
            # 先尝试PNG格式（质量最好）
            buffer = io.BytesIO()
            img.save(buffer, format="PNG", optimize=True)
            png_size_mb = len(buffer.getvalue()) / (1024 * 1024)
            
            if png_size_mb <= max_size_mb:
                # PNG大小合适，直接使用
                img_base64 = base64.b64encode(buffer.getvalue()).decode()
                images.append((img_base64, "image/png"))
            else:
                # PNG太大，尝试高质量JPEG
                buffer = io.BytesIO()
                img.save(buffer, format="JPEG", quality=95, optimize=True)
                jpeg_size_mb = len(buffer.getvalue()) / (1024 * 1024)
                
                if jpeg_size_mb > max_size_mb:
                    # 还是太大，适当缩放图片尺寸
                    scale = (max_size_mb / jpeg_size_mb) ** 0.5
                    new_w = int(img.width * scale)
                    new_h = int(img.height * scale)
                    img = img.resize((new_w, new_h), Image.LANCZOS)
                    buffer = io.BytesIO()
                    img.save(buffer, format="JPEG", quality=95, optimize=True)
                
                img_base64 = base64.b64encode(buffer.getvalue()).decode()
                images.append((img_base64, "image/jpeg"))
            
            print(f"[PDF解析] 第{page_num+1}页图片大小: {len(img_base64)/1024:.1f}KB (base64)")
        doc.close()
        return images

    @staticmethod
    def ocr_pages_to_text(pdf_path: str) -> str:
        """对PDF每一页进行OCR识别，返回纯文本"""
        ocr = _get_ocr()
        if ocr is None:
            return ""

        doc = fitz.open(pdf_path)
        all_text_lines = []

        for page_num in range(len(doc)):
            page = doc[page_num]
            # 渲染页面为图片
            pix = page.get_pixmap(dpi=200)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

            # 保存到临时文件供PaddleOCR读取
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
                img.save(tmp.name, format='PNG')
                tmp_path = tmp.name

            try:
                result = ocr.ocr(tmp_path)
                if result and result[0]:
                    page_lines = [line[1][0] for line in result[0]]
                    all_text_lines.append(f"--- 第{page_num+1}页 OCR识别 ---")
                    all_text_lines.extend(page_lines)
                    print(f"[OCR] 第{page_num+1}页识别到 {len(page_lines)} 行文字")
            except Exception as e:
                print(f"[OCR] 第{page_num+1}页识别失败: {e}")
            finally:
                os.unlink(tmp_path)

        doc.close()
        return "\n".join(all_text_lines)

    @classmethod
    def extract_full_text(cls, pdf_path: str) -> str:
        """提取PDF内嵌文本（纯文本提取，不使用OCR）"""
        embedded = cls.extract_text(pdf_path)
        if embedded.strip():
            print(f"[文本提取] 内嵌文本: {len(embedded)} 字符")
            return embedded
        print(f"[文本提取] 未提取到内嵌文本")
        return ""

    @staticmethod
    def save_text_file(pdf_path: str, text: str, output_dir: str = "uploads") -> str:
        """保存提取的文本为TXT文件，返回TXT文件路径"""
        base_name = os.path.splitext(os.path.basename(pdf_path))[0]
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        txt_filename = f"{timestamp}_{base_name}.txt"
        txt_path = os.path.join(output_dir, txt_filename)
        os.makedirs(output_dir, exist_ok=True)

        with open(txt_path, 'w', encoding='utf-8') as f:
            f.write(f"# 订单文本提取结果\n")
            f.write(f"# 源文件: {os.path.basename(pdf_path)}\n")
            f.write(f"# 提取时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"# {'='*50}\n\n")
            f.write(text)

        print(f"[文本保存] 已保存到: {txt_path}")
        return txt_path


# ============ 模版A（得力/阳采/德致/其他）识别提示词 ============

TEMPLATE_A_SYSTEM_PROMPT = """你是一个专业的采购订单信息提取助手。当前订单来自国铁商城/电商平台（得力、阳采、德致或其他平台），请从PDF文档中提取订单信息。

**核心原则：图片优先识别**
- 由于PDF可能是扫描件或图片型文档，文本提取可能不完整
- 你必须以页面图片为主要识别来源，文本仅作辅助参考
- 逐页仔细查看所有图片，确保不遗漏任何信息
- 表格的列标题通常在图片顶部，根据列标题找到对应的列数据

**重要：多商品拆分规则**
如果订单包含多行商品明细（表格中有多行），你必须为每一行商品分别提取。返回一个JSON数组，每个元素代表一行商品记录。前置信息（采购单编号、收料单位、收货地址等）在每条记录中保持一致。

请严格按照以下字段名返回，这些字段名对应国铁商城采购订单模板的原生表头：

[
  {
    "采购单编号": "采购单编号（通常在订单顶部）",
    "需求单编号": "需求单编号",
    "审批通过时间": "审批通过时间，格式YYYY-MM-DD",
    "收料单位": "收料单位",
    "所属路局": "所属路局",
    "单位编号": "单位编号",
    "供应商名称": "供应商名称",
    "供应商编码": "供应商编码",
    "下单人": "下单人",
    "收货人": "收货人",
    "收货人联系方式": "收货人联系方式（手机号或座机号）",
    "收货地址": "完整收货地址",
    "商品名称": "当前行商品名称（完整名称，包含规格型号描述）",
    "品牌": "当前行品牌",
    "单位": "单位（如：个、台、套、件等）",
    "数量": "数量（纯数字）",
    "单价（含税）": "当前行含税单价（纯数字，不要带'¥'）",
    "合计（含税）": "当前行金额小计（单价×数量，纯数字，不要带'¥'）",
    "合计金额": "整个订单的总合计金额（订单底部总计金额，纯数字，每行相同，不要带'¥'）",
    "发票备注": "发票备注",
    "订单备注": "订单备注/其他备注",
    "商品明细JSON": ""
  }
]

识别规则：
1. 商品表格有多少行就返回多少个JSON对象
2. 前置信息（采购单编号、收料单位、收货地址、供应商、下单人、收货人、收货人联系方式等）每条记录都填一样
3. 合计（含税）是当前行的小计金额（单价×数量），每行可能不同
4. 合计金额是整个订单底部的总合计金额，每行都填相同的值
5. 日期统一为YYYY-MM-DD格式
6. 如果某字段不存在，返回空字符串""
7. 单价（含税）、合计（含税）、合计金额都是纯数字，不要带"¥"符号
8. 不要将合计金额的值填到合计（含税）上，两者是不同的字段
9. **务必逐页仔细查看所有图片**，图片中的表格是主要识别对象
10. **即使文本提取不完整，也要从图片中尽力识别所有字段**，不要留空
11. 如果图片中的文字模糊，请根据上下文和表格结构合理推断"""

# ============ 模版B（齐心）识别提示词 ============

TEMPLATE_B_SYSTEM_PROMPT = """你是一个专业的采购订单信息提取助手。当前订单来自深圳齐心集团销售到货签收单，请从PDF文档中提取订单信息。

**齐心订单使用完全独立的字段体系，请不要使用国铁商城/得力等其他平台的字段名。**

**重要：多商品拆分规则**
如果订单包含多行商品明细（表格中有多行），你必须为每一行商品分别提取。返回一个JSON数组，每个元素代表一行商品记录。前置信息在每条记录中保持一致。

请严格按照以下字段名返回，这些字段名对应齐心销售到货签收单模板的原生表头：

[
  {
    "采购单号": "采购单号（如1260330090500789，不是DN开头的发货单号）",
    "发货日期": "发货日期，格式YYYY-MM-DD",
    "客户名称": "客户名称",
    "客户地址": "客户地址",
    "收货人": "收货人",
    "联系人": "联系人",
    "联系电话": "联系电话",
    "送方名称": "送方名称",
    "收货地址": "收货地址",
    "合约单号": "合约单号（如LINK开头）",
    "经办人": "经办人",
    "序号": "当前行序号",
    "货号": "当前行货号",
    "产品名称": "当前行产品名称（原样提取，不要拆分规格型号）",
    "单位": "单位",
    "数量": "数量（纯数字）",
    "单价": "当前行单价（纯数字，不要带'¥'）",
    "金额": "当前行金额（纯数字，不要带'¥'）",
    "金额合计（小写）": "金额合计小写（纯数字，每行相同，不要带'¥'）",
    "备注": "备注信息",
    "商品明细JSON": ""
  }
]

识别规则：
1. 商品表格有多少行就返回多少个JSON对象
2. 前置信息（采购单号、客户名称、客户地址、送方名称、经办人、收货人、联系人、联系电话等）每条记录都填一样
3. 金额合计（小写）每条记录都填相同的值
4. 日期统一为YYYY-MM-DD格式
5. 如果某字段不存在，返回空字符串""
6. 单价、金额、金额合计（小写）都是纯数字，不要带"¥"符号
7. 产品名称原样提取，不要拆分规格型号"""



class OrderAIExtractor:
    """使用AI大模型从PDF文本中提取订单结构化信息（腾讯混元HY3）"""

    @classmethod
    def get_system_prompt(cls, platform: str) -> str:
        """根据平台返回对应的识别提示词"""
        if platform in TEMPLATE_B_PLATFORMS:
            return TEMPLATE_B_SYSTEM_PROMPT
        else:
            return TEMPLATE_A_SYSTEM_PROMPT

    @classmethod
    def _parse_ai_response(cls, content: str) -> list:
        """解析AI返回的JSON内容"""
        content = content.strip()
        # 清理markdown代码块标记
        if content.startswith("```json"):
            content = content[7:]
        if content.startswith("```"):
            content = content[3:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()

        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                parsed = [parsed]
            return parsed
        except json.JSONDecodeError:
            match = re.search(r'\[[\s\S]*\]', content)
            if match:
                try:
                    return json.loads(match.group())
                except:
                    pass
            print(f"[AI识别] JSON解析失败: {content[:300]}")
            return []

    @classmethod
    def extract_with_ai(cls, pdf_text: str, pdf_images_base64: list = None,
                        platform: str = "其他") -> list:
        """使用HY3多模态API提取订单信息，返回商品行列表"""
        system_prompt = cls.get_system_prompt(platform)

        # 兼容旧的纯base64列表和新的(base64, mime_type)元组列表
        images = []
        if pdf_images_base64:
            for item in pdf_images_base64:
                if isinstance(item, (list, tuple)):
                    images.append(item)
                else:
                    images.append((item, "image/png"))

        print(f"[AI识别] 使用HY3, 图片数: {len(images)}, 文本长度: {len(pdf_text)}")

        # 构建提示词
        if pdf_text.strip():
            text_snippet = pdf_text[:30000]
            if len(pdf_text) > 30000:
                text_snippet += f"\n\n...(文本过长，已截断，剩余{len(pdf_text) - 30000}字符，请优先从图片中识别)"
            prompt = system_prompt + f"\n\n以下是从PDF中提取的文本内容（作为辅助参考，请优先根据页面图片进行识别）：\n\n{text_snippet}"
        else:
            prompt = system_prompt + "\n\n该PDF为图片型文档，无法提取文本内容，请完全根据页面图片进行识别提取。"

        # 构建 OpenAI 兼容的 content 数组
        content_parts = []

        # 先添加图片（多模态识别）
        for img_b64, mime_type in images:
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{img_b64}"}
            })

        # 最后添加文本指令
        content_parts.append({"type": "text", "text": prompt})

        payload = {
            "model": AI_MODEL,
            "messages": [{"role": "user", "content": content_parts}],
            "temperature": 0.05,
            "max_tokens": 8192,
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {get_ai_api_key()}",
        }

        try:
            print(f"[AI识别] 发送请求到 {AI_API_URL}")
            resp = requests.post(AI_API_URL, headers=headers, json=payload, timeout=300)
            if resp.status_code != 200:
                print(f"[AI识别] HTTP {resp.status_code}: {resp.text[:500]}")
                return []

            result = resp.json()
            if "error" in result:
                print(f"[AI识别] API错误: {result['error']}")
                return []

            content = result["choices"][0]["message"]["content"]
            parsed = cls._parse_ai_response(content)
            print(f"[AI识别] 成功识别 {len(parsed)} 条记录")
            return parsed

        except Exception as e:
            print(f"[AI识别] HY3请求失败: {e}")
            return []

    @classmethod
    def _extract_kv_fields(cls, text: str, patterns: dict) -> dict:
        """通用的键值对字段提取"""
        result = {}
        for field, regex in patterns.items():
            match = re.search(regex, text)
            if match:
                val = match.group(1).strip()
                # 日期格式化
                if '日期' in field or '时间' in field:
                    val = val.replace('年', '-').replace('月', '-').replace('日', '').replace('/', '-')
                result[field] = val
        return result

    @classmethod
    def _extract_table_rows(cls, text: str, field_map: dict) -> list:
        """从文本中提取表格商品行，按表头列名精确一一对应。
        支持PDF内嵌文本的垂直排列布局（每个单元格一行）。"""
        rows = []
        lines = [l.strip() for l in text.split('\n') if l.strip()]

        # 严格表头匹配：每个表头必须是独立词（允许带（含税）后缀），
        # 避免 "合计" 被包含在 "合计笔数"、"合计金额" 中误识别为表头。
        header_patterns = {
            '序号': r'(?:^|\s)序号(?:\s|$)',
            '需求单类型': r'(?:^|\s)需求单类型(?:\s|$)',
            '子订单编号': r'(?:^|\s)子订单编号(?:\s|$)',
            '单号编码': r'(?:^|\s)单号编码(?:\s|$)',
            '需求单编号': r'(?:^|\s)需求单编号(?:\s|$)',
            '商品名称': r'(?:^|\s)商品名称(?:\s|$)',
            '规格型号': r'(?:^|\s)规格型号(?:\s|$)',
            '品牌': r'(?:^|\s)品牌(?:\s|$)',
            '单位': r'(?:^|\s)单位(?:\s|$|[（(])',
            '数量': r'(?:^|\s)数量(?:\s|$)',
            '单价': r'(?:^|\s)单价(?:\s|$|[（(])',
            '合计': r'(?:^|\s)合计(?:\s|$|[（(])',
            '签收人': r'(?:^|\s)签收人(?:\s|$)',
        }

        header_rows = []  # [(line_index, [header_name...])]
        for i, line in enumerate(lines):
            found = []
            for std_name, pattern in header_patterns.items():
                if re.search(pattern, line):
                    # 排除干扰："收货单位"、"收料单位"、"计量单位" 不是 "单位"
                    if std_name == '单位' and re.search(r'收货单位|收料单位|计量单位|需求单位', line):
                        continue
                    # 排除干扰："合计笔数"、"合计金额" 不是 "合计" 表头
                    if std_name == '合计' and re.search(r'合计笔数|合计金额', line):
                        continue
                    found.append(std_name)
            if found:
                header_rows.append((i, found))

        if not header_rows:
            print("[规则提取] 未识别到表格表头")
            return rows

        # 合并所有表头，按出现顺序去重
        headers = []
        for _, hlist in header_rows:
            for h in hlist:
                if h not in headers:
                    headers.append(h)

        # 数据从最后一个表头行的下一行开始
        data_start = header_rows[-1][0] + 1

        # 收集数据单元格，直到遇到结束标记
        data_cells = []
        for j in range(data_start, min(data_start + 200, len(lines))):
            dl = lines[j]
            if re.search(r'(合计笔数|合计金额|备注|签名|日期|Powered by|制单人|收货单位|验收单)', dl):
                break
            data_cells.append(dl)

        n_cols = len(headers)
        if n_cols == 0 or len(data_cells) == 0:
            return rows

        # 列名 -> 标准字段名
        header_to_field = {
            '商品名称': '商品名称',
            '品牌': '品牌',
            '单位': '单位',
            '数量': '数量',
            '单价': '单价（含税）',
            '合计': '合计（含税）',
            '需求单编号': '需求单编号',
            '子订单编号': '子订单编号',
            '单号编码': '单号编码',
            '规格型号': '规格型号',
            '签收人': '签收人',
        }

        # 表格数据常见的真实列数（含可能缺失的表头）
        # 如果数据单元格数不能被表头数整除，且差值为1，尝试插入缺失的"需求单编号"
        if len(data_cells) % n_cols != 0:
            if '需求单编号' not in headers and '单号编码' in headers:
                insert_pos = headers.index('单号编码') + 1
                headers.insert(insert_pos, '需求单编号')
                n_cols = len(headers)
                print(f"[规则提取] 补全缺失表头：需求单编号，现 {n_cols} 列")

        n_rows = len(data_cells) // n_cols
        print(f"[规则提取] 表头：{headers}，列数：{n_cols}，数据单元格：{len(data_cells)}，商品行数：{n_rows}")

        # 按列优先分配每个单元格到对应的商品行
        table_data = [dict() for _ in range(n_rows)]  # 每行一个 dict
        for idx, val in enumerate(data_cells):
            col_idx = idx % n_cols
            row_idx = idx // n_cols
            if row_idx >= n_rows:
                break
            header = headers[col_idx]
            table_data[row_idx][header] = val

        # 标准化字段并合并被拆分的数字
        for raw_row in table_data:
            row = {}

            # 商品名称：可能包含品牌/单位，拆分出标准字段
            if '商品名称' in raw_row:
                name = raw_row['商品名称']
                # 如果末尾包含品牌、单位，拆分出来
                parts = name.split()
                if parts:
                    # 最后一段是单位（单个字/常见单位）
                    if len(parts) >= 2 and parts[-1] in ['台', '个', '件', '套', '箱', '支', '张', '本', '卷', '包']:
                        row['单位'] = parts[-1]
                        parts = parts[:-1]
                    # 倒数第二段可能是品牌（如果当前没有品牌）
                    if '品牌' not in raw_row or not raw_row.get('品牌'):
                        if len(parts) >= 2 and parts[-1] in ['得力', '齐心', '晨光', '广博', '三木']:
                            row['品牌'] = parts[-1]
                            parts = parts[:-1]
                    row['商品名称'] = ' '.join(parts)
                else:
                    row['商品名称'] = name

            # 直接映射其他字段
            for h in ['品牌', '单位', '规格型号', '签收人', '需求单编号']:
                if h in raw_row and raw_row[h]:
                    field = header_to_field.get(h, h)
                    row[field] = raw_row[h]

            # 数字字段提取
            for h in ['数量', '单价', '合计']:
                if h in raw_row and raw_row[h]:
                    val = raw_row[h].replace('¥', '').replace('￥', '').replace(',', '').replace('，', '')
                    m = re.search(r'(\d+\.?\d*)', val)
                    if m:
                        field = header_to_field[h]
                        row[field] = m.group(1)

            # 处理子订单编号 / 单号编码 / 需求单编号
            # 如果"子订单编号"+"单号编码"拼接成完整采购单号
            if '子订单编号' in raw_row and '单号编码' in raw_row:
                a = raw_row['子订单编号'].strip()
                b = raw_row['单号编码'].strip()
                # 如果都是数字，拼接
                if a.isdigit() and b.isdigit():
                    row['采购单编号'] = a + b
                else:
                    row['采购单编号'] = a
                    row['需求单编号'] = b
            elif '子订单编号' in raw_row:
                row['采购单编号'] = raw_row['子订单编号']
            elif '单号编码' in raw_row:
                row['采购单编号'] = raw_row['单号编码']

            if '需求单编号' in raw_row and raw_row['需求单编号']:
                row['需求单编号'] = raw_row['需求单编号']

            if row:
                rows.append(row)

        return rows

    @classmethod
    def extract_with_rule_fallback(cls, pdf_text: str, platform: str = "其他") -> list:
        """基于规则的回退方案：当AI不可用时使用正则提取（返回商品行列表）"""
        is_qixin = platform in TEMPLATE_B_PLATFORMS
        text = pdf_text

        if is_qixin:
            # ===== 模版B（齐心）规则提取 =====
            field_def = ORDER_FIELDS_B
            kv_patterns = {
                "采购单号": r'采购单号[：:\s]*(\d+)',
                "合约单号": r'合约单号[：:\s]*(\S+)',
                "发货日期": r'发货日期[：:\s]*(\d{4}[-/]\d{1,2}[-/]\d{1,2})',
                "客户名称": r'客户名称[：:\s]*([^\n]+)',
                "客户地址": r'客户地址[：:\s]*([^\n]+)',
                "联系人": r'联系人[：:\s]*([^\n]+)',
                "送方名称": r'送方名称[：:\s]*([^\n]+)',
                "经办人": r'经办人[：:\s]*([^\n]+)',
                "收货人": r'收货人[：:\s]*([^\n]+)',
                "联系电话": r'(?:联系电话|电话)[：:\s]*(\d[\d\-]{6,15}\d)',
                "收货地址": r'(?:收货地址|客户地址)[：:\s]*([^\n]+)',
                "金额合计（小写）": r'(?:金额合计|合计金额)[^\d]*[小写][^\d]*(\d+\.?\d*)',
            }
            base_data = cls._extract_kv_fields(text, kv_patterns)

            # 日期回退
            if not base_data.get("发货日期"):
                match = re.search(r'(\d{4}[-/]\d{1,2}[-/]\d{1,2})', text)
                if match:
                    base_data["发货日期"] = match.group(1).replace('/', '-')

            # 电话回退
            if not base_data.get("联系电话"):
                match = re.search(r'\b(1[3-9]\d{9})\b', text)
                if match:
                    base_data["联系电话"] = match.group(1)

            # 金额回退
            if not base_data.get("金额合计（小写）"):
                match = re.search(r'(?:合计|总计)[^\d]*(\d+\.?\d*)', text)
                if match:
                    base_data["金额合计（小写）"] = match.group(1)

            order_data = {field: base_data.get(field, "") for field in field_def}
            return [order_data]

        else:
            # ===== 模版A（得力/阳采/德致/其他）规则提取 =====
            field_def = ORDER_FIELDS_A

            # 第一步：提取键值对字段（表头信息）
            kv_patterns = {
                "采购单编号": r'(?:采购单[编号]?|采购单号)[：:\s]*([A-Za-z0-9\-]+)',
                "需求单编号": r'需求单[编号]?[：:\s]*([A-Za-z0-9\-]+)',
                "审批通过时间": r'审批通过时间[：:\s]*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?)',
                "收料单位": r'收料单位[：:\s]*([^\n]+)',
                "所属路局": r'所属路局[：:\s]*([^\n]+)',
                "单位编号": r'单位编号[：:\s]*([A-Za-z0-9\-]+)',
                "供应商名称": r'供应商名称[：:\s]*([^\n]+)',
                "供应商编码": r'(?:供应商编码|编码)[：:\s]*([A-Za-z0-9\-]+)',
                "下单人": r'(?:下单人|经办人)[：:\s]*([^\n]+)',
                "收货人": r'收货人[：:\s]*([^\n]+)',
                "收货人联系方式": r'(?:收货人联系方式|联系电话|电话|联系方式)[：:\s]*(\d[\d\-]{6,15}\d)',
                "收货地址": r'(?:收货地址|地址)[：:\s]*([^\n]+)',
                "发票备注": r'(?:发票备注|发票)[：:\s]*([^\n]+)',
                "订单备注": r'(?:订单备注|备注)[：:\s]*([^\n]+)',
            }
            base_data = cls._extract_kv_fields(text, kv_patterns)

            # 日期回退
            if not base_data.get("审批通过时间"):
                match = re.search(r'(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?)', text)
                if match:
                    raw = match.group(1).replace('年', '-').replace('月', '-').replace('日', '').replace('/', '-')
                    base_data["审批通过时间"] = raw

            # 采购单编号回退
            if not base_data.get("采购单编号"):
                match = re.search(r'\b(\d{15,20})\b', text)
                if match:
                    base_data["采购单编号"] = match.group(1)

            # 电话回退
            if not base_data.get("收货人联系方式"):
                match = re.search(r'\b(1[3-9]\d{9})\b', text)
                if match:
                    base_data["收货人联系方式"] = match.group(1)

            # 供应商名称回退（OCR文本中可能无标签）
            if not base_data.get("供应商名称"):
                match = re.search(r'(?:公司|有限公司|贸易有限公司|商贸有限公司)', text)
                if match:
                    # 向前扩展取完整公司名
                    idx = text.find(match.group())
                    start = max(0, idx - 30)
                    snippet = text[start:idx + len(match.group())]
                    company_match = re.search(r'([\u4e00-\u9fa5（）()\w]+(?:有限公司|贸易有限公司|商贸有限公司))', snippet)
                    if company_match:
                        base_data["供应商名称"] = company_match.group(1)

            # 合计金额（订单底部总计）
            total_patterns = [
                r'(?:合计金额|订单合计|总计|总价|实付)[^\d]*[¥￥]?\s*(\d+\.?\d*)',
                r'(?:合计|总计)\s*[¥￥]?\s*(\d+\.?\d+)',
            ]
            for tp in total_patterns:
                match = re.search(tp, text)
                if match:
                    base_data["合计金额"] = match.group(1)
                    break

            # 第二步：提取商品表格行
            table_rows = cls._extract_table_rows(text, field_def)

            # 第三步：合并表头信息 + 商品行
            result_rows = []
            if table_rows:
                for row in table_rows:
                    full_row = {field: base_data.get(field, "") for field in field_def}
                    for k, v in row.items():
                        if k in field_def:
                            full_row[k] = v
                    result_rows.append(full_row)
            else:
                # 没有表格行，返回基础信息单行
                result_rows.append({field: base_data.get(field, "") for field in field_def})

            print(f"[规则提取] 返回 {len(result_rows)} 条商品记录")
            return result_rows


def extract_order_from_pdf(pdf_path: str, platform: str = "其他", use_ai: bool = True) -> tuple:
    """
    从PDF文件中提取订单信息的主函数

    Args:
        pdf_path: PDF文件路径
        platform: 平台来源（得力/阳采/德致/齐心/其他）
        use_ai: 是否使用AI识别（默认True）

    Returns:
        (order_rows, txt_path): 订单信息列表 + 提取文本的TXT文件路径
    """
    parser = PDFParser()

    # 1. 提取完整文本（内嵌文字 + OCR识别）
    print(f"[PDF解析] 文件: {pdf_path}")
    full_text = parser.extract_full_text(pdf_path)

    # 2. 保存提取的文本为TXT文件
    txt_path = parser.save_text_file(pdf_path, full_text)

    # 3. 分离内嵌文本用于规则解析
    text_for_rules = parser.extract_text(pdf_path)
    print(f"[PDF解析] 规则解析用文本长度: {len(text_for_rules)} 字符")

    # 4. 先用规则提取（稳定可靠）
    print(f"[规则提取] 开始规则提取，平台: {platform}")
    order_rows = OrderAIExtractor.extract_with_rule_fallback(text_for_rules, platform)
    print(f"[规则提取] 返回 {len(order_rows)} 条商品记录")

    # 5. AI增强（可选，规则结果为空或有AI Key时尝试）
    if use_ai:
        current_key = get_ai_api_key()
        if current_key and "your-tokenhub-key" not in current_key:
            print(f"[AI识别] 尝试AI增强识别，平台: {platform}")
            images_base64 = parser.all_pages_to_images(pdf_path)
            print(f"[PDF解析] 页面数: {len(images_base64)}")
            if images_base64:
                ai_rows = OrderAIExtractor.extract_with_ai(full_text, images_base64, platform)
                print(f"[AI识别] AI返回 {len(ai_rows)} 条记录")
                # AI有结果时使用AI，否则保留规则结果
                if ai_rows:
                    order_rows = ai_rows
                    print("[AI识别] 采用AI结果")
                else:
                    print("[AI识别] AI无结果，保留规则提取结果")
        else:
            print("[AI识别] 未配置AI Key，跳过AI")

    # 6. 根据平台选择字段体系，为每行补充完整字段和元数据
    is_qixin = platform in TEMPLATE_B_PLATFORMS
    field_def = ORDER_FIELDS_B if is_qixin else ORDER_FIELDS_A

    result_rows = []
    for row in order_rows:
        complete_row = {field: row.get(field, "") for field in field_def}
        complete_row["平台来源"] = platform
        complete_row["_source_file"] = os.path.basename(pdf_path)
        complete_row["_processed_at"] = __import__('datetime').datetime.now().isoformat()
        complete_row["_platform_type"] = "qixin" if is_qixin else "general"
        result_rows.append(complete_row)

    return result_rows, txt_path


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        platform = sys.argv[2] if len(sys.argv) > 2 else "其他"
        results = extract_order_from_pdf(sys.argv[1], platform)
        print(json.dumps(results, ensure_ascii=False, indent=2))
