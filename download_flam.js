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

  // Orders: scrape from analysis page per department (DNK-E, DNK-E-N, DNK-E-S)
  try {
    console.log('=== Orders: scraping per department ===');
    const departments = ['DNK-E', 'DNK-E-N', 'DNK-E-S'];
    let allRows = [];
    let headers = null;

    for (const dept of departments) {
      console.log(`  Loading orders for dept: ${dept}`);
      const url = `${FLAM_URL}/orders/report/view/analysis?preview=1&sort=&direction=&rt=1&sd=2025%2F05%2F01&ed=2026%2F04%2F30&sec=${encodeURIComponent(dept)}&cu_st=&cu_ed=&ch=&pd=&pn=&fi=`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
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

      // Find the data table (largest one)
      const dataTables = tableData.filter(t => t.length > 5);
      if (dataTables.length > 0) {
        const table = dataTables.sort((a, b) => b.length - a.length)[0];
        if (!headers) {
          headers = table[0];
          console.log(`  Headers: ${headers.join(', ')}`);
        }
        // Add data rows (skip header row)
        const dataRows = table.slice(1);
        allRows = allRows.concat(dataRows);
        console.log(`  ${dept}: ${dataRows.length} rows`);
      } else {
        console.log(`  ${dept}: no data table found (${tableData.length} tables)`);
      }
    }

    if (headers && allRows.length > 0) {
      console.log(`  Total: ${allRows.length} rows across ${departments.length} depts`);
      // Show sample row
      if (allRows.length > 0) {
        console.log('  Sample row:');
        for (let i = 0; i < headers.length; i++) {
          console.log(`    [${i}] "${headers[i]}" = "${(allRows[0][i] || '').substring(0, 30)}"`);
        }
      }
      const csvContent = [headers, ...allRows].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
      fs.writeFileSync(path.join(DATA_DIR, 'orders.csv'), csvContent, 'utf8');
      console.log(`Downloaded: orders.csv (${csvContent.length} bytes, ${allRows.length + 1} rows)`);
    } else {
      console.log('  WARNING: Could not get orders data from any department');
    }
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
