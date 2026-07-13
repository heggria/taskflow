# taskflow (हिन्दी)

> ⚠️ **यह अनुवाद पुराना है।** कृपया नवीनतम जानकारी के लिए [अंग्रेज़ी README](../../README.md) देखें।

taskflow Pi, Codex, Claude Code, OpenCode और Grok Build के लिए एक घोषणात्मक, सत्यापन-योग्य टास्क ग्राफ है। 0.2.0 लाइन में Node.js ≥ 22.19.0, 12 phase kinds और 1500+ परीक्षण हैं। MCP layer किसी MCP SDK पर निर्भर नहीं है; core का peer `typebox` है और DSL TypeScript पर निर्भर है।

> **"taskflow" क्यों, "workflow" क्यों नहीं?** एक *workflow* (code-mode) एक आज्ञात्मक स्क्रिप्ट है जो *बहता* है, जिसका ग्राफ कंट्रोल फ़्लो में छिपा होता है। एक *taskflow* योजना को अलग-अलग टास्क नोड्स के एक घोषणात्मक ग्राफ में ले जाता है — जिसे स्थिर रूप से सत्यापित, दृश्य, पुनः शुरू और एक कमांड के रूप में सहेजा जा सकता है। हम जान-बूझकर अभिव्यक्ति को सत्यापन-योग्यता से बदलते हैं।

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
grok mcp add taskflow -- npx -y -p grok-taskflow@0.2.0 grok-taskflow-mcp
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [अंग्रेज़ी README](../../README.md) · [चीनी README](../../README.zh-CN.md)
