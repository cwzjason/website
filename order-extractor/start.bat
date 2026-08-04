@echo off
chcp 65001 >nul
echo =========================================
echo   订单信息提取与汇总系统
echo =========================================
echo.

REM 检查Python
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未找到Python，请先安装Python 3.9+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [OK] Python版本:
python --version
echo.

REM 安装依赖
echo [安装] 正在安装依赖...
pip install -r requirements.txt -q
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo [OK] 依赖安装完成
echo.

REM 创建必要的目录
if not exist "uploads" mkdir uploads

REM 检查API密钥配置
findstr /C:"your-api-key-here" config.py >nul 2>nul
if %errorlevel% equ 0 (
    echo [警告] 请先在config.py中配置AI_API_KEY
    echo        系统将以规则匹配模式运行（准确率较低）
    echo.
)

echo [启动] 服务启动中...
echo        访问地址: http://localhost:5050
echo        按 Ctrl+C 停止服务
echo.

python app.py
pause
