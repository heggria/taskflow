# taskflow (हिन्दी)

> ⚠️ **यह अनुवाद पुराना है।** कृपया नवीनतम जानकारी के लिए [अंग्रेज़ी README](../../README.md) देखें।

taskflow कोडिंग एजेंटों के लिए एक घोषणात्मक और सत्यापन-योग्य *टास्क ग्राफ* है — यह [Pi](https://pi.dev), [OpenAI Codex](https://github.com/openai/codex), [Claude Code](https://claude.com/product/claude-code), [OpenCode](https://opencode.ai) और [Grok Build](https://docs.x.ai/build/overview) पर चलता है — वह workflow नहीं जिसे आप स्क्रिप्ट करते हैं, बल्कि एक DAG जिसे आप घोषित करते हैं और जिसे runtime एक भी token खर्च करने से पहले सत्यापित करता है। शून्य रनटाइम निर्भरता, 872 परीक्षण, 9 चरण प्रकार।

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
grok plugin install <source> --trust
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [अंग्रेज़ी README](../../README.md) · [चीनी README](../../README.zh-CN.md)
