import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const DEFAULT_FETCH_CHARS = 12_000;
const MAX_FETCH_CHARS = 30_000;
const MAX_HTML_BYTES = 1_000_000;

const commonHeaders = {
  "user-agent": "pi-web-search-extension/0.1 (+https://pi.dev)",
  accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.8",
};

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  domain?: string;
  publishedAt?: string;
  rank: number;
};

type SearchInput = {
  query: string;
  limit: number;
  domains?: string[];
  freshness?: "any" | "day" | "week" | "month" | "year";
};

type SearchProviderResult = {
  provider: string;
  normalizedQuery: string;
  results: SearchResult[];
};

type SearchProvider = {
  search(input: SearchInput, signal?: AbortSignal): Promise<SearchProviderResult>;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal | undefined {
  return combineSignals(AbortSignal.timeout(ms), signal);
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\t/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ ]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toAbsoluteUrl(candidate: string, base: string): string | null {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  return normalizeWhitespace(decodeEntities(stripTags(match[1])));
}

function extractMetaDescription(html: string): string | undefined {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)
    ?? html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i);
  if (!match) return undefined;
  return normalizeWhitespace(decodeEntities(match[1]));
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars).trimEnd() + "\n\n[truncated]";
}

function scoreCandidateHtml(html: string): number {
  const text = normalizeWhitespace(decodeEntities(stripTags(html)));
  if (!text) return 0;

  let score = text.length;
  const paragraphCount = (html.match(/<p\b/gi) || []).length;
  const headingCount = (html.match(/<h[1-3]\b/gi) || []).length;
  score += paragraphCount * 180;
  score += headingCount * 120;

  if (/<(article|main)\b/i.test(html)) score += 1200;
  if (/role=["']main["']/i.test(html)) score += 900;
  if (/(content|article|post|markdown|docs|documentation|readme)/i.test(html)) score += 500;
  if (/(comment|footer|header|nav|menu|sidebar|related|breadcrumb|toolbar|modal|dialog)/i.test(html)) score -= 800;

  return score;
}

function pickMainContentHtml(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;

  const candidates = [body];
  const patterns = [
    /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    /<([a-z0-9]+)\b[^>]*(id|class)=["'][^"']*(content|article|post|markdown-body|readme|documentation|docs|main)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
    /<([a-z0-9]+)\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/\1>/gi,
  ];

  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const chunk = match[0];
      if (chunk) candidates.push(chunk);
    }
  }

  let best = body;
  let bestScore = scoreCandidateHtml(body);
  for (const candidate of candidates) {
    const score = scoreCandidateHtml(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function cleanExtractedText(html: string): string {
  const source = pickMainContentHtml(html);

  const withoutBoilerplate = source
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(header|footer|nav|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<([a-z0-9]+)\b[^>]*(id|class)=["'][^"']*(comment|footer|header|nav|menu|sidebar|related|breadcrumb|toolbar|modal|dialog|cookie|consent|popup)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(article|main|section|p|div|li|h1|h2|h3|h4|h5|h6|pre|code|blockquote|br|tr|hr)\b/gi, "\n<$1")
    .replace(/<\/p>|<\/div>|<\/li>|<\/section>|<\/article>|<\/main>|<\/pre>|<\/blockquote>|<\/tr>|<\/h[1-6]>|<br\s*\/?>|<hr\s*\/?>/gi, "\n")
    .replace(/<(ul|ol|table)\b[^>]*>/gi, "\n")
    .replace(/<\/ul>|<\/ol>|<\/table>/gi, "\n")
    .replace(/<td\b[^>]*>/gi, " ")
    .replace(/<th\b[^>]*>/gi, " ");

  return normalizeWhitespace(decodeEntities(stripTags(withoutBoilerplate)));
}

function getHostname(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

async function assertSafeUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Only http/https URLs are allowed: ${input}`);
  }

  const hostname = url.hostname.toLowerCase();
  if (["localhost", "localhost.localdomain"].includes(hostname) || hostname.endsWith(".local")) {
    throw new Error(`Blocked local hostname: ${hostname}`);
  }

  const directIpKind = isIP(hostname);
  if (directIpKind === 4 && isPrivateIpv4(hostname)) {
    throw new Error(`Blocked private IP: ${hostname}`);
  }
  if (directIpKind === 6 && isPrivateIpv6(hostname)) {
    throw new Error(`Blocked private IP: ${hostname}`);
  }

  const resolved = await lookup(hostname, { all: true });
  for (const entry of resolved) {
    if ((entry.family === 4 && isPrivateIpv4(entry.address)) || (entry.family === 6 && isPrivateIpv6(entry.address))) {
      throw new Error(`Blocked private network target: ${hostname}`);
    }
  }

  return url;
}

async function fetchTextWithRedirects(url: string, signal?: AbortSignal): Promise<{ finalUrl: string; contentType: string; text: string }> {
  let current = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const safeUrl = await assertSafeUrl(current);
    const response = await fetch(safeUrl, {
      method: "GET",
      headers: commonHeaders,
      redirect: "manual",
      signal: withTimeout(DEFAULT_TIMEOUT_MS, signal),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without location from ${current}`);
      const next = toAbsoluteUrl(location, current);
      if (!next) throw new Error(`Invalid redirect target from ${current}`);
      current = next;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status} ${response.statusText}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/") && !contentType.includes("html") && !contentType.includes("xml")) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    }

    const text = await response.text();
    return {
      finalUrl: current,
      contentType,
      text: text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text,
    };
  }

  throw new Error(`Too many redirects for ${url}`);
}

function buildSearchQuery(query: string, domains?: string[]): string {
  const domainTerms = (domains ?? [])
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.replace(/^https?:\/\//, "").replace(/\/$/, ""))
    .map((d) => `site:${d}`);
  return [query.trim(), ...domainTerms].filter(Boolean).join(" ");
}

function parseSearchResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const anchors = Array.from(html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([\s\S]*?)["'][^>]*>([\s\S]*?)<\/a>/gi));

  for (const match of anchors) {
    const href = decodeEntities(match[1]);
    const title = normalizeWhitespace(decodeEntities(stripTags(match[2])));
    if (!href || !title) continue;

    let finalHref = href;
    try {
      const url = new URL(href, SEARCH_ENDPOINT);
      if (url.hostname.includes("duckduckgo.com")) {
        const uddg = url.searchParams.get("uddg");
        if (uddg) finalHref = decodeURIComponent(uddg);
      }
    } catch {
      // Keep href as-is.
    }

    try {
      const parsed = new URL(finalHref);
      const domain = parsed.hostname.replace(/^www\./, "");
      if (!["http:", "https:"].includes(parsed.protocol)) continue;

      const seen = results.some((r) => r.url === parsed.toString());
      if (seen) continue;

      results.push({
        title,
        url: parsed.toString(),
        domain,
        rank: results.length + 1,
      });
    } catch {
      continue;
    }

    if (results.length >= limit) break;
  }

  const snippets = Array.from(html.matchAll(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>|<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi));
  for (let i = 0; i < Math.min(results.length, snippets.length); i++) {
    const snippetHtml = snippets[i][1] || snippets[i][2] || "";
    const snippet = normalizeWhitespace(decodeEntities(stripTags(snippetHtml)));
    if (snippet) results[i].snippet = snippet;
  }

  return results;
}

const duckDuckGoHtmlProvider: SearchProvider = {
  async search(input, signal) {
    const q = buildSearchQuery(input.query, input.domains);
    const body = new URLSearchParams({ q });
    if (input.freshness && input.freshness !== "any") {
      body.set("df", input.freshness[0]);
    }

    const response = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: withTimeout(DEFAULT_TIMEOUT_MS, signal),
    });

    if (!response.ok) {
      throw new Error(`Search failed with ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    return {
      provider: "duckduckgo-html",
      normalizedQuery: q,
      results: parseSearchResults(html, input.limit),
    };
  },
};

export default function webSearch(pi: ExtensionAPI) {
  const searchProvider = duckDuckGoHtmlProvider;
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web and return structured search results with titles, URLs, snippets, and domains.",
    promptSnippet: "Search the web for current information, documentation, or recent facts.",
    promptGuidelines: [
      "Use web_search when the user needs current, external, or web-only information.",
      "After web_search, use web_fetch on the most relevant result before making strong claims.",
      "Prefer official documentation or primary sources when available.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default 5, max 10)." })),
      domains: Type.Optional(Type.Array(Type.String({ description: "Optional domain filter like nextjs.org or docs.python.org." }))),
      freshness: Type.Optional(Type.Union([
        Type.Literal("any"),
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ], { description: "Best-effort freshness hint." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Searching the web for: ${params.query}` }] });

      const limit = clamp(Math.floor(params.limit ?? DEFAULT_SEARCH_LIMIT), 1, MAX_SEARCH_LIMIT);
      const providerResult = await searchProvider.search({
        query: params.query,
        limit,
        domains: params.domains,
        freshness: params.freshness ?? "any",
      }, signal);
      const { results } = providerResult;

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No search results found for: ${params.query}` }],
          details: {
            provider: providerResult.provider,
            query: params.query,
            normalizedQuery: providerResult.normalizedQuery,
            resultCount: 0,
            results: [],
            freshness: params.freshness ?? "any",
          },
        };
      }

      const lines = results.map((result) => {
        const snippet = result.snippet ? `\n   ${result.snippet}` : "";
        return `${result.rank}. ${result.title}\n   ${result.url}${snippet}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: {
          provider: providerResult.provider,
          query: params.query,
          normalizedQuery: providerResult.normalizedQuery,
          resultCount: results.length,
          results,
          freshness: params.freshness ?? "any",
        },
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page, extract readable content, and return metadata for source-aware answers.",
    promptSnippet: "Fetch and extract a web page after selecting a promising search result.",
    promptGuidelines: [
      "Use web_fetch after web_search to inspect a source page.",
      "Prefer fetching one or more primary sources before summarizing.",
      "Use extracted title and final URL when citing the source.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The page URL to fetch." }),
      maxChars: Type.Optional(Type.Number({ description: "Maximum number of characters to return from the extracted content (default 12000, max 30000)." })),
      extract: Type.Optional(Type.Union([
        Type.Literal("readable"),
        Type.Literal("raw"),
      ], { description: "readable extracts cleaned text. raw returns minimally cleaned page text." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Fetching: ${params.url}` }] });

      const mode = params.extract ?? "readable";
      const maxChars = clamp(Math.floor(params.maxChars ?? DEFAULT_FETCH_CHARS), 500, MAX_FETCH_CHARS);
      const { finalUrl, contentType, text } = await fetchTextWithRedirects(params.url, signal);
      const title = extractTitle(text) || getHostname(finalUrl);
      const metaDescription = extractMetaDescription(text);
      const extracted = mode === "raw"
        ? normalizeWhitespace(decodeEntities(stripTags(text)))
        : cleanExtractedText(text);
      const content = truncate(extracted, maxChars);

      const summaryLines = [
        `Title: ${title}`,
        `URL: ${params.url}`,
        `Final URL: ${finalUrl}`,
        `Content-Type: ${contentType || "unknown"}`,
      ];
      if (metaDescription) summaryLines.push(`Description: ${truncate(metaDescription, 300)}`);
      summaryLines.push("", content || "(no extractable text found)");

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: {
          url: params.url,
          finalUrl,
          hostname: getHostname(finalUrl),
          title,
          contentType,
          mode,
          maxChars,
          estimatedInputChars: text.length,
          metaDescription,
          content,
        },
      };
    },
  });
}
