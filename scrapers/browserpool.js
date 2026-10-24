let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch {
  // Puppeteer not installed or skipped in serverless/lean environments
}

// Both onoflix.js and dramaid.js need a real browser to get past
// JS-gated content (onoflix is fully client-rendered; dramaid's video
// player only appears after a "Server" button is clicked). Sharing one
// browser instance across both avoids paying Chromium's startup cost
// (and RAM) twice.
let browserPromise = null;

function getBrowser() {
  if (!puppeteer) {
    return Promise.reject(new Error('Puppeteer tidak tersedia di environment ini (fallback ke mode statis).'));
  }

  if (!browserPromise) {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Several video mirrors detect automated headless browsers.
      // This flag hides the automation tell Chrome exposes.
      '--disable-blink-features=AutomationControlled'
    ];

    const launchOptions = {
      headless: 'new',
      args: launchArgs
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      launchOptions.channel = 'chrome';
    }

    browserPromise = puppeteer
      .launch(launchOptions)
      .catch((err) => {
        console.warn('⚠️  Could not launch preferred Chrome (falling back to default):', err.message);
        delete launchOptions.channel;
        delete launchOptions.executablePath;
        return puppeteer.launch(launchOptions);
      });
  }
  return browserPromise;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 900 });

    // Patch headless-detection signals before page scripts run
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = window.chrome || { runtime: {} };
      const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params);
      }
    });

    return await fn(page);
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser && typeof browser.close === 'function') {
        await browser.close();
      }
    } catch {}
    browserPromise = null;
  }
}

async function gotoWithRetry(page, url, { retries = 2, waitUntil = 'domcontentloaded', timeout = 20000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil, timeout });
      const status = response ? response.status() : null;
      if (status === 403 || status === 429) {
        if (attempt < retries) {
          console.warn(`⚠️  HTTP ${status} loading ${url} (attempt ${attempt + 1}/${retries + 1}) — clearing cookies and retrying.`);
          const client = await page.target().createCDPSession();
          await client.send('Network.clearBrowserCookies');
          await client.detach().catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
          continue;
        }
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        console.warn(`⚠️  Navigation to ${url} failed (attempt ${attempt + 1}/${retries + 1}): ${err.message} — retrying.`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

module.exports = { getBrowser, withPage, closeBrowser, gotoWithRetry };
