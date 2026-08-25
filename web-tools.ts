/**
 * Web Tools Extension
 *
 * Registers two tools for the LLM:
 * - web_search: Search the web using DuckDuckGo's keyless HTML endpoint. Results
 *   go through a session cookie jar, a cheap relevance gate, and result
 *   cleaning/de-duplication, with retry-with-backoff when DDG throttles or
 *   returns an empty/blocked page.
 * - web_fetch: Fetch and read the content of a web page: readable text
 *   extraction, a selective CSS-like selector, binary/PDF refusal, a
 *   bounded download size, an internal timeout, charset sniffing, and
 *   offset/limit pagination for truncated pages.
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
// ─── HTML entity decoding (shared) ────────────────────────────────────────────

/**
 * Decode HTML entities in a string. Single source of truth for entity
 * decoding shared by htmlToText, decodeHtmlEntities, and title extraction.
 */
const NAMED_ENTITIES: Array<[RegExp, string]> = [
	[/&amp;/g, "&"],
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&#39;/g, "'"],
	[/&nbsp;/g, " "],
];

function decodeHtmlEntities(text: string): string {
	let out = text;
	for (const [re, sub] of NAMED_ENTITIES) out = out.replace(re, sub);
	out = out.replace(/&#(\d+);/g, (_m: string, num: string) =>
		String.fromCodePoint(parseInt(num, 10)),
	);
	out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m: string, hex: string) =>
		String.fromCodePoint(parseInt(hex, 16)),
	);
	return out;
}

function htmlToText(html: string): string {
	// Remove script and style elements first
	let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
	text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
	text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");

	// Replace <br> and <p>/<div>/<h1-6> with newlines
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(
		/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi,
		"\n",
	);

	// Replace <td>/<th> with tab
	text = text.replace(/<\/(td|th)>/gi, "\t");

	// Strip all remaining HTML tags
	text = text.replace(/<[^>]*>/g, "");

	// Decode HTML entities (shared decoder)
	text = decodeHtmlEntities(text);

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
 * Slice text by line offset/limit, for paginating a previously-truncated page.
 */
function sliceLines(text: string, offset: number, limit?: number): string {
	const lines = text.split("\n");
	return lines
		.slice(offset, limit == null ? undefined : offset + limit)
		.join("\n");
}

/**
 * Truncate text to a maximum number of lines and characters, appending a note
 * with the (now real) offset/limit pagination hint when truncation occurs.
 */
function truncateText(
	text: string,
	maxLines = 2000,
	maxChars = 50_000,
): { text: string; truncated: boolean } {
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
		result += `\n\n---\n*📄 Content truncated: ${maxChars.toLocaleString()} chars / ${maxLines} lines returned. Re-fetch with offset/limit (web_fetch now supports them) to read the rest.*`;
	}

	return { text: result, truncated };
}

/**
 * Shared browser-ish headers so the search engines see a real client.
 */
function browserHeaders({
	acceptLanguage = "en-US,en;q=0.9",
} = {}): Record<string, string> {
	return {
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": acceptLanguage,
	};
}

// ─── Session cookie jar ─────────────────────────────────────────────────────────

/**
 * Module-level cookie jar keyed by host. Search engines (DuckDuckGo) serve
 * noticeably better results to requests that carry a session cookie, and the
 * better results to requests that carry a session cookie, and the jar lets
 * us reuse cookies across separate tool invocations (the module stays
 * loaded inside pi). Never persisted to disk.
 */
const cookieJar = new Map<string, Map<string, string>>();

function cookieJarFor(host: string): Map<string, string> {
	let jar = cookieJar.get(host);
	if (!jar) {
		jar = new Map<string, string>();
		cookieJar.set(host, jar);
	}
	return jar;
}

/**
 * Parse Set-Cookie header(s) from a response into {name, value} pairs.
 * Uses the structured getSetCookie() when available (Node 20+ undici),
 * and falls back to a manual parse of the joined header otherwise.
 */
function readSetCookies(response: Response): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	// SAFETY: undici's Headers exposes an extra getSetCookie() that the DOM
	// Headers type omits. The cast only widens to a shape with one optional
	// method; if a given runtime lacks it, getSetCookie is undefined and the
	// manual fallback below parses the header instead.
	const headers = response.headers as unknown as {
		getSetCookie?: () => string[];
	};

	let rawCookies: string[] | undefined;
	try {
		rawCookies = headers.getSetCookie?.();
	} catch {
		rawCookies = undefined;
	}
	if (rawCookies && rawCookies.length > 0) {
		for (const raw of rawCookies) {
			const first = raw.split(";")[0]?.trim();
			const eq = first?.indexOf("=") ?? -1;
			if (first && eq > 0)
				out.push([first.slice(0, eq).trim(), first.slice(eq + 1).trim()]);
		}
		return out;
	}

	// Fallback: undici joins multiple Set-Cookie with ", " which can break on
	// Expires dates; split on ", " boundaries that are followed by name=value.
	const single = response.headers.get("set-cookie") ?? "";
	const separated = single.split(/,[\s]*(?=[^;,]+=[^;,]+(?:[,;]|$))/i);
	for (const raw of separated) {
		const trimmed = raw.trim();
		const eq = trimmed.indexOf("=");
		if (eq > 0) {
			out.push([
				trimmed.slice(0, eq).trim(),
				trimmed
					.slice(eq + 1)
					.split(";")[0]
					.trim(),
			]);
		}
	}
	return out;
}

/**
 * fetch() wrapper that mints, persists, and replays cookies per host.
 */
async function fetchWithSession(
	url: string,
	init: {
		headers?: Record<string, string>;
		signal?: AbortSignal;
		redirect?: RequestInit["redirect"];
	} = {},
): Promise<Response> {
	const host = (() => {
		try {
			return new URL(url).host;
		} catch {
			return "";
		}
	})();

	const headers = { ...(init.headers ?? {}) } satisfies Record<string, string>;
	if (host) {
		const jar = cookieJarFor(host);
		if (jar.size > 0) {
			headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
		}
	}

	const response = await fetch(url, { ...init, headers });

	if (response.status >= 300) {
		// Keep cookies set on redirect hops too (they come from the final URL).
		try {
			const finalHost = new URL(response.url).host;
			if (finalHost) {
				for (const [k, v] of readSetCookies(response))
					cookieJarFor(finalHost).set(k, v);
			}
		} catch {
			// ignore
		}
	}

	if (host) {
		for (const [k, v] of readSetCookies(response)) cookieJarFor(host).set(k, v);
	}

	return response;
}

/**
 * Async sleep honoring an abort signal; rejects with AbortError if aborted.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const done = () => {
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timer);
		};
		const onAbort = () => {
			done();
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			done();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

// ─── Search result model + validation ───────────────────────────────────────────

interface SearchResult {
	title: string;
	snippet: string;
	url: string;
}

/**
 * Validate and de-duplicate a list of results. Drops results with no real
 * http(s) URL or (optionally) empty titles, and removes duplicate URLs
 * (keeping the first occurrence). Caps at `count`.
 */
function cleanResults(raw: SearchResult[], count: number): SearchResult[] {
	const seen = new Set<string>();
	const out: SearchResult[] = [];
	for (const r of raw) {
		if (!r.url) continue;
		let parsed: URL;
		try {
			parsed = new URL(r.url);
		} catch {
			continue;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
		const u = parsed.href;
		const key = u
			.replace(/^https?:\/\//i, "")
			.replace(/\/+$/, "")
			.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ title: r.title.trim(), snippet: r.snippet.trim(), url: u });
		if (out.length >= count) break;
	}
	return out;
}

/**
 * Cheap relevance gate for scraped search results. Search engines (to a
 * degree every scraper) sometimes serves generic "degraded" pages whose
 * results share no meaningful word with the query (e.g. Hotmail/Exchange
 * links for "pi coding agent extension"). A result set counts as relevant
 * only if at least one result's title or URL contains a content term from
 * the query. When it fails, the caller falls back to a second engine.
 * Undecidable cases (no query terms to test) pass through.
 */
const QUERY_STOPWORDS = new Set([
	"and",
	"the",
	"for",
	"with",
	"from",
	"that",
	"this",
	"have",
	"what",
	"how",
	"why",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"there",
	"here",
	"can",
	"you",
	"your",
	"all",
	"any",
	"are",
	"was",
	"were",
	"been",
	"not",
	"but",
	"based",
	"about",
	"should",
	"could",
	"would",
	"will",
	"please",
	"explain",
	"give",
	"get",
	"info",
	"information",
	"using",
	"use",
	"useful",
	"top",
	"best",
	"ways",
	"way",
	"help",
	"example",
	"examples",
	"related",
	"things",
	"thing",
	"list",
	"guide",
	"tutorial",
	"show",
	"me",
	"test",
]);

function queryTermsLookRelevant(
	results: SearchResult[],
	query: string,
): boolean {
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w));
	if (terms.length === 0 || results.length === 0) return true; // can't judge

	for (const r of results) {
		const hay = `${r.title} ${r.url}`.toLowerCase();
		if (terms.some((t) => hay.includes(t))) return true;
	}
	return false;
}

// ─── DuckDuckGo Search ───────────────────────────────────────────────────────────

/**
 * Extract the real URL from DDG's redirect wrapper: //duckduckgo.com/l/?uddg=<urlencoded>&rut=...
 */
function extractDuckDuckGoUrl(href: string): string {
	const m = href.match(/[?&]uddg=([^&]+)/);
	if (m) {
		try {
			const decoded = decodeURIComponent(m[1]);
			if (decoded.startsWith("http://") || decoded.startsWith("https://"))
				return decoded;
		} catch {
			// Malformed percent-encoding: fall through and return the href as-is.
		}
	}
	return href;
}

/**
 * Parse DDG's HTML endpoint. Each result is a <div class="result ..."> with
 * a title anchor class="result__a" and a snippet anchor class="result__snippet".
 * The real URL is encoded in the uddg= parameter. We collect links and
 * snippets in document order and zip them by index (DDG emits exactly one of
 * each per organic result).
 */
function parseDuckDuckGoResults(html: string): SearchResult[] {
	const links: Array<{ title: string; url: string }> = [];
	const linkPattern =
		/<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
	let lm: RegExpExecArray | null;
	while ((lm = linkPattern.exec(html)) !== null) {
		const title = lm[2].replace(/<[^>]*>/g, "").trim();
		const url = extractDuckDuckGoUrl(lm[1]);
		if (title) links.push({ title, url });
	}

	const snippets: string[] = [];
	const snippetPattern =
		/<div class="result__snippet">[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	let sm: RegExpExecArray | null;
	while ((sm = snippetPattern.exec(html)) !== null) {
		snippets.push(sm[1].replace(/<[^>]*>/g, "").trim());
	}

	return links.map((l, i) => ({
		title: decodeHtmlEntities(l.title),
		url: l.url,
		snippet: decodeHtmlEntities(snippets[i] ?? ""),
	}));
}

/**
 * Search DuckDuckGo's HTML endpoint (no API key). DDG reliably serves real
 * organic results from scripted/datacenter clients, with retry-with-backoff
 * on throttles, blocks, and empty parses.
 */
async function duckDuckGoSearch(
	query: string,
	count: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const maxTries = 2;
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxTries; attempt++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		try {
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

			const response = await fetchWithSession(url, {
				signal,
				headers: browserHeaders(),
			});

			if (response.status === 429 || response.status === 503) {
				throw new Error(`HTTP ${response.status} (throttled)`);
			}
			if (!response.ok) {
				throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
			}

			const html = await response.text();

			// DDG's anomaly/bot interstitial.
			if (/(anomaly|captcha|challengedetected|unusual traffic)/i.test(html)) {
				throw new Error("DuckDuckGo is blocking automated requests.");
			}

			const results = cleanResults(parseDuckDuckGoResults(html), count);

			// An empty parse on DDG usually means a bot/empty page — retry once.
			// A partial parse is still acceptable.
			if (results.length > 0) {
				return results;
			}
			if (attempt < maxTries) {
				await sleep(500 * attempt, signal);
			}
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < maxTries) {
				await sleep(500 * attempt, signal);
			}
		}
	}

	if (lastError) throw lastError;
	return [];
}

// ─── Web Fetch (content fetching) ──────────────────────────────────────────────

interface FetchResult {
	title?: string;
	text: string;
	url: string;
	finalUrl: string;
	truncated: boolean;
	contentType?: string;
	charset?: string;
	byteLength: number;
}

/** Max bytes of body we will read from a page (protects against huge files). */
const MAX_DOWNLOAD_BYTES = 5_000_000; // 5 MB
/** Default time-to-fetch-and-read budget (ms) if the caller provides none. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** Content-Types treated as non-renderable binary that we refuse to read. */
const BINARY_CONTENT_TYPES = [
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/x-tar",
	"application/x-7z-compressed",
	"application/octet-stream",
	"application/vnd.ms-excel",
	"application/msword",
	"application/vnd.openxmlformats-officedocument",
	"image/",
	"audio/",
	"video/",
];

/**
 * Combine the caller's AbortSignal (if any) with a fallback timeout so a hung
 * server cannot stall the tool forever. Returns a controller to own; the caller
 * must call dispose() when done.
 */
function withTimeout(
	signal: AbortSignal | undefined,
	timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();

	const onParent = () => controller.abort(signal?.reason);
	const timer = setTimeout(() => {
		controller.abort(new DOMException("Request timed out", "TimeoutError"));
	}, timeoutMs);

	signal?.addEventListener("abort", onParent, { once: true });
	if (signal?.aborted) onParent();

	const dispose = () => {
		signal?.removeEventListener("abort", onParent);
		clearTimeout(timer);
	};
	return { signal: controller.signal, dispose };
}

/**
 * Extract a character set from a Content-Type header (e.g. "iso-8859-1").
 * Fallback heuristic: feature-detect UTF-8 from the raw bytes.
 */
function detectCharset(contentType: string, raw: Uint8Array): string {
	const m = contentType.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i);
	if (m && m[1]) {
		// Browsers default to ISO-8859-1 when HTML declares none; TextDecoder
		// defaults to UTF-8. Trust an explicit label but coerce obvious UTF-8.
		const label = m[1].toLowerCase();
		for (const name of ["utf-8", "utf8", "unicode-1-1-utf-8"]) {
			if (label === name) return "utf-8";
		}
		return label;
	}
	// No explicit charset: if the bytes are valid UTF-8, treat them as UTF-8
	// (which is nearly always correct on the modern web).
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(raw);
		return "utf-8";
	} catch {
		return "iso-8859-1";
	}
}

/**
 * Read a bounded prefix of the body. Cap bytes so a huge download can't blow
 * up memory; the returned truncated flag lets callers app a warning.
 */
async function readBody(
	response: Response,
): Promise<{ raw: Uint8Array; byteLength: number; truncated: boolean }> {
	// Refuse downloads that advertise being larger than our cap up front.
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > MAX_DOWNLOAD_BYTES) {
		throw new Error(
			`Content-Length ${(declared / 1e6).toFixed(1)} MB exceeds the ${(
				MAX_DOWNLOAD_BYTES / 1e6
			).toFixed()} MB download cap.`,
		);
	}

	const reader = response.body?.getReader();
	if (!reader) {
		const text = await response.text();
		return {
			raw: new TextEncoder().encode(text),
			byteLength: text.length,
			truncated: false,
		};
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			const remaining = total + value.byteLength;
			if (remaining > MAX_DOWNLOAD_BYTES) {
				await reader.cancel();
				const extra = value.slice(0, MAX_DOWNLOAD_BYTES - total);
				chunks.push(extra);
				total += extra.byteLength;
				truncated = true;
				break;
			}
			total = remaining;
			chunks.push(value);
		}
	}

	const raw = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		raw.set(c, off);
		off += c.byteLength;
	}
	return { raw, byteLength: total, truncated };
}

/**
 * Read the body honoring the declared (or sniffed) charset.
 */
function decodeBody(raw: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset).decode(raw);
	} catch {
		return new TextDecoder("utf-8").decode(raw);
	}
}

/**
 * Convert a page body into readable text according to its content type.
 */
function extractText(
	contentType: string,
	url: string,
	body: string,
	selector?: string,
): string {
	if (contentType.includes("application/json") || url.endsWith(".json")) {
		// For JSON responses, pretty-print
		try {
			const json = JSON.parse(body);
			return JSON.stringify(json, null, 2);
		} catch {
			return body; // Not valid JSON, return raw
		}
	}
	if (
		contentType.includes("text/html") ||
		contentType.includes("text/") ||
		contentType.includes("application/xhtml") ||
		!contentType
	) {
		return selector ? extractBySelector(body, selector) : htmlToText(body);
	}
	return body; // other textual formats, return as-is
}

/**
 * Fetch a web page and extract its readable text content.
 */
async function fetchPage(
	url: string,
	selector?: string,
	options?: { signal?: AbortSignal; offset?: number; limit?: number },
): Promise<FetchResult> {
	const { signal: parentSignal, offset = 0, limit } = options ?? {};
	const timeout = withTimeout(parentSignal);
	try {
		const response = await fetchWithSession(url, {
			signal: timeout.signal,
			headers: browserHeaders(),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") || "";
		const finalUrl = response.url || url;

		// Refuse binary content we can't render as text.
		if (BINARY_CONTENT_TYPES.some((t) => contentType.toLowerCase().includes(t))) {
			throw new Error(
				`Unsupported binary content type: ${contentType || "unknown"}. Cannot extract readable text.`,
			);
		}

		const {
			raw,
			byteLength,
			truncated: bodyTruncated,
		} = await readBody(response);
		const charset = detectCharset(contentType, raw);
		const body = decodeBody(raw, charset);

		// Extract title from raw HTML BEFORE stripping tags
		const isHtml =
			contentType.includes("text/html") ||
			contentType.includes("application/xhtml") ||
			!contentType;
		const title = isHtml
			? (extractTitle(body) ?? extractTitleFallback(body))
			: undefined;

		const text = extractText(contentType, url, body, selector);

		let resultText = text;
		let truncated = bodyTruncated;
		if (text.length > 0) {
			const sliced = sliceLines(text, offset, limit);
			// The whole page is only "truncated" for the caller when we dropped
			// body bytes OR the caller explicitly paginated with limit.
			truncated = truncated || (limit != null && sliced.length < text.length);
			resultText = sliced;
		}

		const { text: finalText, truncated: finalTruncated } =
			truncateText(resultText);

		return {
			title,
			text: finalText,
			url,
			finalUrl,
			truncated: truncated || finalTruncated || bodyTruncated,
			contentType,
			charset,
			byteLength,
		};
	} finally {
		timeout.dispose();
	}
}

/**
 * Fallback title extraction when <title> tag is not found.
 */
function extractTitleFallback(raw: string): string | undefined {
	// Try <h1> tag
	const h1Match = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
	if (h1Match) {
		return h1Match[1]
			.replace(/<[^>]*>/g, "")
			.trim()
			.slice(0, 200);
	}
	// Try meta property="og:title"
	const ogMatch = raw.match(
		/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i,
	);
	if (ogMatch) {
		return decodeHtmlEntities(ogMatch[1].trim());
	}
	// Try meta name="title"
	const metaTitleMatch = raw.match(
		/<meta[^>]*name=["']title["'][^>]*content=["']([^"']*)["']/i,
	);
	if (metaTitleMatch) {
		return decodeHtmlEntities(metaTitleMatch[1].trim());
	}
	return undefined;
}

/**
 * Escape a string for safe use inside a RegExp constructor.
 */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Simple CSS-like selector extraction using regex.
 * Supports: tag, #id, .class, and combinations like div.class or tag#id.class
 */
function extractBySelector(html: string, selector: string): string {
	// Compound selectors: div.class, tag#id, tag#id.class
	const compoundMatch = selector.match(
		/^([a-zA-Z0-9_-]+)?([#.])([a-zA-Z0-9_-]+)$/,
	);
	if (compoundMatch) {
		const tag = compoundMatch[1] || "[a-zA-Z0-9_-]+";
		const type = compoundMatch[2]; // '#' or '.'
		const value = escapeRegExp(compoundMatch[3]);

		if (type === "#") {
			const regex = new RegExp(
				`<(${tag})[^>]*id="${value}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
				"i",
			);
			const match = regex.exec(html);
			if (match) return htmlToText(match[2]);
			return `(No element found with id: ${value})`;
		}

		const regex = new RegExp(
			`<(${tag})[^>]*class="[^"]*\\b${value}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
			"gi",
		);
		const parts: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = regex.exec(html)) !== null) {
			parts.push(htmlToText(m[2]));
		}
		return (
			parts.join("\n\n---\n\n") || `(No elements found with class: ${value})`
		);
	}

	// Simple tag selectors
	if (/^[a-zA-Z0-9_-]+$/.test(selector)) {
		const regex = new RegExp(
			`<${selector}[^>]*>([\\s\\S]*?)<\\/${selector}>`,
			"gi",
		);
		const parts: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(html)) !== null) {
			parts.push(htmlToText(match[1]));
		}
		return (
			parts.join("\n\n---\n\n") || `(No content found for selector: ${selector})`
		);
	}

	// ID selectors (#id)
	if (selector.startsWith("#")) {
		const id = escapeRegExp(selector.slice(1));
		const regex = new RegExp(
			`<([a-zA-Z0-9_-]+)[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
			"i",
		);
		const match = regex.exec(html);
		if (match) return htmlToText(match[2]);
		return `(No element found with id: ${id})`;
	}

	// Class selectors (.class)
	if (selector.startsWith(".")) {
		const cls = escapeRegExp(selector.slice(1));
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

function formatResults(
	query: string,
	results: SearchResult[],
	source: string,
	note?: string,
): {
	content: Array<{ type: "text"; text: string }>;
	details: {
		query: string;
		source: string;
		count: number;
		results: SearchResult[];
	};
} {
	const formatted = results
		.map(
			(r, i) =>
				`${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet || "(no description)"}`,
		)
		.join("\n\n");

	const header = `Search results for "${query}" (via ${source})${note ? `\n*ℹ️ ${note}*` : ""}:\n\n`;

	return {
		content: [{ type: "text", text: `${header}${formatted}` }],
		details: { query, source, count: results.length, results },
	};
}

export default function (pi: ExtensionAPI) {
	// ── Register web_search tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information using DuckDuckGo. Returns titles, snippets, and URLs. " +
			"Use this when you need current information, recent events, or facts not in your training data.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"Use web_search when the user asks about current events, recent information, or topics that may have changed since your training data.",
			"Use web_search to find relevant URLs before using web_fetch to read specific pages.",
			"If results look off-topic, be more specific or quote exact terms — search engines still return noisy results for short or ambiguous queries.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query to look up on the web" }),
			count: Type.Optional(
				Type.Number({
					description: "Number of search results to return (default: 10, max: 20)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const query = params.query;
			const count = Math.min(params.count ?? 10, 20);

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Search aborted." }],
					details: { query, count: 0, results: [], aborted: true },
					isError: true,
				};
			}

			try {
				const results = await duckDuckGoSearch(query, count, signal);
				if (results.length > 0 && queryTermsLookRelevant(results, query)) {
					return formatResults(query, results, "DuckDuckGo");
				}
				if (results.length > 0) {
					// Results existed but looked off-topic (relevance gate).
					const reason = "DuckDuckGo returned results that did not match the query.";
					return {
						content: [
							{
								type: "text",
								text: `No relevant search results found for "${query}" · ${reason} Try a more specific query.`,
							},
						],
						details: { query, count: 0, results: [], errors: [reason] },
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `No search results found for "${query}". Try a different or more specific query.`,
						},
					],
					details: { query, count: 0, results: [] },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Search failed: ${message}\n\nYou can try again or use a more specific query.`,
						},
					],
					details: { query, error: message, count: 0, results: [] },
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
			"HTML tags are stripped, large pages are truncated, and binary/PDFs are refused. Use the optional CSS selector " +
			"(e.g., 'article', '#content', '.markdown-body') to extract a specific portion of the page, or offset/limit " +
			"to paginate through a truncated page.",
		promptSnippet: "Fetch and read the content of a web page by URL",
		promptGuidelines: [
			"Use web_fetch to read the actual content of interesting results found via web_search.",
			"Use the optional selector parameter to narrow to specific parts of a page (e.g., 'article', '#content', '.markdown-body').",
		],
		parameters: Type.Object({
			url: Type.String({
				description:
					"Full URL to fetch, including protocol (e.g., https://example.com/page)",
				pattern: "^https?://",
			}),
			selector: Type.Optional(
				Type.String({
					description:
						"Optional CSS selector to extract a specific portion of the page (e.g., 'article', '#content', '.markdown-body'). " +
						"Supported formats: tag name ('article'), '#id', '.class', or compound like 'div.class'.",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description:
						"Optional 0-based line offset into the page's text to start from (for paginating a previously-truncated page). Default 0.",
					minimum: 0,
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"Optional maximum number of lines to return (for paginating a previously-truncated page).",
					minimum: 1,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { url, selector, offset, limit } = params;

			try {
				const result = await fetchPage(url, selector, {
					signal,
					offset,
					limit,
				});

				let responseText = "";
				if (result.title) {
					responseText += `# ${result.title}\n\n`;
				}
				responseText += `*🔗 ${result.finalUrl}`;
				if (result.truncated) {
					responseText += ` | 📏 Content truncated`;
				}
				responseText += `*\n\n${result.text}`;

				return {
					content: [{ type: "text", text: responseText }],
					details: {
						title: result.title,
						url: result.url,
						finalUrl: result.finalUrl,
						contentType: result.contentType,
						charset: result.charset,
						byteLength: result.byteLength,
						textLength: result.text.length,
						truncated: result.truncated,
						requestedOffset: offset,
						requestedLimit: limit,
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
