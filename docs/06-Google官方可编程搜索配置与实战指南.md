# 06. Google 官方可编程搜索 (Custom Search JSON API) 配置与实战指南

## 一、 效果真实评测（优势与局限）

### 1. 核心优势（为什么它是商业天花板）
- **全球最大索引库与冷门召回**：对于 GitHub 最新开源库、生僻报错信息、Stack Overflow 长尾提问、学术论文，Google 的全网收录广度和召回准确度是任何小众 AI 搜索引擎都无法比拟的；
- **官方通道零风控**：直接走 Google 官方云端基础设施，没有任何“封 IP、弹滑块验证码、被 Cloudflare 拦截”的风险；
- **免费配额极大**：Google 每天固定赠送 **100 次免费查询**（北京时间每日下午自动刷新，相当于**每月 3,000 次**），对个人开发和 AI 助手来说极为充沛。

### 2. 客观局限
- **返回形式偏传统**：它返回的是标准的 SERP 列表（标题、链接、200字左右的文本 Snippet），不像 Tavily 那样自带“AI 总结摘要”，也不像 Firecrawl/Jina 直接吐出整篇 Markdown 正文；
- **网络环境要求**：国内环境调用 `googleapis.com` 需要本机处于通畅的网络或具备代理配置。

---

## 二、 保姆级配置步骤（只需两个核心参数：`API Key` 和 `CX`）

### 第一步：获取搜索引擎 ID (`cx`)
1. 打开 Google 可编程搜索引擎控制台：  
   👉 [https://programmablesearchengine.google.com/controlpanel/all](https://programmablesearchengine.google.com/controlpanel/all)
2. 点击 **“添加”** (Add) 按钮创建新引擎；
3. **关键设置**：
   - 搜索引擎名称：随意填写（例如 `AI-Global-Search`）；
   - **要搜索的内容**：勾选 **“在整个网络中搜索” (Search the entire web)**；
4. 点击“创建”后进入该引擎的 **“概览” (Overview)** 页面；
5. 复制 **“搜索引擎 ID”**（即 `cx`，一串形如 `数字:字母下划线` 的长串，例如 `01757666...:omuauf_xxxxxx`）。

---

### 第二步：获取 Google API Key
1. 打开 Google Cloud Console（谷歌云控制台）：  
   👉 [https://console.cloud.google.com/](https://console.cloud.google.com/)
2. 在顶部新建或选择一个项目；
3. 进入 API 库，搜索并启用 **“Custom Search API”**：  
   👉 直达链接：[https://console.cloud.google.com/apis/library/customsearch.googleapis.com](https://console.cloud.google.com/apis/library/customsearch.googleapis.com) ➔ 点击 **“启用” (Enable)**；
4. 进入 **“API 和服务” ➔ “凭据”** 页面：  
   👉 直达链接：[https://console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
5. 点击顶部的 **“+ 创建凭据” ➔ 选择 “API 密钥” (API Key)**；
6. 复制生成的密钥（形如 `AIzaSy...`）。

---

## 三、 测试与验证方法

拿到 `apiKey` 和 `cx` 后，通过标准 GET 请求即可测试：

```bash
# 格式：https://www.googleapis.com/customsearch/v1?key=YOUR_API_KEY&cx=YOUR_CX&q=搜索词&num=5
curl "https://www.googleapis.com/customsearch/v1?key=YOUR_API_KEY&cx=YOUR_CX&q=Nodejs+fetch&num=3"
```

### 返回 JSON 结构示例：
```json
{
  "items": [
    {
      "title": "Node.js Web API - MDN Web Docs",
      "link": "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      "snippet": "The Fetch API provides a JavaScript interface for accessing and manipulating parts of the protocol..."
    }
  ]
}
```

---

## 四、 后续无缝接入 `smart-search` 方案

在我们的 `keys.json` 中增加：
```json
{
  "google": {
    "key": "YOUR_GOOGLE_API_KEY",
    "cx": "YOUR_SEARCH_ENGINE_ID"
  }
}
```
并在 `index.js` 中引入一个 `searchGoogle(query, count)` 函数，将其作为高质量通用/技术检索的并列商业引擎。
