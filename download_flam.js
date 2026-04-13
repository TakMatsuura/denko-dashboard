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

  // Customer × Product sales (for customer detail drill-down)
  await downloadCSV(context, page,
    `${FLAM_URL}/sales/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=customer&grouping%5B%5D=section&grouping%5B%5D=product&limit=20`,
    `${FLAM_URL}/sales/totalize/export?startdate=${S}&enddate=${E}&grouping%5B%5D=customer&grouping%5B%5D=section&grouping%5B%5D=product&file-format=csv`,
    'customer_product_sales.csv');

  await downloadCSV(context, page,
    `${FLAM_URL}/purchases/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=suppliers&grouping%5B%5D=section&grouping%5B%5D=slipdate&limit=20`,
    `${FLAM_URL}/purchases/totalize/export?startdate=${S}&enddate=${E}&grouping%5B%5D=suppliers&grouping%5B%5D=section&grouping%5B%5D=slipdate&file-format=csv`,
    'dept_purchase.csv');

  // Sales detail (売上伝票CSV) - POST form submission via fetch
  try {
    console.log('=== Sales Detail: download via form POST ===');

    // Navigate to sales export page to get session/cookies
    await page.goto(`${FLAM_URL}/sales/export`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Get the form action and any hidden fields
    const formData = await page.evaluate(() => {
      const form = document.querySelector('form');
      const action = form ? form.action : '';
      const method = form ? form.method : '';
      // Get all hidden inputs
      const hiddens = {};
      document.querySelectorAll('input[type="hidden"]').forEach(el => {
        if (el.name) hiddens[el.name] = el.value;
      });
      return { action, method, hiddens };
    });
    console.log('  Form action:', formData.action, 'method:', formData.method);
    console.log('  Hidden fields:', JSON.stringify(formData.hiddens));

    // Submit form via fetch with POST, including date and file format
    const response = await page.evaluate(async (baseUrl) => {
      const form = document.querySelector('form');
      const formDataObj = new FormData(form);
      // Set start date
      formDataObj.set('sd', '2025/05/01');
      // Set file format to CSV
      formDataObj.set('file-format', 'csv');
      formDataObj.set('format', 'csv');

      const res = await fetch(baseUrl + '/sales/export/exec', {
        method: 'POST',
        credentials: 'include',
        body: formDataObj
      });
      const buffer = await res.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        length: bytes.length,
        bytes: bytes,
        url: res.url
      };
    }, FLAM_URL);

    console.log(`  POST response: ${response.status}, type: ${response.contentType}, size: ${response.length}, url: ${response.url}`);

    const filePath = path.join(DATA_DIR, 'sales_detail.csv');

    if (response.contentType && response.contentType.includes('text/csv')) {
      // Direct CSV response
      fs.writeFileSync(filePath, Buffer.from(response.bytes));
      const content = fs.readFileSync(filePath);
      const text = new TextDecoder('shift_jis').decode(content);
      fs.writeFileSync(filePath, text, 'utf8');
      const lines = text.split('\n').filter(l => l.trim());
      console.log(`  sales_detail.csv: ${lines.length - 1} data rows (CSV)`);
    } else {
      // Might be HTML - save and check content
      const rawText = Buffer.from(response.bytes).toString('utf8');
      console.log(`  Response start: ${rawText.substring(0, 200)}`);
      // Try Shift-JIS decode in case it's CSV with wrong content-type
      const text = new TextDecoder('shift_jis').decode(Buffer.from(response.bytes));
      if (text.includes('売上番号') || text.includes('受注番号')) {
        fs.writeFileSync(filePath, text, 'utf8');
        const lines = text.split('\n').filter(l => l.trim());
        console.log(`  sales_detail.csv: ${lines.length - 1} data rows (detected as CSV)`);
      } else {
        console.log('  Response is not CSV');
      }
    }
  } catch (e) {
    console.log(`  Sales detail download failed: ${e.message}`);
  }

  // Orders: download via form POST (指定納期出力用フォーマット)
  try {
    console.log('=== Orders: download via form POST ===');

    // Navigate to orders export page
    await page.goto(`${FLAM_URL}/orders/export`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Select 指定納期出力用フォーマット from dropdown and log available options
    const formatInfo = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      const info = [];
      for (const sel of selects) {
        const options = Array.from(sel.options).map(o => ({ value: o.value, text: o.text, selected: o.selected }));
        info.push({ name: sel.name, id: sel.id, options });
      }
      return info;
    });
    console.log('  Select elements:', JSON.stringify(formatInfo, null, 2));

    // Find the format dropdown and select 指定納期出力用フォーマット
    const response = await page.evaluate(async (baseUrl) => {
      const form = document.querySelector('form');
      const formDataObj = new FormData(form);
      // Set start date
      formDataObj.set('sd', '2025/05/01');
      // Set file format to CSV
      formDataObj.set('file-format', 'csv');
      formDataObj.set('format', 'csv');

      // Find and set the format dropdown to 指定納期出力用フォーマット
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.text.includes('指定納期')) {
            formDataObj.set(sel.name, opt.value);
            break;
          }
        }
      }

      const res = await fetch(baseUrl + '/orders/export/exec', {
        method: 'POST',
        credentials: 'include',
        body: formDataObj
      });
      const buffer = await res.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        length: bytes.length,
        bytes: bytes,
        url: res.url
      };
    }, FLAM_URL);

    console.log(`  POST response: ${response.status}, type: ${response.contentType}, size: ${response.length}, url: ${response.url}`);

    const filePath = path.join(DATA_DIR, 'orders.csv');

    if (response.contentType && response.contentType.includes('text/csv')) {
      fs.writeFileSync(filePath, Buffer.from(response.bytes));
      const content = fs.readFileSync(filePath);
      const text = new TextDecoder('shift_jis').decode(content);
      fs.writeFileSync(filePath, text, 'utf8');
      const lines = text.split('\n').filter(l => l.trim());
      const headers = lines[0];
      console.log(`  orders.csv: ${lines.length - 1} data rows`);
      console.log(`  Headers: ${headers.substring(0, 300)}`);
      // Check if 指定納期 is in headers
      if (headers.includes('指定納期')) {
        console.log('  ✓ 指定納期 column found!');
      } else {
        console.log('  WARNING: 指定納期 column NOT found in CSV');
      }
    } else {
      const rawText = Buffer.from(response.bytes).toString('utf8');
      console.log(`  Response start: ${rawText.substring(0, 200)}`);
      const text = new TextDecoder('shift_jis').decode(Buffer.from(response.bytes));
      if (text.includes('受注番号') || text.includes('受注日')) {
        fs.writeFileSync(filePath, text, 'utf8');
        const lines = text.split('\n').filter(l => l.trim());
        console.log(`  orders.csv: ${lines.length - 1} data rows (detected as CSV)`);
      } else {
        console.log('  Response is not CSV');
      }
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
