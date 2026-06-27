const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, ".xai-config.json");
const INPUT_DIR = path.join(ROOT, "input");
const OUTPUT_DIR = path.join(ROOT, "output");
const SESSIONS_PATH = path.join(ROOT, "sessions.json");
const LAST_PAYLOAD_PATH = path.join(ROOT, "last-xai-payload.json");
const XAI_EDIT_URL = "https://api.x.ai/v1/images/edits";
const XAI_BASE_URL = "https://api.x.ai/v1";
const OPENAI_EDIT_URL = "https://api.openai.com/v1/images/edits";
const YUNWU_BASE_URL = "https://api.zhongzhuan.chat/v1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function detectMimeFromBuffer(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  return ".jpg";
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

async function readSessions() {
  try {
    return JSON.parse(await fs.readFile(SESSIONS_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function saveSessions(sessions) {
  await fs.writeFile(SESSIONS_PATH, JSON.stringify(sessions, null, 2), "utf8");
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function addSession(sessionData) {
  const sessions = await readSessions();
  sessions.unshift(sessionData);
  if (sessions.length > 200) sessions.length = 200;
  await saveSessions(sessions);
  return sessionData.id;
}

async function updateSession(id, updates) {
  const sessions = await readSessions();
  const session = sessions.find((s) => s.id === id);
  if (session) {
    Object.assign(session, updates);
    await saveSessions(sessions);
  }
}

async function makeThumb(srcPath, thumbPath) {
  try {
    const data = await fs.readFile(srcPath);
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    await fs.writeFile(thumbPath, data);
    return thumbPath;
  } catch {
    return "";
  }
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return "*".repeat(key.length);
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function apiErrorMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data.error === "string") return data.error;
  if (data.error?.message) return String(data.error.message);
  if (data.message) return String(data.message);
  if (data.detail) return typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
  return "";
}

function isSafetyRejection(data) {
  return /(safety|moderation|content[_ -]?policy|policy[_ -]?violation|unsafe|nsfw|disallowed|审核|安全(?:系统|策略|检查|拒绝)|内容(?:政策|违规)|违规|禁止生成|敏感内容)/i.test(apiErrorMessage(data));
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "_",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "_",
    pad(now.getMilliseconds()),
    rand,
  ].join("");
}

function extensionFromMime(mime) {
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  return ".jpg";
}

function mimeFromDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,/i.exec(dataUrl);
  return match ? match[1] : "image/jpeg";
}

async function saveDataUrl(dataUrl, dir, prefix) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error("Invalid data URL.");
  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${prefix}-${stamp()}${extensionFromMime(mime)}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

function getWindowsProxy() {
  const script = `
$settings = Get-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
if ($settings.ProxyEnable -and $settings.ProxyServer) {
  [Console]::Write($settings.ProxyServer)
}
`;

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(stdout.trim()));
  });
}

async function uploadFileToXai(apiKey, filePath, mime) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || (await getWindowsProxy());
  const args = ["-sS"];
  if (proxy) args.push("--proxy", proxy);
  args.push(
    "https://api.x.ai/v1/files",
    "-H",
    `Authorization: Bearer ${apiKey}`,
    "-F",
    "expires_after=3600",
    "-F",
    "purpose=assistants",
    "-F",
    `file=@${filePath};type=${mime || "application/octet-stream"}`,
    "-w",
    "\nHTTP_STATUS:%{http_code}",
  );

  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
      const data = parseMaybeJson(body);
      if (code !== 0 || status < 200 || status >= 300) {
        reject(new Error((typeof data.error === "string" ? data.error : data.error?.message) || data.message || stderr || body || "File upload failed."));
        return;
      }
      if (!data.id) {
        reject(new Error("Files API did not return a file id."));
        return;
      }
      resolve(data.id);
    });
  });
}

async function postToOpenAIWithCurl(apiKey, filePaths, params, endpoint = OPENAI_EDIT_URL) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || (await getWindowsProxy());
  const promptPath = path.join(os.tmpdir(), `openai-image-prompt-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(promptPath, params.prompt, "utf8");
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

  const args = ["-sS"];
  if (proxy) args.push("--proxy", proxy);
  args.push(
    endpoint,
    "-H",
    `Authorization: Bearer ${apiKey}`,
  );
  for (const filePath of paths) {
    args.push("-F", `image=@${filePath}`);
  }
  args.push(
    "-F",
    `prompt=<${promptPath}`,
    "-F",
    `model=${params.model}`,
    "-F",
    `n=${params.n}`,
    "-F",
    `size=${params.size}`,
    "-F",
    `quality=${params.quality}`,
    "-F",
    `output_format=${params.output_format}`,
    "-F",
    `background=${params.background}`,
    "-F",
    `moderation=${params.moderation}`,
  );
  if (params.partial_images > 0) {
    args.push("-F", `partial_images=${params.partial_images}`);
  }
  if (params.input_fidelity && params.input_fidelity !== "auto" && params.model !== "gpt-image-2") {
    args.push("-F", `input_fidelity=${params.input_fidelity}`);
  }
  args.push("-w", "\nHTTP_STATUS:%{http_code}");

  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", async (error) => {
      await fs.rm(promptPath, { force: true }).catch(() => {});
      reject(error);
    });
    child.on("close", async (code) => {
      await fs.rm(promptPath, { force: true }).catch(() => {});
      const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
      const data = parseMaybeJson(body);
      resolve({
        ok: code === 0 && status >= 200 && status < 300,
        status: status || 500,
        data: code === 0 ? data : { error: stderr || body || "OpenAI request failed." },
      });
    });
  });
}

function uploadFileCurl(apiKey, filePath, purpose, baseUrl) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  const args = ["-sS"];
  if (proxy) args.push("--proxy", proxy);
  args.push(
    `${baseUrl}/files`,
    "-H", `Authorization: Bearer ${apiKey}`,
    "-F", `purpose=${purpose}`,
    "-F", `file=@${filePath}`,
    "-w", "\nHTTP_STATUS:%{http_code}",
  );

  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
      const data = parseMaybeJson(body);
      if (code !== 0 || status < 200 || status >= 300) {
        reject(new Error(data.error?.message || data.error || stderr || body || "File upload failed"));
        return;
      }
      resolve(data.id);
    });
  });
}

function createBatchCurl(apiKey, fileId, baseUrl) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  const payload = JSON.stringify({ input_file_id: fileId, endpoint: "/v1/images/edits", completion_window: "24h" });
  const tmpPath = path.join(os.tmpdir(), `batch-payload-${Date.now()}.json`);
  return fs.writeFile(tmpPath, payload, "utf8").then(() => {
    const args = ["-sS"];
    if (proxy) args.push("--proxy", proxy);
    args.push(
      `${baseUrl}/batches`,
      "-H", `Authorization: Bearer ${apiKey}`,
      "-H", "Content-Type: application/json",
      "-d", `@${tmpPath}`,
      "-w", "\nHTTP_STATUS:%{http_code}",
    );

    return new Promise((resolve, reject) => {
      const child = spawn("curl.exe", args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (err) => { fs.rm(tmpPath, { force: true }).catch(() => {}); reject(err); });
      child.on("close", (code) => {
        fs.rm(tmpPath, { force: true }).catch(() => {});
        const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
        const data = parseMaybeJson(body);
        if (code !== 0 || status < 200 || status >= 300) {
          reject(new Error(data.error?.message || data.error || stderr || body || "Batch creation failed"));
          return;
        }
        resolve(data);
      });
    });
  });
}

function getBatchCurl(apiKey, batchId, baseUrl) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  const args = ["-sS"];
  if (proxy) args.push("--proxy", proxy);
  args.push(
    `${baseUrl}/batches/${batchId}`,
    "-H", `Authorization: Bearer ${apiKey}`,
    "-w", "\nHTTP_STATUS:%{http_code}",
  );

  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
      const data = parseMaybeJson(body);
      if (code !== 0 || status < 200 || status >= 300) {
        reject(new Error(data.error?.message || data.error || stderr || body || "Batch status failed"));
        return;
      }
      resolve(data);
    });
  });
}

function getFileContentCurl(apiKey, fileId, baseUrl) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  const args = ["-sS"];
  if (proxy) args.push("--proxy", proxy);
  args.push(
    `${baseUrl}/files/${fileId}/content`,
    "-H", `Authorization: Bearer ${apiKey}`,
    "-w", "\nHTTP_STATUS:%{http_code}",
  );

  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
      if (code !== 0 || status < 200 || status >= 300) {
        reject(new Error(`Batch output download failed (${status})`));
        return;
      }
      resolve(body);
    });
  });
}

function downloadUrlWithPowerShell(url, filePath) {
  const script = `
$ErrorActionPreference = "Stop"
Invoke-WebRequest -Uri $env:IMAGE_URL_CHILD -OutFile $env:IMAGE_OUT_CHILD -UseBasicParsing -TimeoutSec 300
`;

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      env: {
        ...process.env,
        IMAGE_URL_CHILD: url,
        IMAGE_OUT_CHILD: filePath,
      },
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(filePath);
      else reject(new Error(`Download failed [${url}]: ${stderr || `code ${code}`}`));
    });
  });
}

async function saveImageReference(ref, dir, prefix, mime = "image/jpeg") {
  if (!ref) return "";
  await fs.mkdir(dir, { recursive: true });

  if (ref.startsWith("data:")) {
    return saveDataUrl(ref, dir, prefix);
  }

  if (ref.startsWith("/")) {
    ref = `http://127.0.0.1:${PORT}${ref}`;
  }

  const initialPath = path.join(dir, `${prefix}-${stamp()}.tmp`);
  await downloadUrlWithPowerShell(ref, initialPath);
  const tmpBuf = await fs.readFile(initialPath);
  const actualExt = detectMimeFromBuffer(tmpBuf);
  const filePath = path.join(dir, `${prefix}-${stamp()}${actualExt}`);
  await fs.rename(initialPath, filePath);
  return filePath;
}

function imageEditEndpointFromBase(baseUrl, fallback) {
  const trimmed = String(baseUrl || fallback).trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/images/edits")) return trimmed;
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/images/edits`;
  return `${trimmed}/v1/images/edits`;
}

async function postToXai(apiKey, payload, endpoint = XAI_EDIT_URL) {
  if (process.platform === "win32") {
    return postToXaiWithPowerShell(apiKey, payload, endpoint);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    data: parseMaybeJson(text),
  };
}

async function postToXaiWithPowerShell(apiKey, payload, endpoint = XAI_EDIT_URL) {
  const payloadPath = path.join(os.tmpdir(), `xai-image-edit-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(payloadPath, JSON.stringify(payload), "utf8");

  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || (await getWindowsProxy());
  const args = ["-sS"];
  if (proxy) args.push("--proxy", proxy);
  args.push(
    endpoint,
    "-H", `Authorization: Bearer ${apiKey}`,
    "-H", "Content-Type: application/json",
    "-d", `@${payloadPath}`,
    "-w", "\nHTTP_STATUS:%{http_code}",
  );

  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", async (err) => {
      await fs.rm(payloadPath, { force: true }).catch(() => {});
      reject(err);
    });
    child.on("close", async (code) => {
      await fs.rm(payloadPath, { force: true }).catch(() => {});
      const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
      const data = parseMaybeJson(body);
      if (code !== 0 || !status) {
        reject(new Error(stderr || apiErrorMessage(data) || body || "xAI request failed"));
        return;
      }
      resolve({ ok: status >= 200 && status < 300, status, data });
    });
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, requested));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store, no-cache, must-revalidate" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/key") {
      const config = await readConfig();
      sendJson(res, 200, {
        saved: Boolean(config.apiKey),
        masked: maskKey(config.apiKey),
        openaiSaved: Boolean(config.openaiApiKey),
        openaiMasked: maskKey(config.openaiApiKey),
        yunwuSaved: Boolean(config.yunwuApiKey),
        yunwuMasked: maskKey(config.yunwuApiKey),
        yunwuBaseUrl: config.yunwuBaseUrl || YUNWU_BASE_URL,
        thirdGrokSaved: Boolean(config.thirdGrokApiKey),
        thirdGrokMasked: maskKey(config.thirdGrokApiKey),
        thirdGrokBaseUrl: config.thirdGrokBaseUrl || XAI_BASE_URL,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/key") {
      const body = await readJson(req);
      const apiKey = String(body.apiKey || "").trim();
      const provider = String(body.provider || "xai").trim();
      const baseUrl = String(body.baseUrl || "").trim();
      if (!apiKey && provider !== "yunwu-url" && provider !== "third-grok-url") {
        sendJson(res, 400, { error: "API key 不能为空。" });
        return;
      }
      const config = await readConfig();
      if (provider === "openai") {
        config.openaiApiKey = apiKey;
      } else if (provider === "yunwu") {
        config.yunwuApiKey = apiKey;
        if (baseUrl) config.yunwuBaseUrl = baseUrl.replace(/\/+$/, "");
      } else if (provider === "yunwu-url") {
        config.yunwuBaseUrl = (baseUrl || YUNWU_BASE_URL).replace(/\/+$/, "");
      } else if (provider === "third-grok") {
        config.thirdGrokApiKey = apiKey;
        if (baseUrl) config.thirdGrokBaseUrl = baseUrl.replace(/\/+$/, "");
      } else if (provider === "third-grok-url") {
        config.thirdGrokBaseUrl = (baseUrl || XAI_BASE_URL).replace(/\/+$/, "");
      } else {
        config.apiKey = apiKey;
      }
      await saveConfig(config);
      sendJson(res, 200, {
        saved: true,
        masked: maskKey(apiKey),
        yunwuBaseUrl: config.yunwuBaseUrl || YUNWU_BASE_URL,
        thirdGrokBaseUrl: config.thirdGrokBaseUrl || XAI_BASE_URL,
      });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions(?:\/(.+))?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];

      if (req.method === "GET" && !sessionId) {
        const sessions = await readSessions();
        const briefs = sessions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          title: s.title || "",
          prompt: s.prompt,
          provider: s.provider,
          success: s.success,
          outputThumb: s.outputThumb || "",
          thumbnailPaths: s.thumbnailPaths || [],
        }));
        sendJson(res, 200, briefs);
        return;
      }

      if (req.method === "GET" && sessionId) {
        const sessions = await readSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) {
          sendJson(res, 404, { error: "会话不存在。" });
          return;
        }
        sendJson(res, 200, session);
        return;
      }

      if (req.method === "PATCH" && sessionId) {
        const body = await readJson(req);
        const sessions = await readSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) {
          sendJson(res, 404, { error: "会话不存在。" });
          return;
        }
        if (body.title !== undefined) session.title = body.title;
        if (body.prompt !== undefined) session.prompt = body.prompt;
        await saveSessions(sessions);
        sendJson(res, 200, { updated: true });
        return;
      }

      if (req.method === "POST" && !sessionId) {
        const body = await readJson(req);
        const newSession = {
          id: generateId(),
          createdAt: new Date().toISOString(),
          title: body.title || "新会话",
          prompt: "",
          provider: "",
          model: "",
          success: false,
          error: "",
          inputPaths: [],
          outputPaths: [],
          outputThumb: "",
          thumbnailPaths: [],
        };
        await addSession(newSession);
        sendJson(res, 200, { id: newSession.id });
        return;
      }

      if (req.method === "DELETE" && sessionId) {
        const sessions = await readSessions();
        const index = sessions.findIndex((s) => s.id === sessionId);
        if (index === -1) {
          sendJson(res, 404, { error: "会话不存在。" });
          return;
        }
        const removed = sessions.splice(index, 1)[0];
        if (removed.thumbnailPaths) {
          for (const p of removed.thumbnailPaths) {
            await fs.rm(p, { force: true }).catch(() => {});
          }
        }
        await saveSessions(sessions);
        sendJson(res, 200, { deleted: true });
        return;
      }

      if (req.method === "DELETE" && !sessionId) {
        const sessions = await readSessions();
        for (const s of sessions) {
          if (s.thumbnailPaths) {
            for (const p of s.thumbnailPaths) {
              await fs.rm(p, { force: true }).catch(() => {});
            }
          }
        }
        await saveSessions([]);
        sendJson(res, 200, { deleted: true });
        return;
      }

      return;
    }

    if (req.method === "GET" && url.pathname === "/api/file") {
      const requestedPath = url.searchParams.get("path") || "";
      const resolved = path.resolve(requestedPath);
      const allowedRoots = [path.resolve(INPUT_DIR), path.resolve(OUTPUT_DIR)];
      if (!allowedRoots.some((rootPath) => resolved === rootPath || resolved.startsWith(`${rootPath}${path.sep}`))) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      try {
        const data = await fs.readFile(resolved);
        const type = MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": type,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        });
        res.end(data);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/edit") {
      const config = await readConfig();

      const body = await readJson(req);
      const provider = String(body.provider || "xai").trim();
      const prompt = String(body.prompt || "").trim();
      const isGrokProvider = provider === "xai" || provider === "third-grok";
      const inputLimit = isGrokProvider ? 3 : 10;
      const imageUrls = Array.isArray(body.imageUrls)
        ? body.imageUrls.map((value) => String(value || "").trim()).filter(Boolean)
        : [String(body.imageUrl || "").trim()].filter(Boolean);
      imageUrls.splice(inputLimit);
      const imageUrl = imageUrls[0] || "";
      const model = String(body.model || "grok-imagine-image-quality").trim();
      const openaiModel = String(body.openaiModel || "gpt-image-2").trim();
      const n = Math.max(1, Math.min(4, Number(body.n || 1)));
      const aspectRatio = String(body.aspectRatio || body.aspect_ratio || "1:1").trim();
      const resolution = String(body.resolution || "1k").trim();
      const size = String(body.size || "1024x1536").trim();
      const quality = String(body.quality || "medium").trim();
      const outputFormat = String(body.outputFormat || body.output_format || "png").trim();
      const background = String(body.background || "auto").trim();
      const moderation = String(body.moderation || "low").trim();
      const partialImages = Math.max(0, Math.min(3, Number(body.partialImages || body.partial_images || 0)));
      const inputFidelity = String(body.inputFidelity || body.input_fidelity || "auto").trim();

      if (!prompt) {
        sendJson(res, 400, { error: "请输入图片编辑文字。" });
        return;
      }
      if (!imageUrl) {
        sendJson(res, 400, { error: "请上传图片或填写图片 URL。" });
        return;
      }

      const sessionId = String(body.sessionId || "").trim();
      if (sessionId) {
        await updateSession(sessionId, {
          title: prompt.slice(0, 50),
          prompt,
          provider,
          model: isGrokProvider ? model : openaiModel,
        });
      }

      const savedInputPaths = [];
      for (let index = 0; index < imageUrls.length; index += 1) {
        const prefix = imageUrls.length > 1 ? `input-${index + 1}` : "input";
        savedInputPaths.push(await saveImageReference(imageUrls[index], INPUT_DIR, prefix));
      }
      const savedInputPath = savedInputPaths[0];
      if (sessionId && savedInputPaths.length) {
        await updateSession(sessionId, { inputPaths: savedInputPaths });
      }

      if (provider === "openai" || provider === "yunwu") {
        const isYunwu = provider === "yunwu";
        const providerApiKey = isYunwu ? config.yunwuApiKey : config.openaiApiKey;
        const providerName = isYunwu ? "第三方 OpenAI" : "OpenAI";
        const endpoint = isYunwu
          ? `${(config.yunwuBaseUrl || YUNWU_BASE_URL).replace(/\/+$/, "")}/images/edits`
          : OPENAI_EDIT_URL;

        if (!providerApiKey) {
          sendJson(res, 400, { error: `请先保存 ${providerName} API key。` });
          return;
        }

        const openaiPayload = {
          provider,
          endpoint,
          model: openaiModel,
          prompt,
          n,
          size,
          quality,
          output_format: outputFormat,
          background,
          moderation,
          partial_images: partialImages,
          input_fidelity: inputFidelity,
          images: savedInputPaths,
        };
        await fs.writeFile(LAST_PAYLOAD_PATH, JSON.stringify(openaiPayload, null, 2), "utf8");

        const openaiResponse = await postToOpenAIWithCurl(providerApiKey, savedInputPaths, openaiPayload, endpoint);
        const data = openaiResponse.data;
        if (!openaiResponse.ok) {
          const errMsg = (typeof data.error === "string" ? data.error : data.error?.message) || data.message || data.raw || "OpenAI 图片编辑请求失败。";
          await updateSession(sessionId, {
            success: false,
            error: errMsg,
            inputPaths: savedInputPaths,
          });
          sendJson(res, openaiResponse.status, {
            error: errMsg,
            details: data,
            request: openaiPayload,
          });
          return;
        }

        const savedOutputs = [];
        const images = Array.isArray(data.data) ? data.data : [];
        for (let index = 0; index < images.length; index += 1) {
          const item = images[index];
          const itemRef = item && (item.url || item.b64_json);
          if (!itemRef) continue;
          const itemMime = item.mime_type || `image/${outputFormat === "jpg" ? "jpeg" : outputFormat}`;
          const outputPrefix = images.length > 1 ? `openai-output-${index + 1}` : "openai-output";
          if (item.b64_json) {
            savedOutputs.push(await saveImageReference(`data:${itemMime};base64,${item.b64_json}`, OUTPUT_DIR, outputPrefix, itemMime));
          } else {
            savedOutputs.push(await saveImageReference(itemRef, OUTPUT_DIR, outputPrefix, itemMime));
          }
        }

        data.saved = {
          input: savedInputPath,
          inputs: savedInputPaths,
          output: savedOutputs[0] || "",
          outputs: savedOutputs,
        };
        data.request = openaiPayload;
        const openaiThumbPath = savedOutputs[0] ? path.join(OUTPUT_DIR, "thumbs", `thumb-${generateId()}${path.extname(savedOutputs[0])}`) : "";
        const openaiThumb = savedOutputs[0] ? await makeThumb(savedOutputs[0], openaiThumbPath) : "";
        const openaiThumbs = openaiThumb ? [openaiThumb] : [];
        await updateSession(sessionId, {
          success: true,
          inputPaths: savedInputPaths,
          outputPaths: savedOutputs,
          outputThumb: openaiThumb,
          thumbnailPaths: openaiThumbs,
        });
        sendJson(res, 200, data);
        return;
      }

      const xaiApiKey = provider === "third-grok" ? config.thirdGrokApiKey : config.apiKey;
      const xaiProviderName = provider === "third-grok" ? "第三方 Grok" : "xAI";
      const xaiEndpoint = provider === "third-grok"
        ? imageEditEndpointFromBase(config.thirdGrokBaseUrl, XAI_BASE_URL)
        : XAI_EDIT_URL;

      if (!xaiApiKey) {
        sendJson(res, 400, { error: `请先保存 ${xaiProviderName} API key。` });
        return;
      }

      const imagePayloads = [];
      for (let index = 0; index < imageUrls.length; index += 1) {
        const fileBuffer = await fs.readFile(savedInputPaths[index]);
        let mime = "image/jpeg";
        if (fileBuffer.length >= 4 && fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x4e && fileBuffer[3] === 0x47) {
          mime = "image/png";
        } else if (fileBuffer.length >= 12 && fileBuffer.toString("ascii", 0, 4) === "RIFF" && fileBuffer.toString("ascii", 8, 12) === "WEBP") {
          mime = "image/webp";
        } else if (fileBuffer.length >= 3 && fileBuffer[0] === 0xff && fileBuffer[1] === 0xd8 && fileBuffer[2] === 0xff) {
          mime = "image/jpeg";
        }
        imagePayloads.push(`data:${mime};base64,${fileBuffer.toString("base64")}`);
      }

      let xaiPayload;
      if (provider === "xai") {
        // Match the request body generated by the official xAI Imagine playground.
        xaiPayload = {
          model,
          prompt,
          n,
          resolution,
          image: {
            url: imagePayloads[0],
          },
        };
      } else {
        xaiPayload = {
          model,
          prompt,
          n,
          aspect_ratio: aspectRatio,
          resolution,
        };
        if (imagePayloads.length === 1) {
          xaiPayload.image = {
            url: imagePayloads[0],
            type: "image_url",
          };
        } else {
          xaiPayload.images = imagePayloads.map((url) => ({
            url,
            type: "image_url",
          }));
        }
      }
      await fs.writeFile(LAST_PAYLOAD_PATH, JSON.stringify({
        provider,
        endpoint: xaiEndpoint,
        ...xaiPayload,
      }, null, 2), "utf8");

      const xaiResponse = await postToXai(xaiApiKey, xaiPayload, xaiEndpoint);

      const data = xaiResponse.data;

      if (!xaiResponse.ok) {
        const errMsg = (typeof data.error === "string" ? data.error : data.error?.message) || data.message || data.raw || "xAI 图片编辑请求失败。";
        await updateSession(sessionId, {
          success: false,
          error: errMsg,
          inputPaths: savedInputPaths,
        });
        sendJson(res, xaiResponse.status, {
          error: errMsg,
          details: data,
          request: xaiPayload,
        });
        return;
      }

      const savedOutputs = [];
      const images = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.images)
          ? data.images
          : data.image
            ? [data.image]
            : (data.url || data.b64_json)
              ? [data]
              : [];
      for (let index = 0; index < images.length; index += 1) {
        const item = images[index];
        const itemRef = typeof item === "string" ? item : item && (item.url || item.b64_json);
        const itemMime = item?.mime_type || "image/jpeg";
        if (!itemRef) continue;
        const outputPrefix = images.length > 1 ? `output-${index + 1}` : "output";
        if (item?.b64_json) {
          savedOutputs.push(await saveImageReference(`data:${itemMime};base64,${item.b64_json}`, OUTPUT_DIR, outputPrefix, itemMime));
        } else {
          savedOutputs.push(await saveImageReference(itemRef, OUTPUT_DIR, outputPrefix, itemMime));
        }
      }

      if (!savedOutputs.length) {
        const providerError = apiErrorMessage(data);
        const errMsg = providerError || `${xaiProviderName} 响应里没有可保存的图片数据。`;
        const responseStatus = isSafetyRejection(data) ? 400 : 502;
        await updateSession(sessionId, {
          success: false,
          error: errMsg,
          inputPaths: savedInputPaths,
        });
        sendJson(res, responseStatus, {
          error: errMsg,
          response: data,
          request: xaiPayload,
        });
        return;
      }

      data.saved = {
        input: savedInputPath,
        inputs: savedInputPaths,
        output: savedOutputs[0] || "",
        outputs: savedOutputs,
      };
      data.request = xaiPayload;
      const xaiThumbPath = savedOutputs[0] ? path.join(OUTPUT_DIR, "thumbs", `thumb-${generateId()}${path.extname(savedOutputs[0])}`) : "";
      const xaiThumb = savedOutputs[0] ? await makeThumb(savedOutputs[0], xaiThumbPath) : "";
      const xaiThumbs = xaiThumb ? [xaiThumb] : [];
      await updateSession(sessionId, {
        success: true,
        inputPaths: savedInputPaths,
        outputPaths: savedOutputs,
        outputThumb: xaiThumb,
        thumbnailPaths: xaiThumbs,
      });
      sendJson(res, 200, data);
      return;
    }

    const batchMatch = url.pathname.match(/^\/api\/batch(?:\/(.+))?$/);
    if (batchMatch) {
      const batchId = batchMatch[1];
      const config = await readConfig();

      if (req.method === "POST" && !batchId) {
        const body = await readJson(req);
        const provider = String(body.provider || "openai").trim();
        if (provider !== "openai" && provider !== "yunwu") {
          sendJson(res, 400, { error: "批量模式仅支持 OpenAI / 第三方 OpenAI。" });
          return;
        }
        const model = String(body.model || "gpt-image-2").trim();
        const prompts = Array.isArray(body.prompts) ? body.prompts.filter(Boolean) : [];
        const imageUrls = Array.isArray(body.imageUrls)
          ? body.imageUrls.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 10)
          : [];
        const n = Math.max(1, Math.min(4, Number(body.n || 1)));
        const size = String(body.size || "1024x1024").trim();
        const quality = String(body.quality || "medium").trim();
        const outputFormat = String(body.outputFormat || "png").trim();
        const background = String(body.background || "auto").trim();
        const moderation = String(body.moderation || "low").trim();
        const partialImages = Math.max(0, Math.min(3, Number(body.partialImages || 0)));
        const inputFidelity = String(body.inputFidelity || "auto").trim();

        if (!prompts.length) { sendJson(res, 400, { error: "请至少输入一条提示词。" }); return; }
        if (!imageUrls.length) { sendJson(res, 400, { error: "请上传参考图片。" }); return; }

        const isYunwu = provider === "yunwu";
        const apiKey = isYunwu ? config.yunwuApiKey : config.openaiApiKey;
        const baseUrl = isYunwu
          ? (config.yunwuBaseUrl || YUNWU_BASE_URL).replace(/\/+$/, "")
          : "https://api.openai.com/v1";

        if (!apiKey) {
          sendJson(res, 400, { error: `请先保存 ${isYunwu ? "第三方" : "OpenAI"} API key。` });
          return;
        }

        const savedInputPaths = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const prefix = imageUrls.length > 1 ? `batch-input-${i + 1}` : "batch-input";
          savedInputPaths.push(await saveImageReference(imageUrls[i], INPUT_DIR, prefix));
        }

        const jsonlLines = [];
        for (let i = 0; i < prompts.length; i++) {
          const reqBody = {
            model,
            prompt: prompts[i],
            n,
            size,
            quality,
            output_format: outputFormat,
            background,
            moderation,
          };
          if (partialImages > 0) reqBody.partial_images = partialImages;
          if (inputFidelity !== "auto" && model !== "gpt-image-2") reqBody.input_fidelity = inputFidelity;
          if (imageUrls.length === 1) {
            reqBody.image = imageUrls[0];
          } else {
            reqBody.images = imageUrls.map((url) => ({ url, type: "image_url" }));
          }
          jsonlLines.push(JSON.stringify({
            custom_id: `req-${i + 1}`,
            method: "POST",
            url: "/v1/images/edits",
            body: reqBody,
          }));
        }

        const jsonlPath = path.join(os.tmpdir(), `batch-${generateId()}.jsonl`);
        await fs.writeFile(jsonlPath, jsonlLines.join("\n"), "utf8");

        try {
          const fileId = await uploadFileCurl(apiKey, jsonlPath, "batch", baseUrl);
          const batch = await createBatchCurl(apiKey, fileId, baseUrl);

          const sessionId = String(body.sessionId || "").trim();
          if (sessionId) {
            await updateSession(sessionId, {
              title: `批量 ${prompts.length} 条`,
              prompt: prompts.join(" | "),
              provider,
              model,
              inputPaths: savedInputPaths,
              batchId: batch.id,
              batchStatus: batch.status,
            });
          }

          sendJson(res, 200, {
            batch_id: batch.id,
            status: batch.status,
            prompt_count: prompts.length,
            input_paths: savedInputPaths,
          });
        } catch (err) {
          sendJson(res, 500, { error: err.message || "批量任务创建失败。" });
        } finally {
          await fs.rm(jsonlPath, { force: true }).catch(() => {});
        }
        return;
      }

      if (req.method === "GET" && batchId) {
        const isYunwu = req.headers["x-provider"] === "yunwu";
        const apiKey = isYunwu ? config.yunwuApiKey : config.openaiApiKey;
        const baseUrl = isYunwu
          ? (config.yunwuBaseUrl || YUNWU_BASE_URL).replace(/\/+$/, "")
          : "https://api.openai.com/v1";

        if (!apiKey) {
          sendJson(res, 400, { error: "请先保存 API key。" });
          return;
        }

        try {
          const batch = await getBatchCurl(apiKey, batchId, baseUrl);
          const result = { batch_id: batch.id, status: batch.status };

          if (batch.status === "completed" && batch.output_file_id) {
            const outputContent = await getFileContentCurl(apiKey, batch.output_file_id, baseUrl);
            const lines = outputContent.split("\n").filter(Boolean);
            const savedOutputs = [];

            for (const line of lines) {
              const entry = parseMaybeJson(line);
              const body = entry?.response?.body;
              const images = Array.isArray(body?.data) ? body.data : [];
              for (let i = 0; i < images.length; i++) {
                const item = images[i];
                if (!item) continue;
                const mime = item.mime_type || `image/${outputFormat === "jpg" ? "jpeg" : outputFormat}`;
                const prefix = `batch-output-${entry.custom_id || "unknown"}`;
                let saved;
                if (item.b64_json) {
                  saved = await saveDataUrl(`data:${mime};base64,${item.b64_json}`, OUTPUT_DIR, prefix);
                } else if (item.url) {
                  saved = await saveImageReference(item.url, OUTPUT_DIR, prefix, mime);
                }
                if (saved) savedOutputs.push(saved);
              }
            }

            const thumbPath = savedOutputs[0]
              ? path.join(OUTPUT_DIR, "thumbs", `thumb-batch-${generateId()}${path.extname(savedOutputs[0])}`)
              : "";
            const thumb = savedOutputs[0] ? await makeThumb(savedOutputs[0], thumbPath) : "";
            const thumbs = thumb ? [thumb] : [];

            const sessions = await readSessions();
            const session = sessions.find((s) => s.batchId === batchId);
            if (session) {
              session.success = true;
              session.batchStatus = "completed";
              session.outputPaths = savedOutputs;
              session.outputThumb = thumb;
              session.thumbnailPaths = thumbs;
              await saveSessions(sessions);
            }

            result.outputs = savedOutputs;
            result.output_count = savedOutputs.length;
          }

          const sessions = await readSessions();
          const session = sessions.find((s) => s.batchId === batchId);
          if (session && session.batchStatus !== batch.status) {
            session.batchStatus = batch.status;
            await saveSessions(sessions);
          }

          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 500, { error: err.message || "查询批量任务失败。" });
        }
        return;
      }

      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器内部错误。" });
  }
}

http.createServer(handleRequest).listen(PORT, "127.0.0.1", () => {
  console.log(`Grok image editor is running at http://127.0.0.1:${PORT}`);
});
