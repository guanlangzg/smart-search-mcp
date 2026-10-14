# Smart Search MCP (聚合智能搜索引擎)

基于 Model Context Protocol (MCP) 构建的智能路由、双引擎并发聚合与多级容灾搜索引擎服务。专为大语言模型（LLM）对话与编码助手定制。

> 要求 Node.js ≥ 18（推荐 20+）。唯一运行时依赖为 MCP SDK。

## ⚡ 快速开始

```bash
# 1. 安装依赖（仅需 @modelcontextprotocol/sdk）
npm install

# 2. 配置密钥（可选，详见下方"API Key 配置"；不配置则走免费兜底链路）
cp keys.example.json keys.json   # Windows: copy keys.example.json keys.json

# 3. 离线自检（零网络、零额度消耗）
node scripts/test/verify.mjs offline

# 4. 在 MCP 客户端注册（把路径换成你的实际绝对路径）
#    { "mcpServers": { "smart-search": { "command": "node", "args": ["<本仓库路径>/index.js"] } } }

# 5. 完成——LLM 即可调用 smart_search 等 8 个工具
```

想参与开发？请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 🌟 核心特性与架构设计

### 1. 场景双引擎并发聚合（额度充分利用）

商业引擎各有专长、各带**每月自动刷新的免费额度**（Brave 2000 次 / Tavily 1000 次 / Exa ~1000 次 / Firecrawl 500 credits）。本服务不再顺序消耗单一引擎，而是**按场景同时并发调用两个最合适的引擎**，结果合并去重、交错呈现：

| 场景 | 并发双主力 | 理由 |
| :--- | :--- | :--- |
| `auto`（默认） | Tavily + Brave | 流量最大，用两个最大的额度池承接 |
| `tech` | Exa + Firecrawl | 神经语义检索 + 落地页正文清洗 |
| `deep_qa` | Tavily + Exa | AI 总结摘要 + 语义召回 |
| `news_realtime` | Brave + Tavily | 独立索引时效 + 结构化摘要 |

**即时容错**：单方失败由并发搭档天然补位（结果已足够，不追加消耗）；双主力全灭才按场景顺位尝试其余商业引擎。失败不跨调用记忆——每次调用独立评估，不基于 429 猜测引擎的额度状态。

### 2. 两梯队"永不断联"容灾链路

```
                    ┌────────────────────────┐
                    │ smart_search(query)    │
                    └───────────┬────────────┘
                                ▼
                   【场景意图识别 / mode 指定】
                                ▼
  ┌───────────────────────────────────────────────────────────┐
  │ 梯队一：商业引擎双主力并发聚合 (Promise.allSettled)        │
  │                                                           │
  │  Exa + Firecrawl  /  Tavily + Brave  /  ...               │
  │  ├─ 双方成功 → 合并去重、交错排序返回                      │
  │  ├─ 单方失败 → 并发搭档结果已足够，不追加消耗              │
  │  └─ 双方全灭 → 按场景顺位尝试剩余商业引擎                  │
  └─────────────────────────────┬─────────────────────────────┘
                                │ (仅当所有商业引擎均不可用时)
                                ▼
  ┌───────────────────────────────────────────────────────────┐
  │ 梯队二：免 Key 免费引擎终极兜底防线                        │
  │                                                           │
  │  1. DuckDuckGo (HTML / 4.5s 极速超时，失败后冷却记忆)      │
  │          │                                                │
  │          ▼ (国内阻断或超时，冷却期直接跳过免等待)           │
  │  2. 微软必应 Bing (免 Key，国内毫秒级直连，真实落地页)     │
  └───────────────────────────────────────────────────────────┘
```

---

## 🛠️ 注册工具清单 (8 个可用工具)

| 工具名称 | 类型 | 适用场景与容灾机制 |
| :--- | :--- | :--- |
| **`smart_search`** | 综合聚合（**主力推荐**） | 场景双引擎并发聚合（合并去重、择优合并）；单方失败由搭档即时补位；商业全挂时自动降级至免 Key 兜底。 |
| **`search_free`** | 纯免费通道 | 完全不消耗商业额度，强制执行「DuckDuckGo ➔ Bing」链路，DDG 失败带冷却记忆。 |
| **`search_bing`** | 免 Key 单引擎 | 直接请求微软必应网页抓取，国内毫秒级直连。 |
| **`search_duckduckgo`** | 免 Key 单引擎 | 直接请求 DuckDuckGo HTML 搜索，隐私无痕。 |
| **`search_firecrawl`** | 商业直连 | 指定 Firecrawl 首发，失败/额度耗尽自动由其他商业引擎并发补位，全挂走免 Key。 |
| **`search_exa`** | 商业直连 | 指定 Exa 首发，其余同上。 |
| **`search_tavily`** | 商业直连 | 指定 Tavily 首发，其余同上。 |
| **`search_brave`** | 商业直连 | 指定 Brave 首发，其余同上。 |

---

## 📁 目录文件结构

```
smart-search-mcp/
├── index.js               # MCP Server 主入口（场景路由、并发聚合、容灾控制）
├── keys.example.json      # API 密钥配置模板（复制为 keys.json 使用，真实密钥不入库）
├── .env.example           # 环境变量键名模板（复制/参考用，本服务不自动加载 .env）
├── package.json           # 项目元数据与依赖（唯一运行时依赖：MCP SDK）
├── scripts/test/verify.mjs  # 可重复执行的验证脚本（离线单元 / 免Key实连 / 商业冒烟）
├── docs/                  # 架构与调研文档（02 容灾设计、04 已否决方向、05 额度横评等）
├── CONTRIBUTING.md        # 贡献指南：环境、测试、架构红线、安全要求
├── LICENSE                # MIT
└── README.md
```

---

## 🔑 API Key 配置（自带密钥用户请先读）

真实 Key **绝不提交到仓库**。两种方式任选，环境变量优先：

**方式一：`keys.json`（已被 `.gitignore` 忽略）**

```bash
cp keys.example.json keys.json   # Windows 下: copy keys.example.json keys.json
# 编辑 keys.json，填入真实值（占位符 YOUR_XXX_API_KEY_HERE 会被程序视为未配置）
```

```json
{
  "exa": "你的Exa密钥",
  "tavily": "你的Tavily密钥",
  "brave": "你的Brave密钥",
  "firecrawl": "你的Firecrawl密钥"
}
```

**方式二：环境变量**（适合 MCP 客户端配置或部署场景）

键名见 [`.env.example`](.env.example)（`EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY` / `FIRECRAWL_API_KEY`）。

> 注意：本服务**不自动加载 `.env` 文件**。请在 MCP 客户端配置的 `"env"` 字段中注入，或在启动 `index.js` 的 shell 中导出这些变量。`keys.json` 方式则无需环境变量。

**Key 格式速查**（用于自查是否粘贴错了字段，均为前缀识别，非完整格式）：

| 厂商 | 获取入口 | Key 形态 |
| :--- | :--- | :--- |
| Exa | dashboard.exa.ai | 新版 `exa-` 前缀，旧版为 36 位串 |
| Tavily | app.tavily.com | `tvly-...` |
| Brave | api.search.brave.com | `BSA...` |
| Firecrawl | firecrawl.dev/app/api-keys | `fc-...` |

缺 Key 的引擎不会报错：未配置的引擎自动从并发池剔除；全部未配置时 `smart_search` 等价于免费链路，依然可用。

---

## 🚀 安装与测试

### 安装依赖

```bash
npm install          # 唯一运行时依赖 @modelcontextprotocol/sdk
```

### 验证脚本

```bash
node scripts/test/verify.mjs            # 全部：离线单元 + 免Key实连 + 商业冒烟（耗 2 次额度）
node scripts/test/verify.mjs offline    # 仅离线单元（零网络请求）
node scripts/test/verify.mjs free       # 仅免Key链路实连（零额度消耗）
node scripts/test/verify.mjs commercial # 仅商业并发聚合冒烟（耗 2 次额度）
```

### MCP 客户端配置示例

将 `<项目绝对路径>` 替换为本仓库所在目录（Windows 路径注意 JSON 转义 `\\`）：

```json
{
  "mcpServers": {
    "smart-search": {
      "command": "node",
      "args": ["<项目绝对路径>/index.js"]
    }
  }
}
```

---

## 💡 后续优化方向建议

1. **结果缓存机制**：对相同 query 在 10~30 分钟内读内存 LRU 缓存，进一步节约额度。
2. **正文深挖（URL Fetch）**：对前 1~2 个高质量 URL 用 Readability 提取正文，丰富上下文。
3. **并发竞速（Race）**：商业引擎 3 秒未返回时后台预热 Bing 抓取，消除长尾延迟。

## 📄 License

[MIT](LICENSE)
