/**
 * Cloudflare Pages Function — HTTP Basic Auth
 * 全リクエストを認証で保護する。認証情報はPagesの環境変数に保存。
 *
 * 環境変数（Cloudflare Pages ダッシュボードで設定）:
 *   - DASHBOARD_USER  (例: denko)
 *   - DASHBOARD_PASS  (例: Dnk-E!2025#power)
 */
export const onRequest = async ({ request, env, next }) => {
  const expectedUser = env.DASHBOARD_USER || 'denko';
  const expectedPass = env.DASHBOARD_PASS;

  // 環境変数未設定なら一時的にスキップ（セットアップ中のフォールバック）
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

  return new Response('認証が必要です / Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="DENKO Dashboard", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
};
