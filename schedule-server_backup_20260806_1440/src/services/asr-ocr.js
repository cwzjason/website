/**
 * 语音 / 图片识别服务
 * 
 * 环境变量配置（腾讯云）：
 *   TENCENT_SECRET_ID
 *   TENCENT_SECRET_KEY
 *   TENCENT_ASR_REGION  默认 ap-beijing
 *   TENCENT_OCR_REGION  默认 ap-beijing
 * 
 * 未配置时自动进入「演示模式」：返回提示文本，方便前端联调。
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEMO_TEXTS = {
  voice: '（演示模式）语音识别结果：请配置腾讯云 ASR 后自动转文字。',
  image: '（演示模式）图片文字识别结果：请配置腾讯云 OCR 后自动提取文字。',
};

function hasCredentials() {
  return !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);
}

/**
 * 腾讯云 API 通用签名（TC3-HMAC-SHA256）
 */
function signTencent({ service, region, action, version, payload }) {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  const host = `${service}.tencentcloudapi.com`;
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');

  const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const secretDate = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
  const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { host, authorization, timestamp, payload };
}

function callTencentAPI({ service, region, action, version, payload }) {
  return new Promise((resolve, reject) => {
    const { host, authorization, timestamp } = signTencent({ service, region, action, version, payload });

    const req = https.request({
      hostname: host,
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': timestamp,
        'X-TC-Region': region,
        'Authorization': authorization,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`解析响应失败: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 根据文件扩展名映射到腾讯云 ASR Format 参数
 * 支持格式: wav, pcm, ogg-opus, speex, silk, mp3, m4a, aac, amr, flac
 */
const EXT_TO_FORMAT = {
  '.wav': 'wav', '.pcm': 'pcm', '.raw': 'pcm',
  '.ogg': 'ogg-opus', '.opus': 'ogg-opus',
  '.spx': 'speex', '.speex': 'speex',
  '.silk': 'silk',
  '.mp3': 'mp3', '.m4a': 'm4a', '.aac': 'aac',
  '.amr': 'amr', '.flac': 'flac',
};

/**
 * 通过文件头魔数检测 SILK 格式（微信录音）
 * SILK_V3 文件头: #!SILK_V3\n
 */
function isSilkByHeader(buffer) {
  if (buffer.length < 10) return false;
  return buffer.slice(0, 10).toString('ascii') === '#!SILK_V3\n';
}

/**
 * 语音识别（ASR）
 * @param {string} filePath 音频文件路径
 * @param {string} [originalName] 原始文件名（用于检测扩展名）
 * @returns {Promise<{text: string, source: string}>}
 */
async function recognizeVoice(filePath, originalName) {
  if (!hasCredentials()) {
    console.log('[ASR] 未配置腾讯云密钥，使用演示模式');
    return { text: DEMO_TEXTS.voice, source: 'demo' };
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');

    // 自动检测音频格式：优先通过文件扩展名，其次通过文件头魔数
    let format = 'mp3'; // 兜底默认值
    if (originalName) {
      const ext = path.extname(originalName).toLowerCase();
      if (EXT_TO_FORMAT[ext]) {
        format = EXT_TO_FORMAT[ext];
      }
    }
    // 扩展名无法判断时，用文件头魔数检测 silk
    if (format === 'mp3' && isSilkByHeader(buffer)) {
      format = 'silk';
    }

    console.log(`[ASR] 检测到音频格式: ${format} (原始文件名: ${originalName || '未知'})`);

    const payload = JSON.stringify({
      EngSerViceType: '16k_zh',
      SourceType: 1,  // 1 = 原始音频数据 (Base64)
      VoiceFormat: format,
      Data: base64,
      DataLen: buffer.length,
    });

    const res = await callTencentAPI({
      service: 'asr',
      region: process.env.TENCENT_ASR_REGION || 'ap-beijing',
      action: 'SentenceRecognition',
      version: '2019-06-14',
      payload,
    });

    if (res.Response && res.Response.Result) {
      return { text: res.Response.Result, source: 'tencent-asr' };
    }
    if (res.Response && res.Response.Error) {
      throw new Error(res.Response.Error.Message);
    }
    // Result 为空字符串（如空音频），返回空
    if (res.Response) {
      return { text: '', source: 'tencent-asr' };
    }
    throw new Error('ASR 未返回识别结果');
  } catch (err) {
    console.error('[ASR] 识别失败:', err.message);
    return { text: DEMO_TEXTS.voice, source: 'demo' };
  }
}

/**
 * 图片文字识别（OCR - 腾讯云通用印刷体）
 * @param {string} filePath 图片文件路径
 * @returns {Promise<{text: string, source: string}>}
 */
async function recognizeImage(filePath) {
  if (!hasCredentials()) {
    return { text: DEMO_TEXTS.image, source: 'demo' };
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');

    const payload = JSON.stringify({ ImageBase64: base64 });

    const res = await callTencentAPI({
      service: 'ocr',
      region: process.env.TENCENT_OCR_REGION || 'ap-beijing',
      action: 'GeneralBasicOCR',
      version: '2018-11-19',
      payload,
    });

    if (res.Response && res.Response.TextDetections) {
      const text = res.Response.TextDetections.map(t => t.DetectedText).join('\n');
      return { text: text || DEMO_TEXTS.image, source: 'tencent-ocr' };
    }
    if (res.Response && res.Response.Error) {
      throw new Error(res.Response.Error.Message);
    }
    throw new Error('OCR 未返回识别结果');
  } catch (err) {
    console.error('[OCR] 识别失败:', err.message);
    return { text: DEMO_TEXTS.image, source: 'demo' };
  }
}

module.exports = { recognizeVoice, recognizeImage };
