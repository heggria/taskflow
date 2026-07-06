# taskflow 文档网站全面提升方案

> 目标：在现有文档网站内落地“真实案例展示”和“社区/模板征集”两大方向，同时全面提升首页说服力与导航体验。

---

## 一、现状诊断

### 已有资产
- 24 个英文 docs 页面 + 24 个中文 docs 页面，结构对称
- 3 个完整案例研究指南（PR 审计、发布说明锦标赛、代码迁移），但只有两个在 `meta.json` 中可见
-  landing page、OG 图、favicon、sitemap、robots.txt、SEO meta 已具备基础

### 关键缺口
1. **案例研究没有统一入口** —— 3 个案例分散在 `guides/` 下，没有 showcase 首页聚合
2. **模板没有展示页** —— `examples/` 目录里的 JSON 没有通过网站暴露
3. **社区没有页面** —— 没有 GitHub Discussions、贡献指南的入口
4. **首页缺少社会证明** —— 无 testimonial、无数据指标、无清晰对比
5. **导航遗漏** —— `headline-tournament-case-study` 和 `migration-planner-case-study` 未注册到 `meta.json`

---

## 二、落地范围

### 2.1 Showcase / 案例展示（选项 1 的一部分）

新建 `content/docs/{en,zh-cn}/showcase/` 目录：

| 页面 | 说明 |
|---|---|
| `showcase/index.mdx` | 案例展示首页，用 Cards 列出 3 个现有案例研究 |
| `showcase/why-taskflow.mdx` | 命令式脚本 vs taskflow DAG 的对比页，含 token 成本示例 |

同时：
- 更新 `guides/index.mdx`，增加“案例研究”子区域
- 更新 `meta.json`，注册 showcase 区域并补齐遗漏的两个案例研究

### 2.2 Templates / 模板征集（选项 2 的一部分）

新建 `content/docs/{en,zh-cn}/templates.mdx`：

展示 5 个可复用模板：
1. PR Security Audit
2. Release Note Generation
3. Codebase Migration
4. API Doc Generation
5. Dependency Upgrade Review

每个模板包含：标题、简短描述、可运行 JSON 片段、运行命令示例、链接到相关指南。

### 2.3 Community / 社区页面（选项 2 的一部分）

新建 `content/docs/{en,zh-cn}/community.mdx`：

- 链接到 GitHub Discussions（`https://github.com/heggria/taskflow/discussions`）
- 如何提交模板（PR 到 `examples/` 或开 Discussion）
- 贡献规范（命名约定、必填字段、测试要求）
- 提问指南

### 2.4 首页增强（影响力支撑）

更新 `app/[lang]/page.tsx`：

- 新增 **By the numbers** 数据区（4 hosts / 10 phase types / 0 deps / resume）
- 新增 **Testimonials** 社会证明区（3 条角色化引用）
- 新增 **Comparison** 对比区（命令式 vs taskflow，精简版表格）
- 新增/改进底部 CTAs：Read docs / Browse templates / Join community
- （可选）给代码窗口加语法高亮

### 2.5 导航与元数据修复

- `en/meta.json` 与 `zh-cn/meta.json`：
  - 新增 `---Showcase---` / `---案例展示---` 区域
  - 新增 `---Community---` / `---社区---` 区域（或合并到 Guides 后）
  - 补齐 `guides/headline-tournament-case-study` 和 `guides/migration-planner-case-study`

---

## 三、文件清单

```
website/content/docs/en/showcase/index.mdx              # 新增
website/content/docs/en/showcase/why-taskflow.mdx       # 新增
website/content/docs/zh-cn/showcase/index.mdx           # 新增
website/content/docs/zh-cn/showcase/why-taskflow.mdx    # 新增
website/content/docs/en/templates.mdx                   # 新增
website/content/docs/zh-cn/templates.mdx                # 新增
website/content/docs/en/community.mdx                   # 新增
website/content/docs/zh-cn/community.mdx                # 新增
website/content/docs/en/guides/index.mdx                # 修改
website/content/docs/zh-cn/guides/index.mdx             # 修改
website/content/docs/en/meta.json                       # 修改
website/content/docs/zh-cn/meta.json                    # 修改
website/app/[lang]/page.tsx                             # 修改
```

---

## 四、设计规范

- 使用现有 Fumadocs 组件：`Cards`/`Card`、`Callout`、`Steps`/`Step`、`Tabs`/`Tab`
- 中英文结构 1:1，行数尽量一致
- 内部链接：英文用 `/docs/...`，中文用 `/zh-cn/docs/...`
- JSON 片段需通过 `validateTaskflow()` 校验
- 所有代码块加 `title="..."`

---

## 五、执行顺序

1. 创建 showcase 页面（en + zh-cn）
2. 创建 templates 页面（en + zh-cn）
3. 创建 community 页面（en + zh-cn）
4. 更新 guides/index.mdx（en + zh-cn）
5. 更新 meta.json（en + zh-cn）
6. 更新首页 page.tsx
7. 运行 `npm run build -w taskflow-website` 验证
8. 提交 PR、合并、部署

---

## 六、验收标准

- [ ] 新增 10 个 `.mdx` 文件全部构建成功
- [ ] 中英文导航都可见 Showcase、Templates、Community
- [ ] 案例研究在 guides/index 和 showcase/index 中都有入口
- [ ] 首页新增 By the numbers / Testimonials / Comparison / CTAs
- [ ] `npm run build -w taskflow-website` 通过
- [ ] 线上可访问新页面
