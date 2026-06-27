# Grok 图片编辑本地网页

这是一个本地小工具：保存 xAI API key 后，可以上传图片并输入文字，调用 Grok 图片编辑接口。

## 使用方法

```powershell
cd F:\JinxiaoTrainerAlpha-win32-x64-0.1.5\grok-image-editor
node server.js
```

然后打开：

```text
http://127.0.0.1:8787
```

手机端与桌面端使用同一套功能。电脑和手机连接同一个局域网，保持服务运行，然后在手机浏览器打开：

```text
http://电脑局域网IP:8787/mobile.html
```

例如电脑 IP 是 `192.168.1.20`，手机地址就是 `http://192.168.1.20:8787/mobile.html`。首次启动时如果 Windows 防火墙询问，请允许专用网络访问。

手机端共享桌面端的 API 配置、最多 1000 条会话记录、多 Key 选择、自动重试和生成卡片。API Key 保存在电脑的 `.xai-config.json`，不会写入手机浏览器。

## 无需电脑的手机版本

仓库推送到 GitHub 后，Actions 会自动部署 GitHub Pages。手机打开：

```text
https://wrt122311.github.io/Image-editor/mobile.html
```

GitHub Pages 模式不需要电脑运行。API 配置保存在手机浏览器本地，会话和图片保存在手机 IndexedDB，最多保留 1000 条。请在仓库 `Settings → Pages` 中将 Source 设为 `GitHub Actions`。

纯手机模式由浏览器直接请求图片 API，因此所选第三方接口必须允许浏览器跨域访问。GitHub Pages 构建只上传 `index.html`、`mobile.html` 和 `standalone-adapter.js`，不会上传 `.xai-config.json`、会话或输入输出图片。

## 说明

- API key 保存在本目录的 `.xai-config.json`。
- 图片编辑接口为 `POST https://api.x.ai/v1/images/edits`。
- 可选模型为 `grok-imagine-image-quality` 和 `grok-imagine-image`，默认使用高质量模型。
- 如果 8787 端口被占用，可以这样换端口：

```powershell
$env:PORT=8790; node server.js
```
