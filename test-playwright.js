const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
     userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  });
  await page.goto("https://claude.ai/share/ab56f147-a674-4421-813b-29cf1405d550", { waitUntil: 'networkidle' });
  
  const text = await page.evaluate(() => document.body.innerText);
  console.log("PAGE TEXT:", text);
  
  await browser.close();
})();
