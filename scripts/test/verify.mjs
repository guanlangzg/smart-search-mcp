// smart-search-mcp 验证脚本（可重复执行）：
//   node scripts/test/verify.mjs           # 全部：离线单元 + 免Key实连 + 商业聚合冒烟
//   node scripts/test/verify.mjs offline    # 仅离线单元（不发出任何网络请求）
//   node scripts/test/verify.mjs free       # 仅免Key链路实连（DDG/Bing，不耗商业额度）
//   node scripts/test/verify.mjs commercial # 仅一次商业双引擎并发聚合冒烟（耗 2 次额度）
// 说明：测试通过子进程 import index.js 会启动 MCP stdio 监听，故离线用例直接
// 以源码文本断言关键逻辑；实连用例镜像线上实现进行真实 HTTP 验证。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SOURCE = readFileSync(path.join(ROOT, "index.js"), "utf-8");

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `  →  ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------- 1. 离线单元：源码结构断言 ----------
function testOffline() {
  section("离线单元：并发聚合结构");

  check("smart_search 使用双引擎并发 (Promise.allSettled)", /Promise\.allSettled\(/.test(SOURCE));

  check(
    "商业引擎并发主力为 2 个",
    /primaries:\s*configured\.slice\(0,\s*2\)/.test(SOURCE)
  );

  check("去重逻辑存在 (normalizeUrl)", /function normalizeUrl/.test(SOURCE));
  check("交错合并逻辑存在 (mergeResults)", /function mergeResults/.test(SOURCE));

  check("双主力之后存在顺序补位序", /backups/.test(SOURCE));

  check("auto 场景双主力 = Tavily + Brave", /auto:\s*\["tavily",\s*"brave"/.test(SOURCE));
  check("tech 场景双主力 = Exa + Firecrawl", /tech:\s*\["exa",\s*"firecrawl"/.test(SOURCE));
  check(
    "deep_qa 场景双主力 = Tavily + Exa",
    /deep_qa:\s*\["tavily",\s*"exa"/.test(SOURCE)
  );
  check(
    "news_realtime 场景双主力 = Brave + Tavily",
    /news_realtime:\s*\["brave",\s*"tavily"/.test(SOURCE)
  );

  check("英文关键词单词边界匹配 (\\b)", SOURCE.includes("\\\\b${k}\\\\b"));

  check("单引擎直连工具复用并发容灾 (singleEngineTools)", /singleEngineTools/.test(SOURCE));

  check("DDG 失败冷却记忆（免 4.5s 重复等待）", /ddgCooldownUntil/.test(SOURCE));
  check("商业引擎无跨调用冷却（无 engine-state 落盘）", !/engine-state\.json/.test(SOURCE));

  check("count 参数已做 1-10 裁剪", /Math\.max\(1,\s*Math\.min\(Number\(args\.count\)/.test(SOURCE));

  check("示例 Key 占位符视为未配置", /YOUR_.*_HERE/.test(SOURCE) && /getApiKey/.test(SOURCE));

  // 关键行为单元测试：通过临时改写源码抽离纯函数并执行
  section("离线单元：纯函数行为");

  const fnBody = (name) => {
    const m = SOURCE.match(new RegExp(`function ${name}\\(([\\s\\S]*?)\\n\\}`, ""));
    return m ? m[0] : null;
  };
  // normalizeUrl 依赖的常量表（与函数体一起注入执行环境）
  const trackingConstSrc = (SOURCE.match(/const TRACKING_PARAMS = \[[\s\S]*?\];/) || [""])[0];

  // normalizeUrl 行为
  const normalizeUrlSrc = fnBody("normalizeUrl");
  if (normalizeUrlSrc && trackingConstSrc) {
    const normalizeUrl = new Function(`${trackingConstSrc}\n${normalizeUrlSrc}; return normalizeUrl;`)();
    check(
      "normalizeUrl: 协议/末尾斜杠/www 归一",
      normalizeUrl("https://www.example.com/a/") === normalizeUrl("http://example.com/a") &&
        normalizeUrl("https://example.com/a#frag") === normalizeUrl("https://example.com/a"),
      `got: ${normalizeUrl("https://www.example.com/a/")} vs ${normalizeUrl("http://example.com/a")}`
    );
    check(
      "normalizeUrl: 非法输入返回原字符串",
      normalizeUrl("not a url") === "not a url"
    );
    check(
      "normalizeUrl: 剥离 utm/fbclid 等追踪参数",
      normalizeUrl("https://example.com/a?utm_source=x&fbclid=y") ===
        normalizeUrl("https://example.com/a"),
      normalizeUrl("https://example.com/a?utm_source=x&fbclid=y")
    );
    check(
      "normalizeUrl: 保留内容 query 且与参数顺序无关",
      normalizeUrl("https://youtube.com/watch?v=abc123") ===
        normalizeUrl("https://www.youtube.com/watch?v=abc123") &&
        normalizeUrl("https://e.com/p?b=2&a=1") === normalizeUrl("https://e.com/p?a=1&b=2") &&
        normalizeUrl("https://youtube.com/watch?v=abc123") !==
        normalizeUrl("https://youtube.com/watch?v=xyz789"),
      "视频 ID 或参数顺序处理错误"
    );
  } else {
    check("normalizeUrl 函数与其依赖存在于源码", false);
  }

  // mergeResults 行为（连同依赖 normalizeUrl / mergeDuplicate / TRACKING_PARAMS 一起抽离执行）
  const mergeResultsSrc = fnBody("mergeResults");
  const mergeDuplicateSrc = fnBody("mergeDuplicate");
  if (mergeResultsSrc && normalizeUrlSrc && mergeDuplicateSrc && trackingConstSrc) {
    const mergeResults = new Function(
      `${trackingConstSrc}\n${normalizeUrlSrc}\n${mergeDuplicateSrc}\n${mergeResultsSrc}; return mergeResults;`
    )();
    const pA = {
      engine: "A",
      results: [
        { title: "a1", url: "https://x.com/1", content: "短摘要" },
        { title: "a2", url: "https://x.com/2", content: "c2" },
      ],
    };
    const pB = {
      engine: "B",
      results: [
        { title: "dup-title-longer", url: "https://x.com/1?utm_source=b", content: "更长的正文内容正文内容" }, // 归一后与 a1 同一条
        { title: "b2", url: "https://x.com/3", content: "c3" },
      ],
      answer: "AI 摘要",
    };
    const { merged, answer } = mergeResults([pA, pB], 5);
    check(
      "mergeResults: 跨引擎 URL 去重（追踪参数不影响）",
      merged.filter((r) => r.url === "https://x.com/1").length === 1,
      JSON.stringify(merged.map((r) => r.url))
    );
    const dup = merged.find((r) => r.url === "https://x.com/1");
    check(
      "mergeResults: 重复命中择优合并长正文/长标题",
      dup.content === "更长的正文内容正文内容" && dup.title === "dup-title-longer",
      JSON.stringify(dup)
    );
    check(
      "mergeResults: 交错排序（A1,B2,A2 交替而非 A1,A2,B2）",
      merged[0].url === "https://x.com/1" &&
        merged[1].url === "https://x.com/3" &&
        merged[2].url === "https://x.com/2",
      JSON.stringify(merged.map((r) => r.url))
    );
    check("mergeResults: 汇总 AI answer", answer === "AI 摘要");
    check(
      "mergeResults: count 截断",
      mergeResults([pA, pB], 2).merged.length === 2
    );
    check(
      "mergeResults: 不同内容 query 不误伤（两个视频都在）",
      mergeResults(
        [{ engine: "A", results: [{ title: "v1", url: "https://youtube.com/watch?v=aaa", content: "1" }] }],
        5
      ) && (() => {
        const r = mergeResults([
          { engine: "A", results: [{ title: "v1", url: "https://youtube.com/watch?v=aaa", content: "1" }] },
          { engine: "B", results: [{ title: "v2", url: "https://youtube.com/watch?v=bbb", content: "2" }] },
        ], 5);
        return r.merged.length === 2;
      })(),
      "不同 ?v= 的视频被误判为同一条"
    );
  } else {
    check("mergeResults 函数及其依赖存在于源码", false);
  }

  // detectAutoScene 行为
  const detectSrc = fnBody("detectAutoScene");
  if (detectSrc) {
    const detectAutoScene = new Function(`${detectSrc}; return detectAutoScene;`)();
    check(
      "detectAutoScene: 'olympics 2028 events' 不再误判为 tech",
      detectAutoScene("olympics 2028 events") === "deep_qa",
      `got: ${detectAutoScene("olympics 2028 events")}`
    );
    check(
      "detectAutoScene: 'docker 容器网络模式' 识别为 tech",
      detectAutoScene("docker 容器网络模式") === "tech"
    );
    check(
      "detectAutoScene: 'python 蟇的品种' 识别为 tech (python 单词命中)",
      detectAutoScene("python 蛇的品种") === "tech"
    );
    check(
      "detectAutoScene: '今天天气' 识别为 news",
      detectAutoScene("今天天气怎么样") === "news_realtime"
    );
    check(
      "detectAutoScene: 'typescript 泛型' 识别为 tech",
      detectAutoScene("typescript 泛型教程") === "tech"
    );
  } else {
    check("detectAutoScene 函数存在于源码", false);
  }
}

// ---------- 2. 免Key链路实连 ----------
async function testFree() {
  section("免Key引擎实连（DDG / Bing）");

  const t1 = Date.now();
  const bing = await fetch("https://cn.bing.com/search?q=" + encodeURIComponent("Node.js 事件循环"), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => r.text())
    .catch(() => null);
  check(
    "Bing 抓取可达且 b_algo 结构可解析",
    Boolean(bing && /class="[^"]*b_algo[^"]*"/.test(bing)),
    bing ? "页面返回但未匹配到 b_algo" : "网络请求失败"
  );
  console.log(`  (Bing 耗时 ${Date.now() - t1}ms)`);

  // DDG 仅验证可达性，不要求解析成功（国内网络普遍不通，属预期降级路径）
  const t2 = Date.now();
  const ddg = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    body: "q=test",
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => r.status)
    .catch(() => null);
  if (ddg === 200) {
    console.log(`  (DDG 可达 ${Date.now() - t2}ms，解析质量取决于页面结构)`);
  } else {
    console.log(`  (DDG 不可达/超时 ${Date.now() - t2}ms —— 国内网络预期行为，降级路径已由冷却记忆覆盖)`);
  }
}

// ---------- 3. 商业聚合冒烟 ----------
async function testCommercial() {
  section("商业双引擎并发聚合冒烟（消耗 2 次额度）");

  // 直接以 MCP stdio 客户端方式调用 smart_search，验证端到端行为
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "index.js")],
  });
  const client = new Client({ name: "verify-client", version: "1.0.0" });

  try {
    await client.connect(transport);
    const res = await client.callTool({
      name: "smart_search",
      arguments: { query: "MCP protocol tutorial", mode: "tech", count: 4 },
    });
    const text = res.content?.[0]?.text || "";
    check("smart_search 端到端返回文本", text.length > 0);
    check(
      "返回并发聚合标识（双引擎 + 去重说明）或降级链路说明",
      /并发聚合引擎|自动降级提示|DuckDuckGo|Bing/.test(text),
      text.slice(0, 200)
    );
    check(
      "结果含 Markdown 链接条目",
      /####\s+\d+\.\s*\[.*\]\(https?:\/\//.test(text),
      text.slice(0, 300)
    );
    console.log("\n  ---- smart_search 输出预览（前 600 字）----");
    console.log("  " + text.slice(0, 600).replace(/\n/g, "\n  "));
    console.log("  ------------------------------------------");
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------- 入口 ----------
const which = process.argv[2] || "all";

if (which === "offline" || which === "all") await testOffline();
if (which === "free" || which === "all") await testFree();
if (which === "commercial" || which === "all") await testCommercial();

console.log(`\n========== 结果: ${passed} passed, ${failed} failed ==========`);
process.exit(failed > 0 ? 1 : 0);
