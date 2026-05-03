/**
 * 経営分析: Claude Opus 4.7 による解説生成
 *
 * compute_anomalies.js が出力した anomalies.json を読み込み、
 * Claude Opus 4.7 (adaptive thinking) に経営者目線で解説を依頼。
 *
 * 出力: ./biz_analysis.json (公開用)
 *   - public/data/biz_analysis.json にもコピーされる
 */

const fs = require('fs');
const path = require('path');

// .env を master_sync から読み込み (ANTHROPIC_API_KEY)
const envPath = path.resolve(__dirname, '..', '..', 'Box', '030_DENKO', '010_営業本部', '010_電力機器事業部', '000_Common', '999_FLAM_Order_Automation', 'master_sync', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath, override: true });
}
// fallback: ローカルenvも読む
require('dotenv').config({ override: true });

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const ANOMALIES_PATH = path.join(__dirname, 'anomalies.json');
const OUT_PATH = path.join(__dirname, 'biz_analysis.json');
const PUBLIC_PATH = path.join(__dirname, '..', 'public', 'data', 'biz_analysis.json');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY not set');
  process.exit(1);
}

if (!fs.existsSync(ANOMALIES_PATH)) {
  console.error(`❌ ${ANOMALIES_PATH} が存在しません。先に compute_anomalies.js を実行してください`);
  process.exit(1);
}

const anomalies = JSON.parse(fs.readFileSync(ANOMALIES_PATH, 'utf-8'));

const fmtJpy = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '億円';
  if (Math.abs(n) >= 1e4) return Math.round(n / 1e4).toLocaleString() + '万円';
  return n.toLocaleString() + '円';
};

const SYSTEM_PROMPT = `あなたはデンコー電力機器事業部 (社長: 松浦) の経営参謀です。
過去5年 (FY21-FY25) の売上・粗利データと統計的異常検知の結果を読み込み、
経営者向けに「なぜこの月は伸びた / なぜこの月は落ちた」を簡潔かつ深く解説してください。

# 事業背景
- DENKO 電力機器事業部 = 主力3部門 (DNK-E 本社 / DNK-E-N 名古屋 / DNK-E-S 仙台)
- 主力商材: 高圧変圧器・配電盤・受変電設備 (三菱電機・富士電機など)
- 顧客: 鉄道系 (JR東日本・JR貨物)・電力会社系・建設会社系・代理店
- 売上は5月始まり (FY21 = 2021/05-2022/04)
- スポット案件 (変電所更新・新工場建設) で月次売上が大きくぶれる業態

# 観点
- 単月の売上変動は「スポット案件の有無」で説明できることが多い
- 季節性: 期末駆け込み (3月)、盆休み (8月減)、年度切替 (4-5月)
- 顧客集中度の変化に注意
- 新規顧客の発掘と離脱顧客のリカバリは経営最重要

# 出力形式 (JSON)
必ず以下のJSON構造で出力してください。日本語で書いてください。
コードブロック (\`\`\`json ... \`\`\`) で囲まないこと。

{
  "executive_summary": "過去5年の総括 5-7行 (経営者が30秒で把握できる粒度)。 売上トレンド・利益率・主要顧客動向・最重要トピックを冒頭に。",
  "fy_commentary": [
    {
      "fy": "FY21",
      "headline": "1行サマリ (売上規模・前年比・特筆事項)",
      "drivers": "なぜその数字になったか (3-5行・スポット案件・主要顧客の動きを具体名で)",
      "highlight_customers": ["特筆顧客名1", "特筆顧客名2"]
    }
  ],
  "monthly_anomalies": [
    {
      "ym": "2024/03",
      "fy": "FY23",
      "type": "spike|drop",
      "headline": "1行解説",
      "explanation": "2-3行で根拠 (どのスポット商品・どの顧客が要因か)",
      "actionable": "経営アクション (任意・出すべき場合のみ)"
    }
  ],
  "seasonality": {
    "pattern": "季節性の総括 (3-4行)",
    "best_months": ["3月", "12月"],
    "weak_months": ["8月"],
    "comments": ["月別の傾向コメント・3-5本"]
  },
  "customer_insights": {
    "key_growth_customers": [{"name": "顧客名", "trend": "5年間の動き", "comment": "示唆"}],
    "key_declining_customers": [{"name": "顧客名", "trend": "5年間の動き", "comment": "示唆"}],
    "new_customer_highlights": "過去5年の新規開拓のハイライト (2-3行)",
    "churn_risk": "離脱リスクが高い顧客の傾向 (2-3行)"
  },
  "spot_deal_insights": {
    "summary": "スポット大型商品の傾向 (3-4行)",
    "top_spots": [{"product": "商品名", "ym": "2024/05", "sales": "1.2億円", "comment": "コメント"}],
    "continuity_outlook": "継続性の見立て (2-3行)"
  },
  "risks": [
    {"title": "リスクタイトル", "severity": "high|medium|low", "description": "2-3行説明"}
  ],
  "actions": [
    {"priority": "P1|P2|P3", "title": "アクションタイトル", "description": "具体的に何をすべきか・誰が・いつまでに"}
  ]
}

# 注意
- 数字は具体的に (○○億円・○○万円・○○%)
- 顧客名・商品名・案件名は anomalies データから引用してください (実在する固有名詞)
- 「不明」「データが少ない」と言わず、与えられたデータから読み取れる範囲で言い切ってください
- 経営者目線で示唆深く、テンプレ的な表現は避ける
- FY26 (2026/05-2027/04) は対象外 (1ヶ月分しかデータがないため)`;

const userMessage = `# 統計的異常検知の結果

## FYサマリ
${anomalies.fy_summary.map(s => `- ${s.fy}: 売上 ${fmtJpy(s.sales)} / 粗利 ${fmtJpy(s.profit)} (${s.margin.toFixed(1)}%) / 顧客数 ${s.customers} / Top1依存度 ${s.top1_share.toFixed(1)}%`).join('\n')}

## 月次データ (60ヶ月) - 売上・前月比・前年同月比
${anomalies.monthly_data.map(m => `- ${m.ym} (${m.fy}): 売上 ${fmtJpy(m.sales)} / 粗利率 ${m.margin.toFixed(1)}%${m.mom_pct !== undefined ? ` / 前月比 ${m.mom_pct >= 0 ? '+' : ''}${m.mom_pct.toFixed(1)}%` : ''}${m.yoy_pct !== undefined ? ` / YoY ${m.yoy_pct >= 0 ? '+' : ''}${m.yoy_pct.toFixed(1)}%` : ''}`).join('\n')}

## 異常月 (前月比/YoY ±30%超)
${anomalies.anomaly_months.map(m => `- ${m.ym} (${m.fy}): ${fmtJpy(m.sales)} / 前月比 ${m.mom_pct?.toFixed(1) ?? 'N/A'}% / YoY ${m.yoy_pct?.toFixed(1) ?? 'N/A'}%`).join('\n')}

## 新規顧客 (FY内に初出現) Top20
${anomalies.new_customers.slice(0, 20).map(c => `- ${c.fy}: ${c.name} (${c.code}) / 初年度売上 ${fmtJpy(c.sales)}`).join('\n')}

## 復活顧客 (前FYに不在で再登場) Top20
${anomalies.returned_customers.slice(0, 20).map(c => `- ${c.fy}: ${c.name} (${c.code}) / ${c.gap_fys}年ぶり / 売上 ${fmtJpy(c.sales)}`).join('\n')}

## 離脱顧客 (直近2FY不在) Top10
${anomalies.churned_customers.slice(0, 10).map(c => `- ${c.last_fy}最後: ${c.name} (${c.code}) / 過去最終売上 ${fmtJpy(c.last_sales)}`).join('\n')}

## スポット商品 (単月500万超) Top30
${anomalies.spot_products.slice(0, 30).map(p => `- ${p.ym}: ${p.product_name} ${p.spec ? '[' + p.spec + ']' : ''} (${p.product_code}) / 売上 ${fmtJpy(p.sales)} / 数量 ${p.qty} / 粗利率 ${p.margin}%`).join('\n')}

## FY別 Top10 顧客
${anomalies.target_fys.map(fy => `\n### ${fy}\n${(anomalies.top_customers_by_fy[fy] || []).map((c, i) => `  ${i + 1}. ${c.name} (${c.code}): 売上 ${fmtJpy(c.sales)} / 粗利 ${fmtJpy(c.profit)}`).join('\n')}`).join('\n')}

## 顧客集中度の推移
${anomalies.target_fys.map(fy => {
  const c = anomalies.concentration[fy];
  return `- ${fy}: Top1=${c.top1_share.toFixed(1)}% / Top3=${c.top3_share.toFixed(1)}% / Top10=${c.top10_share.toFixed(1)}% / 顧客数=${c.customer_count}`;
}).join('\n')}

---

このデータを読み込んで、経営参謀として、上記のJSON形式で経営分析を出力してください。
日本語で。固有名詞は実データを引用してください。
`;

console.log('===== Claude Opus 4.7 で経営分析を生成 =====');
console.log(`システムプロンプト: ${SYSTEM_PROMPT.length} chars`);
console.log(`ユーザーメッセージ: ${userMessage.length} chars`);
console.log('');

(async () => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const startedAt = Date.now();

  console.log('🔄 API呼び出し中... (adaptive thinking有効・1-2分かかる場合あり)');

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✅ レスポンス受信 (${elapsed}秒)`);
  console.log(`   入力トークン: ${response.usage.input_tokens}`);
  console.log(`   出力トークン: ${response.usage.output_tokens}`);
  if (response.usage.cache_read_input_tokens) {
    console.log(`   キャッシュ: ${response.usage.cache_read_input_tokens}`);
  }

  // 概算コスト (Opus 4.7: input $5/M, output $25/M)
  const cost_usd = (response.usage.input_tokens / 1e6) * 5 + (response.usage.output_tokens / 1e6) * 25;
  console.log(`   概算コスト: $${cost_usd.toFixed(3)} (≒ ${Math.round(cost_usd * 150)}円)`);

  // テキスト抽出
  const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text);
  let text = textBlocks.join('\n').trim();

  // ```json ... ``` で囲まれていたら剥がす
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('❌ JSONパース失敗:', e.message);
    console.error('Raw response:');
    console.error(text.slice(0, 2000));
    // raw保存
    fs.writeFileSync(OUT_PATH.replace('.json', '_raw.txt'), text);
    process.exit(1);
  }

  // メタ情報追加
  const final = {
    generated_at: new Date().toISOString(),
    model: 'claude-opus-4-7',
    target_fys: anomalies.target_fys,
    fy_summary_raw: anomalies.fy_summary,
    monthly_data_raw: anomalies.monthly_data,
    cost_usd,
    usage: response.usage,
    elapsed_sec: parseFloat(elapsed),
    ...parsed,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2));
  console.log(`\n✅ ${OUT_PATH}`);

  // public/data にもコピー
  fs.mkdirSync(path.dirname(PUBLIC_PATH), { recursive: true });
  fs.copyFileSync(OUT_PATH, PUBLIC_PATH);
  console.log(`✅ ${PUBLIC_PATH}`);

  console.log('\n===== サマリ =====');
  console.log(`Executive: ${(parsed.executive_summary || '').slice(0, 200)}...`);
  console.log(`FY解説: ${(parsed.fy_commentary || []).length} 件`);
  console.log(`月次異常解説: ${(parsed.monthly_anomalies || []).length} 件`);
  console.log(`アクション: ${(parsed.actions || []).length} 件`);
  console.log(`リスク: ${(parsed.risks || []).length} 件`);
})().catch(err => {
  console.error('❌ Error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
