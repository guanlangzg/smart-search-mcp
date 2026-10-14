// 开源安全自查脚本（零机密容忍）：扫描工作树 + git 历史，检测凭据/隐私泄露。
// 用法：
//   node scripts/security-audit.mjs          # 扫描工作树 + 全部历史 blob
//   node scripts/security-audit.mjs worktree # 仅工作树（含未跟踪但未忽略文件）
//   node scripts/security-audit.mjs history  # 仅 git 历史 blob
// 原则：命中值仅脱敏显示（前缀 + 长度），绝不全量回显。发现泄露请先吊销密钥再清理历史。
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "all";

const RULES = [
  ["PRIVATE_KEY", /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/],
  ["AWS_ACCESS_KEY", /\bAKIA[0-9A-Z]{16}\b/],
  ["GITHUB_TOKEN", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["SLACK", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b|hooks\.slack\.com\/services?\//],
  ["GOOGLE_API_KEY", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["OPENAI_STYLE_KEY", /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ["SEARCH_ENGINE_KEY", /\b(?:tvly-|exa-|fc-|BSA)[A-Za-z0-9_-]{20,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/],
  ["DISCORD_WEBHOOK", /discord\.com\/api\/webhooks\//],
  ["GENERIC_ASSIGN", /(?:api[_-]?key|apikey|secret|token|passwd|password)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
  ["PRIVATE_IP", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ["PRIVATE_DOMAIN", /\b[\w-]+\.(?:corp|internal|intranet|lan)\b/],
  ["HOME_PATH", /(?:[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]\S+|\/home\/[A-Za-z0-9._-]+\/)/],
  ["PII_EMAIL", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["PII_PHONE_CN", /\b1[3-9]\d{9}\b/],
  ["PII_ID_CN", /\b\d{17}[\dXx]\b/],
];

function redact(s) {
  const t = s.trim();
  return t.length <= 8 ? `[${t}]` : `[${t.slice(0, 6)}…len=${t.length}]`;
}

function scanText(label, text, perRuleLimit = 20) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const [rule, re] of RULES) {
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m && hits < perRuleLimit) {
        out.push(`${label}:${i + 1} [${rule}] ${redact(m[0])}`);
        hits++;
      }
    }
  }
  return out;
}

// 白名单：占位符/文档示例/隐私邮箱/官方前缀说明 等模式命中不算泄露
function isAllowlisted(hit) {
  return (
    /YOUR[_-]/i.test(hit) ||
    /your-.*-here|example|placeholder|xxx|<[^>]+>|前缀/.test(hit) ||
    /users\.noreply\.github\.com/.test(hit) ||
    /AIza\.\.\.|tvly-\.\.\.|fc-\.\.\.|exa-\.\.\.|BSA\.\.\./.test(hit) ||
    /node_modules/.test(hit)
  );
}

const findings = [];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
}
function untrackedNotIgnored() {
  return execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
}

if (mode === "worktree" || mode === "all") {
  for (const f of [...trackedFiles(), ...untrackedNotIgnored()]) {
    try {
      const abs = path.join(ROOT, f);
      if (!existsSync(abs) || statSync(abs).size > 2_000_000) continue;
      findings.push(...scanText(f, readFileSync(abs, "utf8")));
    } catch {}
  }
}

if (mode === "history" || mode === "all") {
  const commits = execFileSync("git", ["rev-list", "--all"], { cwd: ROOT, encoding: "utf8" })
    .trim().split(/\r?\n/).filter(Boolean);
  for (const c of commits) {
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", c], { cwd: ROOT, encoding: "utf8" })
      .split("\0").filter(Boolean);
    for (const f of files) {
      try {
        const content = execFileSync("git", ["show", `${c}:${f}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 20_000_000 });
        findings.push(...scanText(`${c.slice(0, 7)}:${f}`, content));
      } catch (e) {
        if (!/does not exist|Filename too long/.test(e.message)) {
          findings.push(`SCAN_ERROR ${f}: ${String(e.message).split("\n")[0]}`);
        }
      }
    }
  }
}

const leaks = findings.filter((line) => !isAllowlisted(line));

if (leaks.length) {
  console.log(`⚠️  发现 ${leaks.length} 处疑似泄露：`);
  console.log(leaks.join("\n"));
  console.log("\n处理：①立即在对应控制台吊销密钥 ②从文件删除 ③若已入历史，amend 或用 git filter-repo 清洗后 gc prune ④重跑本脚本");
  process.exit(1);
} else {
  console.log(`✅ 未发现泄露（扫描模式: ${mode}，已过滤 ${findings.length - leaks.length} 处占位符/示例白名单项）`);
}
