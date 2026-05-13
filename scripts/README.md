# Scripts 说明

这个目录只保留当前还在使用的发布脚本，目标是把 `gecho-bridge` 以 `Bundle Plugin` 形式发布到 ClawHub，同时不影响 npm 的包名与发布流程。

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
- `skills/tiktok-search/_meta.json`

另外：

- `mcp-client.js` 不再手写版本号，而是直接读取 `package.json.version`
- 如果要发布新版本，先更新 `package.json.version`，再执行 `npm run sync:version`
