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

本仓库没有为鲜花酿自有代码单独添加仓库级许可证。第三方组件仍各自受其原许可证约束；公开可见不代表可以忽略这些许可证。
