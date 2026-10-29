# 柒柒

记住每一轮创作的图片工作台。当前只维护和发布 Windows 桌面端，API 配置、对话与历史图片保存在本机。

[下载桌面安装包](https://github.com/qingyu6688/qiqi/releases/latest) · [查看更新记录](RELEASE.md)

## 能做什么

- 文本生图、参考图编辑、遮罩与画板标注。
- 多提示词排队或并发、历史记录、收藏夹和 ZIP 备份。
- 对话生图：沿用当前分支的历史文字和图片，连续修改同一作品。
- 本机记忆：关闭后可打开原对话继续，新建对话使用独立上下文。
- 模型自动读取：填入 sub2api 地址与 Key，读取列表后勾选使用，无需手填模型 ID。
- 独立文本 API：在设置中填写文本接口，读取模型并一键关联混合对话；图生图可从输入栏直接上传参考图。
- 多图按数量独立请求；对话可选自动或 1–10 张，指定尺寸会完整保留画面并等比补边，原图可单独下载。
- 回复显示阶段、用时及完成、排队和失败数量；单次多图限制为两路请求，失败后保留成功图片。

上下文生图需要支持看图、Responses 与工具调用的对话模型。只有图片 API 时，可用混合模式将对话模型与图片模型分别配置。不同设备之间可通过导入导出迁移。

## 本地开发

使用 Node.js 24、npm、Rust stable、Visual Studio C++ 构建工具和 Windows SDK。在项目根目录执行：

```powershell
npm ci
npm run tauri:dev
```

发布构建执行 `npm run tauri:build -- --bundles nsis`，内嵌界面产物在 `dist-desktop/`，安装包位于 `src-tauri/target/release/bundle/nsis/`。签名所需环境变量和发布步骤见[桌面发布签名说明](docs/桌面发布签名说明.md)。开发时由 Vite 为桌面窗口提供界面资源，不需要部署网站。

## 配置和更新

API Key 由用户在设置中填写，不随项目或安装包预置。Windows 版本使用当前系统用户的 DPAPI 加密保存 Key；对话和图片仍保存在本机数据目录。

桌面发布仓库为 [qingyu6688/qiqi](https://github.com/qingyu6688/qiqi)。1.1.2 起使用独立更新源和签名公钥，下载和安装更新均检查签名及版本。1.1.1 及更早版本没有配置更新源，需要先用新版安装包覆盖安装一次，之后可在“设置 → 关于”检查更新。安装目录、应用标识和数据目录保持一致。

更新包签名用于验证安装包来源和完整性；它不等同于 Windows 可信发布者证书。当前未配置 Authenticode 代码签名证书，Windows 仍可能显示“未知发布者”。

## 项目文档

- [需求规格说明书](docs/需求规格说明书.md)
- [概要设计说明书](docs/概要设计说明书.md)
- [详细设计说明书](docs/详细设计说明书.md)
- [数据库设计文档](docs/数据库设计文档.md)
- [接口设计文档](docs/接口设计文档.md)
- [环境检查](docs/环境检查.md)
- [测试报告](docs/测试报告.md)
- [部署说明文档](docs/部署说明文档.md)
- [桌面发布签名说明](docs/桌面发布签名说明.md)
- [用户使用手册](docs/用户使用手册.md)
- [更新日志](docs/更新日志.md)
- [上游使用参考](docs/上游使用参考.md)

## 来源与许可

基于 [CookSleep/GPT Image Playground](https://github.com/CookSleep/gpt_image_playground) 0.8.1 继续开发。原作者为 CookSleep，保留 [MIT 许可证](LICENSE) 和第三方许可声明。柒柒的品牌、界面说明及独立发布配置见更新日志。

维护：maorongkang@gmail.com。
