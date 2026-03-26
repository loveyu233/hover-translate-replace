const http = require("http");
const https = require("https");
const vscode = require("vscode");

const translationCache = new Map();

function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: "go", scheme: "file" }, {
      provideHover(document, position, token) {
        return provideTranslatedHover(document, position, token);
      },
    }),
    vscode.commands.registerCommand("goHoverTranslate.clearCache", () => {
      translationCache.clear();
      vscode.window.showInformationMessage("Go 悬浮翻译缓存已清空。");
    })
  );
}

async function provideTranslatedHover(document, position, token) {
  const config = getConfig();
  if (!config.enabled) {
    return null;
  }

  const comment = await readDefinitionComment(document, position, token, config.maxChars);
  if (!comment) {
    return null;
  }

  if (config.skipIfSourceMatchesTarget && looksLikeTargetLanguage(comment, config.targetLanguage)) {
    return null;
  }

  const translated = await translateWithCache(comment, config, token);
  if (!translated) {
    return null;
  }
  const cleaned = cleanTranslatedText(translated, config.targetLanguage);
  if (!cleaned) {
    return null;
  }

  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;

  if (config.title) {
    markdown.appendMarkdown(`**${escapeMarkdown(config.title)}**\n\n`);
  }
  markdown.appendText(cleaned);

  if (config.includeOriginal) {
    markdown.appendMarkdown("\n\n---\n\n");
    markdown.appendText(comment.trim());
  }

  return new vscode.Hover(markdown);
}

function getConfig() {
  const config = vscode.workspace.getConfiguration("goHoverTranslate");
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

    return normalizeComment(comment, maxChars);
  }

  return null;
}

function extractDocComment(document, declarationLine) {
  if (declarationLine <= 0) {
    return "";
  }

  const previousLineText = document.lineAt(declarationLine - 1).text.trim();
  if (!previousLineText) {
    return "";
  }

  if (previousLineText.startsWith("//")) {
    const lines = [];
    for (let line = declarationLine - 1; line >= 0; line -= 1) {
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
    for (let line = declarationLine - 1; line >= 0; line -= 1) {
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
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;

  if (lang.startsWith("zh")) {
    return cjkCount > 0 && cjkCount >= latinCount;
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

async function translateWithCache(text, config, token) {
  const cacheKey = JSON.stringify({
    provider: config.provider,
    targetLanguage: config.targetLanguage,
    text,
  });

  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  if (token.isCancellationRequested) {
    return null;
  }

  const translated = await translateText(text, config);
  const normalized = typeof translated === "string" ? translated.trim() : "";
  if (!normalized) {
    return null;
  }

  translationCache.set(cacheKey, normalized);
  return normalized;
}

async function translateText(text, config) {
  if (config.provider === "openai-compatible") {
    return translateWithOpenAICompatible(text, config);
  }
  return translateWithGoogleFree(text, config);
}

async function translateWithGoogleFree(text, config) {
  const url = new URL(config.googleApiUrl);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", config.targetLanguage);
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

async function translateWithOpenAICompatible(text, config) {
  if (!config.openaiApiKey) {
    throw new Error("未配置 goHoverTranslate.openaiApiKey。");
  }

  const url = new URL("/chat/completions", ensureTrailingSlash(config.openaiBaseUrl));
  const payload = {
    model: config.openaiModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `你是专业技术翻译，请把 Go 注释准确翻译成 ${config.targetLanguage}，只返回译文，不要解释。`,
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

function escapeMarkdown(text) {
  return String(text).replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
