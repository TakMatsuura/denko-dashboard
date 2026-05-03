const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FLAM_URL = 'https://dnk.flam.bz';
const FLAM_ID = process.env.FLAM_ID;
const FLAM_PW = process.env.FLAM_PW;

// 引数解析: --fy 2024 で過去FYを取得 (省略時は現FY)
//   現FY:    /tmp/flam_data に保存 (build_html.js が読む)
//   過去FY:  /tmp/flam_data_fyYYYY に保存 (sync後に public/data/fy/YYYY/ にコピー)
const argv = process.argv.slice(2);
let TARGET_FY = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--fy' && argv[i + 1]) TARGET_FY = parseInt(argv[i + 1]);
}

const DATA_DIR = TARGET_FY ? `/tmp/flam_data_fy${TARGET_FY}` : '/tmp/flam_data';

// 会計年度開始日 (5月始まり)
function getFYStartDate() {
  if (TARGET_FY) return `${TARGET_FY}/05/01`;
  const now = new Date();
  const fyYear = now.getMonth() + 1 >= 5 ? now.getFullYear() : now.getFullYear() - 1;
  return `${fyYear}/05/01`;
}
const FY_START_DATE = getFYStartDate();
const FY_LABEL = TARGET_FY ? `FY${TARGET_FY} (過去FY指定)` : `FY${FY_START_DATE.slice(0, 4)} (現FY)`;
console.log(`📅 取得対象: ${FY_LABEL} / 期間: ${FY_START_DATE} 以降`);
console.log(`📁 保存先: ${DATA_DIR}`);

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

  // FY 期間 (5月始まり) を URL エンコード形式で
  const fyYear = parseInt(FY_START_DATE.slice(0, 4));
  const S = encodeURIComponent(`${fyYear}/05/01`);
  const E = encodeURIComponent(`${fyYear + 1}/04/30`);
  console.log(`  期間 (URL encoded): S=${S} / E=${E}`);

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
      formDataObj.set('sd', FY_START_DATE);
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
      formDataObj.set('sd', FY_START_DATE);
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

  // ============================================================
  // ★Phase 0.3-5 (2026-04-28): 5マスタDL追加 (履歴ダッシュボード用)
  // ============================================================
  console.log('=== Master Data Download (Phase 0.3-5) ===');
  const MASTER_LIST = [
    { url: 'customers',              file: 'm_customers.csv',              label: '得意先マスタ' },
    { url: 'products',               file: 'm_products.csv',               label: '商品マスタ' },
    { url: 'suppliers',              file: 'm_suppliers.csv',              label: '仕入先マスタ' },
    { url: 'destinations',           file: 'm_destinations.csv',           label: '納入先マスタ' },
    { url: 'customerproductprices',  file: 'm_customerproductprices.csv',  label: '得意先別商品情報マスタ' },
  ];

  for (const m of MASTER_LIST) {
    try {
      console.log(`  ${m.label} (${m.url}) ...`);
      // Step 1: ページ訪問でセッション取得
      await page.goto(`${FLAM_URL}/${m.url}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1500);

      // Step 2: フォームPOSTで CSV取得
      const response = await page.evaluate(async (params) => {
        const form = document.querySelector('form');
        if (!form) return { status: -1, error: 'No form found' };
        const formData = new FormData(form);
        formData.set('file-format', 'csv');
        formData.set('format', 'csv');
        const res = await fetch(`${params.baseUrl}/${params.urlPath}/export/exec`, {
          method: 'POST',
          credentials: 'include',
          body: formData
        });
        const buffer = await res.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          length: bytes.length,
          bytes: bytes,
        };
      }, { baseUrl: FLAM_URL, urlPath: m.url });

      if (response.status !== 200 || response.length < 50) {
        console.log(`    ⚠️ Failed (status=${response.status}, size=${response.length})`);
        continue;
      }

      // Step 3: 文字コード変換 + 保存
      const buf = Buffer.from(response.bytes);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (e) {
        text = new TextDecoder('shift_jis', { fatal: false }).decode(buf);
      }
      text = text.replace(/^﻿/, '');
      const filePath = path.join(DATA_DIR, m.file);
      fs.writeFileSync(filePath, text, 'utf8');
      const lineCount = text.split('\n').filter(l => l.trim()).length - 1;
      console.log(`    ✅ ${m.file} (${response.length.toLocaleString()} bytes, ${lineCount.toLocaleString()} rows)`);
    } catch (e) {
      console.log(`    ⚠️ ${m.label} failed: ${e.message}`);
    }
  }

  await browser.close();
  console.log('=== Done ===');
})();
