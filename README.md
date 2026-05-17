# Stock Converter

A live portfolio tracker that accepts stock tickers, stores holdings in the browser, fetches current, extended-hours, and 24/5 overnight prices through a local Node server, and shows portfolio value in USD and INR.

## Run

```sh
node server.js
```

Then open:

```text
http://localhost:3000
```

Use Yahoo Finance-style symbols such as `NVDA`, `TSLA`, `BRK-B`, exchange-suffixed symbols like `RELIANCE.NS`, or company names like `micron`.
