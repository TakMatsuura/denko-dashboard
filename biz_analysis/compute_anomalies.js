/**
 * 経営分析: 統計的異常検知
 *
 * 過去5年 (FY22-FY26) の月次・顧客・商品データを読み込み、
 * - 月次売上の前年比/前月比の変動
 * - 新規/復活顧客
 * - スポット商品 (出現頻度の低い高額商品)
 * - 顧客集中度の変化
 * を抽出してJSONに出力する。
 *
 * 出力: ./anomalies.json
 *   - Claude Opus 4.7 への入力に使う
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const DENKI_DEPTS = ['DNK-E', 'DNK-E-N', 'DNK-E-S'];
const DATA_DIR = path.join(__dirname, '..', 'public', 'data', 'fy');
const OUT_PATH = path.join(__dirname, 'anomalies.json');

// 分析対象FY (Plan B: 過去5年 FY22-FY26)
const TARGET_FYS = [2021, 2022, 2023, 2024, 2025];

function readCsvSjis(filepath) {
  if (!fs.existsSync(filepath)) return [];
  const buf = fs.readFileSync(filepath);
  // try UTF-8 first; fall back to SJIS
  const utf8Try = buf.toString('utf-8');
  const text = utf8Try.includes('�')
    ? iconv.decode(buf, 'shift_jis')
    : utf8Try;
  return parseCSV(text);
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];
  const parseLine = (l) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = parseLine(l);
    const o = {};
    headers.forEach((h, i) => o[h] = cells[i] ?? '');
    return o;
  });
}

const fmt = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '億';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v);
};
const pct = (a, b) => b === 0 ? null : ((a - b) / b) * 100;

console.log('===== 経営分析: 統計的異常検知 =====');
console.log(`対象FY: ${TARGET_FYS.map(y => `FY${String(y).slice(2)}`).join(', ')}`);
console.log('');

// ---------- 1. 月次売上トレンド ----------
const monthlyData = []; // {ym, sales, profit, margin}
for (const fy of TARGET_FYS) {
  const fpath = path.join(DATA_DIR, String(fy), 'dept_sales.csv');
  const rows = readCsvSjis(fpath).filter(r => DENKI_DEPTS.includes(r['部門コード']));
  const byMonth = {};
  rows.forEach(r => {
    const ym = r['集計年月'];
    if (!ym) return;
    if (!byMonth[ym]) byMonth[ym] = { sales: 0, profit: 0, cost: 0 };
    byMonth[ym].sales += Number(r['純売上額']) || 0;
    byMonth[ym].profit += Number(r['粗利益']) || 0;
    byMonth[ym].cost += Number(r['原価計']) || 0;
  });
  Object.entries(byMonth).forEach(([ym, v]) => {
    monthlyData.push({
      ym,
      fy: `FY${String(fy).slice(2)}`,
      sales: v.sales,
      profit: v.profit,
      cost: v.cost,
      margin: v.sales > 0 ? (v.profit / v.sales) * 100 : 0,
    });
  });
}
monthlyData.sort((a, b) => a.ym.localeCompare(b.ym));
console.log(`月次データ: ${monthlyData.length}件`);

// 前月比/前年同月比
monthlyData.forEach((m, i) => {
  // 前月比
  if (i > 0) {
    m.mom_pct = pct(m.sales, monthlyData[i - 1].sales);
  }
  // 前年同月比
  const prevYm = m.ym.replace(/^(\d{4})/, (yy) => String(Number(yy) - 1));
  const prev = monthlyData.find(x => x.ym === prevYm);
  if (prev) {
    m.yoy_pct = pct(m.sales, prev.sales);
  }
});

// 異常月の検出 (前月比±30%以上 or YoY±30%以上)
const anomalyMonths = monthlyData.filter(m => {
  return (m.mom_pct !== undefined && Math.abs(m.mom_pct) >= 30)
    || (m.yoy_pct !== undefined && Math.abs(m.yoy_pct) >= 30);
});
console.log(`異常月 (前月比/YoY ±30%超): ${anomalyMonths.length}件`);

// ---------- 2. 新規・復活・離脱顧客 (FY単位) ----------
// dept_customer_sales.csv は年次累計データ (年月カラムなし)
const customerByFY = {}; // {fy: {custCode: {name, sales, profit}}}
for (const fy of TARGET_FYS) {
  const fpath = path.join(DATA_DIR, String(fy), 'dept_customer_sales.csv');
  const rows = readCsvSjis(fpath).filter(r => DENKI_DEPTS.includes(r['部門コード']));
  const byCust = {};
  rows.forEach(r => {
    const code = r['得意先コード'];
    if (!code) return;
    if (!byCust[code]) byCust[code] = { name: r['得意先名'] || code, sales: 0, profit: 0 };
    byCust[code].sales += Number(r['純売上額']) || 0;
    byCust[code].profit += Number(r['粗利益']) || 0;
  });
  customerByFY[`FY${String(fy).slice(2)}`] = byCust;
}

// 新規顧客 (前FYに存在せず当FYに登場)
const newCustomers = []; // {fy, code, name, sales}
const returnedCustomers = []; // {fy, code, name, sales, gap_fys}
const churnedCustomers = []; // {last_fy, code, name, last_sales}

const fyKeys = TARGET_FYS.map(y => `FY${String(y).slice(2)}`);
const allCustomerHistory = {}; // {code: {name, fysActive: Set, salesByFY: {fy: amount}}}

fyKeys.forEach(fy => {
  Object.entries(customerByFY[fy] || {}).forEach(([code, info]) => {
    if (!allCustomerHistory[code]) {
      allCustomerHistory[code] = { name: info.name, fysActive: new Set(), salesByFY: {} };
    }
    if (info.sales > 0) {
      allCustomerHistory[code].fysActive.add(fy);
      allCustomerHistory[code].salesByFY[fy] = info.sales;
    }
    // name上書き (最新を優先)
    if (info.name) allCustomerHistory[code].name = info.name;
  });
});

fyKeys.forEach((fy, idx) => {
  if (idx === 0) return; // 比較対象なし
  const cur = customerByFY[fy] || {};
  const priorFys = fyKeys.slice(0, idx);
  Object.entries(cur).forEach(([code, info]) => {
    if (info.sales <= 0) return;
    const lastActiveFy = [...priorFys].reverse().find(f => (customerByFY[f]?.[code]?.sales || 0) > 0);
    if (!lastActiveFy) {
      // 過去全FYにいなかった = 新規
      newCustomers.push({ fy, code, name: info.name, sales: info.sales });
    } else {
      const gap = idx - priorFys.indexOf(lastActiveFy) - 1;
      if (gap >= 1) {
        returnedCustomers.push({ fy, code, name: info.name, sales: info.sales, gap_fys: gap });
      }
    }
  });
});

// 離脱顧客 (直近2FY不在 & 過去にあった)
const lastFy = fyKeys[fyKeys.length - 1];
const lastFy2 = fyKeys[fyKeys.length - 2];
Object.entries(allCustomerHistory).forEach(([code, h]) => {
  if (!h.fysActive.has(lastFy) && !h.fysActive.has(lastFy2) && h.fysActive.size > 0) {
    const lastActive = [...h.fysActive].sort().reverse()[0];
    churnedCustomers.push({
      last_fy: lastActive,
      code,
      name: h.name,
      last_sales: h.salesByFY[lastActive] || 0,
    });
  }
});

console.log(`新規顧客: ${newCustomers.length}件 / 復活顧客: ${returnedCustomers.length}件 / 離脱顧客: ${churnedCustomers.length}件`);

// ---------- 3. スポット商品 (一発高額案件) ----------
// dept_product_sales.csv は月次商品データ
const spotProducts = []; // {ym, product_code, product_name, sales}
for (const fy of TARGET_FYS) {
  const fpath = path.join(DATA_DIR, String(fy), 'dept_product_sales.csv');
  const rows = readCsvSjis(fpath).filter(r => DENKI_DEPTS.includes(r['部門コード']));
  rows.forEach(r => {
    const sales = Number(r['純売上額']) || 0;
    if (sales >= 5_000_000) { // 500万以上の単月商品売上
      spotProducts.push({
        ym: r['集計年月'],
        product_code: r['商品コード'],
        product_name: r['商品名'],
        spec: r['仕様の規格'] || '',
        sales,
        profit: Number(r['粗利益']) || 0,
        margin: Number(r['粗利率']) || 0,
        qty: Number(r['純売上数']) || 0,
      });
    }
  });
}
spotProducts.sort((a, b) => b.sales - a.sales);
console.log(`スポット商品 (単月500万超): ${spotProducts.length}件`);

// ---------- 4. 顧客集中度の推移 ----------
const concentrationByFY = {}; // {fy: {top1_share, top3_share, top10_share, total}}
fyKeys.forEach(fy => {
  const custs = Object.values(customerByFY[fy] || {})
    .map(c => c.sales)
    .filter(s => s > 0)
    .sort((a, b) => b - a);
  const total = custs.reduce((s, x) => s + x, 0);
  concentrationByFY[fy] = {
    total,
    customer_count: custs.length,
    top1_share: total > 0 ? (custs[0] || 0) / total * 100 : 0,
    top3_share: total > 0 ? custs.slice(0, 3).reduce((s, x) => s + x, 0) / total * 100 : 0,
    top10_share: total > 0 ? custs.slice(0, 10).reduce((s, x) => s + x, 0) / total * 100 : 0,
  };
});

// ---------- 5. FYサマリ ----------
const fySummary = fyKeys.map(fy => {
  const monthsInFy = monthlyData.filter(m => m.fy === fy);
  const sales = monthsInFy.reduce((s, m) => s + m.sales, 0);
  const profit = monthsInFy.reduce((s, m) => s + m.profit, 0);
  return {
    fy,
    months: monthsInFy.length,
    sales,
    profit,
    margin: sales > 0 ? (profit / sales) * 100 : 0,
    customers: concentrationByFY[fy].customer_count,
    top1_share: concentrationByFY[fy].top1_share,
  };
});

// ---------- 出力 ----------
const output = {
  generated_at: new Date().toISOString(),
  target_fys: fyKeys,
  fy_summary: fySummary,
  monthly_data: monthlyData,
  anomaly_months: anomalyMonths,
  new_customers: newCustomers.sort((a, b) => b.sales - a.sales),
  returned_customers: returnedCustomers.sort((a, b) => b.sales - a.sales),
  churned_customers: churnedCustomers.sort((a, b) => b.last_sales - a.last_sales).slice(0, 30),
  spot_products: spotProducts.slice(0, 50), // Top 50
  concentration: concentrationByFY,
  // Top顧客 (FY別)
  top_customers_by_fy: Object.fromEntries(
    fyKeys.map(fy => [
      fy,
      Object.entries(customerByFY[fy] || {})
        .map(([code, info]) => ({ code, name: info.name, sales: info.sales, profit: info.profit }))
        .filter(c => c.sales > 0)
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 10),
    ])
  ),
};

fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`\n✅ ${OUT_PATH}`);
console.log(`   月次: ${monthlyData.length} / 異常月: ${anomalyMonths.length}`);
console.log(`   新規: ${newCustomers.length} / 復活: ${returnedCustomers.length} / 離脱: ${churnedCustomers.length}`);
console.log(`   スポット商品: ${spotProducts.length} (Top50保存)`);
