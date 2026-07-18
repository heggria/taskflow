# taskflow (العربية)

> ⚠️ **هذه الترجمة قديمة.** يُرجى مراجعة [README بالإنجليزية](../../README.md) للحصول على أحدث المعلومات.

taskflow رسم بياني تصريحي وقابل للتحقق للمهام على Pi وCodex وClaude Code وOpenCode وGrok Build. خط 0.2.3 يتطلب Node.js ≥ 22.19.0 ويضم 12 نوعًا من المراحل وأكثر من 1500 اختبار. طبقة MCP لا تعتمد على MCP SDK؛ يستخدم core ‏`typebox` كـ peer ويعتمد DSL على TypeScript.

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
grok mcp add taskflow -- npx -y -p grok-taskflow@0.2.3 grok-taskflow-mcp
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [README بالإنجليزية](../../README.md) · [README بالصينية](../../README.zh-CN.md)
