# Go Hover Translate Replace

这是一个最小本地 VS Code 扩展，只对 `Go` 文件生效。

它的目标不是再次把原文和译文拼在一起，而是额外提供一段“仅译文”的悬浮内容，便于把 Go 注释翻译成你需要的语言。

## 现状限制

VS Code 会把多个 hover provider 的结果合并显示，扩展本身不能直接屏蔽 `gopls` 的悬浮结果。

所以这类扩展能做的是：

1. 通过定义跳转找到真实声明位置
2. 直接提取声明上方的 Go 文档注释
3. 翻译后只返回译文

如果你想让界面尽量接近“替换原 hover”，建议同时加上这段设置，只保留 `gopls` 的签名，不显示原始文档：

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
ln -s /Users/huangzhenyu/com/wd/tools/go-hover-translate-replace \
  ~/.vscode/extensions/local.go-hover-translate-replace-0.0.1
```

## 推荐设置

```json
"goHoverTranslate.enabled": true,
"goHoverTranslate.provider": "google-free",
"goHoverTranslate.targetLanguage": "zh-CN",
"goHoverTranslate.skipIfSourceMatchesTarget": true,
"goHoverTranslate.includeOriginal": false,
"gopls": {
  "ui.documentation.hoverKind": "NoDocumentation",
  "ui.documentation.linksInHover": false
}
```

## 可配置项

- `goHoverTranslate.enabled`：是否启用
- `goHoverTranslate.provider`：`google-free` 或 `openai-compatible`
- `goHoverTranslate.targetLanguage`：目标语言
- `goHoverTranslate.includeOriginal`：是否附带原文
- `goHoverTranslate.skipIfSourceMatchesTarget`：原文已是目标语言时不再显示译文
- `goHoverTranslate.maxChars`：单次翻译最大长度
- `goHoverTranslate.timeoutMs`：请求超时
- `goHoverTranslate.googleApiUrl`：Google 免密接口地址
- `goHoverTranslate.openaiBaseUrl`：OpenAI 兼容接口地址
- `goHoverTranslate.openaiApiKey`：OpenAI 兼容接口密钥
- `goHoverTranslate.openaiModel`：OpenAI 兼容模型名
- `goHoverTranslate.title`：悬浮框标题

## 命令

- `Go Hover Translate: 清空翻译缓存`
