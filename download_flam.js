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

  await downloadCSV(context, page,
    `${FLAM_URL}/orders/report/view/analysis?preview=1&rt=1&sd=${S}&ed=${E}&fi=`,
    `${FLAM_URL}/orders/report/view/analysis/export?rt=1&sd=${S}&ed=${E}&fi=&file-format=csv`,
    'orders.csv');

  await downloadCSV(context, page,
    `${FLAM_URL}/stockrecents/export`,
    `${FLAM_URL}/stockrecents/export/download?file-format=csv`,
    'stockrecents.csv');

  await browser.close();
  console.log('=== Done ===');
})();
