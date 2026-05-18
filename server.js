import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const QUOTE_TTL_MS = 4_000;
const SEARCH_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

const cache = new Map();
let yahooSession = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^=\-]/g, "");
}

function cleanQuery(query) {
  return String(query || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function parseSymbols(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map(cleanSymbol)
      .filter(Boolean)
  )].slice(0, 30);
}

function cleanCurrency(currency) {
  return String(currency || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
}

function parseCurrencies(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map(cleanCurrency)
      .filter((currency) => currency.length === 3)
  )].slice(0, 20);
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;=]+?=)/g) : [];
}

function cookieHeader(setCookies) {
  return setCookies
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 StockConverter/1.0",
        ...headers
      }
    });

    if (!response.ok) {
      throw new Error(`Finance request failed with ${response.status}`);
    }

    return {
      headers: response.headers,
      text: await response.text()
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetchText(url, headers);
  return JSON.parse(response.text);
}

async function getYahooSession(forceRefresh = false) {
  if (!forceRefresh && yahooSession && Date.now() - yahooSession.time < 60 * 60_000) {
    return yahooSession;
  }

  const cookieResponse = await fetchText("https://fc.yahoo.com", {
    "Accept": "text/html,application/xhtml+xml"
  });
  let cookie = cookieHeader(getSetCookieHeaders(cookieResponse.headers));

  if (!cookie) {
    const financeResponse = await fetchText("https://finance.yahoo.com/quote/TSLA", {
      "Accept": "text/html,application/xhtml+xml"
    });
    cookie = cookieHeader(getSetCookieHeaders(financeResponse.headers));
  }

  if (!cookie) {
    throw new Error("Unable to create Yahoo Finance session.");
  }

  const crumbResponse = await fetchText("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    "Accept": "text/plain",
    "Cookie": cookie
  });
  const crumb = crumbResponse.text.trim();

  if (!crumb || crumb.includes("{")) {
    throw new Error("Unable to retrieve Yahoo Finance crumb.");
  }

  yahooSession = { cookie, crumb, time: Date.now() };
  return yahooSession;
}

function lastNumber(values = []) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return null;
}

function firstNumber(...values) {
  return values.find((value) => Number.isFinite(value)) ?? null;
}

function fieldNumber(source, key) {
  const value = source?.[key];

  if (Number.isFinite(value)) return value;
  if (Number.isFinite(value?.raw)) return value.raw;

  return null;
}

function fieldString(source, key) {
  const value = source?.[key];

  if (typeof value === "string") return value;
  if (typeof value?.fmt === "string") return value.fmt;
  if (typeof value?.raw === "string") return value.raw;

  return "";
}

function lastChartPoint(values = [], timestamps = []) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) {
      return {
        value: values[i],
        time: Number.isFinite(timestamps[i]) ? timestamps[i] : null
      };
    }
  }

  return { value: null, time: null };
}

function sessionLabel(source) {
  if (source === "preMarket") return "Pre-market";
  if (source === "afterHours") return "After-hours";
  if (source === "overnight") return "Overnight";
  return "Regular";
}

async function getQuoteSnapshot(symbol) {
  const cacheKey = `snapshot:${symbol}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.time < QUOTE_TTL_MS) {
    return cached.value;
  }

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const data = await fetchJson(url);
  const snapshot = data?.quoteResponse?.result?.[0] || null;

  if (!snapshot) {
    throw new Error(`No quote snapshot found for ${symbol}`);
  }

  cache.set(cacheKey, { time: Date.now(), value: snapshot });
  return snapshot;
}

async function getQuoteSummaryPrice(symbol) {
  const cacheKey = `summary:${symbol}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.time < QUOTE_TTL_MS) {
    return cached.value;
  }

  const getSummary = async (forceRefresh = false) => {
    const session = await getYahooSession(forceRefresh);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?formatted=false&lang=en-US&region=US&modules=price&corsDomain=finance.yahoo.com&crumb=${encodeURIComponent(session.crumb)}`;
    return fetchJson(url, { "Cookie": session.cookie });
  };
  let data = await getSummary();

  if (data?.finance?.error) {
    data = await getSummary(true);
  }

  if (data?.finance?.error) {
    throw new Error(data.finance.error.description || `No overnight price data found for ${symbol}`);
  }

  const price = data?.quoteSummary?.result?.[0]?.price || null;

  if (!price) {
    throw new Error(`No overnight price data found for ${symbol}`);
  }

  cache.set(cacheKey, { time: Date.now(), value: price });
  return price;
}

async function getChartQuote(symbol) {
  const cacheKey = `quote:${symbol}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.time < QUOTE_TTL_MS) {
    return cached.value;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
  const [data, snapshotResult, summaryResult] = await Promise.all([
    fetchJson(url),
    getQuoteSnapshot(symbol).catch(() => null),
    getQuoteSummaryPrice(symbol).catch(() => null)
  ]);
  const result = data?.chart?.result?.[0];

  if (!result) {
    const message = data?.chart?.error?.description || `No market data found for ${symbol}`;
    throw new Error(message);
  }

  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const snapshot = snapshotResult || {};
  const summary = summaryResult || {};
  const latestChartPoint = lastChartPoint(quote.close, result.timestamp);
  const regularMarketTime = firstNumber(
    fieldNumber(summary, "regularMarketTime"),
    snapshot.regularMarketTime,
    meta.regularMarketTime
  );
  const regularMarketPrice = firstNumber(
    fieldNumber(summary, "regularMarketPrice"),
    snapshot.regularMarketPrice,
    meta.regularMarketPrice,
    latestChartPoint.value,
    lastNumber(quote.close)
  );
  const previousClose = firstNumber(
    fieldNumber(summary, "regularMarketPreviousClose"),
    snapshot.regularMarketPreviousClose,
    snapshot.previousClose,
    meta.chartPreviousClose,
    meta.previousClose
  );
  const marketState = fieldString(summary, "marketState") || snapshot.marketState || meta.marketState || "";
  const preMarketPrice = firstNumber(fieldNumber(summary, "preMarketPrice"), snapshot.preMarketPrice);
  const postMarketPrice = firstNumber(fieldNumber(summary, "postMarketPrice"), snapshot.postMarketPrice);
  const overnightMarketPrice = firstNumber(fieldNumber(summary, "overnightMarketPrice"), snapshot.overnightMarketPrice);
  const preMarketTime = firstNumber(fieldNumber(summary, "preMarketTime"), snapshot.preMarketTime);
  const postMarketTime = firstNumber(fieldNumber(summary, "postMarketTime"), snapshot.postMarketTime);
  const overnightMarketTime = firstNumber(fieldNumber(summary, "overnightMarketTime"), snapshot.overnightMarketTime);
  let price = regularMarketPrice;
  let priceTime = regularMarketTime;
  let priceSource = "regular";
  const sessionCandidates = [
    { source: "regular", price: regularMarketPrice, time: regularMarketTime },
    { source: "preMarket", price: preMarketPrice, time: preMarketTime },
    { source: "afterHours", price: postMarketPrice, time: postMarketTime },
    { source: "overnight", price: overnightMarketPrice, time: overnightMarketTime }
  ]
    .filter((item) => Number.isFinite(item.price) && Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time);

  if ((marketState === "PREPRE" || marketState === "POSTPOST") && Number.isFinite(overnightMarketPrice)) {
    price = overnightMarketPrice;
    priceTime = overnightMarketTime;
    priceSource = "overnight";
  } else if (marketState === "PRE" && Number.isFinite(preMarketPrice)) {
    price = preMarketPrice;
    priceTime = preMarketTime;
    priceSource = "preMarket";
  } else if ((marketState.startsWith("POST") || marketState === "CLOSED") && Number.isFinite(postMarketPrice)) {
    price = postMarketPrice;
    priceTime = postMarketTime;
    priceSource = "afterHours";
  } else if (
    Number.isFinite(postMarketPrice)
    && Number.isFinite(postMarketTime)
    && Number.isFinite(regularMarketTime)
    && postMarketTime > regularMarketTime
  ) {
    price = postMarketPrice;
    priceTime = postMarketTime;
    priceSource = "afterHours";
  } else if (
    sessionCandidates[0]
    && sessionCandidates[0].source !== "regular"
    && (!Number.isFinite(regularMarketTime) || sessionCandidates[0].time >= regularMarketTime)
  ) {
    price = sessionCandidates[0].price;
    priceTime = sessionCandidates[0].time;
    priceSource = sessionCandidates[0].source;
  } else if (
    Number.isFinite(latestChartPoint.value)
    && Number.isFinite(latestChartPoint.time)
    && Number.isFinite(regularMarketTime)
    && latestChartPoint.time > regularMarketTime
  ) {
    price = latestChartPoint.value;
    priceTime = latestChartPoint.time;
    priceSource = "afterHours";
  }

  const change = Number.isFinite(price) && Number.isFinite(previousClose)
    ? price - previousClose
    : null;
  const changePercent = Number.isFinite(change) && previousClose
    ? (change / previousClose) * 100
    : null;
  const extendedChange = priceSource === "regular" || !Number.isFinite(price) || !Number.isFinite(regularMarketPrice)
    ? null
    : price - regularMarketPrice;
  const extendedChangePercent = Number.isFinite(extendedChange) && regularMarketPrice
    ? (extendedChange / regularMarketPrice) * 100
    : null;

  if (!Number.isFinite(price)) {
    throw new Error(`No live price returned for ${symbol}`);
  }

  const payload = {
    symbol,
    yahooSymbol: snapshot.symbol || meta.symbol || symbol,
    price,
    priceSource,
    sessionLabel: sessionLabel(priceSource),
    regularMarketPrice,
    previousClose,
    change,
    changePercent,
    extendedChange,
    extendedChangePercent,
    overnightMarketPrice,
    overnightMarketTime: Number.isFinite(overnightMarketTime)
      ? new Date(overnightMarketTime * 1000).toISOString()
      : null,
    currency: fieldString(summary, "currency") || snapshot.currency || meta.currency || "USD",
    exchangeName: fieldString(summary, "exchangeName") || snapshot.fullExchangeName || snapshot.exchange || meta.exchangeName || "",
    marketState,
    updatedAt: Number.isFinite(priceTime)
      ? new Date(priceTime * 1000).toISOString()
      : new Date().toISOString()
  };

  cache.set(cacheKey, { time: Date.now(), value: payload });
  return payload;
}

async function resolveSecurity(query) {
  const cleanedQuery = cleanQuery(query);
  const directSymbol = cleanSymbol(cleanedQuery);

  if (!cleanedQuery) {
    throw new Error("Enter a ticker or company name.");
  }

  if (directSymbol) {
    try {
      const quote = await getChartQuote(directSymbol);
      return {
        query: cleanedQuery,
        symbol: quote.yahooSymbol || directSymbol,
        name: quote.yahooSymbol || directSymbol,
        exchangeName: quote.exchangeName,
        quoteType: "EQUITY"
      };
    } catch {
      // Fall through to Yahoo's search index for company-name entries.
    }
  }

  const cacheKey = `search:${cleanedQuery.toLowerCase()}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.time < SEARCH_TTL_MS) {
    return cached.value;
  }

  const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(cleanedQuery)}&quotesCount=8&newsCount=0&enableFuzzyQuery=true`;
  const data = await fetchJson(searchUrl);
  const candidates = Array.isArray(data?.quotes) ? data.quotes : [];
  const supportedTypes = new Set(["EQUITY", "ETF", "MUTUALFUND", "INDEX"]);
  const marketCandidates = candidates.filter((item) => item.symbol && supportedTypes.has(item.quoteType));
  const preferred = marketCandidates.find((item) => cleanSymbol(item.symbol) === directSymbol) || marketCandidates[0];

  if (!preferred?.symbol) {
    throw new Error(`No ticker found for "${cleanedQuery}".`);
  }

  const resolved = {
    query: cleanedQuery,
    symbol: cleanSymbol(preferred.symbol),
    name: preferred.shortname || preferred.longname || preferred.name || preferred.symbol,
    exchangeName: preferred.exchDisp || preferred.exchange || "",
    quoteType: preferred.quoteType || ""
  };

  cache.set(cacheKey, { time: Date.now(), value: resolved });
  return resolved;
}

async function getResolvedQuote(input) {
  const requestedSymbol = cleanSymbol(input);

  try {
    const quote = await getChartQuote(requestedSymbol);
    return { ...quote, requestedSymbol };
  } catch (quoteError) {
    const resolved = await resolveSecurity(input);

    if (!resolved.symbol || resolved.symbol === requestedSymbol) {
      throw quoteError;
    }

    const quote = await getChartQuote(resolved.symbol);
    return {
      ...quote,
      symbol: resolved.symbol,
      requestedSymbol,
      resolvedFrom: input,
      name: resolved.name
    };
  }
}

async function getFxRate(fromCurrency, toCurrency) {
  const from = cleanCurrency(fromCurrency);
  const to = cleanCurrency(toCurrency);

  if (!from || !to) {
    throw new Error("A three-letter currency code is required.");
  }

  if (from === to) return 1;

  if (from === "INR" && to === "USD") {
    return 1 / await getFxRate("USD", "INR");
  }

  try {
    return (await getChartQuote(`${from}${to}=X`)).price;
  } catch (error) {
    if (from !== "USD" && to !== "USD") {
      const [fromToUsd, usdToTarget] = await Promise.all([
        getFxRate(from, "USD"),
        getFxRate("USD", to)
      ]);
      return fromToUsd * usdToTarget;
    }

    throw error;
  }
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === "/api/resolve") {
      const resolved = await resolveSecurity(url.searchParams.get("query"));
      json(res, 200, resolved);
      return;
    }

    if (url.pathname === "/api/quotes") {
      const symbols = parseSymbols(url.searchParams.get("symbols"));

      if (!symbols.length) {
        json(res, 400, { error: "Add at least one stock symbol." });
        return;
      }

      const settled = await Promise.allSettled(symbols.map(getResolvedQuote));
      const quotes = settled
        .filter((item) => item.status === "fulfilled")
        .map((item) => item.value);
      const errors = settled
        .map((item, index) => item.status === "rejected"
          ? { symbol: symbols[index], message: item.reason.message }
          : null)
        .filter(Boolean);

      json(res, errors.length && !quotes.length ? 502 : 200, {
        quotes,
        errors,
        refreshedAt: new Date().toISOString()
      });
      return;
    }

    if (url.pathname === "/api/rates") {
      const currencies = parseCurrencies(url.searchParams.get("currencies"));
      const uniqueCurrencies = currencies.length ? currencies : ["USD"];
      const rates = {};

      await Promise.all(uniqueCurrencies.map(async (currency) => {
        const [usd, inr] = await Promise.all([
          getFxRate(currency, "USD"),
          getFxRate(currency, "INR")
        ]);

        rates[currency] = { usd, inr };
      }));

      json(res, 200, {
        rates,
        refreshedAt: new Date().toISOString()
      });
      return;
    }

    if (url.pathname === "/api/fx") {
      const pair = cleanSymbol(url.searchParams.get("pair") || "USDINR=X") || "USDINR=X";
      const quote = await getChartQuote(pair);

      json(res, 200, {
        pair,
        rate: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        updatedAt: quote.updatedAt
      });
      return;
    }

    json(res, 404, { error: "API route not found." });
  } catch (error) {
    json(res, 502, { error: error.message || "Unable to fetch market data." });
  }
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const type = mimeTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "Content-Type": mimeTypes[".html"],
      "Cache-Control": "no-store"
    });
    res.end(fallback);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Stock Converter is running at http://localhost:${PORT}`);
});
