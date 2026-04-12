import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function getText(node: any): string {
  if (node.value !== undefined) return node.value;
  if (!node.childNodes || node.childNodes.length === 0) return "";

  const blockElements = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "br"]);

  return node.childNodes
    .map((child: any) => {
      const tag = (child.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style") return "";

      const text = getText(child);
      if (blockElements.has(tag)) return "\n" + text;
      return text;
    })
    .join("");
}

function findFirstTag(node: any, tagName: string): any | undefined {
  if (!node) return undefined;
  if ((node.tagName || "").toLowerCase() === tagName) return node;
  if (!node.childNodes || node.childNodes.length === 0) return undefined;

  for (const child of node.childNodes) {
    const found = findFirstTag(child, tagName);
    if (found) return found;
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch the contents of a URL",
    promptGuidelines: [
      "Use this to retrieve full content from a URL found via web_search",
      "Summarize and extract key information rather than returning raw HTML when possible",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      method: Type.Optional(Type.String({ description: "HTTP method (GET, POST, etc.)" })),
      headers: Type.Optional(Type.String({ description: "Additional headers as JSON string" })),
      body: Type.Optional(Type.String({ description: "Request body for POST/PUT" })),
    }),

    async execute(_toolCallId, params) {
      try {
        const options: RequestInit = {
          method: params.method || "GET",
        };

        if (params.headers) {
          options.headers = JSON.parse(params.headers);
        }

        if (params.body && (params.method === "POST" || params.method === "PUT")) {
          options.body = params.body;
        }

        const res = await fetch(params.url, options);
        const raw = await res.text();

        let text = raw;
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        const looksLikeHtml = contentType.includes("text/html") || /<\s*html|<\s*body|<!doctype\s+html/i.test(raw);

        if (looksLikeHtml) {
          // Use dynamic require with full path to pi's node_modules
          const { parse } = require("/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/parse5");
          const doc = parse(raw);
          const body = findFirstTag(doc, "body");
          const html = findFirstTag(doc, "html");
          const root = body || html || doc;

          text = getText(root)
            .replace(/\r/g, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

          if (!text) text = raw;
        }

        if (res.ok) {
          return { content: [{ type: "text", text }], details: { status: res.status } };
        }

        return {
          content: [{ type: "text", text: `❗ HTTP ${res.status}\n\n${text}` }],
          details: { status: res.status },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❗ Error: ${err}` }],
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using Bing RSS",
    promptGuidelines: [
      "For online research: (1) use web_search to find relevant pages, (2) use web_fetch to retrieve full content from promising URLs",
      "Parse search results for titles, URLs, and descriptions to identify most relevant sources",
      "Summarize key findings from fetched pages rather than copying raw content",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
    }),

    async execute(_toolCallId, params) {
      try {
        const url = `https://www.bing.com/search?q=${encodeURIComponent(params.query)}&format=rss`;
        const res = await fetch(url);

        if (!res.ok) {
          return {
            content: [{ type: "text", text: `❗ HTTP ${res.status}` }],
            details: { status: res.status },
          };
        }

        const xml = await res.text();
        
        // Use dynamic require with full path to pi's node_modules
        const { XMLParser } = require("/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/fast-xml-parser");
        const parser = new XMLParser();
        const data = parser.parse(xml);
        const rawItems = data.rss?.channel?.item;
        const items = Array.isArray(rawItems) ? rawItems : [rawItems];
        const results: { title: string; url: string; description: string }[] = items
          .slice(0, 5)
          .map((item: any) => ({
            title: item.title || "",
            url: item.link || "",
            description: item.description || "",
          }));

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No results found" }],
            details: {},
          };
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || "(no description)"}\n`
        ).join("\n");

        return {
          content: [{ type: "text", text: `Search results for "${params.query}":\n\n${formatted}` }],
          details: { count: results.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❗ Error: ${err}` }],
          details: {},
        };
      }
    },
  });
}
