# 鲜花酿发布契约

本文件是鲜花酿的发布事实源。每次打包或创建 GitHub Release 前先读这里，再核对 `manifest.json`、`package.json`、`CHANGELOG.md` 和发布包实物。

## 1. 固定信息

- 项目：鲜花酿，Hana v2 App，ID `xianhuaniang`
- 仓库：<https://github.com/moononnn/xianhuaniang>
- 发布分支：`main`
- 版本唯一来源：`manifest.json` 与 `package.json` 必须完全一致
- Tag：`v<版本号>`
- Release 标题：`v<版本号> — <本版主要变化>`
- Release 附件：`xianhuaniang-v<版本号>.zip`
- CI：`.github/workflows/test.yml`；合并或推送到 `main` 后运行自动测试

## 2. 发布档位

- 纯文案、外观微调或小修复：推送代码并打版本 tag，不创建 Release；变更继续记在本地 `PENDING_CHANGES.md`。
- 新功能、用户等待的修复或流程变化：推送 `main`，等 CI 全绿，再打干净安装包、完成交叉审查并创建 GitHub Release。
- 首次公开预览版版本定为 `0.1.0`。后续按项目版本节奏递增；版本号不能代替测试或实机验收证据。

## 3. 干净安装包

### 必须包含

- App 根目录的 `manifest.json`、`package.json`、`index.js`
- `assets/`、`backend/`、`runtime/`、`theme/`、`ui/`
- `vendor/sillytavern/` 的完整引擎源码、锁文件和必要静态资源，保留原始许可证
- `README.md`、`CHANGELOG.md`、`TESTING.md`、`THIRD_PARTY_NOTICES.md`

### 必须排除

- `.git/`、测试目录、PENDING 变更账本、项目日志、迁移计划、交接文档和本机调试资料
- `vendor/sillytavern/node_modules/`、npm 缓存、运行数据、日志、备份、密钥和临时文件
- 用户角色卡、聊天、世界书、模型配置及其他个人资料

**例外说明：**JS-Slash-Runner 扩展源码中存在一个名为 `src/iframe/node_modules/` 的路径，当前只包含扩展运行所需的 `log.js` 与说明文件，并非 npm 依赖树；它必须保留。除此路径外，不得打包任何 `node_modules` 依赖目录。酒馆依赖会在首次启动时按随包 `package-lock.json` 执行 `npm ci`。

### 打包要求

- 在 App 目录之外建立独立暂存目录，只从白名单复制文件；禁止直接压缩整个开发目录。
- 压缩前后核对文件清单、App 根目录结构、版本号和总大小。
- 解压最终 zip 到新的空目录，检查入口、清单与资源路径，并在副本上执行发布包语法检查。
- 不覆盖或删除旧发布包、备份或用户数据。

## 4. 固定验证

### 自动测试

按 [`TESTING.md`](TESTING.md) 中的 Windows PowerShell 命令运行全部 `tests/*.test.js`，串行执行，并确认结果结构化、无失败。修改某个测试或模块后，先跑受影响测试；完整发布前还需全量结果。

### Hana App 清单

使用当前 Hana 安装包附带的官方 App 校验器；确认输出为非空结构化结果、`ok: true` 且没有错误。发布包副本也要校验，不能只验证开发目录。

### 外部内容检查

- 公开内容不得包含用户本名、除「小花」以外的伙伴名字、私人项目名或本机私有路径。
- 不得包含真实邮箱、访问令牌、模型密钥或聊天/角色资料；尤其不能泄露 QQ 邮箱。
- 保留 SillyTavern 与所有随包第三方组件的许可证和版权声明，不擅自把它们改标成鲜花酿许可证。
- 检查包内没有测试数据、日志、缓存、运行数据、备份、密钥及 npm 依赖目录；对 `src/iframe/node_modules/log.js` 仅按上方例外保留。
- GitHub `About` 简介与 Hana App `manifest.description` 是两处独立字段；更改其中一处时按需求分别核对。

## 5. 固定发布顺序

1. 核对本契约、`PENDING_CHANGES.md`、版本与变更范围。
2. 更新 `CHANGELOG.md`，检查 README、manifest/package 版本和项目发布说明一致。
3. 运行相关测试、全量自动测试和官方 App 静态校验。
4. 将逻辑边界清晰的改动拆成可独立审查的提交；首次仓库提交由仓库所有者署名。
5. 推送 `main`，等待 GitHub CI 全绿；失败先修复，不继续打包或建 Release。
6. 创建 `v<版本号>` tag。
7. 按白名单生成干净 zip，计算 SHA-256，并在解压副本复验。
8. 对最终 zip 做独立交叉审查，检查包内容、安装/升级路径与对外红线。
9. 创建标题含版本主要变化的 GitHub Release，附上 zip 和 SHA-256。
10. 从 GitHub 下载 Release 附件复核 SHA-256，再记录最终证据。

## 6. 首发与项目特殊注意事项

- 应用运行于本机；首次启动要从 npm 安装酒馆依赖，因此需要网络并可能耗时较长。
- 内嵌 SillyTavern 版本、模型选择补丁和第三方扩展更新时，必须重新核对许可证、来源与运行兼容性。
- `manifest.description` 展示在 Hana 应用管理页面；仓库 About 简介另行维护。
- 发布不等于运行时已安装或生效；不要代替使用者批准 App 权限或重启 Hana。

## 7. 最终报告字段

- Commit：
- Tag：
- CI run：
- Release URL：
- 附件大小：
- SHA-256：
- 发布包交叉审查：
- 未执行检查及原因：
