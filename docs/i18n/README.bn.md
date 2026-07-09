# taskflow (বাংলা)

> ⚠️ **এই অনুবাদটি পুরোনো।** অনুগ্রহ করে সর্বশেষ তথ্যের জন্য [ইংরেজি README](../../README.md) দেখুন।

taskflow কোডিং এজেন্টের জন্য একটি ডিক্লারেটিভ এবং যাচাইযোগ্য *টাস্ক গ্রাফ* — এটি [Pi](https://pi.dev), [OpenAI Codex](https://github.com/openai/codex), [Claude Code](https://claude.com/product/claude-code), [OpenCode](https://opencode.ai) ও [Grok Build](https://docs.x.ai/build/overview)-এ চলে — এটি এমন কোনো workflow নয় যা আপনি স্ক্রিপ্ট করেন, বরং একটি DAG যা আপনি ঘোষণা করেন এবং runtime একটি token খরচের আগেই যাচাই করে। শূন্য রানটাইম নির্ভরতা, ৮৭২টি পরীক্ষা, ৯টি ফেজ টাইপ।

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
grok plugin install <source> --trust
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [ইংরেজি README](../../README.md) · [চীনা README](../../README.zh-CN.md)
