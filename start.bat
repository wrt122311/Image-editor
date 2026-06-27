@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动图片编辑器...
echo 浏览器访问 http://127.0.0.1:8787
echo 关闭此窗口将停止服务器。
echo.
start "" http://127.0.0.1:8787
cmd /k node server.js
