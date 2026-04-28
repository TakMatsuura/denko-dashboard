/**
 * Phase 0.3-6: GitHub Actions サーバ側マスタ週次スナップショット
 * - FLAMから5マスタをDL
 * - data/master_snapshots/YYYY-MM-DD/ にgzip圧縮で保存
 * - 個人PC依存ゼロ (クラウド実行)
 *
 * メモリ効率: page.evaluate経由ではなく context.request.post() で直接Buffer取得
 * (108K行productsを page.evaluate でやるとV8 4GBヒープOOM)
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
      // /export ページに移動してフォームのhidden field (CSRFトークン等) を取得
      await page.goto(`${FLAM_URL}/${m.url}/export`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1500);

      // フォームのフィールド情報をブラウザから抽出 (軽量)
      const formInfo = await page.evaluate(() => {
        const form = document.querySelector('form');
        if (!form) return null;
        const fields = {};
        // hidden inputs (CSRF等)
        form.querySelectorAll('input[type=hidden]').forEach(el => {
          if (el.name) fields[el.name] = el.value;
        });
        // text/number inputs (デフォルト値)
        form.querySelectorAll('input[type=text], input[type=number]').forEach(el => {
          if (el.name && el.value) fields[el.name] = el.value;
        });
        // select の選択値
        form.querySelectorAll('select').forEach(sel => {
          if (sel.name) fields[sel.name] = sel.value;
        });
        // checkbox/radio (チェック済みのみ)
        form.querySelectorAll('input[type=checkbox]:checked, input[type=radio]:checked').forEach(el => {
          if (el.name) fields[el.name] = el.value;
        });
        return { action: form.action || '', method: form.method || 'POST', fields };
      });

      if (!formInfo) {
        console.log(`    ⚠️ No form on /${m.url}/export`);
        summary.files.push({ file: m.file, status: 'no_form' });
        continue;
      }

      // file-format を CSV に上書き
      formInfo.fields['file-format'] = 'csv';
      formInfo.fields['format'] = 'csv';

      // Playwright の APIRequestContext で POST (Node側fetch・Bufferを直接取得)
      const postUrl = `${FLAM_URL}/${m.url}/export/exec`;
      const apiRes = await context.request.post(postUrl, { form: formInfo.fields });
      const status = apiRes.status();
      const contentType = apiRes.headers()['content-type'] || '';

      if (status !== 200) {
        console.log(`    ⚠️ POST ${postUrl} → status=${status}`);
        summary.files.push({ file: m.file, status: 'failed', http_status: status });
        continue;
      }

      const rawBuf = await apiRes.body();  // Buffer (バイナリ直接、CDP serializeなし)
      console.log(`    POST status=${status}, type=${contentType}, raw=${rawBuf.length.toLocaleString()}B`);

      if (rawBuf.length < 50) {
        console.log(`    ⚠️ Body too small`);
        summary.files.push({ file: m.file, status: 'failed', bytes: rawBuf.length });
        continue;
      }

      // 文字コード判定 → UTF-8 化
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(rawBuf);
      } catch (e) {
        text = new TextDecoder('shift_jis', { fatal: false }).decode(rawBuf);
      }
      text = text.replace(/^﻿/, '');

      // gzip圧縮で保存 (5-10x圧縮)
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
