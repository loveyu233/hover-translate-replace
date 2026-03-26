# Hover Translate Replace

这是一个本地 VS Code 扩展，用来增强悬浮翻译体验，并提供常用文本替换能力。

它的目标不是再次把原文和译文拼在一起，而是额外提供一段“仅译文”的悬浮内容，并支持右键做中英互译、变量名格式化等操作。

## 缓存机制

扩展现在有两级缓存：

1. 内存缓存：当前 VS Code 会话内，同一段文本不会重复请求翻译
2. 持久化缓存：重载窗口或重启 VS Code 后，仍会复用旧结果

持久化缓存文件默认放在扩展目录下的：

`./.cache/translation-cache.json`

缓存上限默认是 2000 条，采用“最近使用优先保留”的方式淘汰旧项。

## 现状限制

VS Code 会把多个 hover provider 的结果合并显示，扩展本身不能直接屏蔽其他扩展或语言服务返回的 hover。

所以这类扩展能做的是：

1. 通过定义跳转找到真实声明位置
2. 直接提取声明附近的说明文本
3. 翻译后只返回译文

如果你在 Go 项目里使用，并且想让界面尽量接近“替换原 hover”，建议同时加上这段设置，只保留 `gopls` 的签名，不显示原始文档：

```json
"gopls": {
  "ui.documentation.hoverKind": "NoDocumentation",
  "ui.documentation.linksInHover": false
}
```

这样最终效果会更像：

- `gopls` 负责显示函数签名
- 本扩展负责显示译文

## 安装方式

### 方式一：扩展开发宿主

1. 用 VS Code 打开本目录
2. 按 `F5`
3. 在新的 Extension Development Host 窗口里测试 Go 悬浮

### 方式二：作为本地扩展软链接

把本目录软链接到 `~/.vscode/extensions` 下，然后重载 VS Code。

示例：

```bash
ln -s <扩展目录> ~/.vscode/extensions/local.hover-translate-replace-0.0.1
```

## 推荐设置

```json
"hoverTranslateReplace.enabled": true,
"hoverTranslateReplace.provider": "google-free",
"hoverTranslateReplace.targetLanguage": "zh-CN",
"hoverTranslateReplace.skipIfSourceMatchesTarget": true,
"hoverTranslateReplace.includeOriginal": false,
"gopls": {
  "ui.documentation.hoverKind": "NoDocumentation",
  "ui.documentation.linksInHover": false
}
```

## 可配置项

- `hoverTranslateReplace.enabled`：是否启用
- `hoverTranslateReplace.provider`：`google-free`、`openai-compatible` 或 `tencent-cloud`
- `hoverTranslateReplace.targetLanguage`：目标语言
- `hoverTranslateReplace.includeOriginal`：是否附带原文
- `hoverTranslateReplace.skipIfSourceMatchesTarget`：原文已是目标语言时不再显示译文
- `hoverTranslateReplace.maxChars`：单次翻译最大长度
- `hoverTranslateReplace.timeoutMs`：请求超时
- `hoverTranslateReplace.googleApiUrl`：Google 免密接口地址
- `hoverTranslateReplace.openaiBaseUrl`：OpenAI 兼容接口地址
- `hoverTranslateReplace.openaiApiKey`：OpenAI 兼容接口密钥
- `hoverTranslateReplace.openaiModel`：OpenAI 兼容模型名
- `hoverTranslateReplace.tencentSecretId`：腾讯云 API 密钥 ID
- `hoverTranslateReplace.tencentSecretKey`：腾讯云 API 密钥 Key
- `hoverTranslateReplace.tencentRegion`：腾讯云请求地域
- `hoverTranslateReplace.tencentProjectId`：腾讯云项目 ID
- `hoverTranslateReplace.tencentSourceLanguage`：腾讯云源语言，默认 `auto`
- `hoverTranslateReplace.tencentEndpoint`：腾讯云机器翻译接口地址
- `hoverTranslateReplace.title`：悬浮框标题

## 命令

- `清空翻译缓存`
- `切换原文显示`
- `中英互译替换`
- `替换为大驼峰`

## 默认快捷键

- `中英互译替换`：`Ctrl+Alt+R`，macOS 为 `Cmd+Alt+R`
- `替换为大驼峰`：`Ctrl+Alt+P`，macOS 为 `Cmd+Alt+P`

如果你想改成自己的快捷键，请在 VS Code 的“键盘快捷方式”里搜索这些命令 ID：

- `hoverTranslateReplace.replaceSelectionBidirectional`
- `hoverTranslateReplace.replaceSelectionAsPascalCase`

## 右键替换

在编辑器里双击或手动选中一段文本后，右键可以看到 `中英互译替换`。

规则是：

- 选中中文：替换为英文
- 选中英文：替换为中文

这项功能会复用当前配置的翻译源和缓存。

## 大驼峰替换

右键菜单还提供 `替换为大驼峰`。

规则是：

- 选中中文：先翻译成英文，再转成 `PascalCase`
- 选中英文：直接转成 `PascalCase`

例如：

- `获取文章列表` -> `GetArticleList`
- `get article list` -> `GetArticleList`

## 腾讯云配置示例

```json
"hoverTranslateReplace.provider": "tencent-cloud",
"hoverTranslateReplace.targetLanguage": "zh-CN",
"hoverTranslateReplace.tencentSecretId": "你的 SecretId",
"hoverTranslateReplace.tencentSecretKey": "你的 SecretKey",
"hoverTranslateReplace.tencentRegion": "ap-beijing",
"hoverTranslateReplace.tencentProjectId": 0,
"hoverTranslateReplace.tencentSourceLanguage": "auto"
```

腾讯云文本翻译接的是 `TextTranslate` 接口，认证方式使用 `TC3-HMAC-SHA256` 签名。
