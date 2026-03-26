const fs = require("fs/promises");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const vscode = require("vscode");

const translationCache = new Map();
const expandedOriginalSet = new Set();
const nativeHoverExtractionSet = new Set();
const hoverLanguageIds = [
  "go",
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
  "java",
  "python",
  "rust",
];
const persistentCache = {
  filePath: path.join(__dirname, ".cache", "translation-cache.json"),
  loadPromise: null,
  writeTimer: null,
  writePromise: Promise.resolve(),
  maxEntries: 2000,
};

function activate(context) {
  void ensurePersistentCacheLoaded();

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      hoverLanguageIds.map((language) => ({ language, scheme: "file" })),
      {
      provideHover(document, position, token) {
        return provideTranslatedHover(document, position, token);
      },
      }
    ),
    vscode.commands.registerCommand("hoverTranslateReplace.clearCache", async () => {
      translationCache.clear();
      await flushPersistentCache(true);
      vscode.window.showInformationMessage("悬浮翻译缓存已清空。");
    }),
    vscode.commands.registerCommand("hoverTranslateReplace.toggleOriginal", async (payload) => {
      await toggleOriginal(payload);
    }),
    vscode.commands.registerCommand("hoverTranslateReplace.replaceSelectionBidirectional", async () => {
      await replaceSelectionBidirectional();
    }),
    vscode.commands.registerCommand("hoverTranslateReplace.replaceSelectionAsPascalCase", async () => {
      await replaceSelectionAsPascalCase();
    })
  );
}

async function provideTranslatedHover(document, position, token) {
  const requestKey = buildHoverKey(document.uri, position);
  if (nativeHoverExtractionSet.has(requestKey)) {
    return null;
  }

  const config = getConfig();
  if (!config.enabled) {
    return null;
  }

  const definitionInfo = await readDefinitionComment(document, position, token, config.maxChars);
  if (!definitionInfo || !definitionInfo.comment) {
    return null;
  }
  const { comment, hoverKey } = definitionInfo;
  const sourceMatchesTarget = config.skipIfSourceMatchesTarget &&
    looksLikeTargetLanguage(comment, config.targetLanguage);

  const displayText = sourceMatchesTarget
    ? cleanTranslatedText(comment, config.targetLanguage)
    : cleanTranslatedText(await translateWithCache(comment, config, token), config.targetLanguage);

  if (!displayText) {
    return null;
  }

  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = {
    enabledCommands: ["hoverTranslateReplace.toggleOriginal"],
  };
  markdown.supportHtml = false;

  if (config.title) {
    markdown.appendMarkdown(`**${escapeMarkdown(config.title)}**\n\n`);
  }
  markdown.appendText(displayText);

  const shouldShowOriginal = !sourceMatchesTarget &&
    (config.includeOriginal || expandedOriginalSet.has(hoverKey));
  if (shouldShowOriginal) {
    markdown.appendMarkdown("\n\n---\n\n");
    markdown.appendText(comment.trim());
  }

  if (!sourceMatchesTarget) {
    const toggleUri = buildToggleCommandUri({
      hoverKey,
      sourceUri: document.uri.toString(),
      line: position.line,
      character: position.character,
    });
    markdown.appendMarkdown(`\n\n[${shouldShowOriginal ? "隐藏原文" : "显示原文"}](${toggleUri})`);
  }

  return new vscode.Hover(markdown);
}

function getConfig() {
  const config = vscode.workspace.getConfiguration("hoverTranslateReplace");
  return {
    enabled: config.get("enabled", true),
    provider: config.get("provider", "google-free"),
    targetLanguage: config.get("targetLanguage", "zh-CN"),
    includeOriginal: config.get("includeOriginal", false),
    skipIfSourceMatchesTarget: config.get("skipIfSourceMatchesTarget", true),
    maxChars: config.get("maxChars", 2500),
    timeoutMs: config.get("timeoutMs", 8000),
    googleApiUrl: config.get("googleApiUrl", "https://translate.googleapis.com/translate_a/single"),
    openaiBaseUrl: config.get("openaiBaseUrl", "https://api.openai.com/v1"),
    openaiApiKey: config.get("openaiApiKey", ""),
    openaiModel: config.get("openaiModel", "gpt-4o-mini"),
    tencentSecretId: config.get("tencentSecretId", ""),
    tencentSecretKey: config.get("tencentSecretKey", ""),
    tencentRegion: config.get("tencentRegion", "ap-beijing"),
    tencentProjectId: config.get("tencentProjectId", 0),
    tencentSourceLanguage: config.get("tencentSourceLanguage", "auto"),
    tencentEndpoint: config.get("tencentEndpoint", "https://tmt.tencentcloudapi.com"),
    title: config.get("title", "译文"),
  };
}

async function readDefinitionComment(document, position, token, maxChars) {
  const definitions = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    document.uri,
    position
  );

  const locations = Array.isArray(definitions) ? definitions : definitions ? [definitions] : [];
  for (const location of locations) {
    if (token.isCancellationRequested) {
      return null;
    }

    const targetUri = location.targetUri || location.uri;
    const targetRange = location.targetSelectionRange || location.range;
    if (!targetUri || !targetRange || targetUri.scheme !== "file") {
      continue;
    }

    const targetDocument = await vscode.workspace.openTextDocument(targetUri);
    const comment = extractDocComment(targetDocument, targetRange.start.line);
    if (!comment) {
      continue;
    }

    return {
      comment: normalizeComment(comment, maxChars),
      hoverKey: buildHoverKey(targetUri, targetRange.start),
    };
  }

  const hoverComment = await readNativeHoverComment(document, position, maxChars);
  if (!hoverComment) {
    return null;
  }

  return {
    comment: hoverComment,
    hoverKey: buildHoverKey(document.uri, position),
  };
}

async function readNativeHoverComment(document, position, maxChars) {
  const requestKey = buildHoverKey(document.uri, position);
  nativeHoverExtractionSet.add(requestKey);
  try {
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      document.uri,
      position
    );
    const items = Array.isArray(hovers) ? hovers : [];
    for (const hover of items) {
      const text = extractTextFromHover(hover);
      if (!text) {
        continue;
      }
      const cleaned = cleanupHoverTextForTranslation(text);
      if (!cleaned) {
        continue;
      }
      return normalizeComment(cleaned, maxChars);
    }
  } catch (error) {
    console.warn("[hover-translate-replace] 读取原生 hover 失败:", error);
  } finally {
    nativeHoverExtractionSet.delete(requestKey);
  }

  return "";
}

function extractTextFromHover(hover) {
  if (!hover || !hover.contents) {
    return "";
  }

  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  const texts = contents
    .map((item) => hoverContentItemToText(item))
    .filter(Boolean)
    .map((item) => item.trim())
    .filter(Boolean);

  return texts.join("\n\n").trim();
}

function hoverContentItemToText(item) {
  if (!item) {
    return "";
  }
  if (typeof item === "string") {
    return item;
  }
  if (typeof item.value === "string") {
    return item.value;
  }
  if (typeof item.language === "string" && typeof item.value === "string") {
    return item.value;
  }
  return "";
}

function cleanupHoverTextForTranslation(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-=]{3,}$/gm, " ")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) {
    return "";
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const filtered = lines.filter((line, index) => {
    if (!line) {
      return false;
    }
    if (index === 0 && line.includes("::")) {
      return false;
    }
    if (/^macro_rules!/.test(line)) {
      return false;
    }
    if (/^fn\s+|^struct\s+|^enum\s+|^trait\s+|^class\s+|^interface\s+|^module\s+/i.test(line)) {
      return false;
    }
    if (/matched arm/i.test(line)) {
      return false;
    }
    return true;
  });

  return filtered.join("\n").trim();
}

function extractDocComment(document, declarationLine) {
  const languageId = document.languageId;
  if (languageId === "python") {
    return extractPythonDocComment(document, declarationLine);
  }
  if (languageId === "rust") {
    return extractRustDocComment(document, declarationLine);
  }
  return extractSlashOrBlockComment(document, declarationLine);
}

function extractSlashOrBlockComment(document, declarationLine) {
  if (declarationLine <= 0) {
    return "";
  }

  const scanStartLine = skipAnnotationLikeLines(document, declarationLine - 1);
  if (scanStartLine < 0) {
    return "";
  }

  const previousLineText = document.lineAt(scanStartLine).text.trim();
  if (!previousLineText) {
    return "";
  }

  if (previousLineText.startsWith("//")) {
    const lines = [];
    for (let line = scanStartLine; line >= 0; line -= 1) {
      const text = document.lineAt(line).text.trim();
      if (!text.startsWith("//")) {
        break;
      }
      lines.push(text.replace(/^\/\/\s?/, ""));
    }
    return lines.reverse().join("\n").trim();
  }

  if (previousLineText.endsWith("*/")) {
    const lines = [];
    let foundStart = false;
    for (let line = scanStartLine; line >= 0; line -= 1) {
      const text = document.lineAt(line).text;
      lines.push(text);
      if (text.includes("/*")) {
        foundStart = true;
        break;
      }
      if (text.trim() === "") {
        break;
      }
    }

    if (!foundStart) {
      return "";
    }

    return lines
      .reverse()
      .join("\n")
      .replace(/^\s*\/\*\s?/, "")
      .replace(/\s*\*\/\s*$/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
      .join("\n")
      .trim();
  }

  return "";
}

function skipAnnotationLikeLines(document, startLine) {
  let line = startLine;
  while (line >= 0) {
    const text = document.lineAt(line).text.trim();
    if (text === "") {
      line -= 1;
      continue;
    }
    if (isAnnotationLikeLine(text, document.languageId)) {
      line -= 1;
      continue;
    }
    break;
  }
  return line;
}

function isAnnotationLikeLine(text, languageId) {
  if (!text) {
    return false;
  }

  if (languageId === "rust") {
    return text.startsWith("#[");
  }

  if (languageId === "java" || languageId === "javascript" || languageId === "typescript" ||
      languageId === "javascriptreact" || languageId === "typescriptreact") {
    return text.startsWith("@");
  }

  return false;
}

function extractRustDocComment(document, declarationLine) {
  if (declarationLine <= 0) {
    return "";
  }

  const scanStartLine = skipAnnotationLikeLines(document, declarationLine - 1);
  if (scanStartLine < 0) {
    return "";
  }

  const lines = [];
  for (let line = scanStartLine; line >= 0; line -= 1) {
    const text = document.lineAt(line).text.trim();
    if (text.startsWith("///")) {
      lines.push(text.replace(/^\/\/\/\s?/, ""));
      continue;
    }
    if (text.startsWith("//!")) {
      lines.push(text.replace(/^\/\/!\s?/, ""));
      continue;
    }
    if (text.startsWith("//")) {
      break;
    }
    if (text === "") {
      break;
    }
    break;
  }

  if (lines.length > 0) {
    return lines.reverse().join("\n").trim();
  }

  return extractSlashOrBlockComment(document, declarationLine);
}

function extractPythonDocComment(document, declarationLine) {
  const hashComment = extractPythonHashComment(document, declarationLine);
  if (hashComment) {
    return hashComment;
  }

  return extractPythonDocstring(document, declarationLine);
}

function extractPythonHashComment(document, declarationLine) {
  if (declarationLine <= 0) {
    return "";
  }

  const lines = [];
  for (let line = declarationLine - 1; line >= 0; line -= 1) {
    const text = document.lineAt(line).text.trim();
    if (text.startsWith("#")) {
      lines.push(text.replace(/^#\s?/, ""));
      continue;
    }
    if (text === "") {
      break;
    }
    break;
  }

  return lines.length > 0 ? lines.reverse().join("\n").trim() : "";
}

function extractPythonDocstring(document, declarationLine) {
  const declarationIndent = getIndentLevel(document.lineAt(declarationLine).text);
  let line = declarationLine + 1;
  while (line < document.lineCount) {
    const rawText = document.lineAt(line).text;
    const trimmed = rawText.trim();

    if (trimmed === "") {
      line += 1;
      continue;
    }

    const indent = getIndentLevel(rawText);
    if (indent <= declarationIndent) {
      return "";
    }

    if (!trimmed.startsWith(`"""`) && !trimmed.startsWith(`'''`)) {
      return "";
    }

    return readPythonTripleQuotedString(document, line);
  }

  return "";
}

function readPythonTripleQuotedString(document, startLine) {
  const firstLine = document.lineAt(startLine).text;
  const trimmed = firstLine.trim();
  const quote = trimmed.startsWith(`"""`) ? `"""` : trimmed.startsWith(`'''`) ? `'''` : "";
  if (!quote) {
    return "";
  }

  const startIndex = firstLine.indexOf(quote);
  const afterStart = firstLine.slice(startIndex + 3);
  const sameLineEnd = afterStart.indexOf(quote);
  if (sameLineEnd >= 0) {
    return afterStart.slice(0, sameLineEnd).trim();
  }

  const lines = [];
  if (afterStart.trim()) {
    lines.push(afterStart.trimEnd());
  }

  for (let line = startLine + 1; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    const endIndex = text.indexOf(quote);
    if (endIndex >= 0) {
      const beforeEnd = text.slice(0, endIndex).trimEnd();
      if (beforeEnd) {
        lines.push(beforeEnd);
      }
      return lines.join("\n").trim();
    }
    lines.push(text.trimEnd());
  }

  return "";
}

function getIndentLevel(text) {
  const match = String(text || "").match(/^\s*/);
  return match ? match[0].length : 0;
}

function normalizeComment(comment, maxChars) {
  const normalized = comment
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trim()}\n\n...`;
}

function looksLikeTargetLanguage(text, targetLanguage) {
  const lang = String(targetLanguage || "").toLowerCase();
  const normalizedText = String(text || "");
  const cjkCount = (normalizedText.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (normalizedText.match(/[A-Za-z]/g) || []).length;
  const strippedForLanguageCheck = normalizedText
    .replace(/`[^`\n]+`/g, " ")
    .replace(/\[[^\]\n]+\]\([^)]+\)/g, " ")
    .replace(/\b[A-Za-z_][A-Za-z0-9_.:/-]{2,}\b/g, " ");
  const strippedLatinCount = (strippedForLanguageCheck.match(/[A-Za-z]/g) || []).length;

  if (lang.startsWith("zh")) {
    return cjkCount >= 6 || (cjkCount > 0 && cjkCount >= strippedLatinCount);
  }
  if (lang.startsWith("en")) {
    return latinCount > 0 && latinCount > cjkCount * 2;
  }
  return false;
}

function cleanTranslatedText(text, targetLanguage) {
  let cleaned = String(text || "").trim();
  if (!cleaned) {
    return "";
  }

  cleaned = cleaned
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]\n]+)\]/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");

  const paragraphs = cleaned
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean);

  cleaned = paragraphs.join("\n\n");

  if (String(targetLanguage || "").toLowerCase().startsWith("zh")) {
    cleaned = cleaned
      .replace(/不是\s*多个/g, "不适合多个")
      .replace(/并发使用是安全的/g, "并发使用")
      .replace(/\s+([，。；：！？])/g, "$1")
      .replace(/([（【“‘])\s+/g, "$1")
      .replace(/\s+([）】”’])/g, "$1");
  }

  return cleaned.trim();
}

function buildHoverKey(uri, position) {
  return `${uri.toString()}#${position.line}:${position.character}`;
}

function buildToggleCommandUri(payload) {
  const encoded = encodeURIComponent(JSON.stringify([payload]));
  return `command:hoverTranslateReplace.toggleOriginal?${encoded}`;
}

async function toggleOriginal(payload) {
  if (!payload || !payload.hoverKey) {
    return;
  }

  if (expandedOriginalSet.has(payload.hoverKey)) {
    expandedOriginalSet.delete(payload.hoverKey);
  } else {
    expandedOriginalSet.add(payload.hoverKey);
  }

  if (!payload.sourceUri || typeof payload.line !== "number" || typeof payload.character !== "number") {
    return;
  }

  const targetUri = vscode.Uri.parse(payload.sourceUri);
  const document = await vscode.workspace.openTextDocument(targetUri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: true,
  });
  const position = new vscode.Position(payload.line, payload.character);
  const selection = new vscode.Selection(position, position);
  editor.selection = selection;
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  await vscode.commands.executeCommand("editor.action.showHover");
}

async function replaceSelectionBidirectional() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const selection = editor.selection;
  if (!selection || selection.isEmpty) {
    vscode.window.showInformationMessage("请先选中一段文本。");
    return;
  }

  const selectedText = editor.document.getText(selection).trim();
  if (!selectedText) {
    vscode.window.showInformationMessage("选中文本为空，无法替换。");
    return;
  }

  const direction = detectBidirectionalReplacement(selectedText);
  if (!direction) {
    vscode.window.showInformationMessage("当前仅支持中英双向替换。");
    return;
  }

  const config = getConfig();
  let translated;
  try {
    translated = await translateForReplacementWithRetry(selectedText, config, direction);
  } catch (error) {
    vscode.window.showErrorMessage(`替换失败: ${error.message}`);
    return;
  }

  if (!translated || translated.trim() === selectedText) {
    vscode.window.showInformationMessage("没有得到可替换的译文。");
    return;
  }

  const normalized = direction.targetLanguage.startsWith("zh")
    ? cleanTranslatedText(translated, direction.targetLanguage)
    : translated.trim();

  const applied = await editor.edit((editBuilder) => {
    editBuilder.replace(selection, normalized);
  });

  if (!applied) {
    vscode.window.showErrorMessage("替换失败，编辑器未能应用修改。");
  }
}

async function translateForReplacementWithRetry(text, config, direction) {
  const primaryOverrides = {
    sourceLanguage: direction.sourceLanguage,
    targetLanguage: direction.targetLanguage,
  };
  const primaryTranslated = await translateWithCache(text, config, undefined, primaryOverrides);
  if (isUsefulReplacement(primaryTranslated, text)) {
    return primaryTranslated;
  }

  const fallbackOverrides = {
    sourceLanguage: "auto",
    targetLanguage: direction.targetLanguage,
  };
  if (fallbackOverrides.sourceLanguage === primaryOverrides.sourceLanguage) {
    return primaryTranslated;
  }

  const fallbackTranslated = await translateWithCache(text, config, undefined, fallbackOverrides);
  return isUsefulReplacement(fallbackTranslated, text) ? fallbackTranslated : fallbackTranslated || primaryTranslated;
}

function isUsefulReplacement(translated, original) {
  if (!translated || !String(translated).trim()) {
    return false;
  }

  const normalizedTranslated = String(translated).trim();
  const normalizedOriginal = String(original).trim();
  return normalizedTranslated.toLowerCase() !== normalizedOriginal.toLowerCase();
}

async function replaceSelectionAsPascalCase() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const selection = editor.selection;
  if (!selection || selection.isEmpty) {
    vscode.window.showInformationMessage("请先选中一段文本。");
    return;
  }

  const selectedText = editor.document.getText(selection).trim();
  if (!selectedText) {
    vscode.window.showInformationMessage("选中文本为空，无法替换。");
    return;
  }

  const config = getConfig();
  const hasCjk = /[\u3400-\u9fff]/.test(selectedText);
  let baseText = selectedText;

  if (hasCjk) {
    try {
      const translated = await translateForReplacementWithRetry(selectedText, config, {
        sourceLanguage: "zh",
        targetLanguage: "en",
      });
      if (!translated || !translated.trim()) {
        vscode.window.showInformationMessage("没有得到可用的英文结果。");
        return;
      }
      baseText = translated.trim();
    } catch (error) {
      vscode.window.showErrorMessage(`替换失败: ${error.message}`);
      return;
    }
  }

  const identifier = toPascalCaseIdentifier(baseText);
  if (!identifier) {
    vscode.window.showInformationMessage("无法生成有效的 PascalCase 名称。");
    return;
  }

  const applied = await editor.edit((editBuilder) => {
    editBuilder.replace(selection, identifier);
  });

  if (!applied) {
    vscode.window.showErrorMessage("替换失败，编辑器未能应用修改。");
  }
}

function detectBidirectionalReplacement(text) {
  const normalized = String(text || "").trim();
  const hasCjk = /[\u3400-\u9fff]/.test(normalized);
  const hasLatin = /[A-Za-z]/.test(normalized);

  if (hasCjk) {
    return {
      sourceLanguage: "zh",
      targetLanguage: "en",
    };
  }

  if (hasLatin) {
    return {
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    };
  }

  return null;
}

function toPascalCaseIdentifier(text) {
  const normalized = String(text || "")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/\[[^\]\n]+\]\([^)]+\)/g, " ")
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  const parts = normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));

  let result = parts.join("");
  if (!result) {
    return "";
  }
  if (/^[0-9]/.test(result)) {
    result = `Value${result}`;
  }
  return result;
}

async function translateWithCache(text, config, token, overrides = {}) {
  await ensurePersistentCacheLoaded();

  const targetLanguage = overrides.targetLanguage || config.targetLanguage;
  const sourceLanguage = overrides.sourceLanguage || null;
  const cacheKey = JSON.stringify({
    provider: config.provider,
    targetLanguage,
    sourceLanguage,
    text,
  });

  if (translationCache.has(cacheKey)) {
    const cached = translationCache.get(cacheKey);
    touchCacheEntry(cacheKey, cached);
    return cached;
  }

  if (token && token.isCancellationRequested) {
    return null;
  }

  const translated = await translateText(text, config, {
    targetLanguage,
    sourceLanguage,
  });
  const normalized = typeof translated === "string" ? translated.trim() : "";
  if (!normalized) {
    return null;
  }

  touchCacheEntry(cacheKey, normalized);
  schedulePersistentCacheFlush();
  return normalized;
}

async function translateText(text, config, overrides = {}) {
  if (config.provider === "tencent-cloud") {
    return translateWithTencentCloud(text, config, overrides);
  }
  if (config.provider === "openai-compatible") {
    return translateWithOpenAICompatible(text, config, overrides);
  }
  return translateWithGoogleFree(text, config, overrides);
}

async function translateWithGoogleFree(text, config, overrides = {}) {
  const url = new URL(config.googleApiUrl);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", overrides.sourceLanguage || "auto");
  url.searchParams.set("tl", overrides.targetLanguage || config.targetLanguage);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await requestJson(url, {
    method: "GET",
    timeoutMs: config.timeoutMs,
  });

  if (!Array.isArray(response) || !Array.isArray(response[0])) {
    throw new Error("google-free 翻译接口返回格式不符合预期。");
  }

  return response[0]
    .map((item) => (Array.isArray(item) ? item[0] : ""))
    .join("")
    .trim();
}

async function translateWithOpenAICompatible(text, config, overrides = {}) {
  if (!config.openaiApiKey) {
    throw new Error("未配置 hoverTranslateReplace.openaiApiKey。");
  }

  const url = new URL("/chat/completions", ensureTrailingSlash(config.openaiBaseUrl));
  const payload = {
    model: config.openaiModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          `你是专业技术翻译。请把输入文本准确翻译成 ${overrides.targetLanguage || config.targetLanguage}。` +
          `如果已知源语言是 ${overrides.sourceLanguage || "auto"}，请据此翻译。只返回译文，不要解释。`,
      },
      {
        role: "user",
        content: text,
      },
    ],
  };

  const response = await requestJson(url, {
    method: "POST",
    timeoutMs: config.timeoutMs,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const content = response &&
    Array.isArray(response.choices) &&
    response.choices[0] &&
    response.choices[0].message &&
    response.choices[0].message.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI 兼容接口未返回有效译文。");
  }

  return content.trim();
}

async function translateWithTencentCloud(text, config, overrides = {}) {
  if (!config.tencentSecretId || !config.tencentSecretKey) {
    throw new Error("未配置 hoverTranslateReplace.tencentSecretId 或 hoverTranslateReplace.tencentSecretKey。");
  }

  const endpoint = new URL(config.tencentEndpoint);
  const service = "tmt";
  const host = endpoint.host;
  const action = "TextTranslate";
  const version = "2018-03-21";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = formatTencentDate(timestamp);
  const payload = {
    SourceText: text,
    Source: mapTencentLanguageCode(overrides.sourceLanguage || config.tencentSourceLanguage || "auto"),
    Target: mapTencentLanguageCode(overrides.targetLanguage || config.targetLanguage),
    ProjectId: Number.isFinite(config.tencentProjectId) ? config.tencentProjectId : 0,
  };
  const requestBody = JSON.stringify(payload);
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedRequestPayload = sha256Hex(requestBody);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmacSha256Buffer(`TC3${config.tencentSecretKey}`, date);
  const secretService = hmacSha256Buffer(secretDate, service);
  const secretSigning = hmacSha256Buffer(secretService, "tc3_request");
  const signature = hmacSha256Hex(secretSigning, stringToSign);
  const authorization =
    `TC3-HMAC-SHA256 Credential=${config.tencentSecretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await requestJson(endpoint, {
    method: "POST",
    timeoutMs: config.timeoutMs,
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      Host: host,
      "X-TC-Action": action,
      "X-TC-Version": version,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Region": config.tencentRegion,
    },
    body: requestBody,
  });

  if (response && response.Response && response.Response.Error) {
    const error = response.Response.Error;
    throw new Error(`${error.Code || "TencentCloudError"}: ${error.Message || "请求失败"}`);
  }

  const translatedText = response &&
    response.Response &&
    typeof response.Response.TargetText === "string" &&
    response.Response.TargetText;
  if (!translatedText) {
    throw new Error("腾讯云机器翻译未返回有效译文。");
  }

  return translatedText.trim();
}

function requestJson(url, options) {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const transport = parsedUrl.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      parsedUrl,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode}: ${bodyText.slice(0, 300)}`));
            return;
          }

          try {
            resolve(JSON.parse(bodyText));
          } catch (error) {
            reject(new Error(`响应不是合法 JSON: ${error.message}`));
          }
        });
      }
    );

    request.setTimeout(options.timeoutMs || 8000, () => {
      request.destroy(new Error("请求超时。"));
    });
    request.on("error", reject);

    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function ensureTrailingSlash(baseUrl) {
  return String(baseUrl).endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function mapTencentLanguageCode(language) {
  const normalized = String(language || "").trim();
  const lower = normalized.toLowerCase();
  const mapping = {
    "auto": "auto",
    "zh": "zh",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-sg": "zh",
    "zh-tw": "zh-TW",
    "zh-hant": "zh-TW",
    "en": "en",
    "ja": "ja",
    "ko": "ko",
    "fr": "fr",
    "es": "es",
    "it": "it",
    "de": "de",
    "tr": "tr",
    "ru": "ru",
    "pt": "pt",
    "vi": "vi",
    "id": "id",
    "th": "th",
    "ms": "ms",
    "ar": "ar",
    "hi": "hi",
  };

  return mapping[lower] || normalized || "auto";
}

function formatTencentDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function sha256Hex(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function hmacSha256Buffer(key, content) {
  return crypto.createHmac("sha256", key).update(content, "utf8").digest();
}

function hmacSha256Hex(key, content) {
  return crypto.createHmac("sha256", key).update(content, "utf8").digest("hex");
}

async function ensurePersistentCacheLoaded() {
  if (persistentCache.loadPromise) {
    return persistentCache.loadPromise;
  }

  persistentCache.loadPromise = (async () => {
    try {
      await fs.mkdir(path.dirname(persistentCache.filePath), { recursive: true });
      const raw = await fs.readFile(persistentCache.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) {
        return;
      }

      for (const entry of parsed.entries) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          continue;
        }
        const [key, value] = entry;
        if (typeof key !== "string" || typeof value !== "string" || !value.trim()) {
          continue;
        }
        translationCache.set(key, value);
      }

      removeSourceLanguageEntriesFromCache();
      trimPersistentCache();
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      console.warn("[hover-translate-replace] 加载持久化缓存失败:", error);
    }
  })();

  return persistentCache.loadPromise;
}

function touchCacheEntry(key, value) {
  if (translationCache.has(key)) {
    translationCache.delete(key);
  }
  translationCache.set(key, value);
  trimPersistentCache();
}

function trimPersistentCache() {
  while (translationCache.size > persistentCache.maxEntries) {
    const oldestKey = translationCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    translationCache.delete(oldestKey);
  }
}

function removeSourceLanguageEntriesFromCache() {
  for (const [key, value] of Array.from(translationCache.entries())) {
    try {
      const parsedKey = JSON.parse(key);
      if (!parsedKey || typeof parsedKey !== "object") {
        continue;
      }

      const text = typeof parsedKey.text === "string" ? parsedKey.text : "";
      const targetLanguage = typeof parsedKey.targetLanguage === "string" ? parsedKey.targetLanguage : "";
      if (!text || !targetLanguage) {
        continue;
      }

      if (looksLikeTargetLanguage(text, targetLanguage) && String(value || "").trim() === text.trim()) {
        translationCache.delete(key);
      }
    } catch {
      continue;
    }
  }
}

function schedulePersistentCacheFlush() {
  if (persistentCache.writeTimer) {
    clearTimeout(persistentCache.writeTimer);
  }

  persistentCache.writeTimer = setTimeout(() => {
    persistentCache.writeTimer = null;
    void flushPersistentCache(false);
  }, 500);
}

async function flushPersistentCache(force) {
  await ensurePersistentCacheLoaded();

  if (persistentCache.writeTimer) {
    clearTimeout(persistentCache.writeTimer);
    persistentCache.writeTimer = null;
  }

  const payload = force
    ? {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: [],
      }
    : {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: Array.from(translationCache.entries()),
      };

  persistentCache.writePromise = persistentCache.writePromise
    .catch(() => {})
    .then(async () => {
      try {
        await fs.mkdir(path.dirname(persistentCache.filePath), { recursive: true });
        await fs.writeFile(persistentCache.filePath, JSON.stringify(payload, null, 2), "utf8");
      } catch (error) {
        console.warn("[hover-translate-replace] 写入持久化缓存失败:", error);
      }
    });

  return persistentCache.writePromise;
}

function escapeMarkdown(text) {
  return String(text).replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

function deactivate() {
  return flushPersistentCache(false);
}

module.exports = {
  activate,
  deactivate,
};
