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

  // Orders: need to navigate, fill dates, click search, then export
  try {
    console.log('  Loading orders page...');
    await page.goto(`${FLAM_URL}/orders/report/view/analysis`, { waitUntil: 'networkidle', timeout: 60000 });

    // Fill start date
    const sdInput = page.locator('input[name="sd"]').first();
    await sdInput.fill('2025/05/01');

    // Fill end date
    const edInput = page.locator('input[name="ed"]').first();
    await edInput.fill('2026/04/30');

    // Click search button
    await page.locator('input[name="検索"], input[type="image"][name="検索"]').first().click();
    await page.waitForTimeout(5000);
    console.log('  Orders search completed');

    // Now fetch the export
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'include' });
      const buffer = await res.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes };
    }, `${FLAM_URL}/orders/report/view/analysis/export?rt=1&sd=2025%2F05%2F01&ed=2026%2F04%2F30&fi=&file-format=csv`);

    console.log(`  Orders export: ${response.status}, type: ${response.contentType}, size: ${response.length}`);
    fs.writeFileSync(path.join(DATA_DIR, 'orders.csv'), Buffer.from(response.bytes));
    console.log(`Downloaded: orders.csv (${response.length} bytes)`);
  } catch (e) {
    console.log(`  Orders download failed: ${e.message}`);
  }

  // Stockrecents: similar approach
  try {
    console.log('  Loading stockrecents page...');
    await page.goto(`${FLAM_URL}/stockrecents/export`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    const response = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'include' });
      const buffer = await res.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes };
    }, `${FLAM_URL}/stockrecents/export/download?file-format=csv`);

    console.log(`  Stock export: ${response.status}, type: ${response.contentType}, size: ${response.length}`);
    fs.writeFileSync(path.join(DATA_DIR, 'stockrecents.csv'), Buffer.from(response.bytes));
    console.log(`Downloaded: stockrecents.csv (${response.length} bytes)`);
  } catch (e) {
    console.log(`  Stock download failed: ${e.message}`);
  }

  await browser.close();
  console.log('=== Done ===');
})();
