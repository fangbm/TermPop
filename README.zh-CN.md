# TermPop

[English](README.md) | 简体中文

**不离开页面，也能看懂术语。**

TermPop 是一款面向 Chrome 和 Microsoft Edge 的开源浏览器扩展。它会在阅读网页时标记技术词汇，并在词汇原位置附近展示简洁、结合上下文的解释。基础术语匹配由 Rust/WASM 在浏览器本地完成；你也可以配置自己的 LLM，用于补充摘词和生成释义。

> 当前公开版本采用本地优先、BYOK（自带 API Key）模式。TermPop 不提供账号系统、托管 LLM 代理或支付服务。

## 安装

### Microsoft Edge

可直接从 [Microsoft Edge 扩展商店](https://microsoftedge.microsoft.com/addons/detail/termpop/blphbffphknkkblackimhnjbckegnchn) 安装。

### Chrome 或手动安装

1. 从 [GitHub Releases](https://github.com/fangbm/TermPop/releases) 下载最新安装包。
2. 解压 ZIP 文件。
3. 打开 `chrome://extensions` 或 `edge://extensions`。
4. 开启“开发人员模式”。
5. 选择“加载解压缩的扩展”，并选择解压后的扩展目录。

## 功能

- **悬停模式**：扫描可读网页文本，自动标亮已识别的技术词汇。
- **划词模式**：选中一段文本后，通过浏览器右键菜单请求 TermPop 解释。
- **混合模式**：同时启用悬停标亮和划词解释。
- **上下文释义卡**：支持锁定、刷新、根据屏幕空间自动切换展示方向，以及本地缓存。
- **Rust + WASM 本地匹配**：在浏览器中匹配本地缓存的词条。
- **LLM 补词与释义**：可通过你配置的服务商补充领域词汇，并生成结合上下文的解释。
- **截图解释**：适用于没有正常暴露 DOM 文本的词汇或短语。
- **TermPop PDF 阅读器**：通过 TermPop 打开的 PDF 可渲染并标记术语；不支持直接注入 Chrome/Edge 内置 PDF 阅读器。

## 首次使用

1. 打开 TermPop 弹窗。
2. 选择“悬停”“划词”或“混合”模式。
3. 点击“在所有网站启用 TermPop”，一次性授予普通 HTTP/HTTPS 页面访问权限。
4. 在银行、邮箱等敏感页面，可使用“在此站点停用”加入本地黑名单。

本地 `file://` 页面需要在扩展详情中单独启用“允许访问文件网址”。

TermPop 不会在安装时直接请求全站权限；只有你在弹窗中主动选择启用时，浏览器才会弹出一次授权确认。

## 截图解释

先在弹窗中开启“截图解释”，再按 `Alt+Shift+S`，在当前页面框选一个词或短语。可在 `chrome://extensions/shortcuts` 或 `edge://extensions/shortcuts` 自定义快捷键。

截图识别有三种方式：

- **自动选择**：当 TermPop 能根据配置识别出模型支持图片输入时，优先使用多模态 LLM；否则先使用本地 OCR。若视觉请求明确返回“不支持图片输入”，会自动回退到本地 OCR。
- **多模态 LLM**：将选中区域和少量周边上下文图像发送给你配置的服务商。
- **本地 OCR**：使用内置 Tesseract 在本地识别图片文字，再对识别结果请求释义。

截图只会在你开始框选后获取，不会写入 TermPop 的术语或释义缓存。使用多模态模式时，选中图片会直接发送给你配置的服务商，并受该服务商的数据政策约束。

## LLM 与隐私

TermPop 支持 OpenAI、Kimi、OpenAI-compatible 和 Anthropic 风格服务商。可在弹窗中填写服务商、API Key、模型和 Base URL；“测试连接”会复用扩展已有的访问设置，不额外申请服务商域名权限。

开源版本会将设置、API Key、黑名单、词典和缓存保存到本机的浏览器扩展存储中。API Key 不会被注入网页 content script，但浏览器扩展存储**不是 hardened secret storage**。建议使用服务商支持的受限 Key，不应将当前版本视作安全的多人或商业部署方案。

TermPop 不包含内置遥测，也不运行 TermPop 自有后端。常规 LLM 请求会把待解释术语及其周边上下文发送到你配置的服务商；请不要在不希望该服务商接触内容的页面启用扩展。

## 词典与缓存

公开版本不再内置固定默认词表。LLM 会从你选择处理的页面中摘取词条，逐步建立仅属于当前浏览器配置文件的本地词库。扩展将术语缓存和释义缓存分开，以减少重复工作：

- 术语可按全局、同域名或当前页面语境复用。
- 释义缓存会区分词条、语言、服务商/模型、例句开关和上下文指纹。
- 缓存仅保存在当前浏览器配置文件中；清除扩展存储即可删除。

## 本地开发

### 环境要求

- Rust stable
- Node.js 22 或更高版本
- [`wasm-pack`](https://github.com/rustwasm/wasm-pack)

如未安装 `wasm-pack`：

```powershell
cargo install wasm-pack --locked
```

构建 Rust 内核和浏览器扩展：

```powershell
cargo test --workspace
wasm-pack build crates/termpop-core --target web --out-dir ../../extension/src/wasm -- --features wasm

cd extension
npm ci
npm run typecheck
npm test
npm run build
```

随后从 [`extension/dist`](extension/dist) 加载解压缩扩展。

官网是独立的 React 19 应用：

```powershell
cd apps/termpop-site
npm ci
npm run typecheck
npm run build
```

Cloudflare Pages 配置：根目录 `apps/termpop-site`，构建命令 `npm ci && npm run build`，输出目录 `dist`。

## 项目结构

```text
TermPop/
├── crates/termpop-core/    Rust 术语检测内核与 WASM 导出
├── extension/              Manifest V3 浏览器扩展
│   ├── src/background/     Service Worker、LLM、缓存、OCR、权限
│   ├── src/content/        增量扫描、标亮和悬浮层
│   ├── src/pdf-viewer/     TermPop 托管 PDF 阅读器
│   ├── src/popup/          扩展设置界面
│   └── tests/              扩展回归测试
├── apps/termpop-site/      React 19 产品官网
├── docs/                   设计与开发文档
└── .github/workflows/      CI 与发布工作流
```

## 当前限制

- 不支持直接标记 Chrome 或 Edge 的内置 PDF 阅读器，请使用 TermPop PDF 阅读器。
- 为避免破坏页面结构，自动标亮会跳过链接、代码块、表单控件、可编辑区域和布局敏感的文本容器。
- 截图功能依赖浏览器能够捕获当前标签页；浏览器内部页面和受保护页面无法截图。
- 本地 OCR 只在本地识别文字，释义仍需要配置 LLM 服务商。
- 公开版本不包含托管账号、计费或团队协作能力。

## 许可证

Rust workspace 当前声明为 MIT；仓库根目录尚未提交统一的 `LICENSE` 文件。
