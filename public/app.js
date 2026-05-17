const REFRESH_MS = 15_000;
const STORAGE_KEY = "stock-converter-holdings";

const elements = {
  form: document.querySelector("#holding-form"),
  symbolInput: document.querySelector("#symbol-input"),
  quantityInput: document.querySelector("#quantity-input"),
  refreshButton: document.querySelector("#refresh-button"),
  quickActions: document.querySelector(".quick-actions"),
  body: document.querySelector("#holdings-body"),
  emptyState: document.querySelector("#empty-state"),
  portfolioUsd: document.querySelector("#portfolio-usd"),
  portfolioInr: document.querySelector("#portfolio-inr"),
  portfolioChange: document.querySelector("#portfolio-change"),
  portfolioChangeInr: document.querySelector("#portfolio-change-inr"),
  fxRate: document.querySelector("#fx-rate"),
  holdingCount: document.querySelector("#holding-count"),
  refreshDetail: document.querySelector("#refresh-detail"),
  marketStatus: document.querySelector("#market-status"),
  pulse: document.querySelector(".pulse")
};

let holdings = loadHoldings();
let quotes = new Map();
let conversionRates = new Map();
let refreshTimer = null;
let refreshRun = 0;

function money(value, currency = "USD") {
  const safeValue = Number.isFinite(value) ? value : 0;
  const locale = currency === "INR" ? "en-IN" : "en-US";

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }).format(safeValue);
  } catch {
    return `${currency} ${safeValue.toLocaleString(locale, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2
    })}`;
  }
}

const number = (value) => new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4
}).format(Number.isFinite(value) ? value : 0);

function loadHoldings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved)
      ? saved
          .map((item) => ({
            symbol: cleanSymbol(item.symbol || ""),
            quantity: Number(item.quantity),
            name: String(item.name || "")
          }))
          .filter((item) => item.symbol && item.quantity > 0)
      : [];
  } catch {
    return [];
  }
}

function saveHoldings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
}

function cleanSymbol(value) {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9.^=\-]/g, "");
}

function setStatus(message, isLive = false) {
  elements.marketStatus.textContent = message;
  elements.pulse.classList.toggle("live", isLive);
}

function measuredTextWidth(text, style, size) {
  const canvas = measuredTextWidth.canvas || document.createElement("canvas");
  measuredTextWidth.canvas = canvas;
  const context = canvas.getContext("2d");
  context.font = `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${size}px ${style.fontFamily}`;
  return context.measureText(text).width;
}

function fitText(element, minSize) {
  element.style.fontSize = "";
  element.style.whiteSpace = "nowrap";

  const availableWidth = Math.max(0, element.getBoundingClientRect().width - 4);
  const text = element.textContent || "";
  const style = getComputedStyle(element);
  let size = parseFloat(getComputedStyle(element).fontSize);

  while (measuredTextWidth(text, style, size) > availableWidth && size > minSize) {
    size -= 1;
  }

  element.style.fontSize = `${Math.max(size, minSize)}px`;
}

function fitSummaryNumbers() {
  fitText(elements.portfolioUsd, 24);
  fitText(elements.portfolioChange, 18);
  fitText(elements.holdingCount, 30);
}

function formatChange(value, currency = "USD") {
  const formatted = money(Math.abs(value || 0), currency);
  if (!value) return formatted;
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function changeClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "";
}

function rateFor(currency, target) {
  const normalized = cleanCurrency(currency);

  if (normalized === target) return 1;

  return conversionRates.get(normalized)?.[target.toLowerCase()] || 0;
}

function cleanCurrency(value) {
  return String(value || "USD").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "USD";
}

function totals() {
  return holdings.reduce((sum, holding) => {
    const quote = quotes.get(holding.symbol);
    const price = quote?.price || 0;
    const change = quote?.change || 0;
    const currency = cleanCurrency(quote?.currency);
    const valueNative = price * holding.quantity;
    const changeNative = change * holding.quantity;
    const valueUsd = valueNative * rateFor(currency, "USD");
    const valueInr = valueNative * rateFor(currency, "INR");
    const changeUsd = changeNative * rateFor(currency, "USD");
    const changeInr = changeNative * rateFor(currency, "INR");

    sum.valueUsd += valueUsd;
    sum.valueInr += valueInr;
    sum.changeUsd += changeUsd;
    sum.changeInr += changeInr;
    return sum;
  }, { valueUsd: 0, valueInr: 0, changeUsd: 0, changeInr: 0 });
}

function renderSummary() {
  const total = totals();
  const usdInr = rateFor("USD", "INR");

  elements.portfolioUsd.textContent = money(total.valueUsd, "USD");
  elements.portfolioInr.textContent = money(total.valueInr, "INR");
  elements.portfolioChange.textContent = formatChange(total.changeUsd, "USD");
  elements.portfolioChange.className = `metric-number ${changeClass(total.changeUsd)}`;
  elements.portfolioChangeInr.textContent = `${formatChange(total.changeInr, "INR")} today`;
  elements.portfolioChangeInr.className = `metric-subtext ${changeClass(total.changeInr)}`;
  elements.holdingCount.textContent = holdings.length;
  elements.fxRate.textContent = usdInr ? `USD/INR: ${number(usdInr)}` : "USD/INR: --";
  requestAnimationFrame(fitSummaryNumbers);
}

function renderHoldings() {
  elements.body.innerHTML = "";
  elements.emptyState.classList.toggle("is-hidden", holdings.length > 0);

  for (const holding of holdings) {
    const quote = quotes.get(holding.symbol);
    const price = quote?.price || 0;
    const currency = cleanCurrency(quote?.currency);
    const nativeValue = price * holding.quantity;
    const valueUsd = nativeValue * rateFor(currency, "USD");
    const valueInr = nativeValue * rateFor(currency, "INR");
    const row = document.createElement("tr");
    const source = quote?.priceSource && quote.priceSource !== "regular" ? `${quote.sessionLabel} · ` : "";
    const move = quote ? `${source}${formatChange(quote.change || 0, currency)} (${number(quote.changePercent || 0)}%)` : "Loading";
    const moveTone = quote ? changeClass(quote.change || 0) : "";

    row.innerHTML = `
      <td>
        <div class="symbol-cell">
          <span class="symbol-badge">${holding.symbol.slice(0, 2)}</span>
          <span>
            ${holding.symbol}
            <div class="subline ${moveTone}">${move}</div>
          </span>
        </div>
      </td>
      <td>${number(holding.quantity)}</td>
      <td>${quote ? money(price, currency) : "--"}</td>
      <td>${money(valueUsd, "USD")}</td>
      <td>${quote && rateFor(currency, "INR") ? money(valueInr, "INR") : "--"}</td>
      <td>
        <button class="remove-button" type="button" title="Remove ${holding.symbol}" aria-label="Remove ${holding.symbol}" data-remove="${holding.symbol}">×</button>
      </td>
    `;

    elements.body.appendChild(row);
  }

  renderSummary();
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

function replaceHoldingSymbol(requestedSymbol, resolvedSymbol, name = "") {
  if (!requestedSymbol || !resolvedSymbol || requestedSymbol === resolvedSymbol) return false;

  const oldHolding = holdings.find((holding) => holding.symbol === requestedSymbol);
  const resolvedHolding = holdings.find((holding) => holding.symbol === resolvedSymbol);

  if (!oldHolding) return false;

  if (resolvedHolding) {
    resolvedHolding.quantity += oldHolding.quantity;
    if (!resolvedHolding.name && name) resolvedHolding.name = name;
    holdings = holdings.filter((holding) => holding !== oldHolding);
  } else {
    oldHolding.symbol = resolvedSymbol;
    if (name) oldHolding.name = name;
  }

  return true;
}

async function refreshPrices() {
  const runId = ++refreshRun;

  if (!holdings.length) {
    quotes = new Map();
    renderHoldings();
    setStatus("Waiting for holdings");
    elements.refreshDetail.textContent = "Add your first stock";
    return;
  }

  setStatus("Updating prices");
  const symbols = holdings.map((holding) => holding.symbol).join(",");

  try {
    const quotePayload = await fetchJson(`/api/quotes?symbols=${encodeURIComponent(symbols)}`);
    const currencies = [...new Set(quotePayload.quotes.map((quote) => cleanCurrency(quote.currency)))];
    const ratePayload = await fetchJson(`/api/rates?currencies=${encodeURIComponent(currencies.join(","))}`);

    if (runId !== refreshRun) return;

    const renamed = quotePayload.quotes.some((quote) => replaceHoldingSymbol(
      quote.requestedSymbol,
      quote.symbol,
      quote.name
    ));

    quotes = new Map(quotePayload.quotes.map((quote) => [quote.symbol, quote]));
    conversionRates = new Map(Object.entries(ratePayload.rates));

    if (renamed) saveHoldings();

    const refreshed = new Date(quotePayload.refreshedAt);
    elements.refreshDetail.textContent = `Updated ${refreshed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;

    if (quotePayload.errors?.length) {
      const missed = quotePayload.errors.map((item) => item.symbol).join(", ");
      setStatus(`Could not load ${missed}`, false);
    } else {
      const hasOvernight = quotePayload.quotes.some((quote) => quote.priceSource === "overnight");
      const hasExtendedHours = quotePayload.quotes.some((quote) => quote.priceSource !== "regular");
      setStatus(hasOvernight ? "24/5 overnight prices updating" : hasExtendedHours ? "Extended-hours prices updating" : "Live prices updating", true);
    }
  } catch (error) {
    if (runId !== refreshRun) return;
    setStatus(error.message || "Price update failed", false);
  } finally {
    if (runId !== refreshRun) return;
    renderHoldings();
  }
}

async function resolveHolding(input) {
  const rawInput = String(input || "").trim();
  const fallback = cleanSymbol(rawInput);

  if (!rawInput) {
    throw new Error("Enter a ticker or company name.");
  }

  try {
    const payload = await fetchJson(`/api/resolve?query=${encodeURIComponent(rawInput)}`);
    return {
      symbol: cleanSymbol(payload.symbol),
      name: payload.name || ""
    };
  } catch (error) {
    if (!fallback) throw error;
    return { symbol: fallback, name: "" };
  }
}

async function upsertHolding(symbol, quantity) {
  const amount = Number(quantity);

  if (!Number.isFinite(amount) || amount <= 0) return false;

  setStatus("Finding ticker");
  const resolved = await resolveHolding(symbol);
  const normalized = resolved.symbol;

  if (!normalized) return false;

  const existing = holdings.find((holding) => holding.symbol === normalized);

  if (existing) {
    existing.quantity = amount;
    if (!existing.name && resolved.name) existing.name = resolved.name;
  } else {
    holdings = [...holdings, { symbol: normalized, quantity: amount, name: resolved.name }];
  }

  saveHoldings();
  renderHoldings();
  refreshPrices();
  return true;
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const added = await upsertHolding(elements.symbolInput.value, elements.quantityInput.value);

    if (added) {
      elements.form.reset();
      elements.symbolInput.focus();
    }
  } catch (error) {
    setStatus(error.message || "Could not find that ticker", false);
  }
});

elements.quickActions.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-symbol]");

  if (!button) return;

  elements.symbolInput.value = button.dataset.symbol;
  elements.quantityInput.value = button.dataset.quantity;
  await upsertHolding(button.dataset.symbol, button.dataset.quantity);
});

elements.refreshButton.addEventListener("click", refreshPrices);

elements.body.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-remove]");

  if (!button) return;

  holdings = holdings.filter((holding) => holding.symbol !== button.dataset.remove);
  quotes.delete(button.dataset.remove);
  saveHoldings();
  renderHoldings();
  refreshPrices();
});

renderHoldings();
refreshPrices();
refreshTimer = setInterval(refreshPrices, REFRESH_MS);

window.addEventListener("beforeunload", () => {
  clearInterval(refreshTimer);
});

window.addEventListener("resize", fitSummaryNumbers);
