/**
 * 埠勤商贸 - 腾讯云 COS 上传模块
 * 
 * 配置方式（环境变量）：
 *   COS_ENABLED=true          # 启用COS
 *   COS_SECRET_ID=xxx         # 腾讯云 SecretId
 *   COS_SECRET_KEY=xxx        # 腾讯云 SecretKey
 *   COS_BUCKET=xxx            # 存储桶名称
 *   COS_REGION=ap-guangzhou   # 地域
 *   COS_DOMAIN=               # 自定义CDN域名（可选）
 *
 * 当前为占位实现，启用后需安装 cos-nodejs-sdk-v5：
 *   npm install cos-nodejs-sdk-v5
 */
require('dotenv').config();

const COS_ENABLED = process.env.COS_ENABLED === 'true';

let cosClient = null;

function getCOS() {
  if (!COS_ENABLED) return null;
  if (cosClient) return cosClient;

  try {
    const COS = require('cos-nodejs-sdk-v5');
    cosClient = new COS({
      SecretId: process.env.COS_SECRET_ID,
      SecretKey: process.env.COS_SECRET_KEY,
    });
    console.log('[COS] 腾讯云COS已启用');
    return cosClient;
  } catch (e) {
    console.warn('[COS] cos-nodejs-sdk-v5 未安装，COS功能不可用。安装方式: npm install cos-nodejs-sdk-v5');
    return null;
  }
}

/**
 * 上传文件到 COS
 * @param {string} localPath - 本地文件路径
 * @param {string} cosKey - COS对象键（如 product/10001/main_01.jpg）
 * @returns {Promise<string>} - COS 访问URL
 */
async function uploadToCOS(localPath, cosKey) {
  const cos = getCOS();
  if (!cos) {
    // COS未启用，返回本地路径
    console.log('[COS] 未启用，使用本地路径:', localPath);
    return localPath;
  }

  const fs = require('fs');
  if (!fs.existsSync(localPath)) {
    throw new Error(`文件不存在: ${localPath}`);
  }

  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION || 'ap-guangzhou',
        Key: cosKey,
        Body: fs.createReadStream(localPath),
        ContentType: `image/${cosKey.split('.').pop()}`,
      },
      (err, data) => {
        if (err) {
          console.error('[COS] 上传失败:', err.message);
          return reject(err);
        }
        const domain = process.env.COS_DOMAIN
          || `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com`;
        const url = `${domain}/${cosKey}`;
        console.log('[COS] 上传成功:', url);
        resolve(url);
      }
    );
  });
}

/**
 * 批量上传产品图片到 COS
 * @param {number} productId - 产品ID
 * @param {Array<{localPath: string, type: string, sort: number}>} images - 图片信息
 * @returns {Promise<Array>} - 上传结果
 */
async function uploadProductImages(productId, images) {
  const results = [];
  for (const img of images) {
    const ext = (img.localPath || '').split('.').pop() || 'jpg';
    const cosKey = `product/${productId}/${img.type}_${String(img.sort).padStart(2, '0')}.${ext}`;
    try {
      const cosUrl = await uploadToCOS(img.localPath, cosKey);
      results.push({
        ...img,
        cosUrl,
        success: true,
      });
    } catch (err) {
      console.error(`[COS] 产品 ${productId} 图片上传失败:`, err.message);
      results.push({
        ...img,
        cosUrl: img.localPath,
        success: false,
        error: err.message,
      });
    }
  }
  return results;
}

module.exports = {
  COS_ENABLED,
  uploadToCOS,
  uploadProductImages,
};
