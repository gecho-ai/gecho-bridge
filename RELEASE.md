# Gecho Bridge 发布流程

本文档规范 `@gecho-ai/gecho-bridge` 的 beta 测试包和正式 npm 包发布。

## 一、版本规则

### Beta 测试版

版本格式：`1.1.30-beta.0`、`1.1.30-beta.1`。

Beta 发布到 npm 的 `beta` 标签，不会影响 `latest` 稳定版：

```bash
npx -y @gecho-ai/gecho-bridge@beta
```

同一个版本号不能重复发布，发现问题必须递增 beta 序号。

### 正式版

版本格式：`1.1.30`，发布到 npm 的 `latest` 标签，并创建 Git tag `v1.1.30`。

## 二、发布前准备

```bash
cd /Users/wangzhiguang/createPlux/gecho-ai/gecho-bridge
git status --short --branch
npm whoami --registry=https://registry.npmjs.org
npm config get registry
```

发布前必须确认工作区没有无关修改，并且 npm 登录的是官方 registry。未登录时执行：

```bash
npm login --registry=https://registry.npmjs.org
```

所有发布命令都显式使用 `--registry=https://registry.npmjs.org`，不要依赖本机默认镜像。

## 三、发布 Beta 测试版

### 1. 使用测试分支

```bash
git switch test/V1.1.30
```

### 2. 修改 npm 版本

```bash
npm version 1.1.30-beta.0 --no-git-tag-version
```

如果只是测试 Bridge，没有 skill 功能变更，不执行 `npm run sync:version`，skill metadata 保持原版本。

### 3. 构建和预检查

```bash
npm run build:bundle
npm pack --dry-run --registry=https://registry.npmjs.org
npm publish --dry-run --registry=https://registry.npmjs.org
```

确认包内包含最新的 `dist/mcp-client.cjs`、`dist/server.cjs`、`server.js`、`mcp-client.js` 和 `data-dir.js`，且没有包含 `node_modules`、本地数据或敏感文件。

### 4. 发布 Beta

```bash
npm publish \
  --tag beta \
  --access public \
  --registry=https://registry.npmjs.org
```

### 5. 验证 Beta

```bash
npm view @gecho-ai/gecho-bridge dist-tags --registry=https://registry.npmjs.org
npx -y @gecho-ai/gecho-bridge@beta
```

重点验证浏览器启动、Chrome/Edge 选择、Onboarding 首次打开、插件安装引导、扩展重连、任务恢复和重复页签问题。

## 四、发布正式版

### 1. 合并测试分支

```bash
git switch main
git pull --ff-only origin main
git merge --no-ff test/V1.1.30
```

### 2. 修改正式版本并同步 metadata

```bash
npm version 1.1.30 --no-git-tag-version
npm run sync:version
```

正式版需要让 `package.json`、插件配置和 skill metadata 版本保持一致。

### 2.1 预览 ClawHub Skill 发布计划

Skill 发布与 Plugin 发布相互独立。正式版如果包含 Skill 内容变更，先执行：

```bash
npm run skill:dry-run
```

确认只包含本次变更的 Skill 后，再执行：

```bash
CLAWHUB_CHANGELOG='Release 1.1.30' npm run skill:publish
```

脚本默认发布 `skills/` 和 `distribution-skills/`，只上传 ClawHub 上不存在或内容已变化的 Skill，并显式指定团队 owner `gecho-ai`。中文 Skill 目录不默认发布，需要通过 `SKILL_ROOTS` 显式指定。

### 3. 构建和预检查

```bash
npm run build:bundle
npm pack --dry-run --registry=https://registry.npmjs.org
npm publish --dry-run --registry=https://registry.npmjs.org
```

### 4. 提交正式版本

```bash
git add package.json package-lock.json \
  .claude-plugin/plugin.json \
  openclaw.plugin.json \
  skills distribution-skills
git commit -m "chore: release v1.1.30"
```

### 5. 发布 latest 并创建 Git tag

```bash
npm publish \
  --tag latest \
  --access public \
  --registry=https://registry.npmjs.org

git tag v1.1.30
git push origin main v1.1.30
```

## 五、发布后验证

```bash
npm view @gecho-ai/gecho-bridge dist-tags --registry=https://registry.npmjs.org
npm view @gecho-ai/gecho-bridge versions --registry=https://registry.npmjs.org
```

预期示例：

```json
{
  "latest": "1.1.30",
  "beta": "1.1.30-beta.1"
}
```

稳定用户使用：

```bash
npx -y @gecho-ai/gecho-bridge@latest
```

测试用户使用：

```bash
npx -y @gecho-ai/gecho-bridge@beta
```

## 六、数据目录规则

Bridge 默认使用系统用户目录，不依赖 npm/npx 缓存目录：

- macOS：`~/Library/Application Support/Gecho/Bridge`
- Windows：`%LOCALAPPDATA%/Gecho/Bridge`
- Linux：`~/.local/state/gecho/bridge`

只有需要隔离 beta 和正式版数据，或需要切换测试环境时，才配置：

```json
{
  "env": {
    "GECHO_DATA_DIR": "/absolute/path/to/gecho-bridge-data"
  }
}
```

## 七、发布原则

1. 同一个 npm 版本只能发布一次，发现问题必须递增版本号。
2. Beta 使用 `beta` 标签，正式版使用 `latest` 标签。
3. Beta 只改 Bridge 时，不强制升级 skill metadata。
4. 正式版发布前，统一包、插件和 skill metadata 版本。
5. 每次发布必须先执行 `npm pack --dry-run` 和 `npm publish --dry-run`。
6. 发布完成后必须验证 npm dist-tags 和实际安装命令。
