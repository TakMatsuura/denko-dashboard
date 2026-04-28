/**
 * Phase 0.3-6: GitHub Actions サーバ側マスタ週次スナップショット
 * - FLAMから5マスタをDL
 * - data/master_snapshots/YYYY-MM-DD/ にgzip圧縮で保存
 * - 個人PC依存ゼロ (クラウド実行)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FLAM_URL = 'https://dnk.flam.bz';
const FLAM_ID = process.env.FLAM_ID;
const FLAM_PW = process.env.FLAM_PW;
const SCRIPT_DIR = __dirname;

// JST date YYYY-MM-DD
const now = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const TODAY = new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const SNAPSHOT_DIR = path.join(SCRIPT_DIR, 'data', 'master_snapshots', TODAY);

fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const MASTER_LIST = [
  { url: 'customers',              file: 'm_customers.csv',              label: '得意先マスタ' },
  { url: 'products',               file: 'm_products.csv',               label: '商品マスタ' },
  { url: 'suppliers',              file: 'm_suppliers.csv',              label: '仕入先マスタ' },
  { url: 'destinations',           file: 'm_destinations.csv',           label: '納入先マスタ' },
  { url: 'customerproductprices',  file: 'm_customerproductprices.csv',  label: '得意先別商品情報マスタ' },
];

(async () => {
  console.log(`=== Weekly Master Sync (${TODAY}) ===`);
  console.log(`Snapshot dir: ${SNAPSHOT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Login
  await page.goto(`${FLAM_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="data[User][loginid]"]', FLAM_ID);
  await page.fill('input[name="data[User][password]"]', FLAM_PW);
  await page.click('input[type="submit"]');
  await page.waitForURL('**/', { timeout: 30000 });
  console.log('Logged in to FLAM');

  const summary = { date: TODAY, files: [] };

  for (const m of MASTER_LIST) {
    try {
      console.log(`  ${m.label} (${m.url}) ...`);
      await page.goto(`${FLAM_URL}/${m.url}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1500);

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
        return { status: res.status, contentType: res.headers.get('content-type'), length: bytes.length, bytes: bytes };
      }, { baseUrl: FLAM_URL, urlPath: m.url });

      if (response.status !== 200 || response.length < 50) {
        console.log(`    ⚠️ Failed (status=${response.status}, size=${response.length})`);
        summary.files.push({ file: m.file, status: 'failed', bytes: 0 });
        continue;
      }

      const buf = Buffer.from(response.bytes);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (e) {
        text = new TextDecoder('shift_jis', { fatal: false }).decode(buf);
      }
      text = text.replace(/^﻿/, '');

      // Save as gzip (5-10x smaller than raw CSV)
      const utf8Buf = Buffer.from(text, 'utf8');
      const gzipped = zlib.gzipSync(utf8Buf, { level: 9 });
      const outPath = path.join(SNAPSHOT_DIR, `${m.file}.gz`);
      fs.writeFileSync(outPath, gzipped);

      const rowCount = text.split('\n').filter(l => l.trim()).length - 1;
      console.log(`    ✅ ${m.file}.gz (raw=${utf8Buf.length.toLocaleString()}B, gz=${gzipped.length.toLocaleString()}B, ${rowCount.toLocaleString()} rows)`);
      summary.files.push({
        file: `${m.file}.gz`,
        status: 'ok',
        raw_bytes: utf8Buf.length,
        gz_bytes: gzipped.length,
        rows: rowCount
      });
    } catch (e) {
      console.log(`    ⚠️ ${m.label} failed: ${e.message}`);
      summary.files.push({ file: m.file, status: 'error', error: e.message });
    }
  }

  // Save manifest
  const manifestPath = path.join(SNAPSHOT_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(summary, null, 2));
  console.log(`Saved manifest: ${manifestPath}`);

  await browser.close();
  console.log('=== Weekly Master Sync Done ===');
})();
