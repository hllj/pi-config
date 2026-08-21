/**
 * Web Tools Extension
 *
 * Registers two tools for the LLM:
 * - web_search: Search the web using Bing (replaced DuckDuckGo which now requires CAPTCHA)
 * - web_fetch: Fetch and read the content of a web page
 *
 * Place in ~/.pi/agent/extensions/ or .pi/extensions/
 * and restart pi or run /reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Strip HTML tags and extract readable text from HTML content.
 */
function htmlToText(html: string): string {
	// Remove script and style elements first
	let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
	text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
	text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");

	// Replace <br> and <p>/<div>/<h1-6> with newlines
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi, "\n");

	// Replace <td>/<th> with tab
	text = text.replace(/<\/(td|th)>/gi, "\t");

	// Strip all remaining HTML tags
	text = text.replace(/<[^>]*>/g, "");

	// Decode common HTML entities
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	text = text.replace(/&#(\d+);/g, (_m: string, num: string) => String.fromCodePoint(parseInt(num, 10)));
	// Decode hex HTML entities (e.g. &#x27; -> ')
	text = text.replace(/&#x([0-9a-fA-F]+);/g, (_m: string, hex: string) => String.fromCodePoint(parseInt(hex, 16)));

	// Collapse multiple newlines
	text = text.replace(/\n{3,}/g, "\n\n");

	// Trim each line
	text = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.join("\n");

	// Collapse multiple newlines again after trimming
	text = text.replace(/\n{3,}/g, "\n\n");

	return text.trim();
}

/**
 * Extract page title from raw HTML <title> tag.
 * NOTE: Must be called on raw HTML, NOT on htmlToText-processed output.
 */
function extractTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
	if (match) {
		return decodeHtmlEntities(match[1].trim());
	}
	return undefined;
}

/**
 * Decode HTML entities in a string.
 */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_m: string, num: string) => String.fromCodePoint(parseInt(num, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m: string, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Truncate text to a maximum number of lines and characters,
 * returning the truncated text and a flag indicating if truncation occurred.
 */
function truncateText(text: string, maxLines = 2000, maxChars = 50_000): { text: string; truncated: boolean } {
	let truncated = false;
	let result = text;

	if (result.length > maxChars) {
		result = result.slice(0, maxChars);
		truncated = true;
	}

	const lines = result.split("\n");
	if (lines.length > maxLines) {
		result = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}

	if (truncated) {
		result += `\n\n---\n*📄 Content truncated: ${maxChars.toLocaleString()} chars / ${maxLines} lines max. Use web_fetch with offset/limit if available.*`;
	}

	return { text: result, truncated };
}

// ─── Bing Search ────────────────────────────────────────────────────────────────

interface SearchResult {
	title: string;
	snippet: string;
	url: string;
}

/**
 * Extract the real URL from a Bing redirect URL.
 * Bing wraps all result links in: https://www.bing.com/ck/a?...&u=BASE64_ENCODED_URL...&ntb=1
 * In the HTML, & is encoded as &amp;, so we need to handle both forms.
 * The u= value is base64-encoded with a 2-byte prefix (e.g., "a1").
 */
function extractBingRedirectUrl(href: string): string {
	// Decode HTML entities first (&amp; -> &)
	const decodedHref = href
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"');

	// Try to extract u= parameter (base64-encoded URL)
	const uMatch = decodedHref.match(/[?&]u=([^&]+)/);
	if (uMatch) {
		try {
			// Get the raw base64 value (do NOT URL-decode it - + signs are valid base64 chars)
			const rawB64 = uMatch[1];
			// Strip the leading 2-byte prefix (e.g., "a1") which is Bing's internal marker
			const cleanB64 = rawB64.slice(2);
			// Use Buffer for reliable base64 decoding (cross-platform Node.js)
			const decoded = Buffer.from(cleanB64, "base64").toString("utf-8");
			if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
				return decoded;
			}
		} catch {
			// Fall through to default handling
		}
	}
	// Fallback: return href as-is
	return href;
}

/**
 * Search using Bing's HTML interface (no API key required).
 * Bing is used instead of DuckDuckGo because DDG now requires CAPTCHA challenges.
 */
async function bingSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	// Use a longer cache-busting URL to avoid bot detection
	const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;

	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});

	if (!response.ok) {
		throw new Error(`Bing search returned status ${response.status}`);
	}

	const html = await response.text();

	// Check for CAPTCHA or bot challenge
	if (html.includes("captcha") || html.includes("CAPTCHA") || html.includes("unusual traffic") || html.includes("robot")) {
		throw new Error("Search engine is blocking automated requests. Try a more specific query or try again later.");
	}

	const results: SearchResult[] = [];

	// Parse Bing's HTML results structure:
	// <li class="b_algo"> ... <h2><a href="...">title</a></h2> ... <p class="b_lineclamp2">snippet</p> ... </li>
	const algoPattern = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
	const titlePattern = /<h2[^>]*>.*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
	const snippetPattern = /<div\s+class="b_caption">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i;

	let algoMatch: RegExpExecArray | null;
	while ((algoMatch = algoPattern.exec(html)) !== null) {
		const liContent = algoMatch[1];

		// Extract title + URL
		const titleMatch = titlePattern.exec(liContent);
		if (!titleMatch) continue;

		const rawUrl = titleMatch[1];
		const rawTitle = titleMatch[2].replace(/<[^>]*>/g, "").trim();
		const title = decodeHtmlEntities(rawTitle);

		// Extract snippet
		const snippetMatch = snippetPattern.exec(liContent);
		const rawSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
		const snippet = decodeHtmlEntities(rawSnippet);

		// Resolve real URL from Bing redirect
		const url = extractBingRedirectUrl(rawUrl);

		results.push({ title, snippet, url });

		if (results.length >= count) break;
	}

	return results;
}

// ─── Web Fetch (content fetching) ──────────────────────────────────────────────

interface FetchResult {
	title?: string;
	text: string;
	url: string;
	truncated: boolean;
}

/**
 * Fetch a web page and extract its readable text content.
 */
async function fetchPage(url: string, selector?: string, signal?: AbortSignal): Promise<FetchResult> {
	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
		redirect: "follow",
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const contentType = response.headers.get("content-type") || "";
	const raw = await response.text();

	// Extract title from raw HTML BEFORE stripping tags
	const title = contentType.includes("text/html") || !contentType
		? extractTitle(raw) ?? extractTitleFallback(raw)
		: undefined;

	let text: string;

	if (contentType.includes("application/json") || url.endsWith(".json")) {
		// For JSON responses, pretty-print
		try {
			const json = JSON.parse(raw);
			text = JSON.stringify(json, null, 2);
		} catch {
			text = raw; // Not valid JSON, return raw
		}
	} else if (contentType.includes("text/html") || contentType.includes("text/") || !contentType) {
		if (selector) {
			text = extractBySelector(raw, selector);
		} else {
			text = htmlToText(raw);
		}
	} else {
		text = raw; // binary-ish or unknown, return raw
	}

	const { text: truncatedText, truncated } = truncateText(text);

	return {
		title,
		text: truncatedText,
		url,
		truncated,
	};
}

/**
 * Fallback title extraction when <title> tag is not found.
 */
function extractTitleFallback(raw: string): string | undefined {
	// Try <h1> tag
	const h1Match = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
	if (h1Match) {
		return h1Match[1].replace(/<[^>]*>/g, "").trim().slice(0, 200);
	}
	// Try meta property="og:title"
	const ogMatch = raw.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
	if (ogMatch) {
		return decodeHtmlEntities(ogMatch[1].trim());
	}
	// Try meta name="title"
	const metaTitleMatch = raw.match(/<meta[^>]*name=["']title["'][^>]*content=["']([^"']*)["']/i);
	if (metaTitleMatch) {
		return decodeHtmlEntities(metaTitleMatch[1].trim());
	}
	return undefined;
}

/**
 * Simple CSS-like selector extraction using regex.
 * Supports: tag, #id, .class, and combinations like div.class or tag#id.class
 */
function extractBySelector(html: string, selector: string): string {
	// Compound selectors: div.class, tag#id, tag#id.class
	const compoundMatch = selector.match(/^([a-zA-Z0-9_-]+)?([#.])([a-zA-Z0-9_-]+)$/);
	if (compoundMatch) {
		const tag = compoundMatch[1] || "[a-zA-Z0-9_-]+";
		const type = compoundMatch[2]; // '#' or '.'
		const value = compoundMatch[3];

		if (type === "#") {
			const regex = new RegExp(
				`<(${tag})[^>]*id="${value}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
				"i",
			);
			const match = regex.exec(html);
			if (match) return htmlToText(match[2]);
			return `(No element found with id: ${value})`;
		} else {
			const regex = new RegExp(
				`<(${tag})[^>]*class="[^"]*\\b${value}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
				"gi",
			);
			const parts: string[] = [];
			let m: RegExpExecArray | null;
			while ((m = regex.exec(html)) !== null) {
				parts.push(htmlToText(m[2]));
			}
			return parts.join("\n\n---\n\n") || `(No elements found with class: ${value})`;
		}
	}

	// Simple tag selectors
	if (/^[a-zA-Z0-9_-]+$/.test(selector)) {
		const regex = new RegExp(`<${selector}[^>]*>([\\s\\S]*?)<\\/${selector}>`, "gi");
		const parts: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(html)) !== null) {
			parts.push(htmlToText(match[1]));
		}
		return parts.join("\n\n---\n\n") || `(No content found for selector: ${selector})`;
	}

	// ID selectors (#id)
	if (selector.startsWith("#")) {
		const id = selector.slice(1);
		const regex = new RegExp(`<([a-zA-Z0-9_-]+)[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
		const match = regex.exec(html);
		if (match) return htmlToText(match[2]);
		return `(No element found with id: ${id})`;
	}

	// Class selectors (.class)
	if (selector.startsWith(".")) {
		const cls = selector.slice(1);
		const regex = new RegExp(
			`<([a-zA-Z0-9_-]+)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
			"gi",
		);
		const parts: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(html)) !== null) {
			parts.push(htmlToText(match[2]));
		}
		return parts.join("\n\n---\n\n") || `(No elements found with class: ${cls})`;
	}

	// Fallback: treat as tag with attributes
	return `(Selector "${selector}" not supported. Use simple tag names like "article", "#id", or ".class")`;
}

// ─── Extension ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Register web_search tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information. Returns titles, snippets, and URLs. " +
			"Use this when you need current information, recent events, or facts not in your training data.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"Use web_search when the user asks about current events, recent information, or topics that may have changed since your training data.",
			"Use web_search to find relevant URLs before using web_fetch to read specific pages.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query to look up on the web" }),
			count: Type.Optional(
				Type.Number({ description: "Number of search results to return (default: 10, max: 20)" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const query = params.query;
			const count = Math.min(params.count ?? 10, 20);

			try {
				const results = await bingSearch(query, count, signal);

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No search results found for "${query}". Try a different query.`,
							},
						],
						details: { query, count: 0, results: [] },
					};
				}

				const formatted = results
					.map(
						(r, i) =>
							`${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet || "(no description)"}`,
					)
					.join("\n\n");

				return {
					content: [
						{
							type: "text",
							text: `Search results for "${query}":\n\n${formatted}`,
						},
					],
					details: { query, count: results.length, results },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Search failed: ${message}. You can try again or use a more specific query.`,
						},
					],
					details: { query, error: message, results: [] },
					isError: true,
				};
			}
		},
	});

	// ── Register web_fetch tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch the content of a web page by URL. Returns the page title and readable text content. " +
			"HTML tags are stripped, and large pages are truncated. Use the optional CSS selector " +
			"(e.g., 'article', '#content', '.markdown-body') to extract a specific portion of the page.",
		promptSnippet: "Fetch and read the content of a web page by URL",
		promptGuidelines: [
			"Use web_fetch to read the actual content of interesting results found via web_search.",
			"Use the optional selector parameter to narrow to specific parts of a page (e.g., 'article', '#content', '.markdown-body').",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "Full URL to fetch, including protocol (e.g., https://example.com/page)",
				pattern: "^https?://",
			}),
			selector: Type.Optional(
				Type.String({
					description:
						"Optional CSS selector to extract a specific portion of the page (e.g., 'article', '#content', '.markdown-body'). " +
						"Supported formats: tag name ('article'), '#id', '.class', or compound like 'div.class'.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { url, selector } = params;

			try {
				const result = await fetchPage(url, selector, signal);

				let responseText = "";
				if (result.title) {
					responseText += `# ${result.title}\n\n`;
				}
				responseText += `*🔗 ${result.url}`;
				if (result.truncated) {
					responseText += ` | 📏 Content truncated`;
				}
				responseText += `*\n\n${result.text}`;

				return {
					content: [{ type: "text", text: responseText }],
					details: {
						title: result.title,
						url: result.url,
						truncated: result.truncated,
						textLength: result.text.length,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch ${url}: ${message}`,
						},
					],
					details: { url, error: message },
					isError: true,
				};
			}
		},
	});
}