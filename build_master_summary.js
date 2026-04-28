/**
 * Phase 0.3-5: マスタ履歴ダッシュボード用 差分計算 + サマリ生成
 * - DATA_DIR の m_*.csv を読み込み
 * - data/master_history/YYYY-MM-DD.json として履歴保存
 * - 過去履歴と比較して master_summary.json (current+30日推移) 生成
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = '/tmp/flam_data';
const SCRIPT_DIR = __dirname;
const HISTORY_DIR = path.join(SCRIPT_DIR, 'data', 'master_history');
const SUMMARY_OUTPUT = path.join(SCRIPT_DIR, 'data', 'master_summary.json');

fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(path.dirname(SUMMARY_OUTPUT), { recursive: true });

// 今日の日付 (JST)
const now = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const jstDate = new Date(now.getTime() + jstOffset);
const TODAY = jstDate.toISOString().slice(0, 10);  // YYYY-MM-DD

const MASTER_FILES = {
  customers: 'm_customers.csv',
  products: 'm_products.csv',
  suppliers: 'm_suppliers.csv',
  destinations: 'm_destinations.csv',
  customerproductprices: 'm_customerproductprices.csv',
};

const MASTER_LABELS = {
  customers: '得意先マスタ',
  products: '商品マスタ',
  suppliers: '仕入先マスタ',
  destinations: '納入先マスタ',
  customerproductprices: '得意先別商品情報マスタ',
};

// ===== ユーティリティ =====
function parseCSV(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return { header: [], rows: [] };
  const parseRow = (line) => {
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        result.push(cur); cur = '';
      } else { cur += c; }
    }
    result.push(cur);
    return result;
  };
  const header = parseRow(lines[0]);
  const rows = lines.slice(1).map(parseRow);
  return { header, rows };
}

function getColumnIdx(header, ...candidates) {
  for (const c of candidates) {
    const idx = header.findIndex(h => h.replace(/^"|"$/g, '') === c);
    if (idx >= 0) return idx;
  }
  return -1;
}

// ===== 当日サマリ生成 =====
console.log(`=== Master Summary Build (${TODAY}) ===`);

const todaySnapshot = {
  date: TODAY,
  counts: {},
  codes: {},  // 各マスタのコード集合 (Set→array, 大きさを抑える: products以外)
  prices_sample: {},  // 単価情報 (得意先×商品 → 単価)
};

for (const [key, file] of Object.entries(MASTER_FILES)) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`  SKIP ${key}: ${file} not found`);
    todaySnapshot.counts[key] = null;
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const { header, rows } = parseCSV(content);
  todaySnapshot.counts[key] = rows.length;

  // コード列を抽出
  let codeIdx = -1;
  if (key === 'customers') codeIdx = getColumnIdx(header, '得意先コード');
  else if (key === 'products') codeIdx = getColumnIdx(header, '商品コード');
  else if (key === 'suppliers') codeIdx = getColumnIdx(header, '仕入先コード');
  else if (key === 'destinations') codeIdx = getColumnIdx(header, '納入先コード');

  if (codeIdx >= 0 && key !== 'products') {
    todaySnapshot.codes[key] = rows.map(r => (r[codeIdx] || '').replace(/^"|"$/g, '').trim()).filter(c => c);
  }

  // products は件数のみ (大量のため詳細はスキップ)
  if (key === 'products') {
    todaySnapshot.codes[key] = rows.length;  // 件数のみ
  }

  // customerproductprices は単価mapを抽出
  if (key === 'customerproductprices') {
    const custIdx = getColumnIdx(header, '得意先コード');
    const prodIdx = getColumnIdx(header, '商品コード');
    const priceIdx = getColumnIdx(header, '単価１', '単価1');
    if (custIdx >= 0 && prodIdx >= 0 && priceIdx >= 0) {
      const priceMap = {};
      for (const r of rows) {
        const cust = (r[custIdx] || '').replace(/^"|"$/g, '').trim();
        const prod = (r[prodIdx] || '').replace(/^"|"$/g, '').trim();
        const price = (r[priceIdx] || '').replace(/^"|"$/g, '').trim();
        if (cust && prod && price) {
          const k = `${cust}|${prod}`;
          priceMap[k] = parseInt(price, 10) || 0;
        }
      }
      // 全てを保存するとサイズ大 → ハッシュ化して圧縮
      const priceKeys = Object.keys(priceMap);
      todaySnapshot.prices_sample = {
        total: priceKeys.length,
        // 全件のハッシュキーリスト (差分検出用、 サイズ削減のため price と key のみ)
        // 1日のJSONを5MB以下に
        all: priceMap,
      };
    }
  }
  console.log(`  ${key}: ${rows.length.toLocaleString()} rows`);
}

// ===== 履歴保存 =====
const todayHistoryPath = path.join(HISTORY_DIR, `${TODAY}.json`);
// 軽量版: pricesは上限の単価マップを別ファイルに保存
const todayLite = {
  date: TODAY,
  counts: todaySnapshot.counts,
  codes: todaySnapshot.codes,
};
fs.writeFileSync(todayHistoryPath, JSON.stringify(todayLite, null, 2));
console.log(`Saved history: ${todayHistoryPath}`);

// 単価mapは別ファイル (大きいため)
const todayPricesPath = path.join(HISTORY_DIR, `${TODAY}_prices.json`);
fs.writeFileSync(todayPricesPath, JSON.stringify(todaySnapshot.prices_sample, null, 0));
console.log(`Saved prices: ${todayPricesPath}`);

// ===== 過去履歴読込 + 差分計算 =====
const historyFiles = fs.readdirSync(HISTORY_DIR)
  .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();
console.log(`History files: ${historyFiles.length}`);

const trend = historyFiles.slice(-30).map(f => {
  const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
  return { date: data.date, counts: data.counts };
});

// 直近の差分 (前日 vs 今日)
let diffSummary = {
  added: {}, removed: {}, count_change: {},
};
if (historyFiles.length >= 2) {
  const yesterdayFile = historyFiles[historyFiles.length - 2];
  const yesterday = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, yesterdayFile), 'utf8'));
  for (const key of Object.keys(MASTER_FILES)) {
    const todayCount = todaySnapshot.counts[key] || 0;
    const yesterdayCount = (yesterday.counts && yesterday.counts[key]) || 0;
    diffSummary.count_change[key] = todayCount - yesterdayCount;

    // コード比較 (products以外)
    if (key !== 'products' && Array.isArray(todaySnapshot.codes[key]) && yesterday.codes && Array.isArray(yesterday.codes[key])) {
      const todaySet = new Set(todaySnapshot.codes[key]);
      const yesterdaySet = new Set(yesterday.codes[key]);
      diffSummary.added[key] = [...todaySet].filter(x => !yesterdaySet.has(x));
      diffSummary.removed[key] = [...yesterdaySet].filter(x => !todaySet.has(x));
    }
  }

  // 単価変更検知
  const yesterdayPricesPath = path.join(HISTORY_DIR, `${yesterday.date}_prices.json`);
  if (fs.existsSync(yesterdayPricesPath)) {
    const yesterdayPrices = JSON.parse(fs.readFileSync(yesterdayPricesPath, 'utf8'));
    if (yesterdayPrices.all && todaySnapshot.prices_sample.all) {
      const priceChanges = [];
      for (const key of Object.keys(todaySnapshot.prices_sample.all)) {
        const todayPrice = todaySnapshot.prices_sample.all[key];
        const yesterdayPrice = yesterdayPrices.all[key];
        if (yesterdayPrice !== undefined && yesterdayPrice !== todayPrice) {
          const [cust, prod] = key.split('|');
          priceChanges.push({ customer: cust, product: prod, old: yesterdayPrice, new: todayPrice });
        }
      }
      diffSummary.price_changes = priceChanges.slice(0, 100);  // 上位100件
      diffSummary.price_changes_total = priceChanges.length;
    }
  }
}

// ===== サマリ生成 =====
const summary = {
  generated_at: new Date().toISOString(),
  today: TODAY,
  labels: MASTER_LABELS,
  current: todaySnapshot.counts,
  trend: trend,
  diff: diffSummary,
};

fs.writeFileSync(SUMMARY_OUTPUT, JSON.stringify(summary, null, 2));
console.log(`Saved summary: ${SUMMARY_OUTPUT}`);
console.log(`Trend points: ${trend.length}`);
console.log(`Diff summary:`, {
  added_total: Object.values(diffSummary.added || {}).reduce((s, a) => s + (a?.length || 0), 0),
  removed_total: Object.values(diffSummary.removed || {}).reduce((s, a) => s + (a?.length || 0), 0),
  price_changes_total: diffSummary.price_changes_total || 0,
});
console.log('=== Done ===');
