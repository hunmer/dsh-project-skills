# dsh-project-skills

让 DSH 发现**当前工作区**里的 Claude / Agents 技能，并把它们放进输入框 `/` 的技能列表；但选中后**不通过 DSH 的 `skill` 工具加载正文**，而是注入一段指针，让 Agent 自己用文件读取工具去读 `SKILL.md`。

## 行为

- 扫描以下位置（存在才扫描）：
  - `<工作区>/.claude/skills`
  - `<工作区>/.agents/skills`
  - 最近 `.git` 祖先目录下的同名目录（工作区是仓库子目录时）
- 支持两种布局：
  - `<技能名>/SKILL.md`
  - `<技能名>.md`
- 读取 YAML frontmatter 的 `name`、`description`、`whenToUse`（或 `when-to-use`）、`user-invocable`。
  - `name` 必须是 kebab-case；缺省时回退到目录名/文件名。
  - `description` 必填。
  - `user-invocable: false` 的技能会被跳过，交给 DSH 内置 provider 处理（如果有）。
- 发布的技能统一是：
  - `userInvocable: true` —— 出现在 `/` 菜单；
  - `modelInvocable: false` —— 不进入 `skill` 工具目录，也不能被模型主动调用。
- 用户选中 `/name` 后，DSH 的 skill 调用链路会向对话注入：

  ```text
  This project skill is stored as a file and was not loaded into this prompt.

  Read "<绝对路径>/SKILL.md" with the Read tool before continuing.
  Then follow the instructions in that file exactly. ...
  ```

  因此正文始终由 Agent 读取文件获得，不会作为工具结果直接塞进上下文。

## 为什么菜单里显示“仅用户”

DSH 的 `/` 菜单会给 `modelInvocable: false` 的技能加上 `仅用户 · ` 前缀。这是刻意的：这些技能只能由用户通过 `/` 显式触发。

## 安装

在插件目录中执行（把 `web` 换成你的 profile 名）：

```sh
dsh plugin --profile web add E:\dsh-plugins\dsh-project-skills
```

或者在 DSH 里用插件管理器的“安装本地插件/包”功能，选择本目录。安装后 bundle 会自动把 `project-skills` 行插入当前 profile。

依赖：无（只用 Node 内置模块）。Node >= 22。

## 配置

默认配置即可用。需要覆盖时，在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: project-skills
  name: dsh-project-skills
  config:
    providerName: project-skills
    includeClaude: true
    includeAgents: true
    extraDirs:
      - ./tools/skills
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `providerName` | `project-skills` | 注册到 `ctx.skills` 的 provider 名；同一 scope 层内需唯一 |
| `includeClaude` | `true` | 是否扫描 `.claude/skills` |
| `includeAgents` | `true` | 是否扫描 `.agents/skills` |
| `extraDirs` | `[]` | 额外技能根目录；相对路径按会话工作区解析 |

## 优先级

同一 provider 内，rank 越小越优先（重复技能名只保留一个）：

| 位置 | rank |
| --- | --- |
| `<cwd>/.claude/skills` | 140 |
| `<cwd>/.agents/skills` | 145 |
| `<project-root>/.claude/skills` | 150 |
| `<project-root>/.agents/skills` | 155 |
| `extraDirs` | 160 |

DSH 的 skill registry 是分层的：agent preset 自带的 `dsh-skill-filesystem` 注册在 preset scope，本插件除了宿主层之外，还会为每个活动 agent 在其 **agent scope** 再注册一次。更近的 scope 会直接覆盖同名技能，`rank` 只在同一层内参与比较，因此项目 `.claude`/`.agents` 里的同名技能会覆盖 preset 里的 `.agents` 条目（包括 `.dsh/skills` 的同名项）。

没有同名覆盖的 `.dsh/skills` 技能仍然由 DSH 原生 provider 提供。

> 注意：扫描 `.agents/skills` 意味着本插件会“接管”项目级 `.agents` 技能，使它们从模型 skill 目录中消失，只保留 `/` 用户调用 + 读文件语义。如果不想这样，设置 `includeAgents: false`。

## 刷新

技能列表由 DSH 的 skill registry 缓存，网页端 `/` 菜单还会按会话缓存：

- 安装/启用插件后，插件管理器会触发一次失效，重新打开 `/` 即可看到；
- 运行中新增或修改技能文件，通常需要**新会话**或刷新页面后才会出现在 `/` 菜单；
- 已存在的技能正文每次调用都会重新读取文件，改内容不需要重载。

## 开发

```sh
node --test test/discovery.test.js
```

frontmatter 解析器是一个刻意做小的 YAML 子集实现：顶层标量、引号、布尔值、`|` / `>` 块。`metadata:` 等嵌套结构会被忽略；描述缺失的技能会被跳过并记录一条警告。

## 已知限制

- 不支持 Claude Code 的 `.claude/commands/*.md`（那是 slash command，不是 skill）。
- 不支持从 `.claude/plugins/*/skills` 发现插件技能。
- 不做文件监听；理由见“刷新”。
- 需要技能文件对 Agent 可读；如果工作区在仓库子目录且 session 沙箱限制在上层目录之外，指向仓库根的技能可能读不到。
