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

  // Orders: scrape from orders LIST page per department (sec= works here)
  try {
    console.log('=== Orders: scraping from list page per department ===');
    const departments = ['DNK-E', 'DNK-E-N', 'DNK-E-S'];
    let allRows = [];
    let headers = null;

    for (const dept of departments) {
      console.log(`  Loading orders list for dept: ${dept}`);
      const url = `${FLAM_URL}/orders/view/?sd=2025%2F05%2F01&ed=&sec=${encodeURIComponent(dept)}&limit=10000`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
      await page.waitForTimeout(3000);

      // Get result count from page
      const resultInfo = await page.evaluate(() => {
        const text = document.body.innerText;
        const match = text.match(/(\d+)\s*件.*の検索結果/);
        return match ? match[0] : 'unknown';
      });
      console.log(`  ${dept}: ${resultInfo}`);

      // Scrape the table, handling checkboxes and links properly
      const tableData = await page.evaluate(() => {
        const table = document.querySelector('table.list, table.index, table');
        if (!table) return null;

        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length < 2) return null;

        // Get headers
        const headerRow = rows[0];
        const headerCells = Array.from(headerRow.querySelectorAll('th'));
        const headers = headerCells.map(th => th.textContent.trim());

        // Get data rows
        const dataRows = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll('td'));
          if (cells.length >= 5) {
            const row = cells.map(td => td.textContent.trim().replace(/\s+/g, ' '));
            dataRows.push(row);
          }
        }
        return { headers, rows: dataRows, totalRows: rows.length };
      });

      if (tableData && tableData.rows.length > 0) {
        if (!headers) {
          headers = tableData.headers;
          console.log(`  Headers (${headers.length}): ${headers.join(' | ')}`);
          // Show first data row for debugging
          if (tableData.rows.length > 0) {
            console.log(`  Row0 (${tableData.rows[0].length} cols): ${tableData.rows[0].join(' | ')}`);
          }
        }
        allRows = allRows.concat(tableData.rows);
        console.log(`  ${dept}: ${tableData.rows.length} data rows`);
      } else {
        console.log(`  ${dept}: no table data found`);

        // Fallback: show page info for debugging
        const debugInfo = await page.evaluate(() => {
          const tables = document.querySelectorAll('table');
          return { tableCount: tables.length, bodyLength: document.body.innerText.length, title: document.title };
        });
        console.log(`  Debug: ${JSON.stringify(debugInfo)}`);
      }
    }

    if (headers && allRows.length > 0) {
      console.log(`  Total: ${allRows.length} rows across ${departments.length} depts`);

      // Map column names: find key columns by name
      const colMap = {};
      headers.forEach((h, i) => { colMap[h] = i; });
      console.log(`  Column indices: ${JSON.stringify(colMap)}`);

      // Create normalized CSV with standard column names
      // Map from list page columns to our expected format
      const orderDateIdx = headers.findIndex(h => h.includes('受注日'));
      const orderNumIdx = headers.findIndex(h => h.includes('受注番号'));
      const customerIdx = headers.findIndex(h => h.includes('得意先'));
      const amountIdx = headers.findIndex(h => h.includes('受注合計金額'));
      const costIdx = headers.findIndex(h => h.includes('原価計'));
      const statusIdx = headers.lastIndexOf('引当');

      console.log(`  Key columns: 受注日=${orderDateIdx}, 受注番号=${orderNumIdx}, 得意先=${customerIdx}, 金額=${amountIdx}, 原価=${costIdx}, 引当=${statusIdx}`);

      // Build CSV with normalized headers
      const csvHeaders = ['受注日', '受注番号', '得意先名称', '受注合計金額', '原価計', '引当/計上'];
      const csvRows = allRows.map(row => {
        return [
          row[orderDateIdx] || '',
          row[orderNumIdx] || '',
          row[customerIdx] || '',
          row[amountIdx] || '0',
          row[costIdx] || '0',
          row[statusIdx] || '',
        ];
      });

      const csvContent = [csvHeaders, ...csvRows].map(row => row.map(cell => `"${(cell||'').replace(/"/g, '""')}"`).join(',')).join('\n');
      fs.writeFileSync(path.join(DATA_DIR, 'orders.csv'), csvContent, 'utf8');
      console.log(`Downloaded: orders.csv (${csvContent.length} bytes, ${csvRows.length + 1} rows)`);

      // Show sample normalized row
      if (csvRows.length > 0) {
        console.log(`  Sample: ${csvHeaders.map((h, i) => `${h}="${csvRows[0][i]}"`).join(', ')}`);
      }
    } else {
      console.log('  WARNING: Could not get orders data');
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
