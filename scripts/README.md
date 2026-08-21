# Scripts 说明

这个目录只保留当前还在使用的发布脚本，目标是把 `gecho-bridge` 以 `Bundle Plugin` 形式发布到 ClawHub，同时不影响 npm 的包名与发布流程。

Skill 和 Bundle Plugin 是两条独立的 ClawHub 发布链路：Plugin 使用
`publish-bundle-dist.sh`，Skill 使用下面的 `publish-skills.sh`。

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

### `publish-skills.sh`

作用：

- 把 `skills/` 和 `distribution-skills/` 下的独立 Skill 复制到干净的临时目录。
- 通过支持 owner 的最新版 `clawhub sync` 对比 ClawHub 上的内容指纹。
- 只发布新增或发生变化的 Skill，避免重复发布。
- 默认显式发布到团队 owner `gecho-ai`，不会跟随个人当前账号误发。
- 默认隔离本机 OpenClaw/Clawdbot 的其他 Skill 目录，避免误发布本地文件。
- 默认在暂存前校验每个 Skill 的 frontmatter 和 `_meta.json`；校验失败会停止流程。

支持三种模式：

- `stage`：只准备临时目录，不访问 ClawHub。
- `dry-run`：显示将要发布的 Skill，不上传。
- `publish`：上传新增或变化的 Skill。

对应命令：

```bash
npm run skill:stage
npm run skill:dry-run
npm run skill:publish
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
CLAWHUB_CHANGELOG='Release 1.1.31' npm run skill:publish
CLAWHUB_BUMP=minor CLAWHUB_CHANGELOG='New skill capabilities' npm run skill:publish
# 仅在已经完成外部校验、需要跳过本地结构校验时使用
SKILL_VALIDATE=0 npm run skill:dry-run
```

默认使用 `npx -y clawhub@latest`，因为旧版 CLI 不支持 `sync --owner`。如需使用已安装的最新版 CLI，可以指定：

```bash
CLAWHUB_CLI='clawhub' npm run skill:dry-run
```

默认发布的目录是：

- `skills/`
- `distribution-skills/`

中文 Skill 目录默认不参与发布。如需单独发布，可以显式指定：

```bash
SKILL_ROOTS='skills-zh-CN distribution-skills-zh-CN' npm run skill:dry-run
```

注意：Skill 版本由 ClawHub 根据远端版本自动递增；正式版发布前先执行
`npm run sync:version`，再执行 `npm run skill:dry-run` 确认发布计划。

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
