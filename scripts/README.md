# Scripts 说明

这个目录只保留当前还在使用的发布脚本，目标是把 `gecho-bridge` 以 `Bundle Plugin` 形式发布到 ClawHub，同时不影响 npm 的包名与发布流程。

Skill 和 Bundle Plugin 是两条独立的发布链路：Bundle Plugin 使用
`publish-bundle-dist.sh`；Skill 根据平台分别使用
`publish-clawhub-skills.sh`、`publish-tencent-skillhub.sh` 和
`publish-modelscope-skills.sh`。旧的 `publish-skills.sh` 仍保留为兼容入口。

## 当前保留的脚本

### `build-bundle.js`

作用：

- 用 `esbuild` 把运行时入口打包成自包含产物。
- 输出到 `dist/mcp-client.cjs` 和 `dist/server.cjs`。
- 解决 Bundle 安装后没有 `node_modules` 导致 MCP 启动失败的问题。

对应命令：

```bash
npm run build:bundle
```

什么时候用：

- 每次准备发布 ClawHub Bundle 前都要执行。
- 如果只是想验证 `dist` 产物是否能独立运行，也可以单独执行。

---

### `prepare-clawhub-stage.js`

作用：

- 只修改“临时发布目录”里的元数据，不改仓库源码。
- 让 ClawHub 的发布名、显示名、版本号可以和 npm 侧解耦。

会改哪些 staged 文件：

- `package.json`
- `package-lock.json`
- `.claude-plugin/plugin.json`
- `openclaw.plugin.json`

支持的环境变量：

- `CLAWHUB_NAME`
- `CLAWHUB_VERSION`
- `CLAWHUB_DISPLAY_NAME`

什么时候用：

- 一般不需要手动调用。
- 它会被 `publish-bundle-dist.sh` 自动调用。

如果手动执行，格式如下：

```bash
node ./scripts/prepare-clawhub-stage.js /tmp/clean_publish_gecho_bridge_dist
```

---

### `publish-bundle-dist.sh`

作用：

- 这是当前唯一保留的正式发布脚本。
- 它会先构建 `dist`，再创建临时 staging 目录，重写 `.mcp.json`，最后调用 `clawhub package publish`。

为什么它是主流程：

- Bundle 安装后不能依赖 `node_modules` 一定存在。
- 所以发布时必须让 `.mcp.json` 指向 `./dist/mcp-client.cjs`，而不是源码里的 `./mcp-client.js`。

支持两种模式：

- `stage`：只准备临时目录，不实际发布
- `publish`：准备完成后直接发布到 ClawHub

对应命令：

```bash
npm run bundle:stage
npm run bundle:publish
npm run bundle:stage:dist
npm run bundle:publish:dist
```

其中：

- `bundle:stage` / `bundle:publish` 是现在推荐使用的一键短命令
- `bundle:stage:dist` / `bundle:publish:dist` 是同一套流程的显式别名

## 当前发布流程

### 1. 构建自包含产物

执行：

```bash
npm run build:bundle
```

结果：

- 生成 `dist/mcp-client.cjs`
- 生成 `dist/server.cjs`

### 2. 创建临时发布目录

默认目录：

```bash
/tmp/clean_publish_gecho_bridge_dist
```

脚本会把项目复制进去，并排除这些本地目录：

- `.git/`
- `data/`
- `node_modules/`
- `.openclaw/`
- `.DS_Store`
- `.idea/`
- `.codex-plugin/`
- `.skillatlas-*` 探测文件

Bundle 暂存前默认会运行 `npm run skill:validate` 对全部 38 个中英文 Skill 做验收。
如需在已完成外部校验后跳过，可显式设置 `SKILL_VALIDATE=0`。

### 3. 重写 staged `.mcp.json`

发布时会把临时目录里的 `.mcp.json` 改成：

```json
{
  "mcpServers": {
    "gecho-tiktok-search": {
      "command": "node",
      "args": ["./dist/mcp-client.cjs"],
      "timeout": 600000,
      "retries": 0
    }
  }
}
```

这样安装后的 Bundle 会直接跑自包含产物。

### 4. 重写 staged 元数据

如果设置了环境变量，脚本会只在临时目录里覆盖这些信息：

- ClawHub 包名
- ClawHub 版本号
- ClawHub Display Name

注意：

- 仓库里的 `package.json.name` 不会因此被改掉。
- 所以 npm 仍然可以继续按原名发布。

### 5. 发布到 ClawHub

最终实际调用的是：

```bash
clawhub package publish <stage_dir> --family bundle-plugin ...
```

## 常用命令

### 只检查 staging 结果

```bash
npm run bundle:stage
```

或：

```bash
npm run bundle:stage:dist
```

### 直接发布默认名字

```bash
npm run bundle:publish
```

或：

```bash
npm run bundle:publish:dist
```

### 发布到 ClawHub 新名字，但不影响 npm

```bash
CLAWHUB_NAME='@gecho-ai/gecho-bridge-bundle' \
CLAWHUB_OWNER='gecho-ai' \
CLAWHUB_DISPLAY_NAME='Gecho Bridge' \
npm run bundle:publish
```

或：

```bash
CLAWHUB_NAME='@gecho-ai/gecho-bridge-bundle' \
CLAWHUB_OWNER='gecho-ai' \
CLAWHUB_DISPLAY_NAME='Gecho Bridge' \
npm run bundle:publish:dist
```

---

### `publish-clawhub-skills.sh`

作用：

- 把 `distribution-skills/` 和 `distribution-skills-zh-CN/` 下的全部 Skill 复制到干净的临时目录。
- 读取每个 Skill 的 `publish.json`，显式使用 ClawHub 的 slug、displayName 和团队 owner。
- 中英文使用不同的目标 slug，不会因为 source slug 相同而被 `sync` 去重。
- 通过 ClawHub 公开 resolve 接口对比内容指纹，只发布新增或发生变化的 Skill。
- 只发布新增或发生变化的 Skill，避免重复发布。
- 默认显式发布到团队 owner `gecho-ai`，不会跟随个人当前账号误发。
- 默认在暂存前运行全量 Skill 验收，并校验每个 Skill 的 frontmatter、`_meta.json` 和四个平台发布配置；校验失败会停止流程。

### 平台级 Skill 发布配置

`distribution-skills/` 和 `distribution-skills-zh-CN/` 下的每个 Skill 都有一个 `publish.json`。它只维护发布身份，不改变源 Skill：

- `sourceSlug` / `locale`：源 Skill 的身份和语言。
- `platforms.clawhub`：ClawHub 的 slug 和显示名。
- `platforms.tencent-skillhub`：腾讯 SkillHub 的 slug、显示名和发布模式。
- `platforms.aily-skillhub`：Aily SkillHub 的 slug、显示名和发布模式；当前用于手动上传。
- `platforms.modelscope`：魔塔社区的 slug 和显示名。

平台公共信息（例如腾讯 SkillHub 的 namespace、API host 和 CLI 名称）统一放在 `config/publish-platforms.json`。平台配置不放进上传副本，避免被某个平台的字段污染其他平台。

Aily SkillHub 当前没有接入自动发布脚本；其 Skill 身份配置与腾讯 SkillHub 保持一致，便于手动上传时沿用同一套 slug 和 displayName。

当前魔塔社区的公开 owner 是 `Gecho`，开发者标识是 `gecho-ai`；中文 Skill 的魔塔 slug 使用 `<sourceSlug>-gecho`，英文 Skill 沿用源 slug。这个命名只属于魔塔，不会改变 Skill 源目录、ClawHub slug 或腾讯 SkillHub slug。

生成缺失配置或检查全部配置：

```bash
npm run publish:config:generate
npm run publish:config:check
```

ClawHub 和腾讯 SkillHub 发布脚本都会读取 `publish.json`，按配置生成临时副本，并把 `publish.json` 与旧版 `skillhub-publish.json` 排除在上传内容之外。中文 Skill 的 ClawHub slug 使用 `-zh-cn`，腾讯 SkillHub 保留已有中文 slug，英文 Skill 使用独立 slug；这些身份都可以在对应 Skill 的配置中单独调整。

腾讯 SkillHub 脚本根据 Key 选择发布链路：`skh_...` 交给官方 CLI 的公共发布接口，`sk-ent-...` 走团队 API。团队更新会先按 slug 查询远端 Skill，再提交 `/versions`；团队新建会提交 `/skills`。团队新建要求 `categoryIds`，可放在 `publish.json` 的 `platforms.tencent-skillhub.categoryIds`，或通过 `--category-ids` 临时指定；已有 Skill 会优先继承远端分类。

支持三种模式：

- `stage`：只准备临时目录，不访问 ClawHub。
- `dry-run`：对比远端内容，显示将要发布的 Skill 和实际命令，不上传。
- `publish`：上传新增或变化的 Skill。

对应命令：

```bash
npm run skill:stage
npm run skill:dry-run
npm run skill:publish
```

只做本地全量验收、不准备 staging 目录：

```bash
npm run skill:validate
```

发布前需要先完成一次 ClawHub 登录：

```bash
clawhub login
clawhub whoami
```

登录账号只用于鉴权，脚本固定传入 `--owner gecho-ai`，所以真正的发布目标是 Gecho AI 团队；当前登录账号必须拥有该团队的发布权限。切换鉴权账号时，先执行
`clawhub logout` 再重新 `clawhub login`。

常用环境变量：

```bash
CLAWHUB_VERSION='1.1.37' CLAWHUB_CHANGELOG='Release 1.1.37' npm run skill:publish
CLAWHUB_TAGS='latest,beta' npm run skill:dry-run
# 仅在已经完成外部校验、需要跳过本地结构校验时使用
SKILL_VALIDATE=0 npm run skill:dry-run
```

也可以指定暂存目录、registry 或已安装的 CLI：

```bash
CLAWHUB_STAGE_DIR="$PWD/tmp/clawhub-publish" \
CLAWHUB_REGISTRY='https://clawhub.ai' \
CLAWHUB_CLI='clawhub' \
npm run skill:dry-run
```

默认发布的目录是：

- `distribution-skills/`
- `distribution-skills-zh-CN/`

按语言或单个 Skill 发布：

```bash
./scripts/publish-clawhub-skills.sh dry-run --locale zh-CN
./scripts/publish-clawhub-skills.sh dry-run --skill tiktok-insight --locale zh-CN
```

Skill 暂存同样会排除 `.DS_Store`、`.idea/`、`.codex-plugin/` 和 `.skillatlas-*` 等本地文件。

---

### `publish-modelscope-skills.sh`

作用：

- 读取 `publish.json` 中的 ModelScope `slug` 和 `displayName`。
- 为每个 Skill 创建只存在于 `tmp/modelscope-publish/` 的平台副本。
- 在副本的 `SKILL.md` 中补齐 ModelScope CLI/API 要求的 `version`。
- 通过 ModelScope 官方 OpenAPI 判断是创建、更新还是跳过。
- 更新使用 `PATCH /openapi/v1/skills/{owner}/{skill_name}/settings`，不会因为重复执行产生新 Skill。

ModelScope 的 `owner`、默认分类、许可证和源码地址放在
`config/publish-platforms.json`；单个 Skill 可以在 `publish.json` 的
`platforms.modelscope` 中覆盖 `category`、`tags`、`license` 和 `sourceUrl`。
上传副本不会包含 `_meta.json`、`publish.json` 或其他平台配置。

支持四种模式：

- `stage`：只生成临时副本和 ZIP，不访问 ModelScope。
- `dry-run`：查询远端并显示 create/update/skip，不上传。
- `publish`：上传并创建或更新 Skill。
- `verify`：查询远端，核对 owner、skill name、display name 和版本。

对应命令：

```bash
npm run skillhub:modelscope:stage
npm run skillhub:modelscope:dry-run -- --skill tiktok-insight --locale en
npm run skillhub:modelscope:publish -- --locale all
npm run skillhub:modelscope:verify -- --skill tiktok-insight --locale en
```

发布前设置 Token：

```bash
export MODELSCOPE_API_KEY='your-modelscope-token'
```

如果远端版本高于本地版本，脚本会中止；版本相同默认跳过，确需重发时显式使用
`--force`。脚本不会自动重试创建或更新请求，避免网络超时后产生重复 Skill。

注意：发布版本默认读取 `package.json`，如果远端已有更高版本，脚本会停止并要求先升级本地版本；正式版发布前先执行
`npm run sync:version`，再执行 `npm run skill:dry-run` 确认发布计划。

### `publish-skills.sh`（兼容旧流程）

该脚本仍保留原来的 `clawhub sync` 行为，主要用于兼容旧的自定义 `SKILL_ROOTS` 调用。它不会读取平台级 `publish.json`，不建议用于中英文混合发布；默认的 `npm run skill:stage/dry-run/publish` 已切换到 `publish-clawhub-skills.sh`。

### 指定 ClawHub 版本号

```bash
CLAWHUB_NAME='@gecho-ai/gecho-bridge-bundle' \
CLAWHUB_OWNER='gecho-ai' \
CLAWHUB_VERSION='X.Y.Z' \
CLAWHUB_DISPLAY_NAME='Gecho Bridge' \
npm run bundle:publish
```

或：

```bash
CLAWHUB_NAME='@gecho-ai/gecho-bridge-bundle' \
CLAWHUB_OWNER='gecho-ai' \
CLAWHUB_VERSION='X.Y.Z' \
CLAWHUB_DISPLAY_NAME='Gecho Bridge' \
npm run bundle:publish:dist
```

## npm 与 ClawHub 的关系

当前方案下，两边是解耦的：

- npm 继续使用仓库里的 `package.json.name`
- ClawHub 可以通过环境变量指定单独的包名和显示名

这意味着：

- 不需要为了 ClawHub 改 npm 包名
- 可以在 ClawHub 上发布不同名字的 Bundle 包

## 版本同步

项目内部现在以根目录 `package.json.version` 作为主版本源。

如果你手动改了 `package.json` 版本，执行下面命令即可把相关元数据同步过去：

```bash
npm run sync:version
```

它会同步这些文件：

- `.claude-plugin/plugin.json`
- `openclaw.plugin.json`
- `skills/`、`skills-zh-CN/`、`distribution-skills/`、`distribution-skills-zh-CN/` 下所有 Skill 的 `_meta.json`

如果某个目录包含 `SKILL.md` 但缺少 `_meta.json`，同步会直接失败，避免新 Skill 被漏掉。

另外：

- `mcp-client.js` 不再手写版本号，而是直接读取 `package.json.version`
- 如果要发布新版本，先更新 `package.json.version`，再执行 `npm run sync:version`
