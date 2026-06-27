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

手机纯前端版本：

```text
mobile.html
```

这个版本不依赖本地 Node 服务，API key 保存在手机浏览器本地。能否直接调用接口取决于对应 API 是否允许浏览器跨域请求。

## 说明

- API key 保存在本目录的 `.xai-config.json`。
- 图片编辑接口为 `POST https://api.x.ai/v1/images/edits`。
- 可选模型为 `grok-imagine-image-quality` 和 `grok-imagine-image`，默认使用高质量模型。
- 如果 8787 端口被占用，可以这样换端口：

```powershell
$env:PORT=8790; node server.js
```
