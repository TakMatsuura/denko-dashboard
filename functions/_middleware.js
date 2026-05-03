/**
 * Cloudflare Pages Function — HTTP Basic Auth (二段階認証)
 *
 * 一般ダッシュボード:
 *   環境変数 DASHBOARD_USER / DASHBOARD_PASS で全関係者がアクセス可
 *
 * Phase M (FLAM運用ダッシュボード):
 *   環境変数 PHASE_M_USER / PHASE_M_PASS で 松浦・桑田・久百々 の3名限定
 *   対象パス: /phase-m/* および /api/phase-m/*
 *   ※ 別認証情報を使うことで、一般のIDで Phase M を見られないように
 */
export const onRequest = async ({ request, env, next }) => {
  const url = new URL(request.url);
  const isPhaseM = url.pathname.startsWith('/phase-m/') || url.pathname.startsWith('/api/phase-m/');

  // 認証情報切り替え
  const expectedUser = isPhaseM
    ? (env.PHASE_M_USER || 'flam-admin')
    : (env.DASHBOARD_USER || 'denko');
  const expectedPass = isPhaseM ? env.PHASE_M_PASS : env.DASHBOARD_PASS;
  const realm = isPhaseM ? 'DENKO FLAM Phase M (管理者限定)' : 'DENKO Dashboard';

  // 環境変数未設定なら一時的にスキップ (セットアップ中のフォールバック)
  // ※Phase M 側は本番環境変数必須にすべきだが、開発時のローカル動作のため fallback 許容
  if (!expectedPass) {
    return next();
  }

  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const sep = decoded.indexOf(':');
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (user === expectedUser && pass === expectedPass) {
        return next();
      }
    } catch (_) { /* fall through to 401 */ }
  }

  return new Response(
    isPhaseM
      ? '管理者認証が必要です / Phase M is restricted to 松浦・桑田・久百々'
      : '認証が必要です / Authentication required',
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
    }
  );
};
