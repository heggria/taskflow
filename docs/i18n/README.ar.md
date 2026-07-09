# taskflow (العربية)

> ⚠️ **هذه الترجمة قديمة.** يُرجى مراجعة [README بالإنجليزية](../../README.md) للحصول على أحدث المعلومات.

taskflow هو *رسم بياني للمهام* تصريحي وقابل للتحقق لوكلاء البرمجة — يعمل على [Pi](https://pi.dev) و [OpenAI Codex](https://github.com/openai/codex) و [Claude Code](https://claude.com/product/claude-code) و [OpenCode](https://opencode.ai) و [Grok Build](https://docs.x.ai/build/overview) — ليس workflow تكتبه كبرنامج نصي، بل DAG تُعلِنه ويتحقق منه وقت التشغيل قبل إنفاق أي token. بدون أي تبعيات وقت تشغيل، 872 اختبارًا، 9 أنواع من المراحل.

> **لماذا "taskflow" وليس "workflow"؟** الـ *workflow* (بنمط code-mode) هو برنامج أمري *يتدفق*، ورسمه البياني مخبأ داخل تدفق التحكم. أما الـ *taskflow* فينقل الخطة إلى رسم بياني تصريحي من عقد مهام منفصلة — يمكن التحقق منه ساكنًا وعرضه واستئنافه وحفظه كأمر. نحن نستبدل القدرة التعبيرية بالقابلية للتحقق، عن قصد.

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

[GitHub](https://github.com/heggria/taskflow) · [README بالإنجليزية](../../README.md) · [README بالصينية](../../README.zh-CN.md)
