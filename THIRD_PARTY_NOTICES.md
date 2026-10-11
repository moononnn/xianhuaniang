# 第三方组件与许可证说明

鲜花酿随包包含以下第三方项目。原有许可证、版权和来源说明保留在各自目录；本文件只做索引，不替代原文。

| 组件 | 随包版本 | 许可证 | 说明 |
| --- | --- | --- | --- |
| SillyTavern | 1.19.0 | GNU AGPL-3.0 | 源码位于 `vendor/sillytavern/`，完整许可证见 `vendor/sillytavern/LICENSE`。 |
| JS-Slash-Runner | 4.9.5 | Aladdin Free Public License v9 | 完整许可证见 `vendor/sillytavern/public/scripts/extensions/third-party/JS-Slash-Runner/LICENSE`。该许可证对商业分发有额外限制。 |
| ST-Prompt-Template | 1.17 | GNU AGPL-3.0 | 完整许可证见 `vendor/sillytavern/public/scripts/extensions/third-party/ST-Prompt-Template/LICENSE`。 |

## 对 SillyTavern 的改动

随包的 SillyTavern 基于上游 1.19.0。鲜花酿在 `vendor/sillytavern/public/index.html` 增加了 `MiniMax-M3.1-Flash-Preview` 模型选项；该选项来自鲜花酿的本地修改，并非上游原版内容。修改日期：2026-10-10。上游代码继续遵循 AGPL-3.0，原始许可证随包提供。

## 鲜花酿自有代码

鲜花酿自有代码以 [GNU AGPL v3](../LICENSE) 发布，继承旧版花酿（hanabrew）的许可证不变。

选 AGPL 不是因为它比别的协议宽松，而是因为内嵌的 SillyTavern 本家就是 AGPL-3.0：AGPL 有传染性，把 AGPL 代码装进自己的作品后，整体必须以 AGPL 发布，不能换成其他协议。因此鲜花酿的「自有代码」边界天然模糊——`backend/`、`runtime/`、`ui/`、`assets/` 是本项目写的，`vendor/` 下全是第三方，两者在授权上已经是同一份协议。

这意味着：**改动了这份代码再对外分发（包括只通过网络提供服务），必须公开完整源码**，AGPL 第 13 条对纯网络服务同样生效。

上表的第三方组件仍各自受其原许可证约束，与上面的 AGPL 是两回事。其中 JS-Slash-Runner 的 Aladdin Free Public License v9 带商业分发限制，**AGPL 授权不覆盖它**。
