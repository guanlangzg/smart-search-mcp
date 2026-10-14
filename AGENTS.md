# smart-search-mcp 项目约定

面向 AI 编码助手与人类贡献者的项目级规范。人类贡献的完整流程见 `CONTRIBUTING.md`。

## 项目定位

MCP (Model Context Protocol) 搜索聚合服务器，单文件实现（`index.js`），零外部运行时依赖（仅 MCP SDK）。修改时保持单文件架构，不为单次需求引入框架。

## 核心架构约定

- **商业引擎 = 资源池，非顺序队列**：4 个商业引擎（exa / firecrawl / tavily / brave）各带月度免费额度、各有专长。`smart_search` 按场景**双引擎并发**调用（`SCENE_ENGINE_ORDER` 前两位），结果在 `mergeResults` 合并去重、交错排序。修改场景配对时须同步 `docs/05` 中的额度横评依据。
- **合并去重策略**：`normalizeUrl` 仅剥离追踪参数白名单（utm/fbclid/gclid 等）、去协议/www/末尾斜杠/锚点、query 参数排序——**内容 query（如 `?v=`）必须保留在去重 key 中**，否则误伤不同结果。重复命中走 `mergeDuplicate` 择优合并（取更长 content/title、http→https），非整条丢弃。排序用引擎交错轮询（双引擎下"每引擎都有露出"已足够，不做共识 frequency 打分）。
- **失败不跨调用记忆（勿引入额度状态机）**：429 无法区分瞬时限流与额度耗尽，据此做整月冷却/让位是无依据猜测，会误伤仍有额度的引擎；并发架构下该机制属多余（搭档已天然补位）。曾实现过该方案后整体移除——不要以任何形式（落盘/内存/按月）重新引入。
- **单引擎直连工具**（`search_exa` 等）复用 `executeCommercialSearch`，以 `preferred` 参数指定首发，其余商业引擎并发/顺位补位。
- **免费引擎仅为兜底**：商业全灭才走 DDG → Bing。任何"提前降级到免费"的改动都违背设计初衷。`duckduckgo` 失败后在进程内存中冷却 10 分钟（直接观测的网络不可达事实，非猜测），冷却期内免费链路直接走 Bing 省 4.5s 超时。
- **auto 路由关键词**：英文词必须单词边界匹配（`\b`），否则短词（如 `ts`）会误命中 `events` 等无关词。

## 验证命令

```bash
node scripts/test/verify.mjs offline     # 零网络，结构+纯函数断言（npm test）
node scripts/test/verify.mjs free        # 免Key实连，零额度消耗
node scripts/test/verify.mjs commercial  # 商业并发冒烟（耗 2 次额度，MCP stdio 客户端端到端）
```

改动 `index.js` 后至少跑 `offline`；改动引擎实现或容灾逻辑后加跑 `free`。新增核心逻辑应在 `scripts/test/verify.mjs` 补离线断言（禁止依赖网络的单元测试）。

## 安全约束

- `keys.json`、`.env`、`memory.md`（维护者本地笔记）均已入 `.gitignore`。凭据绝不提交、绝不在日志回显；提交到仓库的示例文件（`keys.example.json`、`.env.example`、文档内示例）只允许 `YOUR_*` 式占位符。
- DDG/Bing 为 HTML 正则解析，依赖页面 class 结构（`result__title` / `b_algo`），搜索引擎改版需同步修正解析正则。

## 权威文档

设计决策与容灾架构以 `docs/02` 为准；已评估否决的方向及理由见 `docs/04`。
