const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FLAM_URL = 'https://dnk.flam.bz';
const FLAM_ID = process.env.FLAM_ID;
const FLAM_PW = process.env.FLAM_PW;
const DATA_DIR = '/tmp/flam_data';

fs.mkdirSync(DATA_DIR, { recursive: true });

async function downloadCSV(page, searchUrl, downloadSelector, filename) {
  await page.goto(searchUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click(downloadSelector),
    page.waitForTimeout(500),
    page.click('a[data-format="csv"]'),
  ]);

  const filePath = path.join(DATA_DIR, filename);
  await download.saveAs(filePath);
  const size = fs.statSync(filePath).size;
  console.log(`Downloaded: ${filename} (${size} bytes)`);
  return filePath;
}

(async () => {
  console.log('=== Step 1: Launch browser and login ===');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${FLAM_URL}/login`);
  await page.fill('input[name="data[User][loginid]"]', FLAM_ID);
  await page.fill('input[name="data[User][password]"]', FLAM_PW);
  await page.click('input[type="submit"]');
  await page.waitForURL('**/');
  console.log('Logged in');

  const START = '2025/05/01';
  const END = '2026/04/30';
  const S = encodeURIComponent(START);
  const E = encodeURIComponent(END);

  console.log('=== Step 2: Download CSVs ===');

  // 1. Dept + Month sales
  await downloadCSV(page,
    `${FLAM_URL}/sales/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=section&grouping%5B%5D=slipdate&limit=20`,
    '#btn_download', 'dept_sales.csv');

  // 2. Dept + Customer sales
  await downloadCSV(page,
    `${FLAM_URL}/sales/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=customer&grouping%5B%5D=section&limit=20`,
    '#btn_download', 'dept_customer_sales.csv');

  // 3. Dept + Product + Month sales
  await downloadCSV(page,
    `${FLAM_URL}/sales/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=section&grouping%5B%5D=product&grouping%5B%5D=slipdate&limit=20`,
    '#btn_download', 'dept_product_sales.csv');

  // 4. Dept + Supplier + Month purchase
  await downloadCSV(page,
    `${FLAM_URL}/purchases/totalize?startdate=${S}&enddate=${E}&grouping%5B%5D=suppliers&grouping%5B%5D=section&grouping%5B%5D=slipdate&limit=20`,
    '#btn_download', 'dept_purchase.csv');

  // 5. Orders
  try {
    await page.goto(`${FLAM_URL}/orders/report/view/analysis?preview=1&rt=1&sd=${S}&ed=${E}&fi=`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const [dlOrders] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn_download'),
      page.waitForTimeout(500),
      page.click('a[data-format="csv"]'),
    ]);
    await dlOrders.saveAs(path.join(DATA_DIR, 'orders.csv'));
    console.log(`Downloaded: orders.csv (${fs.statSync(path.join(DATA_DIR, 'orders.csv')).size} bytes)`);
  } catch (e) {
    console.log('Orders download failed:', e.message);
  }

  // 6. Stock
  try {
    await page.goto(`${FLAM_URL}/stockrecents/export`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const [dlStock] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn_download'),
      page.waitForTimeout(500),
      page.click('a[data-format="csv"]'),
    ]);
    await dlStock.saveAs(path.join(DATA_DIR, 'stockrecents.csv'));
    console.log(`Downloaded: stockrecents.csv (${fs.statSync(path.join(DATA_DIR, 'stockrecents.csv')).size} bytes)`);
  } catch (e) {
    console.log('Stock download failed:', e.message);
  }

  await browser.close();
  console.log('=== Browser closed ===');
})();
