/**
 * Excel 内嵌图片解析器
 * 解析 .xlsx 文件的 ZIP 内部结构，提取 xl/media/ 中的图片，
 * 通过 drawing.xml 确定图片锚点所在行号，映射图片到商品行。
 */
const AdmZip = require('adm-zip');
const path = require('path');

/** 支持的图片扩展名 */
const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

/**
 * 从 xlsx Buffer 中解析出所有内嵌图片及其行锚点
 * @param {Buffer} xlsxBuffer
 * @returns {{ images: Array<{rowIndex, colIndex, buffer, filename, ext}>, error?: string }}
 */
function parseImagesFromXlsx(xlsxBuffer) {
  try {
    const zip = new AdmZip(xlsxBuffer);
    const entries = zip.getEntries();
    const entryMap = {};
    for (const e of entries) {
      entryMap[e.entryName] = e;
    }

    // 1. 找到所有 worksheet rels，确定 drawing 与 sheet 的绑定关系
    // 遍历 xl/worksheets/_rels/ 下所有 .xml.rels
    const sheetDrawingMap = {}; // sheetPath -> drawingPath (relative)
    for (const name of Object.keys(entryMap)) {
      const match = name.match(/^xl\/worksheets\/_rels\/(sheet\d+)\.xml\.rels$/i);
      if (match) {
        const relsXml = entryMap[name].getData().toString('utf-8');
        const drawingMatch = relsXml.match(/<Relationship[^>]*Type="[^"]*\/drawing"[^>]*Target="([^"]+)"/i);
        if (drawingMatch) {
          // drawing target is relative to xl/worksheets/
          const sheetName = match[1]; // sheet1, sheet2...
          const drawingRelPath = drawingMatch[1]; // ../drawings/drawing1.xml
          const resolvedDrawing = path
            .normalize(`xl/worksheets/${drawingRelPath}`)
            .replace(/\\/g, '/');
          sheetDrawingMap[sheetName] = resolvedDrawing;
        }
      }
    }

    if (Object.keys(sheetDrawingMap).length === 0) {
      // 兼容：没有 worksheet rels，手动查找 xl/drawings/drawing1.xml
      for (let i = 1; i <= 20; i++) {
        const drawingPath = `xl/drawings/drawing${i}.xml`;
        if (entryMap[drawingPath]) {
          sheetDrawingMap[`sheet${i}`] = drawingPath;
        } else {
          break;
        }
      }
    }

    if (Object.keys(sheetDrawingMap).length === 0) {
      return { images: [], message: '文件中未找到嵌入图片' };
    }

    const results = [];

    for (const [sheetName, drawingPath] of Object.entries(sheetDrawingMap)) {
      if (!entryMap[drawingPath]) continue;

      const sheetNum = parseInt(sheetName.replace('sheet', ''), 10) || 1;

      // 2. 读取 drawing rels
      const drawingDir = path.dirname(drawingPath); // xl/drawings
      const drawingFileName = path.basename(drawingPath); // drawing1.xml
      const relsPath = `${drawingDir}/_rels/${drawingFileName}.rels`;

      let relsMap = {};
      if (entryMap[relsPath]) {
        const relsXml = entryMap[relsPath].getData().toString('utf-8');
        const relRe =
          /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"/gi;
        let m;
        while ((m = relRe.exec(relsXml)) !== null) {
          relsMap[m[1]] = m[2];
        }
      }

      // 3. 读取 drawing XML 获取锚点
      const drawingXml = entryMap[drawingPath].getData().toString('utf-8');

      // 用正则匹配每个 <xdr:twoCellAnchor> 或 <xdr:oneCellAnchor> 块
      const anchorRegex =
        /<(xdr:twoCellAnchor|xdr:oneCellAnchor)[^>]*>([\s\S]*?)<\/\1>/gi;
      let anchorMatch;

      while ((anchorMatch = anchorRegex.exec(drawingXml)) !== null) {
        const anchorBlock = anchorMatch[2];

        // 提取 <xdr:from> 中的 <xdr:col> 和 <xdr:row>
        const fromBlock = anchorBlock.match(
          /<xdr:from>([\s\S]*?)<\/xdr:from>/i
        );
        if (!fromBlock) continue;

        const colMatch = fromBlock[1].match(/<xdr:col>(\d+)<\/xdr:col>/i);
        const rowMatch = fromBlock[1].match(/<xdr:row>(\d+)<\/xdr:row>/i);
        if (rowMatch === null) continue;

        const rowIndex = parseInt(rowMatch[1], 10); // 0-based
        const colIndex = colMatch ? parseInt(colMatch[1], 10) : 0;

        // 提取 r:embed 属性
        const embedMatch = anchorBlock.match(/r:embed="(rId\d+)"/i);
        if (!embedMatch) continue;

        const rId = embedMatch[1];
        const relTarget = relsMap[rId];
        if (!relTarget) continue;

        // 计算媒体文件的完整路径
        const mediaPath = path
          .normalize(`${drawingDir}/${relTarget}`)
          .replace(/\\/g, '/');

        if (!entryMap[mediaPath]) continue;

        const imgBuffer = entryMap[mediaPath].getData();
        const imgExt = path.extname(relTarget).toLowerCase();

        if (!IMG_EXTS.includes(imgExt)) continue;

        const filename = `row${rowIndex + 1}_col${colIndex}${imgExt}`;

        results.push({
          rowIndex,       // 0-based drawing row
          colIndex,       // 0-based drawing col
          sheetNum,       // 1-based sheet number
          buffer: imgBuffer,
          filename,
          ext: imgExt,
          size: imgBuffer.length,
        });
      }
    }

    // 按 sheet, row, col 排序
    results.sort((a, b) => a.sheetNum - b.sheetNum || a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);

    return { images: results };
  } catch (err) {
    return { images: [], error: err.message };
  }
}

/**
 * 将解析出的图片按行分组，并映射到 Excel 数据行
 * 假设 Excel 第 1 行是表头，第 2 行起是数据（drawing row=1 → data row=0）
 *
 * @param {Array} images - parseImagesFromXlsx 返回的 images 数组
 * @param {number} headerRows - 表头行数（默认 1 行）
 * @returns {Map<number, Array<{buffer, filename, ext, colIndex}>>}
 *   key = 数据行索引（0-based），value = 该行所有图片
 */
function groupImagesByDataRow(images, headerRows = 1) {
  const map = new Map();

  for (const img of images) {
    // drawing row → data row: 减掉 headerRows
    const dataRow = img.rowIndex - headerRows;
    if (dataRow < 0) continue; // 跳过表头行中的图片

    if (!map.has(dataRow)) {
      map.set(dataRow, []);
    }
    map.get(dataRow).push({
      buffer: img.buffer,
      filename: img.filename,
      ext: img.ext,
      colIndex: img.colIndex,
      drawingRow: img.rowIndex,
    });
  }

  return map;
}

module.exports = { parseImagesFromXlsx, groupImagesByDataRow };
