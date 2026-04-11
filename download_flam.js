const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FLAM_URL = 'https://dnk.flam.bz';
const FLAM_ID = process.env.FLAM_ID;
const FLAM_PW = process.env.FLAM_PW;
const DATA_DIR = '/tmp/flam_data';

fs.mkdirSync(DATA_DIR, { recursive: true });

async function downloadCSV(context, page, searchUrl, exportUrl, filename) {
  // Step 1: Load search page (populates session)
  await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  console.log(`  Loaded search: ${filename}`);

  // Step 2: Get cookies from browser context
  const cookies = await context.cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Step 3: Fetch export URL and get as binary array (for Shift-JIS decoding)
  const response = await page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    const buffer = await res.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes };
  }, exportUrl);

  console.log(`  Export response: ${response.status}, type: ${response.contentType}, size: ${response.length}`);

  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(response.bytes));
  console.log(`Downloaded: ${filename} (${response.length} bytes)`);
}

(async () => {
  console.log('=== Step 1: Launch browser and login ===');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${FLAM_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="data[User][loginid]"]', FLAM_ID);
  await page.fill('input[name="data[User][password]"]', FLAM_PW);
  await page.click('input[type="submit"]');
  await page.waitForURL('**/', { timeout: 30000 });
  console.log('Logged in');

  const S = '2025%2F05%2F01';
  const E = '2026%2F04%2F30';

  console.log('=== Step 2: Download CSVs ===');

  await downloadCSV(context, page,
    `${FLAM_URL}/sales/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=section&grouping%5B%5D=slipdate&limit=20`,
    `${FLAM_URL}/sales/totalize/export?startdate=${S}&enddate=${E}&grouping%5B%5D=section&grouping%5B%5D=slipdate&file-format=csv`,
    'dept_sales.csv');

  await downloadCSV(context, page,
    `${FLAM_URL}/sales/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=customer&grouping%5B%5D=section&limit=20`,
    `${FLAM_URL}/sales/totalize/export?startdate=${S}&enddate=${E}&grouping%5B%5D=customer&grouping%5B%5D=section&file-format=csv`,
    'dept_customer_sales.csv');

  await downloadCSV(context, page,
    `${FLAM_URL}/sales/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=section&grouping%5B%5D=product&grouping%5B%5D=slipdate&limit=20`,
    `${FLAM_URL}/sales/totalize/export?startdate=${S}&enddate=${E}&grouping%5B%5D=section&grouping%5B%5D=product&grouping%5B%5D=slipdate&file-format=csv`,
    'dept_product_sales.csv');

  await downloadCSV(context, page,
    `${FLAM_URL}/purchases/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=suppliers&grouping%5B%5D=section&grouping%5B%5D=slipdate&limit=20`,
    `${FLAM_URL}/purchases/totalize/export?startdate=${S}&enddate=${E}&grouping%5B%5D=suppliers&grouping%5B%5D=section&grouping%5B%5D=slipdate&file-format=csv`,
    'dept_purchase.csv');

  // Orders: try multiple page types to find one with CSV export
  try {
    console.log('=== Orders: trying multiple pages ===');

    // Approach 1: Try orders list page (not analysis)
    const orderPages = [
      { url: `${FLAM_URL}/orders`, name: 'orders index' },
      { url: `${FLAM_URL}/orders/index`, name: 'orders/index' },
      { url: `${FLAM_URL}/orders?startdate=${S}&enddate=${E}`, name: 'orders with dates' },
    ];

    let downloaded = false;
    for (const pg of orderPages) {
      if (downloaded) break;
      console.log(`  Trying page: ${pg.name} (${pg.url})`);
      try {
        await page.goto(pg.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Find ALL links on the page
        const allLinks = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a'))
            .filter(a => a.href)
            .map(a => ({ href: a.href, text: (a.textContent || '').trim().substring(0, 60) }))
            .filter(l => l.href.includes('export') || l.text.includes('エクスポート') || l.text.includes('CSV') || l.text.includes('ダウンロード'));
        });
        console.log(`  Found ${allLinks.length} export links:`);
        allLinks.forEach(l => console.log(`    "${l.text}" -> ${l.href}`));

        // Try export URLs for this page
        const baseUrl = pg.url.split('?')[0];
        const exportUrls = [
          `${baseUrl}/export?file-format=csv`,
          `${baseUrl}/export?startdate=${S}&enddate=${E}&file-format=csv`,
          ...allLinks.map(l => l.href.includes('file-format') ? l.href : `${l.href}${l.href.includes('?') ? '&' : '?'}file-format=csv`),
        ];

        for (const expUrl of exportUrls) {
          const response = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            const buffer = await res.arrayBuffer();
            const bytes = Array.from(new Uint8Array(buffer));
            const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes).slice(0, 300));
            return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes, preview: text };
          }, expUrl);

          const preview = response.preview.trimStart();
          const isCSV = !preview.startsWith('<!DOCTYPE') && !preview.startsWith('<html') && !preview.startsWith('<?xml') && response.length > 200;
          console.log(`  ${isCSV ? 'CSV!' : 'HTML'} ${expUrl.substring(0,80)}... (${response.length} bytes)`);

          if (isCSV) {
            fs.writeFileSync(path.join(DATA_DIR, 'orders.csv'), Buffer.from(response.bytes));
            console.log(`Downloaded: orders.csv (${response.length} bytes)`);
            downloaded = true;
            break;
          }
        }
      } catch (e) {
        console.log(`  Error on ${pg.name}: ${e.message}`);
      }
    }

    // Approach 2: Try scraping the HTML table directly from the analysis page
    if (!downloaded) {
      console.log('  Trying HTML table scrape from analysis page...');
      await page.goto(`${FLAM_URL}/orders/report/view/analysis?preview=1&sort=&direction=&rt=1&sd=2025%2F05%2F01&ed=2026%2F04%2F30&cu_st=&cu_ed=&ch=&pd=&pn=&fi=`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);

      const tableData = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        const results = [];
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll('tr'));
          if (rows.length > 1) {
            const data = rows.map(r => Array.from(r.querySelectorAll('th, td')).map(c => c.textContent.trim()));
            if (data.length > 0 && data[0].length > 2) {
              results.push(data);
            }
          }
        }
        return results;
      });

      console.log(`  Found ${tableData.length} tables with data`);
      // Debug: show all tables info
      tableData.forEach((t, i) => {
        console.log(`  Table ${i}: ${t.length} rows x ${t[0].length} cols`);
        console.log(`    Headers: ${t[0].join(' | ')}`);
        if (t.length > 1) {
          console.log(`    Row1 cols: ${t[1].length}`);
          console.log(`    Row1: ${t[1].join(' | ')}`);
        }
        if (t.length > 2) {
          console.log(`    Row2: ${t[2].join(' | ')}`);
        }
      });

      if (tableData.length > 0) {
        // Convert the largest table to CSV
        const biggest = tableData.sort((a, b) => b.length - a.length)[0];
        const headerCount = biggest[0].length;
        console.log(`  Using table: ${biggest.length} rows x ${headerCount} cols`);

        // Check if header row has fewer cells than data (colspan issue)
        if (biggest.length > 1 && biggest[1].length !== headerCount) {
          console.log(`  WARNING: Header has ${headerCount} cols but data has ${biggest[1].length} cols!`);
        }

        // Show header-to-value mapping for first data row
        if (biggest.length > 1) {
          const dataRow = biggest[1];
          console.log('  Column mapping (sample):');
          for (let i = 0; i < Math.max(headerCount, dataRow.length); i++) {
            console.log(`    [${i}] "${biggest[0][i] || '???'}" = "${(dataRow[i] || '').substring(0, 30)}"`);
          }
        }

        const csvContent = biggest.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
        fs.writeFileSync(path.join(DATA_DIR, 'orders.csv'), csvContent, 'utf8');
        console.log(`Downloaded (scraped): orders.csv (${csvContent.length} bytes, ${biggest.length} rows)`);
        downloaded = true;
      }
    }

    if (!downloaded) console.log('  WARNING: Could not get orders data');
  } catch (e) {
    console.log(`  Orders download failed: ${e.message}`);
  }

  // Stockrecents: try scraping HTML table
  try {
    console.log('=== Stockrecents ===');
    await page.goto(`${FLAM_URL}/stockrecents`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Try scraping the HTML table directly
    const tableData = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const results = [];
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length > 1) {
          const data = rows.map(r => Array.from(r.querySelectorAll('th, td')).map(c => c.textContent.trim()));
          if (data.length > 0 && data[0].length > 2) {
            results.push(data);
          }
        }
      }
      return results;
    });

    console.log(`  Found ${tableData.length} tables`);
    let downloaded = false;

    if (tableData.length > 0) {
      const biggest = tableData.sort((a, b) => b.length - a.length)[0];
      console.log(`  Largest table: ${biggest.length} rows x ${biggest[0].length} cols`);
      console.log(`  Headers: ${biggest[0].join(', ')}`);
      const csvContent = biggest.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
      fs.writeFileSync(path.join(DATA_DIR, 'stockrecents.csv'), csvContent, 'utf8');
      console.log(`Downloaded (scraped): stockrecents.csv (${csvContent.length} bytes, ${biggest.length} rows)`);
      downloaded = true;
    }

    if (!downloaded) console.log('  WARNING: Could not get stockrecents data');
  } catch (e) {
    console.log(`  Stock download failed: ${e.message}`);
  }

  await browser.close();
  console.log('=== Done ===');
})();
