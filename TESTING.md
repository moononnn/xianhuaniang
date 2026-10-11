# 测试说明

## 自动测试

使用 Node.js 内置 `node:test`，不需要安装 App 根目录依赖。Windows PowerShell 中显式枚举测试文件，避免通配符展开差异：

```powershell
$files = Get-ChildItem -LiteralPath .\tests -Filter '*.test.js' -File |
  Sort-Object FullName |
  ForEach-Object FullName
if (-not $files) { throw '没有找到测试文件' }
node --test --test-concurrency=1 @files
```

测试覆盖应用入口与清单、路由和工具注册、内嵌酒馆代理、角色卡与访客数据处理、茶话会交接、测卡/代笔状态迁移、任务恢复、会话归属、变量记录、失败回查和工作台界面约束。测试使用假运行时与临时数据，不会启动 Hana、酒馆服务或真实模型。

单独运行受影响测试时可以直接列出文件，例如：

```powershell
node --test tests/smoke.test.js tests/theater-runner.test.js
```

## App 清单校验

使用当前 Hana 安装包附带的官方 App 校验器，并确认输出是非空结构化结果，包含 `ok: true` 且没有错误；只看进程退出码不算验证完成。校验器具体位置随 Hana 版本变化，以当前安装目录为准。

## 实机验收边界

自动测试不能替代以下检查：

- 在 Hana 中打开鲜花酿，确认酒馆服务启动、主页面进入酒馆，功能面板入口可用。
- 检查 Hana 明暗主题变化能同步到酒馆皮肤。
- 在酒馆已配置模型的前提下，实际执行一轮角色卡体检，确认真实生成、逐幕过程与结果回查。
- 茶话会已安装并获得应用间服务权限时，再验证角色导入；未授权或未安装时应明确提示，而不是假报成功。
- 首次安装测试使用独立资料目录，不能拿日常角色卡、聊天、密钥或其他用户资料做破坏性验证。

没有实机证据时，只能报告自动测试通过，不能据此宣称真实模型、跨应用权限或完整迁移已验收。
