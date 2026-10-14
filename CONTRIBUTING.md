# 贡献指南

感谢你对 smart-search-mcp 的兴趣！本文档说明开发环境、测试流程与必须遵守的架构约定。

## 项目设计哲学（先读这里）

本服务不是"随便拼几个搜索 API"的示例，而是围绕一个资源模型构建的：**4 个商业引擎是各带月度免费额度、各有专长的资源池；免费引擎（DDG/Bing）只是保险丝**。任何 PR 都应服务于这个前提，详见 [`docs/02-架构演进与容灾设计.md`](docs/02-架构演进与容灾设计.md)。

## 环境准备

- Node.js ≥ 18（推荐 20+，使用原生 `fetch` 与 `AbortSignal.timeout`）
- 依赖仅 `@modelcontextprotocol/sdk`：

```bash
git clone https://github.com/<your-fork>/smart-search-mcp.git
cd smart-search-mcp
npm install
```

- 配置密钥（可选，见 README「API Key 配置」章节；无 Key 也能跑测试与免费链路）

## 测试

```bash
node scripts/test/verify.mjs offline     # 离线单元：零网络、零额度消耗（npm test 同此命令）
node scripts/test/verify.mjs free        # 免Key链路实连（DDG/Bing，零额度消耗）
node scripts/test/verify.mjs commercial  # 商业双引擎端到端冒烟（消耗 2 次额度）
```

要求：

1. **改动 `index.js` 后至少跑通 `offline`**；
2. 改动引擎实现或容灾逻辑后加跑 `free`；
3. `commercial` 会消耗真实额度，本地验证后由维护者在 CI 或 review 阶段确认即可；
4. 新增核心逻辑请在 `scripts/test/verify.mjs` 补充离线断言——**单元测试禁止依赖网络**（源码文本断言 + 纯函数抽离执行是本项目既有模式）。

## 代码风格与约束

- **单文件架构**：核心逻辑集中在 `index.js`，不引入构建工具、TypeScript 或额外运行时框架；
- 保持零外部依赖（除 MCP SDK）——可选增强（如缓存、正文提取）需论证必要性；
- 注释与标识符跟随现有风格（中文注释用于业务逻辑说明）；
- stdout 是 MCP 协议通道，**任何日志/调试输出必须走 `console.error`**。

## 架构红线（PR 大概率被拒的方向）

| 红线 | 原因 |
| :--- | :--- |
| 基于 429 做引擎"额度冷却/让位"状态机 | 429 无法区分瞬时限流与额度耗尽，属无依据猜测；曾实现后被整体移除。并发双引擎下搭档天然补位，无需状态记忆 |
| 提前降级到免费引擎（仍有可用商业引擎时） | 违背"商业优先、免费保险丝"定位 |
| 丢弃 URL 内容 query 的去重键 | 会把 `youtube.com/watch?v=...` 等不同内容误判为同一条（已有回归用例守护） |
| 共识 frequency 打分 / 标题模糊去重 / 本地语义重排 | 双引擎并发下无区分度 / 误伤风险 / 违背零依赖约定，调研结论见 `docs/04` |
| 真实密钥、个人路径、环境专属配置进入任何将提交的文本 | 见下方安全要求 |

## 安全要求

- 真实密钥只写入 `keys.json` 或环境变量，两者均被 `.gitignore` 覆盖；示例文件（`keys.example.json`、`.env.example`、文档）只允许 `YOUR_*` 式占位符；
- 提交前自查：搜索 `tvly-`、`BSA`、`fc-`、`exa-`、`AIza` 等前缀后跟 20+ 位随机串的内容；
- 发现密钥泄露请**立即在对应控制台吊销**并开 issue 标记，不要仅在 PR 中删除（git 历史仍会保留）。

## 提交规范

- 使用 Conventional Commits（`feat:` / `fix:` / `docs:` / `test:` / `refactor:`）；
- 一个 PR 聚焦一件事；行为变更须附 `offline`/`free` 测试结果说明；
- 分支名建议 `feat/<topic>`、`fix/<topic>`。

## 文档

`docs/` 按编号组织：需求调研（01）、架构与容灾（02）、实现避坑（03）、已否决方向（04）、额度横评（05）、扩展指南（06）。设计类 PR 请先在 issue 中讨论，达成一致后再提交，避免重复论证已有结论。
