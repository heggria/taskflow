# taskflow (বাংলা)

> ⚠️ **এই অনুবাদটি পুরোনো।** অনুগ্রহ করে সর্বশেষ তথ্যের জন্য [ইংরেজি README](../../README.md) দেখুন।

taskflow Pi, Codex, Claude Code, OpenCode ও Grok Build-এর জন্য একটি ডিক্লারেটিভ, যাচাইযোগ্য টাস্ক গ্রাফ। 0.2.3 লাইনে Node.js ≥ 22.19.0, 12টি phase kind এবং 1500+ পরীক্ষা রয়েছে। MCP layer-এর MCP SDK dependency নেই; core-এর peer `typebox`, আর DSL TypeScript-এর উপর নির্ভরশীল।

> **কেন "taskflow", "workflow" নয় কেন?** একটি *workflow* (code-mode) হল একটি ইম্পারেটিভ স্ক্রিপ্ট যা *প্রবাহিত হয়*, যার গ্রাফ কন্ট্রোল ফ্লোর মধ্যে লুকানো। একটি *taskflow* পরিকল্পনাকে পৃথক টাস্ক নোডের একটি ডিক্লারেটিভ গ্রাফে সরিয়ে নেয় — যা স্থিরভাবে যাচাই, দৃশ্যমান, পুনরারম্ভ এবং একটি কমান্ড হিসেবে সংরক্ষণ করা যায়। আমরা ইচ্ছাকৃতভাবে এক্সপ্রেসিভনেসকে যাচাইযোগ্যতার বিনিময়ে দিই।

```bash
# Pi
pi install npm:pi-taskflow

# Codex
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow

# Claude Code
claude plugin marketplace add heggria/taskflow
claude plugin install claude-taskflow@taskflow

# OpenCode
opencode mcp add taskflow -- npx -y -p opencode-taskflow opencode-taskflow-mcp

# Grok Build (from monorepo checkout pre-publish, or published source)
grok mcp add taskflow -- npx -y -p grok-taskflow@0.2.3 grok-taskflow-mcp
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [ইংরেজি README](../../README.md) · [চীনা README](../../README.zh-CN.md)
