import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取 API Keys (环境变量优先，其次读取 keys.json)
let fileKeys = {};
try {
  const keysPath = path.join(__dirname, "keys.json");
  if (fs.existsSync(keysPath)) {
    fileKeys = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
  }
} catch (e) {
  console.error("[SmartSearch] 读取 keys.json 失败:", e.message);
}

function getApiKey(name) {
  const envMap = {
    brave: "BRAVE_API_KEY",
    tavily: "TAVILY_API_KEY",
    exa: "EXA_API_KEY",
    firecrawl: "FIRECRAWL_API_KEY",
  };
  const raw = process.env[envMap[name]] || fileKeys[name] || "";
  // keys.example.json 的占位符视为未配置，防止用户复制模板后忘记填写真实 Key
  if (/^YOUR_.*_HERE$/.test(raw)) return "";
  return raw;
}

// ==================== DDG 失败记忆（进程内存） ====================
// 不维护商业引擎跨调用状态：429 无法区分瞬时限流与额度耗尽，按月冷却"让位"属于
// 无依据猜测，会让瞬时限流误伤仍有额度的引擎。商业引擎每次调用独立评估，失败
// 只影响当次调用的顺位补位。DDG 例外：网络不可达是直接观测的事实，失败后 10
// 分钟内免费链路直接走 Bing，省去每次 4.5s 超时等待；仅存内存，重启后重新探测。

const DDG_COOLDOWN_MS = 10 * 60 * 1000;
let ddgCooldownUntil = 0;

// 辅助：HTML 实体反转义
function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ");
}

// ==================== 商业 AI 引擎 (需 API Key) ====================

// 1. Brave 搜索实现
async function searchBrave(query, count = 5) {
  const apiKey = getApiKey("brave");
  if (!apiKey) throw new Error("Brave API Key 未配置");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 10)));

  const res = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Brave HTTP ${res.status}: ${errText.slice(0, 150) || res.statusText}`);
  }

  const data = await res.json();
  const list = (data.web?.results || []).slice(0, count).map((r) => ({
    title: r.title || "无标题",
    url: r.url,
    content: r.description || "",
    published: r.page_age || "",
  }));

  return {
    engine: "Brave Search",
    results: list,
  };
}

// 2. Tavily 搜索实现
async function searchTavily(query, count = 5) {
  const apiKey = getApiKey("tavily");
  if (!apiKey) throw new Error("Tavily API Key 未配置");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: Math.min(count, 5),
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Tavily HTTP ${res.status}: ${errText.slice(0, 150) || res.statusText}`);
  }

  const data = await res.json();
  const list = (data.results || []).slice(0, count).map((r) => ({
    title: r.title || "无标题",
    url: r.url,
    content: r.content || "",
    score: r.score,
  }));

  return {
    engine: "Tavily",
    answer: data.answer || null,
    results: list,
  };
}

// 3. Exa 搜索实现
async function searchExa(query, count = 5) {
  const apiKey = getApiKey("exa");
  if (!apiKey) throw new Error("Exa API Key 未配置");

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: Math.min(count, 5),
      contents: {
        text: { maxCharacters: 1200 },
      },
      type: "auto",
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Exa HTTP ${res.status}: ${errText.slice(0, 150) || res.statusText}`);
  }

  const data = await res.json();
  const list = (data.results || []).slice(0, count).map((r) => ({
    title: r.title || "无标题",
    url: r.url,
    content: r.text || (r.highlights ? r.highlights.join(" ... ") : ""),
    published: r.publishedDate || "",
  }));

  return {
    engine: "Exa.ai",
    results: list,
  };
}

// 4. Firecrawl 搜索实现
async function searchFirecrawl(query, count = 5) {
  const apiKey = getApiKey("firecrawl");
  if (!apiKey) throw new Error("Firecrawl API Key 未配置");

  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      limit: Math.min(count, 10),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Firecrawl HTTP ${res.status}: ${errText.slice(0, 150) || res.statusText}`);
  }

  const data = await res.json();
  const list = (data.data || []).slice(0, count).map((r) => ({
    title: r.title || "无标题",
    url: r.url,
    content: r.description || r.markdown || "",
  }));

  return {
    engine: "Firecrawl",
    results: list,
  };
}

async function callCommercial(engine, query, count) {
  if (engine === "exa") return searchExa(query, count);
  if (engine === "firecrawl") return searchFirecrawl(query, count);
  if (engine === "tavily") return searchTavily(query, count);
  if (engine === "brave") return searchBrave(query, count);
  throw new Error(`未知商业引擎: ${engine}`);
}

// ==================== 免 Key 免费引擎 (终极兜底保障) ====================

// 5. DuckDuckGo (HTML / 免Key，优先尝试)
async function searchDuckDuckGo(query, count = 5) {
  const url = "https://html.duckduckgo.com/html/";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    body: "q=" + encodeURIComponent(query),
    signal: AbortSignal.timeout(4500), // 4.5s 超时，若国内受阻迅速让位给 Bing
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo HTTP ${res.status}`);
  }

  const html = await res.text();
  const items = [];

  const resultBlocks =
    html.match(/<div[^>]*class="[^"]*result[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi) || [];

  for (const block of resultBlocks) {
    if (items.length >= count) break;
    const titleMatch =
      block.match(
        /<h2[^>]*class="[^"]*result__title[^"]*"[\s\S]*?<a[^>]*href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>/i
      ) ||
      block.match(
        /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
      );
    if (!titleMatch) continue;

    let targetUrl = titleMatch[1];
    try {
      const u = new URL(targetUrl, "https://duckduckgo.com");
      const real = u.searchParams.get("uddg");
      if (real) targetUrl = decodeURIComponent(real);
    } catch {}

    const title = decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, "").trim());
    const snippetMatch = block.match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i
    );
    const snippet = decodeHtmlEntities(
      (snippetMatch ? snippetMatch[1] : "").replace(/<[^>]+>/g, "").trim()
    );

    if (title && targetUrl) {
      items.push({
        title,
        url: targetUrl,
        content: snippet,
      });
    }
  }

  if (items.length === 0) {
    throw new Error("DuckDuckGo 未解析到有效结果");
  }

  return {
    engine: "DuckDuckGo (免Key)",
    results: items,
  };
}

// 6. 微软必应 Bing (免Key，国内直连最稳)
async function searchBing(query, count = 5) {
  const url = "https://cn.bing.com/search?q=" + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(6000),
  });

  if (!res.ok) {
    throw new Error(`Bing HTTP ${res.status}`);
  }

  const html = await res.text();
  const items = [];

  const algoBlocks = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi) || [];
  for (const block of algoBlocks) {
    if (items.length >= count) break;
    const titleMatch = block.match(
      /<h2><a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i
    );
    if (!titleMatch) continue;

    const targetUrl = titleMatch[1];
    const title = decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, "").trim());

    let snippet = "";
    const captionMatch = block.match(
      /<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
    );
    if (captionMatch) {
      snippet = captionMatch[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const pMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (pMatch) snippet = pMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    snippet = decodeHtmlEntities(snippet);

    if (title && targetUrl) {
      items.push({
        title,
        url: targetUrl,
        content: snippet,
      });
    }
  }

  if (items.length === 0) {
    throw new Error("Bing 未解析到有效结果");
  }

  return {
    engine: "Bing (免Key)",
    results: items,
  };
}

// ==================== 场景路由：双引擎并发聚合 ====================
// 每场景前两位为并发主力（兼顾专长与月度免费额度池大小：Brave 2000 / Exa ~1000 /
// Tavily 1000 / Firecrawl 500），后两位为顺序补位。

const SCENE_ENGINE_ORDER = {
  // auto 流量最大：两大额度池 Tavily + Brave 承接
  auto: ["tavily", "brave", "exa", "firecrawl"],
  // 技术深度：Exa 神经语义 + Firecrawl 正文提取（Firecrawl 500/月最稀缺，耗尽自动让位）
  tech: ["exa", "firecrawl", "tavily", "brave"],
  // 深度问答：Tavily AI 总结 + Exa 语义召回
  deep_qa: ["tavily", "exa", "firecrawl", "brave"],
  // 时效新闻：Brave 独立索引 + Tavily
  news_realtime: ["brave", "tavily", "firecrawl", "exa"],
};

// auto 模式的轻量意图识别（英文关键词用单词边界匹配，避免 "ts" 命中 "events" 之类误判）
function detectAutoScene(query) {
  const q = query.toLowerCase();
  const techWords = [
    "github", "api", "code", "bug", "error", "exception", "typescript", "javascript",
    "python", "golang", "rust", "npm", "pip", "docker", "k8s", "linux", "function",
    "class", "interface", "protocol", "sdk", "algorithm", "arxiv", "architecture",
    "代码", "报错", "接口", "文档", "算法", "论文", "框架", "函数", "原理", "技术", "教程", "库",
  ];
  const newsWords = [
    "news", "today", "yesterday", "latest", "price", "stock", "weather", "release",
    "新闻", "今天", "最新", "发布", "价格", "汇率", "股票", "天气", "刚刚", "发生", "赛事",
  ];

  const hasTech = techWords.some((k) =>
    /[a-z]/.test(k) ? new RegExp(`\\b${k}\\b`).test(q) : q.includes(k)
  );
  const hasNews = newsWords.some((k) =>
    /[a-z]/.test(k) ? new RegExp(`\\b${k}\\b`).test(q) : q.includes(k)
  );

  if (hasTech && !hasNews) return "tech";
  if (hasNews) return "news_realtime";
  return "deep_qa";
}

// 计算并发主力与顺序补位：未配置 Key 的引擎剔除；显式点名时该引擎排首位
function resolveEngineOrder(sceneOrder, preferred = null) {
  const order = preferred
    ? [preferred, ...sceneOrder.filter((e) => e !== preferred)]
    : sceneOrder;
  const configured = order.filter((e) => getApiKey(e));
  return {
    primaries: configured.slice(0, 2),
    backups: configured.slice(2),
  };
}

// 追踪参数白名单：URL 归一化仅剥离这些参数。query 的其余部分是内容本身（视频页 ?v=
// 承载视频 ID、分页 ?page=），必须保留在去重 key 中——整段丢弃会把不同内容误判为同一结果
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "mc_eid",
];

// URL 归一化（跨引擎去重用）：忽略协议与锚点差异、小写 host、去 www、末尾斜杠与追踪参数，
// 保留其余 query 且与参数顺序无关
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    u.searchParams.sort();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "");
    const search = u.searchParams.toString();
    return `${host}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return String(raw || "");
  }
}

// 重复命中时择优合并：取更长的标题/正文（如 Exa 1200 字全文 vs Brave/Bing 短 snippet）、
// http 升级为 https、补齐缺失字段——SearXNG merge_two_main_results 同款策略
function mergeDuplicate(target, other) {
  if ((other.content || "").length > (target.content || "").length) {
    target.content = other.content;
  }
  if ((other.title || "").length > (target.title || "").length) {
    target.title = other.title;
  }
  if (String(target.url || "").startsWith("http://") && String(other.url || "").startsWith("https://")) {
    target.url = other.url;
  }
  if (!target.published && other.published) target.published = other.published;
  if (target.score === undefined && other.score !== undefined) target.score = other.score;
}

// 并发聚合结果合并：URL 去重（跨引擎择优合并）、双引擎交错排序（两方结果交替呈现，避免一家
// 独占前几名）。先完整建组再截断 count，使靠后位置的重复命中也能并入已展示的结果
function mergeResults(payloads, count) {
  const queues = payloads.map((p) => [...p.results]);
  const byKey = new Map();
  const order = [];

  while (queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      while (queue.length > 0) {
        const item = queue.shift();
        const key = normalizeUrl(item.url) || item.title;
        if (!key) continue;
        const existing = byKey.get(key);
        if (existing) {
          mergeDuplicate(existing, item);
          continue;
        }
        byKey.set(key, { ...item });
        order.push(key);
        break;
      }
    }
  }

  const merged = order.slice(0, count).map((k) => byKey.get(k));

  // 汇总 AI 摘要（目前仅 Tavily 返回 answer）
  const answer = payloads.find((p) => p.answer)?.answer || null;
  return { merged, answer };
}

// ==================== 格式化与容灾执行 ====================

// 统一 Markdown 格式化
function formatResultsMarkdown(data, fallbackNotes = []) {
  let md = `### 🔍 搜索结果 (${data.engine})\n`;
  if (fallbackNotes.length > 0) {
    md += `> ⚠️ **自动降级提示**：\n` + fallbackNotes.map((n) => `> - ${n}`).join("\n") + "\n\n";
  } else if (data.sourcesNote) {
    md += `> ✅ **并发聚合引擎**：${data.sourcesNote}（双引擎同时调用，结果已合并去重）\n\n`;
  } else {
    md += `> ✅ **路由引擎**：${data.engine}\n\n`;
  }

  if (data.answer) {
    md += `**💡 AI 总结摘要**：\n${data.answer}\n\n---\n`;
  }

  if (!data.results || data.results.length === 0) {
    md += `未检索到相关内容。\n`;
    return md;
  }

  data.results.forEach((r, idx) => {
    const safeTitle = String(r.title || "无标题").replace(/[\[\]]/g, "");
    md += `#### ${idx + 1}. [${safeTitle}](${r.url})\n`;
    if (r.published) md += `*发布时间: ${r.published}*\n\n`;
    if (r.content) {
      const clean = r.content.trim().slice(0, 800);
      md += `${clean}${r.content.length > 800 ? "..." : ""}\n\n`;
    }
  });

  return md;
}

// 执行免 Key 容灾搜索 (先 DDG，后 Bing；DDG 失败进入短冷却，冷却期内直接走 Bing 省 4.5s)
async function executeFreeSearch(query, count = 5, inheritedNotes = []) {
  const fallbackNotes = [...inheritedNotes];

  if (Date.now() < ddgCooldownUntil) {
    fallbackNotes.push("DuckDuckGo 近期失败冷却中，直接使用 Bing");
  } else {
    try {
      const res = await searchDuckDuckGo(query, count);
      ddgCooldownUntil = 0;
      return formatResultsMarkdown(res, fallbackNotes);
    } catch (err) {
      console.error("[SmartSearch] DuckDuckGo 免Key搜索失败:", err.message);
      ddgCooldownUntil = Date.now() + DDG_COOLDOWN_MS;
      fallbackNotes.push(`DuckDuckGo 失败（${err.message}），自动切换至备用引擎 Bing`);
    }
  }

  try {
    const res = await searchBing(query, count);
    return formatResultsMarkdown(res, fallbackNotes);
  } catch (err) {
    console.error("[SmartSearch] Bing 免Key搜索失败:", err.message);
    fallbackNotes.push(`Bing 失败（${err.message}）`);
  }

  return `### ❌ 免费容错引擎均调用失败\n\n` + fallbackNotes.map((n) => `- ${n}`).join("\n");
}

// 商业引擎并发聚合执行：
// 1) 场景双主力并发调用（Promise.allSettled），成功引擎合并去重返回；
// 2) 一方失败时不再追加调用（另一方结果已足够，避免过度消耗额度）；
// 3) 双主力全灭才按补位序顺序尝试剩余商业引擎；
// 4) 商业全灭进入免 Key 兜底（先 DDG 后 Bing）。
// 失败不跨调用记忆：每次调用独立评估，瞬时故障不影响下一次的引擎选择。
async function executeCommercialSearch(query, count = 5, sceneOrder, preferred = null) {
  const { primaries, backups } = resolveEngineOrder(sceneOrder, preferred);
  const fallbackNotes = [];
  const succeeded = [];

  if (primaries.length > 0) {
    const settled = await Promise.allSettled(
      primaries.map((engine) => callCommercial(engine, query, count))
    );

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const engine = primaries[i];
      if (r.status === "fulfilled" && r.value.results && r.value.results.length > 0) {
        succeeded.push(r.value);
      } else if (r.status === "rejected") {
        fallbackNotes.push(
          `${engine.toUpperCase()} 失败（${r.reason?.message || r.reason}），已由并发搭档补位`
        );
      } else {
        fallbackNotes.push(`${engine.toUpperCase()} 未召回结果，已由并发搭档补位`);
      }
    }
  }

  if (succeeded.length === 0) {
    for (const engine of backups) {
      try {
        const res = await callCommercial(engine, query, count);
        if (res && res.results && res.results.length > 0) {
          succeeded.push(res);
          break;
        }
        fallbackNotes.push(`${engine.toUpperCase()} 商业引擎未召回结果，顺位切换下一个商业引擎`);
      } catch (err) {
        fallbackNotes.push(`${engine.toUpperCase()} 失败（${err?.message || err}），顺位切换下一个商业引擎`);
      }
    }
  }

  if (succeeded.length > 0) {
    const { merged, answer } = mergeResults(succeeded, count);
    const data = {
      engine: succeeded.map((p) => p.engine).join(" + "),
      sourcesNote: succeeded.map((p) => p.engine).join(" / "),
      answer,
      results: merged,
    };
    return formatResultsMarkdown(data, fallbackNotes);
  }

  fallbackNotes.push("所有商业 API 均不可用，已自动进入免 Key 终极保底链路");
  return executeFreeSearch(query, count, fallbackNotes);
}

// 执行聚合容灾调用（商业双引擎并发聚合 -> 免Key引擎：先 DDG 后 Bing）
async function executeSmartSearch(query, mode = "auto", count = 5) {
  if (mode === "free") {
    return executeFreeSearch(query, count);
  }
  const scene = SCENE_ENGINE_ORDER[mode] ? mode : detectAutoScene(query);
  return executeCommercialSearch(query, count, SCENE_ENGINE_ORDER[scene]);
}

// 创建标准 MCP Server
const server = new Server(
  {
    name: "smart-search",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "smart_search",
        description:
          "智能聚合搜索引擎（推荐主力使用）。按查询场景同时并发调用两个最合适的商业引擎（如技术场景 Exa+Firecrawl、问答 Tavily+Exa、新闻 Brave+Tavily），结果合并去重、交错呈现，充分利用各家月度免费额度与专长；单引擎失败由并发搭档即时补位，商业全灭时自动降级至免Key引擎（先DuckDuckGo，再Bing必应终极保底），永不断联。",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词或自然语言问题",
            },
            mode: {
              type: "string",
              enum: ["auto", "tech", "deep_qa", "news_realtime", "free"],
              description:
                "搜索模式：'auto'(自动智能判断，默认，并发Tavily+Brave)；'tech'(并发Exa+Firecrawl)；'deep_qa'(并发Tavily+Exa)；'news_realtime'(并发Brave+Tavily)；'free'(直接走免费免Key通道，先DDG后Bing)",
            },
            count: {
              type: "number",
              description: "返回结果数量（1-10，默认5）",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "search_free",
        description:
          "完全免 Key 聚合搜索（零成本、无额度限制）。优先使用 DuckDuckGo（失败后带冷却记忆，冷却期直接走 Bing 不再等待超时），自动降级至微软必应 (Bing)，非常适合节省商业 API 配额。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词或问题" },
            count: { type: "number", description: "返回数量（1-10，默认5）" },
          },
          required: ["query"],
        },
      },
      {
        name: "search_bing",
        description:
          "直接使用微软必应 (Bing) 进行网页搜索（完全免 Key、国内极速直连、中英文与代码综合质量极佳）。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词" },
            count: { type: "number", description: "返回数量（1-10，默认5）" },
          },
          required: ["query"],
        },
      },
      {
        name: "search_duckduckgo",
        description:
          "直接使用 DuckDuckGo 进行网页搜索（完全免 Key、注重隐私保护，需网络通畅）。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词" },
            count: { type: "number", description: "返回数量（1-10，默认5）" },
          },
          required: ["query"],
        },
      },
      {
        name: "search_firecrawl",
        description:
          "直接使用 Firecrawl 进行搜索（专为 AI Agent 研发，直接提取清洗后的结构化网页内容）。失败或额度耗尽时自动由其他商业引擎补位，全挂走免 Key。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词或长文本意图" },
            count: { type: "number", description: "返回数量（1-10，默认5）" },
          },
          required: ["query"],
        },
      },
      {
        name: "search_exa",
        description:
          "直接使用 Exa.ai 进行神经语义搜索（专为LLM优化，最擅长高质量技术博客、研报、学术论文与深度资料，过滤垃圾SEO内容）。失败或额度耗尽时自动由其他商业引擎补位，全挂走免 Key。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词或长文本意图" },
            count: { type: "number", description: "返回数量（1-5，默认5）" },
          },
          required: ["query"],
        },
      },
      {
        name: "search_tavily",
        description:
          "直接使用 Tavily 进行搜索（自带高质量 AI 总结与网页核心正文摘要提取，适合问答与综合分析）。失败或额度耗尽时自动由其他商业引擎补位，全挂走免 Key。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词或问题" },
            count: { type: "number", description: "返回数量（1-5，默认5）" },
          },
          required: ["query"],
        },
      },
      {
        name: "search_brave",
        description:
          "直接使用 Brave Search 进行全网关键词搜索（独立索引，擅长最新新闻、时效性信息、特定实体查询）。失败或额度耗尽时自动由其他商业引擎补位，全挂走免 Key。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词" },
            count: { type: "number", description: "返回数量（1-10，默认5）" },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const query = args.query;
  const count = Math.max(1, Math.min(Number(args.count) || 5, 10));

  if (!query) {
    return {
      content: [{ type: "text", text: "错误: query 参数不能为空" }],
      isError: true,
    };
  }

  try {
    if (name === "smart_search") {
      const mode = args.mode || "auto";
      const text = await executeSmartSearch(query, mode, count);
      return { content: [{ type: "text", text }] };
    }

    if (name === "search_free") {
      const text = await executeFreeSearch(query, count);
      return { content: [{ type: "text", text }] };
    }

    if (name === "search_bing") {
      const data = await searchBing(query, count);
      const text = formatResultsMarkdown(data);
      return { content: [{ type: "text", text }] };
    }

    if (name === "search_duckduckgo") {
      const data = await searchDuckDuckGo(query, count);
      const text = formatResultsMarkdown(data);
      return { content: [{ type: "text", text }] };
    }

    // 单引擎直连工具：指定引擎首发，其余商业引擎顺序补位
    const singleEngineTools = {
      search_firecrawl: "firecrawl",
      search_exa: "exa",
      search_tavily: "tavily",
      search_brave: "brave",
    };
    if (singleEngineTools[name]) {
      const text = await executeCommercialSearch(
        query,
        count,
        SCENE_ENGINE_ORDER.auto,
        singleEngineTools[name]
      );
      return { content: [{ type: "text", text }] };
    }

    throw new Error(`未知的工具: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `搜索发生异常: ${err.message}` }],
      isError: true,
    };
  }
});

// 启动 stdio 传输
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[SmartSearch] MCP Server 已启动并监听 stdio (商业双引擎并发聚合 + DDG/Bing 保底)");
}

main().catch((err) => {
  console.error("[SmartSearch] 启动崩溃:", err);
  process.exit(1);
});
