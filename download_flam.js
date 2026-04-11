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

  // Orders: navigate to page, interact with form, find export link
  try {
    console.log('  Loading orders report page...');
    await page.goto(`${FLAM_URL}/orders/report/view/analysis`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Debug: dump all form elements on the page
    const formInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select, button, a'));
      return inputs.map(el => ({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        class: el.className || '',
        text: (el.textContent || '').trim().substring(0, 50),
        href: el.href || '',
        value: el.value || ''
      })).filter(e => e.name || e.type === 'submit' || e.text.includes('検索') || e.text.includes('エクスポート') || e.text.includes('CSV') || e.text.includes('ダウンロード') || e.text.includes('export') || e.href.includes('export'));
    });
    console.log('  Form elements found:');
    formInfo.forEach(e => console.log(`    ${e.tag} name="${e.name}" id="${e.id}" type="${e.type}" class="${e.class}" text="${e.text}" href="${e.href}" value="${e.value}"`));

    // Fill date fields - try various possible selectors
    const dateSelectors = ['input[name="sd"]', '#sd', 'input[name="data[sd]"]', 'input[name="data[Order][sd]"]'];
    for (const sel of dateSelectors) {
      const el = await page.$(sel);
      if (el) { await el.fill('2025/05/01'); console.log(`  Set start date via ${sel}`); break; }
    }
    const endDateSelectors = ['input[name="ed"]', '#ed', 'input[name="data[ed]"]', 'input[name="data[Order][ed]"]'];
    for (const sel of endDateSelectors) {
      const el = await page.$(sel);
      if (el) { await el.fill('2026/04/30'); console.log(`  Set end date via ${sel}`); break; }
    }

    // Try to find and click search/submit button by various methods
    const btnSelectors = [
      'input[type="submit"]', 'button[type="submit"]',
      'input[value="検索"]', 'button:has-text("検索")',
      'a:has-text("検索")', '.search-btn', '#search-btn',
      'input.btn', 'button.btn'
    ];
    let clicked = false;
    for (const sel of btnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(5000);
          console.log(`  Clicked search: ${sel}`);
          clicked = true;
          break;
        }
      } catch (e) { /* ignore */ }
    }
    if (!clicked) {
      // Try form submit directly
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) form.submit();
      });
      await page.waitForTimeout(5000);
      console.log('  Submitted form via JS');
    }

    // Debug: check page after search
    const pageTitle = await page.title();
    console.log(`  After search - Page: ${pageTitle}, URL: ${page.url()}`);

    // Look for export/download links on the page
    const exportLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(a => a.href && (a.href.includes('export') || a.href.includes('download') || a.href.includes('csv')))
        .map(a => ({ href: a.href, text: (a.textContent || '').trim().substring(0, 50) }));
    });
    console.log('  Export links on page:');
    exportLinks.forEach(l => console.log(`    "${l.text}" -> ${l.href}`));

    // Try clicking export link if found, or use download event
    let downloaded = false;
    if (exportLinks.length > 0) {
      for (const link of exportLinks) {
        if (link.href.includes('csv') || link.href.includes('export')) {
          console.log(`  Trying export link: ${link.href}`);
          const response = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            const buffer = await res.arrayBuffer();
            const bytes = Array.from(new Uint8Array(buffer));
            const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes).slice(0, 200));
            return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes, preview: text };
          }, link.href);

          const preview = response.preview.trimStart();
          console.log(`  Response: ${response.status}, size: ${response.length}, preview: ${preview.substring(0, 80)}`);
          if (!preview.startsWith('<!DOCTYPE') && !preview.startsWith('<html') && !preview.startsWith('<?xml') && response.length > 100) {
            fs.writeFileSync(path.join(DATA_DIR, 'orders.csv'), Buffer.from(response.bytes));
            console.log(`Downloaded: orders.csv (${response.length} bytes)`);
            downloaded = true;
            break;
          }
        }
      }
    }

    if (!downloaded) {
      // Last resort: try POST request to export URL
      console.log('  Trying POST export...');
      const response = await page.evaluate(async (url) => {
        const formData = new FormData();
        formData.append('file-format', 'csv');
        const res = await fetch(url, { method: 'POST', credentials: 'include', body: formData });
        const buffer = await res.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes).slice(0, 200));
        return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes, preview: text };
      }, `${FLAM_URL}/orders/report/view/analysis/export`);

      const preview = response.preview.trimStart();
      console.log(`  POST response: ${response.status}, size: ${response.length}, preview: ${preview.substring(0, 80)}`);
      if (!preview.startsWith('<!DOCTYPE') && !preview.startsWith('<html') && !preview.startsWith('<?xml') && response.length > 100) {
        fs.writeFileSync(path.join(DATA_DIR, 'orders.csv'), Buffer.from(response.bytes));
        console.log(`Downloaded: orders.csv (${response.length} bytes)`);
        downloaded = true;
      }
    }

    if (!downloaded) console.log('  WARNING: Could not get orders CSV');
  } catch (e) {
    console.log(`  Orders download failed: ${e.message}`);
  }

  // Stockrecents: find actual export links on the page
  try {
    console.log('  Loading stockrecents page...');
    await page.goto(`${FLAM_URL}/stockrecents`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Debug: find all links with export/download/csv
    const stockLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(a => a.href && (a.href.includes('export') || a.href.includes('download') || a.href.includes('csv') || (a.textContent || '').includes('エクスポート') || (a.textContent || '').includes('CSV')))
        .map(a => ({ href: a.href, text: (a.textContent || '').trim().substring(0, 50) }));
    });
    console.log('  Stock page links:');
    stockLinks.forEach(l => console.log(`    "${l.text}" -> ${l.href}`));

    // Also check for dropdown menus that might be hidden
    const hiddenLinks = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('li a, .dropdown-menu a, [class*="export"] a, [class*="download"]'));
      return items
        .filter(a => a.href)
        .map(a => ({ href: a.href, text: (a.textContent || '').trim().substring(0, 50), visible: a.offsetParent !== null }));
    });
    console.log('  Hidden/dropdown links:');
    hiddenLinks.forEach(l => console.log(`    [${l.visible ? 'visible' : 'hidden'}] "${l.text}" -> ${l.href}`));

    let downloaded = false;

    // Try all found export links
    for (const link of [...stockLinks, ...hiddenLinks]) {
      if (link.href && (link.href.includes('export') || link.href.includes('csv'))) {
        const response = await page.evaluate(async (url) => {
          const res = await fetch(url, { credentials: 'include' });
          const buffer = await res.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buffer));
          const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes).slice(0, 200));
          return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes, preview: text };
        }, link.href);

        const preview = response.preview.trimStart();
        console.log(`  Stock try "${link.text}": ${response.status}, size: ${response.length}, preview: ${preview.substring(0, 60)}`);
        if (!preview.startsWith('<!DOCTYPE') && !preview.startsWith('<html') && !preview.startsWith('<?xml') && response.length > 100) {
          fs.writeFileSync(path.join(DATA_DIR, 'stockrecents.csv'), Buffer.from(response.bytes));
          console.log(`Downloaded: stockrecents.csv (${response.length} bytes)`);
          downloaded = true;
          break;
        }
      }
    }

    if (!downloaded) {
      // Fallback: try known URLs
      const stockUrls = [
        `${FLAM_URL}/stockrecents/export/download?file-format=csv`,
        `${FLAM_URL}/stockrecents/export?file-format=csv`,
        `${FLAM_URL}/stockrecents/index/export?file-format=csv`,
      ];
      for (const url of stockUrls) {
        const response = await page.evaluate(async (url) => {
          const res = await fetch(url, { credentials: 'include' });
          const buffer = await res.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buffer));
          const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes).slice(0, 200));
          return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes, preview: text };
        }, url);
        const preview = response.preview.trimStart();
        console.log(`  Stock fallback: ${response.status}, size: ${response.length}, preview: ${preview.substring(0, 60)}`);
        if (!preview.startsWith('<!DOCTYPE') && !preview.startsWith('<html') && !preview.startsWith('<?xml') && response.length > 100) {
          fs.writeFileSync(path.join(DATA_DIR, 'stockrecents.csv'), Buffer.from(response.bytes));
          console.log(`Downloaded: stockrecents.csv (${response.length} bytes)`);
          downloaded = true;
          break;
        }
      }
    }

    if (!downloaded) console.log('  WARNING: Could not get stockrecents CSV');
  } catch (e) {
    console.log(`  Stock download failed: ${e.message}`);
  }

  await browser.close();
  console.log('=== Done ===');
})();
