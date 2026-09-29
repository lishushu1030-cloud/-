#!/usr/bin/env node
'use strict';

/* ============================================================================
 *  本地小服务 server.js
 *  ---------------------------------------------------------------------------
 *  它干两件事：
 *    1. 把本文件夹当成一个静态网站发出去（index.html、IMG_3392.JPG 等）；
 *    2. 提供一个 POST /api/remove-bg 接口，替网页去调用 Replicate 上的
 *       lucataco/remove-bg 模型，再把「去完背景的 PNG」原样传回网页。
 *
 *  ★ 为什么不能像天气那样直接在网页里 fetch Replicate？
 *    · 浏览器跨域（CORS）默认拿不到 api.replicate.com 的响应；
 *    · 更要紧的是：Key 一旦写进 HTML/JS，任何人按 F12 就能看到并盗刷。
 *    所以 Key 只放在「服务端的环境变量」里，网页只跟自己家的服务说话：
 *
 *        网页(index.html)  ──POST 图片──▶  server.js  ──带 Key──▶  Replicate
 *        网页(index.html)  ◀──返回 PNG──  server.js  ◀──结果链接──  Replicate
 *
 *  启动：  node server.js
 *  依赖：  无（只用 Node 自带的模块，不需要 npm install）
 *  要求：  Node.js 18 及以上（需要内置的 fetch）
 * ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* ---------------------------------------------------------------------------
 * 0. 先把 .env 里的配置读进 process.env
 *    优先级：真实环境变量 > .env 文件（已经设过的不会被覆盖）
 * ------------------------------------------------------------------------- */
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // 没有 .env 也没关系，用系统环境变量就行
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

/* ---------------------------------------------------------------------------
 * 1. 配置
 * ------------------------------------------------------------------------- */
const HOST = '127.0.0.1';                    // 只监听本机，局域网里的别人访问不到
const DEFAULT_PORT = Number(process.env.PORT) || 8787;
const MAX_UPLOAD = 12 * 1024 * 1024;         // 单张图片最大 12 MB

const MODEL_OWNER = 'lucataco';
const MODEL_NAME = 'remove-bg';
/* 这个模型是 2023 年发布的，Replicate 上**没有给它设默认版本**，
   所以只能「按版本号」调用；用 /v1/models/{owner}/{name}/predictions
   那种按模型名调用的写法会直接返回 404。
   以后如果换成有默认版本的模型，把这里清空（''）就会自动改用模型名调用。 */
const MODEL_VERSION = '95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1';

const REPLICATE_API = 'https://api.replicate.com/v1';
const WAIT_SECONDS = 60;                     // 同步模式最长等 60 秒
const POLL_TIMEOUT_MS = 120000;              // 没跑完就轮询，总共最多等 2 分钟
const MAX_RETRY_ON_429 = 3;                  // 被限流时最多自动重试几次

/* --- 第四屏：文字生成图片（OpenRouter）--------------------------------------
   模型跑在 OpenRouter 上，Key 同样只放服务端：前端 → 本服务 → OpenRouter。
   想换模型只改这一个常量（模型列表：https://openrouter.ai/models?output_modalities=image） */
const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'openai/gpt-5.4-image-2';

/* 这些取值范围来自该模型的端点能力（/api/v1/images/models/…/endpoints），
   传了它不认的值会被上游拒掉，所以这里先过滤一遍。 */
const ASPECTS = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];
const QUALITIES = ['auto', 'low', 'medium', 'high'];
const MAX_PROMPT = 2000;                     // 提示词最长 2000 字
const MAX_IMAGES = 4;                        // 一次最多出 4 张（每张都单独计费）
const IMAGE_WAIT_MS = 5 * 60 * 1000;         // 高质量大图可能要 2 分钟以上，给足 5 分钟

/* ---------------------------------------------------------------------------
 * 2. 小工具
 * ------------------------------------------------------------------------- */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `图片太大（超过 ${Math.round(limit / 1024 / 1024)} MB），请换一张小一点的。`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------------------------------------------------------------------
 * 3. 静态文件（index.html 等）
 * ------------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;

  // 只允许访问本文件夹内的文件（挡掉 ../../ 这类路径穿越）
  const abs = path.resolve(__dirname, '.' + rel);
  if (abs !== __dirname && !abs.startsWith(__dirname + path.sep)) {
    return sendJson(res, 403, { error: '不允许访问这个路径。' });
  }

  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 找不到：' + rel);
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html';
    // 页面文件不缓存，改完刷新就能看到；图片缓存一小时，省点流量
    const cache = isHtml || ext === '.js' || ext === '.css' ? 'no-store' : 'public, max-age=3600';

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cache,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

/* ---------------------------------------------------------------------------
 * 4. 去背景：把图片交给 Replicate 上的 lucataco/remove-bg
 * ------------------------------------------------------------------------- */

/** 图片转成 data URI（Replicate 支持 data:image/...;base64,... 这种输入） */
function toDataUri(buf, mime) {
  return 'data:' + (mime || 'image/png') + ';base64,' + buf.toString('base64');
}

/** 把 Replicate 的报错翻译成人话 */
function describeReplicateError(status, data, fallbackText) {
  const detail = data && (data.detail || data.error)
    ? String(data.detail || data.error)
    : String(fallbackText || '').slice(0, 200);

  switch (status) {
    case 401:
      return new HttpError(401, 'Replicate 拒绝了这个 Key（401）。请检查 REPLICATE_API_TOKEN 是否写错或已失效。');
    case 402:
      return new HttpError(402, 'Replicate 账户需要绑定付款方式或余额不足（402），去 replicate.com/account/billing 看看。');
    case 404:
      return new HttpError(
        404,
        `Replicate 找不到这个模型版本（404）。多半是 server.js 里的 MODEL_VERSION 失效了，` +
          `去 https://replicate.com/${MODEL_OWNER}/${MODEL_NAME}/versions 复制最新的版本号换上。`
      );
    case 422:
      return new HttpError(422, '传过去的参数不对（422）：' + detail);
    case 429:
      return new HttpError(
        429,
        'Replicate 限流了（429）：短时间内提交的任务太多。' +
          '新账户（余额不足 $5）限制比较紧——每分钟最多 6 次、而且同时只能跑 1 张。' +
          '等十几秒再点一次就好。'
      );
    default:
      return new HttpError(status, `Replicate 返回 HTTP ${status}${detail ? '：' + detail : ''}`);
  }
}

/** 组出「创建预测」的请求：有版本号就按版本调，没有就按模型名调 */
function predictionRequest(imageInput) {
  if (MODEL_VERSION) {
    return {
      url: `${REPLICATE_API}/predictions`,
      body: { version: MODEL_VERSION, input: { image: imageInput } },
    };
  }
  return {
    url: `${REPLICATE_API}/models/${MODEL_OWNER}/${MODEL_NAME}/predictions`,
    body: { input: { image: imageInput } },
  };
}

/**
 * 建一个预测任务。
 * Prefer: wait 表示「你等我一会儿，跑完直接把结果给我」；
 * 遇到 429 限流时，按 Replicate 给的 retry_after 自动等一会儿再试。
 */
async function createPrediction(imageInput, token) {
  const { url, body } = predictionRequest(imageInput);

  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': `wait=${WAIT_SECONDS}`,
        'Cancel-After': '2m', // 超时就自动取消这次任务，不浪费额度
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 不是 JSON 就按状态码报错 */
    }

    if (res.ok) return data;

    if (res.status === 429 && attempt <= MAX_RETRY_ON_429) {
      const wait = Math.min(Number(data && data.retry_after) || 5, 20);
      console.log(`[去背景] 被限流，等 ${wait} 秒后自动重试（第 ${attempt} 次）…`);
      await sleep(wait * 1000 + 500);
      continue;
    }

    throw describeReplicateError(res.status, data, text);
  }
}

/** 从 output 里找出图片地址（不同模型的 output 结构不太一样，这里都兜住） */
function pickOutputUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.length ? pickOutputUrl(output[0]) : null;
  if (typeof output === 'object' && typeof output.url === 'string') return output.url;
  return null;
}

const FAILED_STATUS = ['failed', 'canceled', 'cancelled'];
const DONE_STATUS = ['succeeded', 'successful'];

/** 等模型出结果：先看同步返回，没有就每隔 1.5 秒问一次 */
async function waitForOutput(prediction, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pred = prediction;

  for (;;) {
    const url = pickOutputUrl(pred && pred.output);
    if (url) return url; // 只要拿到结果就立刻用（文件类输出可能早于 status 完成）

    const status = pred && pred.status;
    if (FAILED_STATUS.includes(status)) {
      throw new HttpError(502, `模型运行失败（${status}）${pred.error ? '：' + pred.error : ''}`);
    }
    if (DONE_STATUS.includes(status) && !pred.output) {
      throw new HttpError(502, '模型跑完了，但没有返回图片。换一张图试试。');
    }
    if (Date.now() > deadline) {
      throw new HttpError(504, '等模型结果超过 2 分钟，已放弃。可以稍后再试一次。');
    }

    await sleep(1500);
    const getUrl = (pred && pred.urls && pred.urls.get) || `${REPLICATE_API}/predictions/${pred && pred.id}`;
    const res = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new HttpError(502, `查询进度失败：HTTP ${res.status}`);
    pred = await res.json();
  }
}

/** 把结果图片下载到内存里 */
async function downloadOutput(url, token) {
  // replicate.delivery 上是带签名的地址，一般不需要鉴权；万一 401/403 就补上
  let res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new HttpError(502, `下载结果失败：HTTP ${res.status}`);
  return {
    contentType: (res.headers.get('content-type') || 'image/png').split(';')[0],
    body: Buffer.from(await res.arrayBuffer()),
  };
}

async function handleRemoveBg(req, res) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new HttpError(
      500,
      '服务端没有读到 REPLICATE_API_TOKEN。请在本文件夹的 .env 里填好 Key（或先 export 再用 node server.js 启动），' +
        '改完记得重启这个服务。详见 README.md。'
    );
  }

  const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!/^image\//i.test(mime)) {
    throw new HttpError(400, '请求里没有图片：Content-Type 应该是 image/png、image/jpeg 这类。');
  }

  const buf = await readBody(req, MAX_UPLOAD);
  if (!buf.length) throw new HttpError(400, '收到的图片是空的，请重新选一张。');

  console.log(`[去背景] 收到图片 ${(buf.length / 1024).toFixed(0)} KB（${mime}），提交给 Replicate…`);
  const t0 = Date.now();

  const prediction = await createPrediction(toDataUri(buf, mime), token);
  const outUrl = await waitForOutput(prediction, token);
  const png = await downloadOutput(outUrl, token);

  const elapsed = Date.now() - t0;
  console.log(`[去背景] 成功，用时 ${(elapsed / 1000).toFixed(1)} 秒，结果 ${(png.body.length / 1024).toFixed(0)} KB`);

  res.writeHead(200, {
    'Content-Type': png.contentType,
    'Content-Length': png.body.length,
    'Cache-Control': 'no-store',
    'X-Elapsed-Ms': String(elapsed),
  });
  res.end(png.body);
}

/* ---------------------------------------------------------------------------
 * 5. 文字生成图片：把提示词交给 OpenRouter 上的 openai/gpt-5.4-image-2
 *
 *    用的是 OpenRouter 的「Image API」：POST /api/v1/images
 *    请求体就是 {model, prompt, aspect_ratio, quality, n}，很直白；
 *    返回体形如：
 *      { "created":…, "data":[{"b64_json":"<base64>","media_type":"image/png"}],
 *        "usage":{"cost":0.006} }
 *    图片是 base64，不是网址，所以直接把这段 base64 原样交给前端，由前端拼成
 *    data:image/png;base64,… 显示——省一次落盘、也不会把临时文件留在服务器上。
 * ------------------------------------------------------------------------- */

/** 把 OpenRouter 的报错翻译成人话 */
function describeOpenRouterError(status, data, fallbackText) {
  const detail = data && data.error
    ? String(data.error.message || data.error)
    : String(fallbackText || '').slice(0, 200);

  switch (status) {
    case 400:
      return new HttpError(400, 'OpenRouter 认为请求不合法（400）：' + detail);
    case 401:
      return new HttpError(401, 'OpenRouter 拒绝了这个 Key（401）。请检查 .env 里的 OPENROUTER_API_KEY 是否写错或已失效。');
    case 402:
      return new HttpError(402, 'OpenRouter 账户余额不足（402）。去 openrouter.ai/credits 充值后再试。');
    case 403:
      return new HttpError(403, 'OpenRouter 不允许这次请求（403）：' + detail);
    case 404:
      return new HttpError(404, `OpenRouter 上找不到模型 ${IMAGE_MODEL}（404）。请检查 server.js 顶部的 IMAGE_MODEL。`);
    case 413:
      return new HttpError(413, '提示词太长了，请精简一点再试。');
    case 429:
      return new HttpError(429, 'OpenRouter 限流了（429）：短时间内请求太多，等十几秒再点一次。');
    default:
      if (status >= 500) return new HttpError(502, `OpenRouter 或模型方出错（HTTP ${status}）${detail ? '：' + detail : ''}`);
      return new HttpError(status, `OpenRouter 返回 HTTP ${status}${detail ? '：' + detail : ''}`);
  }
}

/** 发一次出图请求；被限流就按 Retry-After 自动等一会儿再试 */
async function requestImages(body, token) {
  for (let attempt = 1; ; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), IMAGE_WAIT_MS);

    let response, text;
    try {
      response = await fetch(`${OPENROUTER_API}/images`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          // 这两个头是可选的，只在 OpenRouter 的排行榜上给你的应用署个名。
          // 注意：HTTP 头只能是 ASCII，这里千万不能写中文——
          // Node 的 fetch 会直接抛 "Cannot convert argument to a ByteString"。
          'HTTP-Referer': `http://localhost:${DEFAULT_PORT}`,
          'X-Title': 'Wu Yufei - Personal Homepage',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      text = await response.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new HttpError(504, '等到 5 分钟还没出图，已经放弃这次请求。可以换个短一点的提示词，或把质量档位调低再试。');
      }
      throw new HttpError(502, '连不上 OpenRouter（网络错误）：' + (err && err.message ? err.message : '未知原因'));
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 不是 JSON 就按状态码报错 */
    }

    if (response.ok) return data;

    if (response.status === 429 && attempt <= MAX_RETRY_ON_429) {
      const wait = Math.min(Number(response.headers.get('retry-after')) || 5, 20);
      console.log(`[文生图] 被限流，等 ${wait} 秒后自动重试（第 ${attempt} 次）…`);
      await sleep(wait * 1000 + 500);
      continue;
    }

    throw describeOpenRouterError(response.status, data, text);
  }
}

async function handleGenerateImage(req, res) {
  const token = process.env.OPENROUTER_API_KEY;
  if (!token) {
    throw new HttpError(
      500,
      '服务端没有读到 OPENROUTER_API_KEY。请在本文件夹的 .env 里填好这个 Key，' +
        '改完记得重启服务（node server.js）。详见 README.md。'
    );
  }

  const raw = await readBody(req, 64 * 1024);
  let payload = null;
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON。');
  }

  const prompt = String((payload && payload.prompt) || '').trim();
  if (!prompt) throw new HttpError(400, '请先写下你想要的画面，再点「生成图片」。');
  if (prompt.length > MAX_PROMPT) {
    throw new HttpError(400, `提示词有 ${prompt.length} 字，超过 ${MAX_PROMPT} 字了，请精简一下。`);
  }

  // 只放行模型认可的值，避免把非法参数甩给上游
  const aspect = ASPECTS.includes(payload.aspect_ratio) ? payload.aspect_ratio : 'auto';
  const quality = QUALITIES.includes(payload.quality) ? payload.quality : 'auto';
  const n = Math.min(MAX_IMAGES, Math.max(1, Math.round(Number(payload.n) || 1)));

  const t0 = Date.now();
  console.log(`[文生图] 提示词 ${prompt.length} 字 · 比例 ${aspect} · 质量 ${quality} · ${n} 张，提交给 OpenRouter…`);

  const data = await requestImages({ model: IMAGE_MODEL, prompt, aspect_ratio: aspect, quality, n }, token);

  const items = data && Array.isArray(data.data) ? data.data : [];
  const images = items
    .map((it) => ({
      b64: it && it.b64_json ? String(it.b64_json) : '',
      mediaType: (it && it.media_type) || 'image/png',
    }))
    .filter((it) => it.b64);

  if (!images.length) throw new HttpError(502, 'OpenRouter 这次没有返回图片，换个说法再试一次。');

  const elapsed = Date.now() - t0;
  const cost = data && data.usage ? Number(data.usage.cost) || 0 : 0;
  console.log(`[文生图] 成功，${images.length} 张，用时 ${(elapsed / 1000).toFixed(1)} 秒，花费 $${cost.toFixed(4)}`);

  sendJson(res, 200, {
    ok: true,
    model: IMAGE_MODEL,
    elapsedMs: elapsed,
    costUsd: cost,
    images,
  });
}

/* ---------------------------------------------------------------------------
 * 6. 路由
 * ------------------------------------------------------------------------- */
const server = http.createServer((req, res) => {
  /* --- 跨域（CORS）---------------------------------------------------
     这一屏的页面可能是从别的地方打开的：编辑器的预览面板、或者直接双击
     index.html（file://）。对浏览器来说这就算「跨域」，需要服务端点头才放行。

     只对「本机页面」点头：localhost / 127.0.0.1 上的任意端口，
     以及 file:// 打开时浏览器给的字符串 "null"。
     外网站点（http://某个陌生网站 之类）一律不点头——否则别人的网页
     也能偷偷调用你本机的这个服务，刷掉你的 Replicate 额度。 */
  const origin = req.headers.origin;
  const allowed = !origin
    ? null
    : origin === 'null'
      ? 'null'
      : /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
        ? origin
        : null;

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    // 带 Content-Type: image/* 的 POST 属于「非简单请求」，浏览器会先发一个 OPTIONS 探路
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* 路径里有奇怪的转义就按原样处理 */
  }

  // 网页加载时用来自查：服务在不在、两个 Key 配好没
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      hasToken: Boolean(process.env.REPLICATE_API_TOKEN),
      model: `${MODEL_OWNER}/${MODEL_NAME}`,
      hasOpenRouterToken: Boolean(process.env.OPENROUTER_API_KEY),
      imageModel: IMAGE_MODEL,
    });
  }

  if (pathname === '/api/remove-bg') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '这个接口只支持 POST。' });
    handleRemoveBg(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err && err.message ? err.message : '服务器内部出错。';
      console.error('[去背景] 失败：', message);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: message });
    });
    return;
  }

  if (pathname === '/api/generate-image') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '这个接口只支持 POST。' });
    handleGenerateImage(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err && err.message ? err.message : '服务器内部出错。';
      console.error('[文生图] 失败：', message);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: message });
    });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  sendJson(res, 405, { error: '不支持的请求方法：' + req.method });
});

/* ---------------------------------------------------------------------------
 * 7. 启动（端口被占用就自动往后找一个）
 * ------------------------------------------------------------------------- */
let port = DEFAULT_PORT;

function banner(p) {
  const hasReplicate = Boolean(process.env.REPLICATE_API_TOKEN);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  console.log('');
  console.log('  ✅ 服务已启动');
  console.log('  🌐 打开网页：  http://localhost:' + p);
  console.log('  🔑 Replicate： ' + (hasReplicate ? '已读取到 REPLICATE_API_TOKEN（第三屏·去背景）' : '⚠️  没读到，去 .env 里填一下'));
  console.log('  🔑 OpenRouter：' + (hasOpenRouter ? `已读取到 OPENROUTER_API_KEY（第四屏·文生图，模型 ${IMAGE_MODEL}）` : '⚠️  没读到，去 .env 里填一下'));
  console.log('  ⏹  停止服务：  按 Control + C');
  console.log('');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < DEFAULT_PORT + 10) {
    console.log(`端口 ${port} 被占用了，换 ${port + 1} 再试…`);
    port += 1;
    setTimeout(() => server.listen(port, HOST), 80);
  } else {
    console.error('启动失败：', err.message);
    process.exit(1);
  }
});

server.on('listening', () => banner(port));

server.listen(port, HOST);
