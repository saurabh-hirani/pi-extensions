# Web Search

`web-search` is a local pi extension that gives pi two basic web research tools:

- `web_search`
- `web_fetch`

This is an MVP. Internally it already uses a small provider layer so the search backend can be swapped later without changing the tool interface.

It focuses on the must-have workflow:

1. search the web
2. inspect results
3. fetch a page
4. answer with sources

## What it does

### `web_search`
Searches the public web and returns structured results.

Inputs:

- `query`
- `limit`
- `domains` (optional domain filters)
- `freshness` (`any`, `day`, `week`, `month`, `year`)

Returns:

- title
- url
- snippet
- domain
- rank

Notes:

- Domain filters are applied by adding `site:` terms to the query.
- Freshness is best-effort in this MVP.
- Results are intentionally kept short and structured so the model can decide what to fetch next.

### `web_fetch`
Fetches a web page and extracts readable text.

Inputs:

- `url`
- `maxChars`
- `extract` (`readable` or `raw`)

Returns:

- title
- url
- final URL after redirects
- content type
- estimated content length
- extracted text

## Safety

This extension includes a small set of network guardrails.

It blocks:

- non-HTTP URLs
- localhost
- loopback/private/link-local IPs
- common local hostnames like `localhost`

It also:

- uses request timeouts
- limits redirects
- trims large responses before sending them to the model

## What’s available

After loading this extension, pi can use:

- `web_search` for finding sources
- `web_fetch` for reading a source page

Recommended usage pattern:

1. call `web_search`
2. pick the most relevant result
3. call `web_fetch` on one or more results
4. summarize with links back to the sources

## Limitations

This is a basic MVP.

Current limitations:

- Search is intentionally simple and may not be ideal for every query.
- Freshness support is best-effort.
- HTML extraction is heuristic, not full article parsing.
- JavaScript-heavy pages may return partial or low-quality text.
- This extension does not yet cache results.
- The current backend is still a simple built-in provider, even though the code is now structured to support cleaner providers later.

## Install

Place the directory in one of pi’s extension locations, then reload pi:

- `~/.pi/agent/extensions/web-search/`
- `.pi/extensions/web-search/`

Then run:

```text
/reload
```

## Notes

This extension is meant to be a simple starting point for web research inside pi. It keeps the interface small and easy to swap out later if you want a different search backend or stronger extraction.