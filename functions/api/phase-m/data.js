/**
 * Cloudflare Pages Function — Phase M ダッシュボード集計エンドポイント
 *
 * GET /api/phase-m/data
 *
 * データソース:
 *   public/data/run_history.jsonl (build時に Box から GitHub repo に取り込み)
 *   ※当面はモックデータで動作確認、本番接続は M-2.5 で
 *
 * レスポンス:
 *   {
 *     today: { processed, success, warning, failed, in_progress },
 *     monthly_trend: [...日次件数の30日分],
 *     by_eigyo: [{ eigyo, count, success_rate, last_action }],
 *     errors: { by_stage, recent_errors, recurring_products },
 *     phase_b: { count, customers, days_until_removal },
 *     master_register: { count, products },
 *     notifications: [...直近30件],
 *     cost: { gemini_count, anthropic_count, monthly_usd_estimate },
 *     alerts: [...]
 *   }
 */

const PHASE_B_REMOVAL_DATE = new Date('2026-07-01T00:00:00+09:00');

export const onRequest = async ({ request, env }) => {
  // 認証は _middleware.js で済んでいる前提

  try {
    // データソース読込み (R2/KV対応 or static file)
    let runHistoryText = '';
    try {
      // 1. R2 (推奨) - 環境変数 PHASE_M_BUCKET に R2 binding がセットされている場合
      if (env.PHASE_M_BUCKET) {
        const obj = await env.PHASE_M_BUCKET.get('run_history.jsonl');
        if (obj) runHistoryText = await obj.text();
      }
      // 2. fallback: static file (build時にコピー)
      if (!runHistoryText) {
        const url = new URL(request.url);
        const staticUrl = `${url.origin}/data/run_history.jsonl`;
        const r = await fetch(staticUrl);
        if (r.ok) runHistoryText = await r.text();
      }
    } catch (e) {
      console.error('[phase-m/data] data load failed:', e.message);
    }

    let entries = [];
    let dataSourceLabel = 'empty';
    if (runHistoryText) {
      entries = runHistoryText.split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && !e.dry_run);  // dry_run は除外
      dataSourceLabel = entries.length > 0 ? 'live' : 'empty';
    } else {
      // モックデータ
      entries = generateMockEntries();
      dataSourceLabel = 'mock';
    }

    // 集計
    const summary = aggregate(entries, dataSourceLabel);

    return new Response(JSON.stringify(summary, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// =================== 集計ロジック ===================
function aggregate(entries, dataSourceLabel) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const today = entries.filter(e => e.ts.slice(0, 10) === todayStr);
  const thisMonth = entries.filter(e => e.ts >= startOfMonth);

  // 1. 今日の状況
  const todayStatus = {
    processed: today.length,
    success: today.filter(e => e.status === 'success').length,
    warning: today.filter(e => e.status === 'warning').length,
    failed: today.filter(e => e.status === 'failed').length,
    in_progress: 0,  // 状態 'pending' は完了前なのでログには通常入らない
  };

  // 2. 月間トレンド (直近30日の日次件数)
  const monthlyTrend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const dayEntries = entries.filter(e => e.ts.slice(0, 10) === ds);
    monthlyTrend.push({
      date: ds,
      total: dayEntries.length,
      success: dayEntries.filter(e => e.status === 'success').length,
      failed: dayEntries.filter(e => e.status === 'failed').length,
    });
  }

  // 3. 営業別 (今月)
  const eigyoMap = {};
  thisMonth.forEach(e => {
    const k = e.eigyo || 'unknown';
    if (!eigyoMap[k]) eigyoMap[k] = { eigyo: k, count: 0, success: 0, last_ts: null };
    eigyoMap[k].count++;
    if (e.status === 'success') eigyoMap[k].success++;
    if (!eigyoMap[k].last_ts || e.ts > eigyoMap[k].last_ts) eigyoMap[k].last_ts = e.ts;
  });
  const byEigyo = Object.values(eigyoMap)
    .map(e => ({ ...e, success_rate: e.count ? Math.round(e.success / e.count * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  // 4. エラー分析
  const errorEntries = thisMonth.filter(e => e.status === 'failed' || e.error_message);
  const byStage = {
    extract: errorEntries.filter(e => e.error_message?.includes('抽出') || e.error_message?.includes('extract')).length,
    matching: errorEntries.filter(e => e.error_message?.includes('マスタ未登録') || e.error_message?.includes('マッチ')).length,
    price: errorEntries.filter(e => e.error_message?.includes('価格') || e.error_message?.includes('price')).length,
    register: errorEntries.filter(e => e.error_message?.includes('受注登録') || e.error_message?.includes('register')).length,
    other: 0,
  };
  byStage.other = Math.max(0, errorEntries.length - byStage.extract - byStage.matching - byStage.price - byStage.register);

  // 5. Phase B 利用状況
  const phaseBCount = thisMonth.filter(e => e.price_source === 'historical_sales').length;
  const phaseBCustomers = [...new Set(thisMonth.filter(e => e.price_source === 'historical_sales').map(e => e.customer_name))].filter(Boolean);
  const daysUntilRemoval = Math.ceil((PHASE_B_REMOVAL_DATE - now) / (1000 * 60 * 60 * 24));

  // 6. 商品マスタ自動登録
  const masterRegistered = thisMonth.reduce((s, e) => s + (e.master_registered || 0), 0);

  // 7. コスト
  const geminiCount = thisMonth.filter(e => e.provider === 'gemini').length;
  const anthropicCount = thisMonth.filter(e => e.provider === 'anthropic').length;
  // Anthropic コスト概算 ($0.04 / 件)
  const monthlyUsd = (anthropicCount * 0.04).toFixed(2);

  // 8. 異常検知 (アラート)
  const alerts = [];
  if (todayStatus.processed > 0 && todayStatus.failed / todayStatus.processed > 0.2) {
    alerts.push({ level: 'high', type: 'failure_rate', message: `今日の失敗率が${Math.round(todayStatus.failed/todayStatus.processed*100)}% (閾値20%超)` });
  }
  if (daysUntilRemoval <= 14 && daysUntilRemoval > 0 && phaseBCount > 0) {
    alerts.push({ level: 'medium', type: 'phase_b_removal', message: `Phase B 撤去まで残り${daysUntilRemoval}日 (今月${phaseBCount}件利用中)` });
  }

  return {
    generated_at: now.toISOString(),
    data_source: dataSourceLabel,
    today: todayStatus,
    monthly_trend: monthlyTrend,
    by_eigyo: byEigyo,
    errors: { by_stage: byStage, recent_count: errorEntries.length },
    phase_b: { count: phaseBCount, customers: phaseBCustomers, days_until_removal: daysUntilRemoval },
    master_register: { count: masterRegistered },
    cost: { gemini_count: geminiCount, anthropic_count: anthropicCount, monthly_usd_estimate: monthlyUsd },
    alerts,
    total_entries_this_month: thisMonth.length,
  };
}

// =================== モックデータ生成 ===================
function generateMockEntries() {
  const eigyos = ['久百々', '桑田', '小松', '本田', '斎藤', '田中', '高橋', '武山'];
  const customers = [
    { code: 'ESB0001', name: '新陽社' },
    { code: 'ESB0002', name: '内山電機' },
    { code: 'ESB0003', name: '精美電機製作所' },
    { code: 'ESB0034', name: 'アイワ電設開発' },
    { code: 'ESC0095', name: 'エムテック' },
  ];
  const entries = [];
  const now = new Date();
  for (let day = 0; day < 30; day++) {
    const d = new Date(now); d.setDate(d.getDate() - day);
    const dailyCount = Math.floor(Math.random() * 6) + 1;
    for (let i = 0; i < dailyCount; i++) {
      const c = customers[Math.floor(Math.random() * customers.length)];
      const success = Math.random() > 0.15;
      entries.push({
        ts: new Date(d.setHours(9 + i, Math.floor(Math.random() * 60), 0)).toISOString(),
        eigyo: eigyos[Math.floor(Math.random() * eigyos.length)],
        juchu_no: success ? `0001${String(15000 + entries.length).slice(-4)}` : null,
        status: success ? 'success' : (Math.random() > 0.5 ? 'failed' : 'warning'),
        pdf: `${c.name}_${30000 + entries.length}.pdf`,
        customer_code: c.code,
        customer_name: c.name,
        lines_count: Math.floor(Math.random() * 8) + 1,
        duration_ms: Math.floor(Math.random() * 60000) + 30000,
        provider: Math.random() > 0.05 ? 'gemini' : 'anthropic',
        price_source: Math.random() > 0.7 ? 'historical_sales' : 'kakeritsu',
        master_registered: Math.random() > 0.7 ? 1 : 0,
        price_deviations: Math.random() > 0.85 ? 1 : 0,
        error_message: success ? null : ['商品マスタ未登録', '価格決定失敗', '抽出失敗'][Math.floor(Math.random() * 3)],
        dry_run: false,
      });
    }
  }
  return entries;
}
