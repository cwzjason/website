# 企业微信消息加解密模块
# 用于处理企业微信回调消息的加密和解密

import base64
import hashlib
import struct
import socket
import random
import string
import time
from Crypto.Cipher import AES

"""
企业微信加解密库
参考：https://developer.work.weixin.qq.com/document/path/90968
"""


class WXBizMsgCrypt:
    """企业微信消息加解密类"""
    
    def __init__(self, token: str, encoding_aes_key: str, corp_id: str):
        self.token = token
        self.encoding_aes_key = encoding_aes_key
        self.corp_id = corp_id
        self.key = base64.b64decode(encoding_aes_key + "=")
        
    def VerifyURL(self, msg_signature: str, timestamp: str, 
                  nonce: str, echostr: str) -> tuple:
        """验证URL有效性"""
        # 计算签名
        signature = self._get_signature(timestamp, nonce, echostr)
        
        if signature != msg_signature:
            return -1, "签名验证失败"
        
        # 解密echostr
        ret, plain_text = self._decrypt(echostr)
        if ret != 0:
            return -1, "解密失败"
        
        return 0, plain_text
    
    def DecryptMsg(self, msg_signature: str, timestamp: str,
                   nonce: str, encrypt_msg: str) -> tuple:
        """解密消息"""
        signature = self._get_signature(timestamp, nonce, encrypt_msg)
        
        if signature != msg_signature:
            return -1, None
        
        ret, xml_content = self._decrypt(encrypt_msg)
        return ret, xml_content
    
    def EncryptMsg(self, reply_msg: str, nonce: str, 
                   timestamp: str = None) -> tuple:
        """加密回复消息"""
        if timestamp is None:
            timestamp = str(int(time.time()))
        
        ret, encrypt = self._encrypt(reply_msg)
        if ret != 0:
            return ret, None
        
        signature = self._get_signature(timestamp, nonce, encrypt)
        
        # 构建XML响应
        resp_xml = (
            f'<xml>'
            f'<Encrypt><![CDATA[{encrypt}]]></Encrypt>'
            f'<MsgSignature><![CDATA[{signature}]]></MsgSignature>'
            f'<TimeStamp>{timestamp}</TimeStamp>'
            f'<Nonce><![CDATA[{nonce}]]></Nonce>'
            f'</xml>'
        )
        
        return 0, resp_xml
    
    def _get_signature(self, timestamp: str, nonce: str, encrypt: str) -> str:
        """计算签名"""
        sort_list = sorted([self.token, timestamp, nonce, encrypt])
        sha = hashlib.sha1()
        sha.update("".join(sort_list).encode())
        return sha.hexdigest()
    
    def _encrypt(self, text: str) -> tuple:
        """加密"""
        # 生成16位随机字符串
        random_str = ''.join(random.choices(string.ascii_letters + string.digits, k=16))
        
        # 构建明文
        text_bytes = text.encode('utf-8')
        text_length = len(text_bytes)
        
        # 明文 = random(16) + msg_len(4) + msg + corp_id
        msg = (
            random_str.encode('utf-8') +
            struct.pack("!I", text_length) +
            text_bytes +
            self.corp_id.encode('utf-8')
        )
        
        # PKCS7 padding
        block_size = 32
        padding_length = block_size - (len(msg) % block_size)
        msg += bytes([padding_length] * padding_length)
        
        # AES加密
        cipher = AES.new(self.key, AES.MODE_CBC, self.key[:16])
        encrypted = cipher.encrypt(msg)
        
        return 0, base64.b64encode(encrypted).decode()
    
    def _decrypt(self, encrypt_text: str) -> tuple:
        """解密"""
        try:
            # Base64解码
            cipher_text = base64.b64decode(encrypt_text)
            
            # AES解密
            cipher = AES.new(self.key, AES.MODE_CBC, self.key[:16])
            plain_text = cipher.decrypt(cipher_text)
            
            # 去除PKCS7 padding
            pad = plain_text[-1]
            plain_text = plain_text[:-pad]
            
            # 解析：random(16) + msg_len(4) + msg + corp_id
            content = plain_text[16:]  # 去掉random
            msg_len = struct.unpack("!I", content[:4])[0]
            msg = content[4:4 + msg_len].decode('utf-8')
            corp_id = content[4 + msg_len:].decode('utf-8')
            
            if corp_id != self.corp_id:
                return -1, None
            
            return 0, msg
        except Exception as e:
            print(f"解密失败: {e}")
            return -1, None
