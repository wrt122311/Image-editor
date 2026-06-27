(function () {
  const standalone = new URLSearchParams(location.search).get("standalone") === "1"
    || location.hostname.endsWith(".github.io");
  if (!standalone) return;

  const nativeFetch = window.fetch.bind(window);
  const CONFIG_KEY = "image_editor_standalone_config_v2";
  const DB_NAME = "image-editor-standalone";
  const STORE = "sessions";
  const LIMIT = 1000;
  const batches = new Map();

  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  const trimBase = (value, fallback) => String(value || fallback).trim().replace(/\/+$/, "");
  const mask = (value) => {
    const key = String(value || "");
    if (!key) return "";
    if (key.length < 10) return `${key.slice(0, 3)}...`;
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
  };
  const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
  const readBody = async (init) => {
    if (!init?.body) return {};
    if (typeof init.body === "string") return JSON.parse(init.body || "{}");
    return {};
  };

  function readConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); } catch { return {}; }
  }

  function saveConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  function normalizeProfiles(source, kind) {
    const grok = kind === "grok";
    return (Array.isArray(source) ? source : []).filter((item) => item?.id).map((item) => {
      const keys = (Array.isArray(item.keys) ? item.keys : []).filter((key) => key?.apiKey).map((key, index) => ({
        id: String(key.id || `${item.id}-key-${index + 1}`),
        note: String(key.note || `Key ${index + 1}`),
        apiKey: String(key.apiKey),
      }));
      if (!keys.length && item.apiKey) keys.push({ id: `${item.id}-legacy-key`, note: item.keyNote || "默认 Key", apiKey: item.apiKey });
      const activeKeyId = keys.some((key) => key.id === item.activeKeyId) ? item.activeKeyId : keys[0]?.id || "";
      const active = keys.find((key) => key.id === activeKeyId) || null;
      return {
        id: String(item.id),
        name: String(item.name || (grok ? "第三方 Grok" : "第三方 GPT")),
        keys,
        activeKeyId,
        apiKey: active?.apiKey || "",
        keyNote: active?.note || "",
        baseUrl: trimBase(item.baseUrl, grok ? "https://api.x.ai/v1" : "https://api.openai.com/v1"),
        model: String(item.model || (grok ? "grok-imagine-image" : "gpt-image-2")),
        ...(grok ? {} : { mode: item.mode === "tasks" ? "tasks" : "edits", resolution: item.resolution || "2k" }),
      };
    });
  }

  function publicProfiles(profiles) {
    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      mode: profile.mode,
      resolution: profile.resolution,
      saved: Boolean(profile.apiKey),
      masked: mask(profile.apiKey),
      activeKeyId: profile.activeKeyId,
      keyNote: profile.keyNote,
      keys: profile.keys.map((key) => ({ id: key.id, note: key.note, saved: true, masked: mask(key.apiKey), active: key.id === profile.activeKeyId })),
    }));
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbRequest(mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let request;
      try { request = action(tx.objectStore(STORE)); } catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { const result = request?.result; db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  const allSessions = async () => ((await dbRequest("readonly", (store) => store.getAll())) || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const getSession = (id) => dbRequest("readonly", (store) => store.get(id));
  const putSession = async (session) => {
    await dbRequest("readwrite", (store) => store.put(session));
    const sessions = await allSessions();
    for (const old of sessions.slice(LIMIT)) await dbRequest("readwrite", (store) => store.delete(old.id));
  };

  function sessionBrief(session) {
    return {
      id: session.id,
      createdAt: session.createdAt,
      title: session.title || "",
      prompt: session.prompt || "",
      provider: session.provider || "",
      providerName: session.providerName || "",
      model: session.model || "",
      configuration: session.configuration || null,
      success: Boolean(session.success),
      error: session.error || "",
      durationMs: session.durationMs || 0,
      inputCount: session.inputPaths?.length || 0,
      outputCount: session.outputPaths?.length || 0,
      outputThumb: session.outputThumb || "",
      thumbnailPaths: session.thumbnailPaths || [],
    };
  }

  function endpointFromBase(baseUrl, suffix) {
    const base = trimBase(baseUrl, "");
    if (base.endsWith(suffix)) return base;
    if (/\/v\d+$/i.test(base)) return `${base}${suffix}`;
    return `${base}/v1${suffix}`;
  }

  function dataUrlBlob(dataUrl) {
    const [meta, value] = String(dataUrl).split(",");
    const mime = /data:([^;]+)/.exec(meta)?.[1] || "image/png";
    const binary = atob(value || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }

  async function parseApiResponse(response) {
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : data.error?.message || data.message || `HTTP ${response.status}`), { status: response.status, data });
    return data;
  }

  async function callEdits(profile, body) {
    const form = new FormData();
    (body.imageUrls || []).forEach((source, index) => {
      const blob = dataUrlBlob(source);
      form.append("image", blob, `input-${index + 1}.${blob.type.includes("jpeg") ? "jpg" : blob.type.split("/")[1] || "png"}`);
    });
    form.append("model", profile.model);
    form.append("prompt", body.prompt);
    form.append("n", String(body.n || 1));
    form.append("size", body.size || "1024x1536");
    form.append("quality", body.quality || "medium");
    form.append("output_format", body.outputFormat || "png");
    form.append("background", body.background || "auto");
    form.append("moderation", body.moderation || "low");
    if (body.partialImages) form.append("partial_images", String(body.partialImages));
    if (body.inputFidelity && body.inputFidelity !== "auto") form.append("input_fidelity", body.inputFidelity);
    return parseApiResponse(await nativeFetch(endpointFromBase(profile.baseUrl, "/images/edits"), {
      method: "POST", headers: { Authorization: `Bearer ${profile.apiKey}` }, body: form,
    }));
  }

  async function callGrok(profile, body) {
    const images = (body.imageUrls || []).map((url) => ({ url, type: "image_url" }));
    const payload = {
      model: profile.model,
      prompt: body.prompt,
      n: Number(body.n || 1),
      resolution: body.resolution || "2k",
      aspect_ratio: body.aspectRatio || "1:1",
    };
    if (profile.official) {
      delete payload.aspect_ratio;
      payload.image = { url: body.imageUrls[0] };
    } else if (images.length === 1) payload.image = images[0];
    else payload.images = images;
    return parseApiResponse(await nativeFetch(endpointFromBase(profile.baseUrl, "/images/edits"), {
      method: "POST",
      headers: { Authorization: `Bearer ${profile.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));
  }

  function taskSettings(size, resolution) {
    const map = { "1024x1024": ["1:1", "1k"], "1024x1536": ["2:3", "1k"], "1536x1024": ["3:2", "1k"], "2048x2048": ["1:1", "2k"], "2048x1152": ["16:9", "2k"], "3840x2160": ["16:9", "4k"], "2160x3840": ["9:16", "4k"] };
    const values = map[size] || [size === "auto" ? "auto" : size, resolution];
    return { size: values[0], resolution: values[1] || resolution };
  }

  async function callTask(profile, body) {
    const imageUrls = [];
    for (let index = 0; index < body.imageUrls.length; index += 1) {
      const form = new FormData();
      const blob = dataUrlBlob(body.imageUrls[index]);
      form.append("file", blob, `input-${index + 1}.png`);
      const upload = await parseApiResponse(await nativeFetch(`${trimBase(profile.baseUrl)}/uploads/images`, {
        method: "POST", headers: { Authorization: `Bearer ${profile.apiKey}` }, body: form,
      }));
      if (!upload.url) throw new Error("参考图上传后没有返回 URL。");
      imageUrls.push(upload.url);
    }
    const settings = taskSettings(body.size, profile.resolution);
    const payload = {
      model: profile.model, prompt: body.prompt, n: Number(body.n || 1), size: settings.size,
      resolution: settings.resolution, quality: body.quality, output_format: body.outputFormat,
      background: body.background, moderation: body.moderation, image_urls: imageUrls,
    };
    const submitted = await parseApiResponse(await nativeFetch(`${trimBase(profile.baseUrl)}/images/generations`, {
      method: "POST", headers: { Authorization: `Bearer ${profile.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }));
    const items = Array.isArray(submitted.data) ? submitted.data : [submitted.data || submitted];
    const taskId = items.find((item) => item?.task_id || item?.id)?.task_id || items.find((item) => item?.id)?.id;
    if (!taskId) throw new Error("异步接口未返回 task_id。");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const response = await parseApiResponse(await nativeFetch(`${trimBase(profile.baseUrl)}/tasks/${encodeURIComponent(taskId)}?language=zh`, { headers: { Authorization: `Bearer ${profile.apiKey}` } }));
      const task = response.data || response;
      if (["failed", "cancelled"].includes(task.status)) throw new Error(task.error?.message || task.fail_reason || `任务${task.status}`);
      if (task.status === "completed") {
        const urls = (task.result?.images || []).flatMap((item) => Array.isArray(item?.url) ? item.url : item?.url ? [item.url] : []);
        if (!urls.length) throw new Error("任务完成但没有返回图片。");
        return { data: urls.map((url) => ({ url })), task_id: taskId };
      }
    }
    throw new Error("异步图片任务等待超时。");
  }

  function extractOutputs(data, format) {
    const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.images) ? data.images : data?.image ? [data.image] : [];
    return items.map((item) => {
      if (typeof item === "string") return item;
      if (item?.url) return item.url;
      if (item?.b64_json) return `data:${item.mime_type || `image/${format || "png"}`};base64,${item.b64_json}`;
      return "";
    }).filter(Boolean);
  }

  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function durableOutput(url) {
    if (!url || url.startsWith("data:")) return url;
    try {
      const response = await nativeFetch(url);
      if (!response.ok) return url;
      return await blobDataUrl(await response.blob());
    } catch {
      return url;
    }
  }

  function resolveProvider(config, provider, body) {
    if (provider === "openai") return { name: "OpenAI", apiKey: config.openaiApiKey, baseUrl: "https://api.openai.com/v1", model: body.openaiModel || "gpt-image-2", kind: "openai", mode: "edits" };
    if (provider === "xai") return { name: "xAI", apiKey: config.apiKey, baseUrl: "https://api.x.ai/v1", model: body.model || "grok-imagine-image", kind: "grok", official: true };
    if (provider.startsWith("openai-profile:")) {
      const profile = normalizeProfiles(config.thirdOpenAIProfiles, "openai").find((item) => item.id === provider.slice(15));
      return profile ? { ...profile, kind: "openai" } : null;
    }
    if (provider.startsWith("grok-profile:")) {
      const profile = normalizeProfiles(config.thirdGrokProfiles, "grok").find((item) => item.id === provider.slice(13));
      return profile ? { ...profile, kind: "grok" } : null;
    }
    return null;
  }

  async function runEdit(body) {
    const startedAt = Date.now();
    const config = readConfig();
    const profile = resolveProvider(config, body.provider || "xai", body);
    if (!profile) throw new Error("选择的 API 配置不存在。");
    if (!profile.apiKey) throw new Error(`请先保存 ${profile.name} API Key。`);
    const configuration = {
      provider: body.provider, providerName: profile.name, apiBaseUrl: profile.baseUrl,
      apiMode: profile.mode || "grok-edit", keyId: profile.activeKeyId || "", keyNote: profile.keyNote || "",
      keyMasked: mask(profile.apiKey), model: profile.model, size: body.size, quality: body.quality,
      outputFormat: body.outputFormat, background: body.background, moderation: body.moderation,
      count: Number(body.n || 1), aspectRatio: body.aspectRatio, resolution: body.resolution,
      partialImages: body.partialImages, inputFidelity: body.inputFidelity,
    };
    const session = body.sessionId ? await getSession(body.sessionId) : null;
    if (session) {
      Object.assign(session, { title: body.prompt.slice(0, 50), prompt: body.prompt, provider: body.provider, providerName: profile.name, model: profile.model, configuration, inputPaths: body.imageUrls || [], success: false, error: "" });
      await putSession(session);
    }
    try {
      const data = profile.kind === "grok" ? await callGrok(profile, body) : profile.mode === "tasks" ? await callTask(profile, body) : await callEdits(profile, body);
      const outputs = await Promise.all(extractOutputs(data, body.outputFormat).map(durableOutput));
      if (!outputs.length) throw new Error("响应中没有图片数据。");
      if (session) {
        Object.assign(session, { success: true, error: "", outputPaths: outputs, outputThumb: outputs[0], thumbnailPaths: outputs, durationMs: Date.now() - startedAt });
        await putSession(session);
      }
      return { ...data, saved: { input: body.imageUrls?.[0] || "", inputs: body.imageUrls || [], output: outputs[0], outputs } };
    } catch (error) {
      if (session) { Object.assign(session, { success: false, error: error.message, durationMs: Date.now() - startedAt }); await putSession(session); }
      throw error;
    }
  }

  async function handleProfiles(path, method, body, kind) {
    const config = readConfig();
    const prop = kind === "grok" ? "thirdGrokProfiles" : "thirdOpenAIProfiles";
    const profiles = normalizeProfiles(config[prop], kind);
    const base = kind === "grok" ? "/api/grok-profiles" : "/api/openai-profiles";
    const keyMatch = path.match(new RegExp(`^${base}/([^/]+)/keys(?:/([^/]+))?$`));
    if (keyMatch) {
      const profile = profiles.find((item) => item.id === decodeURIComponent(keyMatch[1]));
      if (!profile) return jsonResponse({ error: "配置不存在。" }, 404);
      const keyId = keyMatch[2] ? decodeURIComponent(keyMatch[2]) : "";
      if (method === "POST" && !keyId) {
        if (!body.apiKey || !body.note) return jsonResponse({ error: "Key 内容和备注不能为空。" }, 400);
        const key = { id: uid(), note: body.note.trim(), apiKey: body.apiKey.trim() };
        profile.keys.push(key); if (body.active || !profile.activeKeyId) profile.activeKeyId = key.id;
        syncActive(profile); config[prop] = profiles; saveConfig(config);
        return jsonResponse({ saved: true, keyId: key.id, profile: publicProfiles(profiles).find((item) => item.id === profile.id) });
      }
      const key = profile.keys.find((item) => item.id === keyId);
      if (!key) return jsonResponse({ error: "API Key 不存在。" }, 404);
      if (method === "PATCH") {
        if (body.note !== undefined) { if (!body.note.trim()) return jsonResponse({ error: "Key 备注不能为空。" }, 400); key.note = body.note.trim(); }
        if (body.apiKey) key.apiKey = body.apiKey.trim();
        if (body.active) profile.activeKeyId = key.id;
        syncActive(profile); config[prop] = profiles; saveConfig(config);
        return jsonResponse({ saved: true, keyId: key.id, profile: publicProfiles(profiles).find((item) => item.id === profile.id) });
      }
      if (method === "DELETE") {
        if (profile.keys.length <= 1) return jsonResponse({ error: "一个配置至少保留一个 Key。" }, 400);
        profile.keys = profile.keys.filter((item) => item.id !== key.id);
        if (profile.activeKeyId === key.id) profile.activeKeyId = profile.keys[0].id;
        syncActive(profile); config[prop] = profiles; saveConfig(config);
        return jsonResponse({ deleted: true, profile: publicProfiles(profiles).find((item) => item.id === profile.id) });
      }
    }
    const profileMatch = path.match(new RegExp(`^${base}(?:/([^/]+))?$`));
    if (!profileMatch) return null;
    const profileId = profileMatch[1] ? decodeURIComponent(profileMatch[1]) : "";
    if (method === "POST" && !profileId) {
      const id = String(body.id || uid());
      const index = profiles.findIndex((item) => item.id === id);
      const existing = index >= 0 ? profiles[index] : null;
      const keys = existing?.keys.map((key) => ({ ...key })) || [];
      let activeKeyId = existing?.activeKeyId || keys[0]?.id || "";
      if (body.apiKey) {
        const active = keys.find((key) => key.id === activeKeyId);
        if (active) active.apiKey = body.apiKey.trim();
        else { const key = { id: uid(), note: body.keyNote?.trim() || "默认 Key", apiKey: body.apiKey.trim() }; keys.push(key); activeKeyId = key.id; }
      }
      const profile = {
        id, name: body.name?.trim() || existing?.name || (kind === "grok" ? "第三方 Grok" : "第三方 GPT"), keys, activeKeyId,
        baseUrl: trimBase(body.baseUrl, existing?.baseUrl || (kind === "grok" ? "https://api.x.ai/v1" : "https://api.openai.com/v1")),
        model: body.model?.trim() || existing?.model || (kind === "grok" ? "grok-imagine-image" : "gpt-image-2"),
        ...(kind === "grok" ? {} : { mode: body.mode === "tasks" ? "tasks" : existing?.mode || "edits", resolution: body.resolution || existing?.resolution || "2k" }),
      };
      syncActive(profile);
      if (!profile.name || !profile.apiKey || !profile.baseUrl || !profile.model) return jsonResponse({ error: "名称、API Key、Base URL 和模型名不能为空。" }, 400);
      if (index >= 0) profiles[index] = profile; else profiles.push(profile);
      config[prop] = profiles; saveConfig(config);
      return jsonResponse({ saved: true, profile: publicProfiles(profiles).find((item) => item.id === id) });
    }
    if (method === "DELETE" && profileId) {
      const next = profiles.filter((item) => item.id !== profileId);
      if (next.length === profiles.length) return jsonResponse({ error: "配置不存在。" }, 404);
      config[prop] = next; saveConfig(config); return jsonResponse({ deleted: true });
    }
    return jsonResponse({ error: "不支持的操作。" }, 405);
  }

  function syncActive(profile) {
    if (!profile.keys.some((key) => key.id === profile.activeKeyId)) profile.activeKeyId = profile.keys[0]?.id || "";
    const active = profile.keys.find((key) => key.id === profile.activeKeyId);
    profile.apiKey = active?.apiKey || "";
    profile.keyNote = active?.note || "";
  }

  window.fetch = async function standaloneFetch(input, init = {}) {
    const requestUrl = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!requestUrl.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const path = requestUrl.pathname;
    const method = String(init.method || "GET").toUpperCase();
    const body = await readBody(init);
    try {
      if (path === "/api/key" && method === "GET") {
        const config = readConfig();
        return jsonResponse({
          saved: Boolean(config.apiKey), masked: mask(config.apiKey),
          openaiSaved: Boolean(config.openaiApiKey), openaiMasked: mask(config.openaiApiKey),
          thirdOpenAIProfiles: publicProfiles(normalizeProfiles(config.thirdOpenAIProfiles, "openai")),
          thirdGrokProfiles: publicProfiles(normalizeProfiles(config.thirdGrokProfiles, "grok")),
        });
      }
      if (path === "/api/key" && method === "POST") {
        const config = readConfig();
        if (body.provider === "openai") config.openaiApiKey = body.apiKey;
        else config.apiKey = body.apiKey;
        saveConfig(config); return jsonResponse({ saved: true, masked: mask(body.apiKey) });
      }
      const profileResponse = path.startsWith("/api/openai-profiles")
        ? await handleProfiles(path, method, body, "openai")
        : path.startsWith("/api/grok-profiles") ? await handleProfiles(path, method, body, "grok") : null;
      if (profileResponse) return profileResponse;
      if (path === "/api/sessions" && method === "GET") return jsonResponse((await allSessions()).map(sessionBrief));
      if (path === "/api/sessions" && method === "POST") {
        const session = { id: uid(), createdAt: new Date().toISOString(), title: body.title || "新会话", prompt: body.prompt || "", provider: "", model: "", providerName: "", configuration: null, durationMs: 0, success: false, error: "", inputPaths: [], outputPaths: [], outputThumb: "", thumbnailPaths: [] };
        await putSession(session); return jsonResponse({ id: session.id });
      }
      const sessionMatch = path.match(/^\/api\/sessions\/(.+)$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        if (method === "GET") { const session = await getSession(id); return session ? jsonResponse(session) : jsonResponse({ error: "会话不存在。" }, 404); }
        if (method === "PATCH") { const session = await getSession(id); if (!session) return jsonResponse({ error: "会话不存在。" }, 404); Object.assign(session, body); await putSession(session); return jsonResponse({ updated: true }); }
        if (method === "DELETE") { await dbRequest("readwrite", (store) => store.delete(id)); return jsonResponse({ deleted: true }); }
      }
      if (path === "/api/edit" && method === "POST") return jsonResponse(await runEdit(body));
      if (path === "/api/batch" && method === "POST") {
        const id = uid();
        const outputs = [];
        for (const prompt of body.prompts || []) {
          const result = await runEdit({ ...body, prompt, sessionId: "" });
          outputs.push(...(result.saved?.outputs || []));
        }
        const session = body.sessionId ? await getSession(body.sessionId) : null;
        if (session) { Object.assign(session, { prompt: (body.prompts || []).join(" | "), provider: body.provider, success: true, outputPaths: outputs, outputThumb: outputs[0] || "", durationMs: 0 }); await putSession(session); }
        batches.set(id, { batch_id: id, status: "completed", outputs, output_count: outputs.length });
        return jsonResponse({ batch_id: id, status: "completed", prompt_count: body.prompts?.length || 0 });
      }
      const batchMatch = path.match(/^\/api\/batch\/(.+)$/);
      if (batchMatch && method === "GET") return jsonResponse(batches.get(batchMatch[1]) || { error: "任务不存在。" }, batches.has(batchMatch[1]) ? 200 : 404);
      return jsonResponse({ error: `纯手机模式暂不支持：${method} ${path}` }, 404);
    } catch (error) {
      return jsonResponse({ error: error.message || "请求失败。", details: error.data || null }, error.status || 500);
    }
  };
})();
