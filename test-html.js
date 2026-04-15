const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
     userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  });
  
  page.on('response', response => {
    if (response.url().includes('api/chat')) {
      console.log('Intercepted API response:', response.url());
    }
  });

  await page.goto("https://claude.ai/share/ab56f147-a674-4421-813b-29cf1405d550", { waitUntil: 'networkidle' });
  
  const text = await page.evaluate(() => document.documentElement.outerHTML);
  fs.writeFileSync('claude_share_output.html', text);
  console.log("Wrote HTML to claude_share_output.html");
  
  await browser.close();
})();
