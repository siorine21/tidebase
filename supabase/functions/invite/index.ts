/**
 * 招待制の会員登録 API（Supabase Edge Function・認証不要）
 *
 *   GET  /functions/v1/invite?token=<uuid>
 *        → 招待の下見。{ valid, group_name, inviter, label }
 *   POST /functions/v1/invite
 *        { token, email, password, username } → アカウント作成 + グループ参加
 *
 * なぜ Edge Function か:
 *   Supabase Auth の一般公開サインアップは無効（disable_signup = true）にしてある。
 *   不特定多数に登録されないための一番外側の壁で、これは動かさない。
 *   招待された人だけは、この関数が service_role の Admin API で
 *   アカウントを作ることで登録できる。つまり「招待を持っていること」が
 *   唯一の登録経路になる。
 *
 * verify_jwt = false（supabase/config.toml）。招待される人はまだアカウントが
 * ないので、認証を要求できない。代わりにトークン（UUID v4）の所持が認可になる。
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 完全な検証はしない（RFC 5322 は正規表現で書くものではない）。
// 明らかな誤入力を弾き、最終的な判断は Auth 側に任せる。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 20;

/** 招待が無効な理由 → 画面に出す日本語 */
const REASONS: Record<string, string> = {
  not_found: "この招待リンクは無効です。招待した人に確認してください。",
  used: "この招待リンクは使用済みです。招待した人に新しいリンクを作ってもらってください。",
  expired: "この招待リンクは期限切れです。招待した人に新しいリンクを作ってもらってください。",
  full: "このグループは人数の上限に達しています。",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** service_role で PostgREST / Auth Admin を叩く */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** SECURITY DEFINER の SQL 関数を呼ぶ（認可の判断は DB 側に集約する） */
async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await api(`/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`rpc ${name} failed: ${response.status} ${await response.text()}`);
  }
  // RETURNS VOID の関数は 204 / 空ボディで返るので、そのまま json() すると落ちる
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

type Peek = {
  valid: boolean;
  reason: string | null;
  group_name: string | null;
  inviter: string | null;
  label: string | null;
};

async function peek(token: string): Promise<Peek> {
  const rows = await rpc("peek_invite", { invite_token: token }) as Peek[];
  return rows[0] ?? { valid: false, reason: "not_found", group_name: null, inviter: null, label: null };
}

async function handleGet(token: string): Promise<Response> {
  if (!UUID_RE.test(token)) {
    return json(200, { valid: false, error: REASONS.not_found });
  }
  const result = await peek(token);
  if (!result.valid) {
    return json(200, { valid: false, error: REASONS[result.reason ?? "not_found"] ?? REASONS.not_found });
  }
  return json(200, {
    valid: true,
    group_name: result.group_name,
    inviter: result.inviter,
    label: result.label,
  });
}

async function handlePost(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "リクエストの形式が正しくありません。" });
  }

  const token = String(body.token ?? "");
  const email = String(body.email ?? "").trim();
  const password = String(body.password ?? "");
  const username = String(body.username ?? "").trim();

  if (!UUID_RE.test(token)) return json(403, { error: REASONS.not_found });
  if (!EMAIL_RE.test(email)) return json(422, { error: "メールアドレスの形式が正しくありません。" });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json(422, { error: `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。` });
  }
  if (!username) return json(422, { error: "ニックネームを入力してください。" });
  if (username.length > MAX_USERNAME_LENGTH) {
    return json(422, { error: `ニックネームは ${MAX_USERNAME_LENGTH} 文字以内にしてください。` });
  }

  // 先に招待を押さえる。アカウントを作ってから招待が無効だと分かると、
  // グループに入れない宙ぶらりんのアカウントが残ってしまう。
  const claimedGroup = await rpc("claim_invite", { invite_token: token }) as string | null;
  if (!claimedGroup) {
    const result = await peek(token);   // なぜ駄目だったのかを具体的に返す
    return json(403, { error: REASONS[result.reason ?? "used"] ?? REASONS.used });
  }

  // 作った直後に失敗したら消す（下の catch）。消さないと
  // 「アカウントはあるがグループに入っていない」人が残り、やり直そうとしても
  // 「このメールアドレスは既に登録されています」で永久に詰む（D-059）。
  let createdUserId: string | null = null;

  try {
    // Admin API でユーザーを作る。disable_signup の対象外。
    // email_confirm: true — 確認メールは使わない。Supabase の内蔵メールは
    // 1 時間 2 通の制限があり、届かないと招待した人が困る（D-034 と同じ判断）。
    const created = await api("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!created.ok) {
      const text = await created.text();
      const duplicate = /already been registered|already exists|email_exists/i.test(text);
      throw Object.assign(new Error(text), {
        userMessage: duplicate
          ? "このメールアドレスは既に登録されています。ログイン画面からお進みください。"
          : "アカウントを作成できませんでした。時間をおいて試してください。",
        status: duplicate ? 409 : 502,
      });
    }
    const user = await created.json() as { id: string };
    createdUserId = user.id;

    // handle_new_user トリガーが profiles を作っているので、名前を入れる
    const named = await api(`/rest/v1/profiles?id=eq.${user.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ username }),
    });
    // ニックネームは UNIQUE。衝突しても登録自体は続行する（後から設定で変えられる）
    if (!named.ok && named.status !== 409) {
      throw Object.assign(new Error(await named.text()), {
        userMessage: "アカウントを作成できませんでした。時間をおいて試してください。",
        status: 502,
      });
    }

    await rpc("redeem_invite", { invite_token: token, new_user: user.id });
    return json(200, { ok: true });
  } catch (error) {
    // 途中で作ったアカウントは消す。残すとやり直しが「既に登録されています」で
    // 弾かれ、グループに入れないまま詰んでしまう
    if (createdUserId) {
      await api(`/auth/v1/admin/users/${createdUserId}`, { method: "DELETE" })
        .catch(() => {});
    }
    // 押さえた招待を戻して、同じリンクをもう一度使えるようにする
    await rpc("release_invite", { invite_token: token }).catch(() => {});
    const { userMessage, status } = error as { userMessage?: string; status?: number };
    /* **生のエラー文をそのまま出さない**（D-125）。
       Auth の応答にはメールアドレスが入ることがあり、ログに残ってしまう。
       残すのは「どこで、どういう分類で失敗したか」だけ。 */
    console.error(JSON.stringify({
      fn: "invite", event: "signup_failed",
      status: status ?? 502,
      created_user: Boolean(createdUserId),
      kind: userMessage ? "handled" : "unexpected",
    }));
    return json(status ?? 502, {
      error: userMessage ?? "アカウントを作成できませんでした。時間をおいて試してください。",
    });
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json(500, { error: "サーバー設定が不足しています。" });
  }

  try {
    if (request.method === "GET") {
      return await handleGet(new URL(request.url).searchParams.get("token") ?? "");
    }
    if (request.method === "POST") {
      return await handlePost(request);
    }
    return json(405, { error: "GET / POST のみ対応しています" });
  } catch (error) {
    console.error(JSON.stringify({
      fn: "invite", event: "unhandled",
      method: request.method,
      message: String((error as Error)?.message ?? "").slice(0, 200),
    }));
    return json(500, { error: "処理に失敗しました。時間をおいて試してください。" });
  }
});
