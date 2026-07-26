import PostalMime from "postal-mime";

interface Env {
  MAIL_DB: D1Database;
  MAIL_BUCKET: R2Bucket;
  INITIAL_EMAIL: string;
  INITIAL_PASSWORD: string;
  MAIL_PROVIDER?: "mailgun" | "cloudflare";
  MAILGUN_DOMAIN?: string;
  MAILGUN_API_BASE: string;
  MAILGUN_API_KEY: string;
  MAILGUN_SIGNING_KEY: string;
  MAILGUN_POLL_ENABLED?: string;
  SESSION_TTL_DAYS: string;
  EMAIL?: SendEmail;
}

type User = { id: number; username: string; is_admin: number; enabled: number };
type MessageRow = {
  id: string;
  direction: "inbound" | "outbound";
  sender: string;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string;
  status: string;
  is_read: number;
  created_at: number;
  cc: string;
  bcc: string;
  in_reply_to: string;
  references_header: string;
  parent_message_id: string | null;
  mailgun_message_id?: string | null;
};

type ComposeValues = {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  parentMessageId?: string;
  inReplyTo?: string;
  references?: string;
};

const encoder = new TextEncoder();
const SESSION_COOKIE = "mail_session";
// Workers Free has a strict 10 ms CPU budget. Login rate limiting and long
// passwords compensate for the lower iteration count used at the edge.
const PASSWORD_ITERATIONS = 10_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const errorId = crypto.randomUUID();
      console.error(`[${errorId}]`, error);
      return htmlPage("服务器错误", `<main class="center-shell"><section class="auth-card error-card"><div class="brand-mark">!</div><h1>服务器错误</h1><p>请求处理失败，请稍后重试。</p><pre class="error-details">错误编号：${errorId}\n${escapeHtml(error instanceof Error ? error.message : String(error))}</pre><a class="button-link" href="/inbox">返回收件箱</a></section></main>`, 500);
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const recipient = parsed.to?.map((item) => item.address).join(", ") || message.to;
    const owner = await findMailboxOwner(env, recipient);
    if (!owner) return;
    await saveInbound(env, {
      ownerUserId: owner.id,
      messageId: parsed.messageId || message.headers.get("message-id") || crypto.randomUUID(),
      sender: parsed.from?.address || message.from,
      recipient,
      cc: parsed.cc?.map((item) => item.address).join(", ") || "",
      inReplyTo: parsed.inReplyTo || "",
      references: Array.isArray(parsed.references) ? parsed.references.join(" ") : String(parsed.references || ""),
      subject: parsed.subject || "",      text: parsed.text || "",
      html: typeof parsed.html === "string" ? parsed.html : "",
      raw,
      attachments: await Promise.all(parsed.attachments.map(async (item) => ({
        filename: item.filename || "attachment",
        contentType: item.mimeType || "application/octet-stream",
        data: await attachmentContentToArrayBuffer(item.content),
      }))),
    });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.MAIL_DB.batch([
      env.MAIL_DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.MAIL_DB.prepare("DELETE FROM webhook_tokens WHERE expires_at < ?").bind(now),
      env.MAIL_DB.prepare("DELETE FROM login_attempts WHERE window_started_at < ?").bind(now - 24 * 60 * 60_000),
    ]);
    if (env.MAILGUN_POLL_ENABLED === "true") {
      try {
        const result = await pollMailgunStoredMessages(env);
        console.log("Mailgun scheduled sync", result);
        await writeSyncDiagnostic(env, "mailgun_last_result", JSON.stringify({ ok: true, ...result }));
        await env.MAIL_DB.prepare("DELETE FROM sync_state WHERE name = 'mailgun_last_error'").run();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Mailgun scheduled sync failed", error);
        await writeSyncDiagnostic(env, "mailgun_last_error", detail);
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/webhooks/mailgun/inbound") {
    return receiveMailgun(request, env);
  }

  if (url.pathname === "/login") {
    // Login has no authenticated cookie or privileged state to protect. Some
    // browser/proxy combinations rewrite Origin, so do not block bootstrap here.
    return request.method === "POST" ? login(request, env) : loginPage();
  }

  const user = await authenticate(request, env);
  if (!user) return redirect("/login");

  if (request.method === "POST" && !isTrustedFormPost(request)) {
    console.warn("Blocked form POST", {
      path: url.pathname,
      origin: request.headers.get("Origin"),
      secFetchSite: request.headers.get("Sec-Fetch-Site"),
      host: request.headers.get("Host"),
    });
    return htmlPage("请求被拒绝", `<main class="center-shell"><section class="auth-card error-card"><div class="brand-mark">!</div><h1>请求被拒绝</h1><pre class="error-details">安全检查未通过\nPath：${escapeHtml(url.pathname)}\nOrigin：${escapeHtml(request.headers.get("Origin") || "未提供")}\nSec-Fetch-Site：${escapeHtml(request.headers.get("Sec-Fetch-Site") || "未提供")}</pre><a class="button-link" href="/inbox">返回收件箱</a></section></main>`, 403);
  }
  if (request.method === "POST" && url.pathname === "/logout") return logout(request, env);
  if (request.method === "POST" && url.pathname === "/sync") return syncMailbox(env, user);
  if (request.method === "GET" && url.pathname === "/") return redirect("/inbox");
  if (request.method === "GET" && url.pathname === "/inbox") return listMessages(env, user, "inbound");
  if (request.method === "GET" && url.pathname === "/sent") return listMessages(env, user, "outbound");
  if (request.method === "GET" && url.pathname.startsWith("/message/")) {
    return showMessage(env, user, url.pathname.slice("/message/".length));
  }
  if (request.method === "GET" && url.pathname.startsWith("/attachment/")) {
    return downloadAttachment(env, user.id, url.pathname.slice("/attachment/".length));
  }
  if (url.pathname === "/compose") {
    return request.method === "POST" ? sendMessage(request, env, user) : composeForRequest(env, user, url);
  }
  if (url.pathname === "/settings/password") {
    return request.method === "POST" ? changePassword(request, env, user) : passwordPage(user);
  }
  if (url.pathname === "/admin/users") {
    if (!user.is_admin) return htmlPage("无权限", "<h1>403</h1>", 403);
    return request.method === "POST" ? createMailboxUser(request, env, user) : usersPage(env, user);
  }

  return htmlPage("未找到", "<h1>404</h1>", 404);
}

async function login(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const username = String(form.get("username") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  const loginKey = await sha256(`${request.headers.get("CF-Connecting-IP") || "local"}:${username.toLowerCase()}`);
  const blockedUntil = await getLoginBlock(env, loginKey);
  if (blockedUntil > Date.now()) return loginPage("尝试次数过多，请稍后再试", 429);

  let row = await env.MAIL_DB.prepare(
    "SELECT id, username, password_hash, password_salt, password_iterations, is_admin, enabled FROM users WHERE lower(username) = lower(?) AND enabled = 1",
  ).bind(username).first<{ id: number; username: string; password_hash: string; password_salt: string; password_iterations: number; is_admin: number; enabled: number }>();

  if (!row && username === env.INITIAL_EMAIL.toLowerCase() && password === env.INITIAL_PASSWORD) {
    const credential = await hashPassword(password);
    const now = Date.now();
    await env.MAIL_DB.prepare(
      "INSERT INTO users (username, password_hash, password_salt, password_iterations, is_admin, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
    ).bind(username, credential.hash, credential.salt, credential.iterations, now, now).run();
    row = await env.MAIL_DB.prepare(
      "SELECT id, username, password_hash, password_salt, password_iterations, is_admin, enabled FROM users WHERE lower(username) = lower(?)",
    ).bind(username).first<typeof row extends infer T ? NonNullable<T> : never>();
  }

  if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash, row.password_iterations))) {
    await recordLoginFailure(env, loginKey);
    return loginPage("用户名或密码错误", 401);
  }
  await env.MAIL_DB.prepare("DELETE FROM login_attempts WHERE identity_key = ?").bind(loginKey).run();

  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = Date.now() + Number(env.SESSION_TTL_DAYS || "30") * 86_400_000;
  await env.MAIL_DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), row.id, tokenHash, expiresAt, Date.now()).run();

  const response = redirect("/inbox");
  response.headers.append("Set-Cookie", sessionCookie(request, token, Math.floor((expiresAt - Date.now()) / 1000)));
  return response;
}

async function authenticate(request: Request, env: Env): Promise<User | null> {
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (!token) return null;
  return env.MAIL_DB.prepare(
    `SELECT users.id, users.username, users.is_admin, users.enabled FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.enabled = 1`,
  ).bind(await sha256(token), Date.now()).first<User>();
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (token) await env.MAIL_DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  const response = redirect("/login");
  response.headers.append("Set-Cookie", sessionCookie(request, "", 0));
  return response;
}

async function changePassword(request: Request, env: Env, user: User): Promise<Response> {
  const form = await request.formData();
  const current = String(form.get("current_password") || "");
  const next = String(form.get("new_password") || "");
  const confirm = String(form.get("confirm_password") || "");
  const credential = await env.MAIL_DB.prepare(
    "SELECT password_hash, password_salt, password_iterations FROM users WHERE id = ?",
  ).bind(user.id).first<{ password_hash: string; password_salt: string; password_iterations: number }>();

  if (!credential || !(await verifyPassword(current, credential.password_salt, credential.password_hash, credential.password_iterations))) {
    return passwordPage(user, "当前密码错误", 400);
  }
  if (next.length < 16) return passwordPage(user, "新密码至少需要 16 个字符", 400);
  if (next !== confirm) return passwordPage(user, "两次输入的新密码不一致", 400);

  const updated = await hashPassword(next);
  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ? WHERE id = ?",
    ).bind(updated.hash, updated.salt, updated.iterations, Date.now(), user.id),
    env.MAIL_DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  const response = redirect("/login");
  response.headers.append("Set-Cookie", sessionCookie(request, "", 0));
  return response;
}

async function receiveMailgun(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const timestamp = String(form.get("timestamp") || "");
  const token = String(form.get("token") || "");
  const signature = String(form.get("signature") || "");
  if (!(await verifyMailgunSignature(env.MAILGUN_SIGNING_KEY, timestamp, token, signature))) {
    return new Response("invalid signature", { status: 401 });
  }
  const numericTimestamp = Number(timestamp) * 1000;
  if (!Number.isFinite(numericTimestamp) || Math.abs(Date.now() - numericTimestamp) > 15 * 60_000) {
    return new Response("expired webhook", { status: 401 });
  }
  const replay = await env.MAIL_DB.prepare("SELECT token FROM webhook_tokens WHERE token = ?").bind(token).first();
  if (replay) return Response.json({ ok: true, duplicate: true });

  const recipient = String(form.get("recipient") || "");
  const owner = await findMailboxOwner(env, recipient);
  if (!owner) {
    await env.MAIL_DB.prepare("INSERT OR IGNORE INTO webhook_tokens (token, expires_at) VALUES (?, ?)")
      .bind(token, Date.now() + 24 * 60 * 60_000).run();
    return Response.json({ ok: true, filtered: true });
  }

  const attachmentCount = Number(form.get("attachment-count") || "0");
  const attachments: Array<{ filename: string; contentType: string; data: ArrayBuffer }> = [];
  for (let index = 1; index <= attachmentCount; index++) {
    const file = form.get(`attachment-${index}`);
    if (file instanceof File) {
      attachments.push({ filename: file.name || `attachment-${index}`, contentType: file.type || "application/octet-stream", data: await file.arrayBuffer() });
    }
  }

  const parsedHeaders = parseMessageHeaders(String(form.get("message-headers") || ""));
  await saveInbound(env, {
    ownerUserId: owner.id,
    messageId: parsedHeaders["message-id"] || `mailgun-token:${token}`,
    cc: parsedHeaders.cc || "",
    inReplyTo: parsedHeaders["in-reply-to"] || "",
    references: parsedHeaders.references || "",
    sender: String(form.get("from") || form.get("sender") || ""),
    recipient,
    subject: String(form.get("subject") || ""),
    text: String(form.get("body-plain") || ""),
    html: String(form.get("body-html") || ""),
    attachments,
  });
  await env.MAIL_DB.prepare("INSERT OR IGNORE INTO webhook_tokens (token, expires_at) VALUES (?, ?)")
    .bind(token, Date.now() + 24 * 60 * 60_000).run();
  return Response.json({ ok: true });
}

async function saveInbound(env: Env, input: {
  ownerUserId: number; messageId: string; sender: string; recipient: string; subject: string; text: string; html: string;
  cc?: string; inReplyTo?: string; references?: string;
  raw?: ArrayBuffer; attachments: Array<{ filename: string; contentType: string; data: ArrayBuffer }>;
}): Promise<void> {
  const scopedMessageId = `${input.ownerUserId}:${input.messageId}`;
  const existing = await env.MAIL_DB.prepare("SELECT id FROM messages WHERE mailgun_message_id = ?")
    .bind(scopedMessageId).first<{ id: string }>();
  if (existing) return;

  const id = crypto.randomUUID();
  const now = Date.now();
  let rawKey: string | null = null;
  if (input.raw) {
    rawKey = `raw/${id}.eml`;
    await env.MAIL_BUCKET.put(rawKey, input.raw, { httpMetadata: { contentType: "message/rfc822" } });
  }
  const statements = [env.MAIL_DB.prepare(
    `INSERT INTO messages
     (id, owner_user_id, mailgun_message_id, direction, sender, recipient, cc, subject, text_body, html_body, status, is_read, storage_key, in_reply_to, references_header, created_at)
     VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?, ?, ?)`,
  ).bind(id, input.ownerUserId, scopedMessageId, input.sender, input.recipient, input.cc || "", input.subject, input.text, input.html, rawKey, input.inReplyTo || "", input.references || "", now)];

  for (const attachment of input.attachments) {
    const attachmentId = crypto.randomUUID();
    const key = `attachments/${id}/${attachmentId}/${safeFilename(attachment.filename)}`;
    await env.MAIL_BUCKET.put(key, attachment.data, { httpMetadata: { contentType: attachment.contentType } });
    statements.push(env.MAIL_DB.prepare(
      "INSERT INTO attachments (id, message_id, filename, content_type, size, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(attachmentId, id, attachment.filename, attachment.contentType, attachment.data.byteLength, key, now));
  }
  await env.MAIL_DB.batch(statements);
}

async function sendMessage(request: Request, env: Env, user: User): Promise<Response> {
  const form = await request.formData();
  const from = user.username;
  const to = String(form.get("to") || "").trim();
  const cc = String(form.get("cc") || "").trim();
  const bcc = String(form.get("bcc") || "").trim();
  const subject = String(form.get("subject") || "");
  const text = String(form.get("text") || "");
  const parentMessageId = String(form.get("parent_message_id") || "").trim() || null;
  const inReplyTo = String(form.get("in_reply_to") || "").trim();
  const references = String(form.get("references") || "").trim();
  const attachments = form.getAll("attachments").filter((item): item is File => item instanceof File && item.size > 0);
  const toAddresses = parseRecipientList(to);
  const ccAddresses = parseRecipientList(cc);
  const bccAddresses = parseRecipientList(bcc);
  if (!toAddresses.length) return composePage(env, user, "至少需要一个有效的收件地址", 400);
  if (attachments.some((file) => file.size > 20 * 1024 * 1024)) return composePage(env, user, "单个附件不能超过 20 MB", 400);

  const provider = env.MAIL_PROVIDER || "mailgun";
  let providerMessageId: string | null = null;
  if (provider === "cloudflare") {
    if (!env.EMAIL) return composePage(env, user, "Cloudflare Email Sending binding 未配置。\n请检查 wrangler.toml 中是否存在 EMAIL send_email binding。", 500);
    try {
      if (attachments.length) throw new Error("Cloudflare Email Sending 模式暂未实现发件附件");
      await env.EMAIL.send({ from, to: toAddresses.join(", "), subject, text });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await recordSendAttempt(env, user.id, from, to, subject, provider, false, null, null, detail);
      return composePage(env, user, `Cloudflare Email Sending 调用失败\n错误：${detail}`, 502);
    }
    await recordSendAttempt(env, user.id, from, to, subject, provider, true, 202, null, "accepted");
  } else {
    const domain = from.split("@")[1] || mailgunDomain(env);
    const endpoint = `${env.MAILGUN_API_BASE}/v3/${domain}/messages`;
    const body = new FormData();
    body.set("from", from);
    for (const address of toAddresses) body.append("to", address);
    for (const address of ccAddresses) body.append("cc", address);
    for (const address of bccAddresses) body.append("bcc", address);
    body.set("subject", subject);
    body.set("text", text);
    if (inReplyTo) body.set("h:In-Reply-To", inReplyTo);
    if (references) body.set("h:References", references);
    for (const file of attachments) body.append("attachment", file, file.name);
    const authorization = btoa(`api:${env.MAILGUN_API_KEY}`);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST", headers: { Authorization: `Basic ${authorization}` }, body,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await recordSendAttempt(env, user.id, from, to, subject, provider, false, null, null, detail);
      return composePage(env, user, [
        "无法连接 Mailgun API",
        `Endpoint：${endpoint}`,
        `错误：${detail}`,
        "请检查 MAILGUN_API_BASE、Cloudflare 网络状态和 Mailgun Region。",
      ].join("\n"), 502);
    }
    const responseText = await response.text();
    const requestIdHeader = response.headers.get("x-request-id") || response.headers.get("x-mailgun-request-id");
    if (!response.ok) {
      const requestId = requestIdHeader || "未提供";
      await recordSendAttempt(env, user.id, from, to, subject, provider, false, response.status, requestIdHeader, responseText);
      const hint = mailgunErrorHint(response.status, responseText, domain, env.MAILGUN_API_BASE);
      console.error("Mailgun send failed", { status: response.status, requestId, endpoint, response: responseText });
      return composePage(env, user, [
        "Mailgun 发件失败",
        `HTTP：${response.status} ${response.statusText}`,
        `Endpoint：${endpoint}`,
        `Domain：${domain}`,
        `Request ID：${requestId}`,
        `Response：${responseText || "（空响应）"}`,
        `建议：${hint}`,
      ].join("\n"), 502);
    }
    try {
      const payload = JSON.parse(responseText) as { id?: string };
      providerMessageId = payload.id || null;
    } catch {
      providerMessageId = null;
    }
    await recordSendAttempt(env, user.id, from, to, subject, provider, true, response.status, requestIdHeader, responseText);
  }

  const localMessageId = crypto.randomUUID();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [env.MAIL_DB.prepare(
    `INSERT INTO messages
     (id, owner_user_id, mailgun_message_id, direction, sender, recipient, cc, bcc, subject, text_body, status, is_read, in_reply_to, references_header, parent_message_id, created_at)
     VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'accepted', 1, ?, ?, ?, ?)`,
  ).bind(localMessageId, user.id, providerMessageId, from, toAddresses.join(", "), ccAddresses.join(", "), bccAddresses.join(", "), subject, text, inReplyTo, references, parentMessageId, now)];
  for (const file of attachments) {
    const attachmentId = crypto.randomUUID();
    const storageKey = `attachments/${localMessageId}/${attachmentId}/${safeFilename(file.name)}`;
    await env.MAIL_BUCKET.put(storageKey, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    statements.push(env.MAIL_DB.prepare(
      "INSERT INTO attachments (id, message_id, filename, content_type, size, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(attachmentId, localMessageId, file.name, file.type || "application/octet-stream", file.size, storageKey, now));
  }
  await env.MAIL_DB.batch(statements);
  return redirect("/sent");
}

async function recordSendAttempt(env: Env, userId: number, sender: string, recipient: string, subject: string, provider: string, success: boolean, httpStatus: number | null, requestId: string | null, providerResponse: string): Promise<void> {
  await env.MAIL_DB.prepare(
    `INSERT INTO send_attempts
     (id, user_id, sender, recipient, subject, provider, success, http_status, request_id, provider_response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), userId, sender, recipient, subject, provider, success ? 1 : 0, httpStatus, requestId, providerResponse.slice(0, 8000), Date.now()).run();
}

async function listMessages(env: Env, user: User, direction: "inbound" | "outbound"): Promise<Response> {
  const result = await env.MAIL_DB.prepare(
    "SELECT id, direction, sender, recipient, subject, status, is_read, created_at FROM messages WHERE direction = ? AND owner_user_id = ? ORDER BY created_at DESC LIMIT 100",
  ).bind(direction, user.id).all<MessageRow>();
  const rows = result.results.map((message) => `<a class="message-row ${message.is_read ? "" : "unread"}" href="/message/${encodeURIComponent(message.id)}">
    <span class="avatar">${escapeHtml((direction === "inbound" ? message.sender : message.recipient).trim().charAt(0).toUpperCase() || "M")}</span>
    <span class="message-person">${escapeHtml(direction === "inbound" ? message.sender : message.recipient)}</span>
    <span class="message-subject">${escapeHtml(message.subject || "（无主题）")}${direction === "outbound" ? ` <small class="status-badge">${escapeHtml(message.status)}</small>` : ""}</span>
    <time>${new Date(message.created_at).toLocaleString("zh-CN")}</time>
  </a>`).join("");
  const label = direction === "inbound" ? "收件箱" : "已发送";
  const actions = direction === "inbound"
    ? `<div class="heading-actions"><form method="post" action="/sync"><button class="secondary-button" type="submit">↻ 主动收取</button></form><a class="primary-action" href="/compose">＋ 写邮件</a></div>`
    : `<a class="primary-action" href="/compose">＋ 写邮件</a>`;
  return appPage(label, user, `<section class="page-heading"><div><p class="eyebrow">MAILBOX</p><h1>${label}</h1><p>最近 100 封${direction === "inbound" ? "收到" : "发送"}的邮件</p></div>${actions}</section><section class="mail-list">${rows || "<div class=\"empty-state\"><span>✉</span><h2>暂无邮件</h2><p>新的邮件会显示在这里。</p></div>"}</section>`);
}

async function showMessage(env: Env, user: User, id: string): Promise<Response> {
  const message = await env.MAIL_DB.prepare("SELECT * FROM messages WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first<MessageRow>();
  if (!message) {
    return appPage("未找到", user, "<h1>邮件不存在</h1>", 404);
  }
  if (message.direction === "inbound" && !message.is_read) {
    await env.MAIL_DB.prepare("UPDATE messages SET is_read = 1 WHERE id = ?").bind(id).run();
  }
  const attachments = await env.MAIL_DB.prepare(
    "SELECT id, filename, content_type, size FROM attachments WHERE message_id = ? ORDER BY created_at",
  ).bind(id).all<{ id: string; filename: string; content_type: string; size: number }>();
  const attachmentList = attachments.results.map((item) => `<li><a href="/attachment/${encodeURIComponent(item.id)}">${escapeHtml(item.filename)}</a> (${item.size} bytes)</li>`).join("");
  const senderAddress = extractAddresses(message.sender)[0] || message.sender;
  const senderName = message.sender.replace(/<[^>]+>/g, "").trim().replace(/^['\"]|['\"]$/g, "") || senderAddress;
  return appPage(message.subject || "邮件", user, `<article class="message-card">
    <div class="message-toolbar"><a class="back-link" href="/${message.direction === "inbound" ? "inbox" : "sent"}">← 返回列表</a><div class="message-actions"><a class="secondary-button" href="/compose?reply=${encodeURIComponent(message.id)}">↩ 回复</a><a class="secondary-button" href="/compose?forward=${encodeURIComponent(message.id)}">↪ 转发</a><span class="direction-badge">${message.direction === "inbound" ? "收件" : "已发送"}</span></div></div>
    <header class="mail-header"><p class="eyebrow">MESSAGE</p><h1>${escapeHtml(message.subject || "（无主题）")}</h1><div class="sender-card"><span class="sender-avatar">${escapeHtml(senderName.charAt(0).toUpperCase() || "M")}</span><div class="sender-identity"><strong>${escapeHtml(senderName)}</strong><span>${escapeHtml(senderAddress)}</span><small>发送给 ${escapeHtml(message.recipient)}${message.cc ? ` · 抄送 ${escapeHtml(message.cc)}` : ""}</small></div><time>${new Date(message.created_at).toLocaleString("zh-CN")}</time></div></header>
    <section class="mail-content">${formatMailBody(message.text_body)}</section>
    ${attachmentList ? `<section class="attachments"><h2>附件</h2><ul>${attachmentList}</ul></section>` : ""}
  </article>`, 200, message.direction === "inbound" ? "inbox" : "sent");
}

async function syncMailbox(env: Env, user: User): Promise<Response> {
  try {
    const result = await pollMailgunStoredMessages(env);
    await writeSyncDiagnostic(env, "mailgun_last_result", JSON.stringify({ ok: true, manual: true, ...result }));
    await env.MAIL_DB.prepare("DELETE FROM sync_state WHERE name = 'mailgun_last_error'").run();
    return appPage("同步完成", user, `<section class="page-heading"><div><p class="eyebrow">SYNC</p><h1>同步完成</h1><p>已从 Mailgun Stored Events 主动查询邮件</p></div></section><section class="settings-card"><pre class="mail-body">查询事件：${result.events}\n新增邮件：${result.imported}\n重复跳过：${result.duplicates}\n地址过滤：${result.filtered}\n检查起点：${new Date(result.begin * 1000).toLocaleString("zh-CN")}</pre><a class="primary-action" href="/inbox">返回收件箱</a></section>`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeSyncDiagnostic(env, "mailgun_last_error", detail);
    return appPage("同步失败", user, `<section class="page-heading"><div><p class="eyebrow">SYNC ERROR</p><h1>同步失败</h1><p>无法从 Mailgun 主动查询新邮件</p></div></section><pre class="notice">${escapeHtml(error instanceof Error ? error.message : String(error))}</pre><section class="settings-card"><p>主动查询要求 Mailgun Receiving Route 启用 <code>store()</code>。仅有转发或普通接收日志时，Events API 没有可下载的完整邮件正文。</p><a class="primary-action" href="/inbox">返回收件箱</a></section>`, 502);
  }
}

async function writeSyncDiagnostic(env: Env, name: string, value: string): Promise<void> {
  await env.MAIL_DB.prepare(
    `INSERT INTO sync_state (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(name, value.slice(0, 8000), Date.now()).run();
}

async function pollMailgunStoredMessages(env: Env): Promise<{ events: number; imported: number; duplicates: number; filtered: number; begin: number }> {
  const state = await env.MAIL_DB.prepare("SELECT value FROM sync_state WHERE name = 'mailgun_stored_after'")
    .first<{ value: string }>();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const begin = state ? Math.max(0, Number(state.value) - 60) : nowSeconds - 24 * 60 * 60;
  const domain = mailgunDomain(env);
  const eventsUrl = new URL(`${env.MAILGUN_API_BASE}/v3/${domain}/events`);
  // Stored inbound messages expose storage.url on their Events API item. Do
  // not filter by a literal "stored" event name because Mailgun plans/API
  // versions may expose the storage URL on accepted/delivered events instead.
  eventsUrl.searchParams.set("begin", String(begin));
  eventsUrl.searchParams.set("ascending", "yes");
  eventsUrl.searchParams.set("limit", "100");
  const authorization = `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}`;
  const response = await fetch(eventsUrl, { headers: { Authorization: authorization } });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error([
      "Mailgun Events API 查询失败",
      `HTTP：${response.status} ${response.statusText}`,
      `Endpoint：${eventsUrl.toString()}`,
      `Response：${responseText || "（空响应）"}`,
      `建议：${mailgunErrorHint(response.status, responseText, domain, env.MAILGUN_API_BASE)}`,
    ].join("\n"));
  }

  let payload: { items?: Array<Record<string, unknown>> };
  try {
    payload = JSON.parse(responseText) as typeof payload;
  } catch {
    throw new Error(`Mailgun Events API 返回了无法解析的 JSON：\n${responseText.slice(0, 1000)}`);
  }

  const items = payload.items || [];
  let imported = 0;
  let duplicates = 0;
  let filtered = 0;
  let latestTimestamp = begin;
  for (const item of items) {
    const timestamp = Number(item.timestamp || 0);
    if (timestamp > latestTimestamp) latestTimestamp = timestamp;
    const storage = item.storage as { url?: string; key?: string } | undefined;
    if (!storage?.url) continue;
    const message = (item.message || {}) as { headers?: Record<string, string>; recipients?: unknown };
    const envelope = (item.envelope || {}) as { sender?: string; targets?: unknown };
    const messageId = message.headers?.["message-id"] || message.headers?.["Message-Id"] || storage.key || storage.url;
    const stored = await retrieveMailgunStoredMessage(storage.url, authorization);
    const recipient = stored.recipient || joinAddresses(message.recipients) || joinAddresses(envelope.targets);
    const owner = await findMailboxOwner(env, recipient);
    if (!owner) {
      filtered++;
      continue;
    }
    const existing = await env.MAIL_DB.prepare("SELECT id FROM messages WHERE mailgun_message_id = ?")
      .bind(`${owner.id}:${messageId}`).first();
    if (existing) {
      duplicates++;
      continue;
    }
    await saveInbound(env, {
      ownerUserId: owner.id,
      messageId,
      sender: stored.sender || message.headers?.from || envelope.sender || "",
      recipient,
      cc: message.headers?.cc || message.headers?.Cc || "",
      inReplyTo: message.headers?.["in-reply-to"] || message.headers?.["In-Reply-To"] || "",
      references: message.headers?.references || message.headers?.References || "",
      subject: stored.subject || message.headers?.subject || "",      text: stored.text,
      html: stored.html,
      attachments: stored.attachments,
    });
    imported++;
  }

  const nextValue = String(Math.max(latestTimestamp, nowSeconds - 60));
  await env.MAIL_DB.prepare(
    `INSERT INTO sync_state (name, value, updated_at) VALUES ('mailgun_stored_after', ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(nextValue, Date.now()).run();
  return { events: items.length, imported, duplicates, filtered, begin };
}

async function retrieveMailgunStoredMessage(storageUrl: string, authorization: string): Promise<{
  sender: string; recipient: string; subject: string; text: string; html: string;
  attachments: Array<{ filename: string; contentType: string; data: ArrayBuffer }>;
}> {
  const response = await fetch(storageUrl, { headers: { Authorization: authorization } });
  if (!response.ok) {
    throw new Error(`获取 Mailgun Stored Message 失败\nHTTP：${response.status} ${response.statusText}\nStorage URL：${storageUrl}\nResponse：${await response.text()}`);
  }
  const contentType = response.headers.get("Content-Type") || "";
  const attachments: Array<{ filename: string; contentType: string; data: ArrayBuffer }> = [];
  let sender = "";
  let recipient = "";
  let subject = "";
  let text = "";
  let html = "";
  if (contentType.includes("application/json")) {
    const body = await response.json<Record<string, unknown>>();
    sender = String(body.from || body.sender || "");
    recipient = String(body.recipient || "");
    subject = String(body.subject || "");
    text = String(body["body-plain"] || body["stripped-text"] || "");
    html = String(body["body-html"] || body["stripped-html"] || "");
  } else {
    const form = await response.formData();
    sender = String(form.get("from") || form.get("sender") || "");
    recipient = String(form.get("recipient") || "");
    subject = String(form.get("subject") || "");
    text = String(form.get("body-plain") || form.get("stripped-text") || "");
    html = String(form.get("body-html") || form.get("stripped-html") || "");
    const count = Number(form.get("attachment-count") || "0");
    for (let index = 1; index <= count; index++) {
      const file = form.get(`attachment-${index}`);
      if (file instanceof File) attachments.push({ filename: file.name || `attachment-${index}`, contentType: file.type || "application/octet-stream", data: await file.arrayBuffer() });
    }
  }
  return { sender, recipient, subject, text, html, attachments };
}

async function downloadAttachment(env: Env, userId: number, id: string): Promise<Response> {
  const attachment = await env.MAIL_DB.prepare(
    `SELECT attachments.filename, attachments.content_type, attachments.storage_key,
            messages.direction, messages.recipient
     FROM attachments JOIN messages ON messages.id = attachments.message_id
     WHERE attachments.id = ? AND messages.owner_user_id = ?`,
  ).bind(id, userId).first<{ filename: string; content_type: string; storage_key: string; direction: string; recipient: string }>();
  if (!attachment) {
    return new Response("not found", { status: 404 });
  }
  const object = await env.MAIL_BUCKET.get(attachment.storage_key);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

async function getLoginBlock(env: Env, key: string): Promise<number> {
  const row = await env.MAIL_DB.prepare("SELECT blocked_until FROM login_attempts WHERE identity_key = ?")
    .bind(key).first<{ blocked_until: number }>();
  return row?.blocked_until || 0;
}

async function recordLoginFailure(env: Env, key: string): Promise<void> {
  const now = Date.now();
  const windowMs = 15 * 60_000;
  const row = await env.MAIL_DB.prepare(
    "SELECT failed_count, window_started_at FROM login_attempts WHERE identity_key = ?",
  ).bind(key).first<{ failed_count: number; window_started_at: number }>();
  const withinWindow = row && now - row.window_started_at < windowMs;
  const failedCount = withinWindow ? row.failed_count + 1 : 1;
  const windowStartedAt = withinWindow ? row.window_started_at : now;
  const blockedUntil = failedCount >= 5 ? now + windowMs : 0;
  await env.MAIL_DB.prepare(
    `INSERT INTO login_attempts (identity_key, failed_count, window_started_at, blocked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(identity_key) DO UPDATE SET
       failed_count = excluded.failed_count,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until`,
  ).bind(key, failedCount, windowStartedAt, blockedUntil).run();
}

async function createMailboxUser(request: Request, env: Env, admin: User): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  const makeAdmin = form.get("is_admin") === "1" ? 1 : 0;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return usersPage(env, admin, "邮箱地址格式不正确", 400);
  if (email.split("@")[1] !== mailgunDomain(env)) return usersPage(env, admin, `当前仅支持 @${mailgunDomain(env)} 域名`, 400);
  if (password.length < 16) return usersPage(env, admin, "临时密码至少需要 16 个字符", 400);
  const credential = await hashPassword(password);
  const now = Date.now();
  try {
    await env.MAIL_DB.prepare(
      `INSERT INTO users
       (username, password_hash, password_salt, password_iterations, is_admin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(email, credential.hash, credential.salt, credential.iterations, makeAdmin, now, now).run();
  } catch (error) {
    return usersPage(env, admin, `创建失败：${error instanceof Error ? error.message : String(error)}`, 400);
  }
  return redirect("/admin/users");
}

async function usersPage(env: Env, admin: User, error = "", status = 200): Promise<Response> {
  const users = await env.MAIL_DB.prepare(
    "SELECT id, username, is_admin, enabled, created_at FROM users ORDER BY created_at",
  ).all<{ id: number; username: string; is_admin: number; enabled: number; created_at: number }>();
  const rows = users.results.map((item) => `<div class="message-row"><span class="avatar">${escapeHtml(item.username.charAt(0).toUpperCase())}</span><span class="message-person">${escapeHtml(item.username)}</span><span class="message-subject">${item.is_admin ? "管理员" : "邮箱用户"} · ${item.enabled ? "已启用" : "已禁用"}</span><time>${new Date(item.created_at).toLocaleDateString("zh-CN")}</time></div>`).join("");
  return appPage("邮箱账号", admin, `<section class="page-heading"><div><p class="eyebrow">ACCOUNTS</p><h1>邮箱账号</h1><p>每个账号只能查看和发送自己的邮件</p></div></section>${notice(error)}<section class="mail-list">${rows}</section><form method="post" class="settings-card stack" style="margin-top:22px"><h2>创建邮箱账号</h2><label><span>邮箱地址</span><input name="email" type="email" placeholder="user@${escapeHtml(mailgunDomain(env))}" required></label><label><span>临时密码（至少 16 位）</span><input name="password" type="password" minlength="16" required></label><label><span><input name="is_admin" type="checkbox" value="1" style="width:auto"> 设为管理员</span></label><button class="primary-button">创建账号</button></form>`, status);
}

function loginPage(error = "", status = 200): Response {
  return htmlPage("登录", `<main class="center-shell"><section class="auth-card"><div class="brand-mark">M</div><p class="eyebrow">PRIVATE MAILBOX</p><h1>欢迎回来</h1><p class="muted">登录你的私人邮箱管理中心</p>${notice(error)}<form method="post" class="stack auth-form">
    <label><span>邮箱地址</span><input name="username" type="email" autocomplete="username" placeholder="name@example.com" required autofocus></label>
    <label><span>密码</span><input name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required></label>
    <button class="primary-button">登录邮箱</button>
  </form><p class="security-note">🔒 登录信息通过 Cloudflare 加密传输</p></section></main>`, status);
}

async function composeForRequest(env: Env, user: User, url: URL): Promise<Response> {
  const replyId = url.searchParams.get("reply");
  const forwardId = url.searchParams.get("forward");
  const sourceId = replyId || forwardId;
  if (!sourceId) return composePage(env, user);
  const source = await env.MAIL_DB.prepare("SELECT * FROM messages WHERE id = ? AND owner_user_id = ?")
    .bind(sourceId, user.id).first<MessageRow>();
  if (!source) return appPage("未找到", user, "<h1>邮件不存在</h1>", 404);
  if (replyId) {
    const replyTo = source.direction === "inbound" ? (extractAddresses(source.sender)[0] || source.sender) : source.recipient;
    const providerId = stripOwnerMessagePrefix(source.mailgun_message_id || "");
    return composePage(env, user, "", 200, {
      to: replyTo,
      subject: /^(re|回复)\s*:/i.test(source.subject) ? source.subject : `Re: ${source.subject}`,
      text: `\n\n在 ${new Date(source.created_at).toLocaleString("zh-CN")}，${source.sender} 写道：\n${quoteText(source.text_body)}`,
      parentMessageId: source.id,
      inReplyTo: providerId,
      references: [source.references_header, providerId].filter(Boolean).join(" "),
    });
  }
  return composePage(env, user, "", 200, {
    subject: /^(fwd|fw|转发)\s*:/i.test(source.subject) ? source.subject : `Fwd: ${source.subject}`,
    text: `\n\n---------- 转发消息 ----------\n发件人：${source.sender}\n时间：${new Date(source.created_at).toLocaleString("zh-CN")}\n主题：${source.subject}\n收件人：${source.recipient}\n${source.cc ? `抄送：${source.cc}\n` : ""}\n${source.text_body}`,
    parentMessageId: source.id,
  });
}

function composePage(_env: Env, user: User, error = "", status = 200, values: ComposeValues = {}): Response {
  return appPage("写邮件", user, `<section class="page-heading"><div><p class="eyebrow">COMPOSE</p><h1>写邮件</h1><p>通过 Mailgun 安全发送邮件</p></div></section>${notice(error)}<form method="post" enctype="multipart/form-data" class="compose-card stack">
    <input type="hidden" name="parent_message_id" value="${escapeHtml(values.parentMessageId || "")}"><input type="hidden" name="in_reply_to" value="${escapeHtml(values.inReplyTo || "")}"><input type="hidden" name="references" value="${escapeHtml(values.references || "")}">
    <div class="form-grid"><label><span>发件地址</span><input value="${escapeHtml(user.username)}" disabled></label><label><span>收件地址</span><input name="to" value="${escapeHtml(values.to || "")}" placeholder="多个地址用逗号分隔" required></label></div>
    <details class="recipient-options" ${values.cc || values.bcc ? "open" : ""}><summary>添加抄送 / 密送</summary><div class="form-grid"><label><span>抄送 CC</span><input name="cc" value="${escapeHtml(values.cc || "")}" placeholder="cc@example.com"></label><label><span>密送 BCC</span><input name="bcc" value="${escapeHtml(values.bcc || "")}" placeholder="bcc@example.com"></label></div></details>
    <label><span>主题</span><input name="subject" value="${escapeHtml(values.subject || "")}" placeholder="邮件主题"></label>
    <label><span>正文</span><textarea name="text" rows="16" placeholder="在这里输入邮件内容……">${escapeHtml(values.text || "")}</textarea></label>
    <label><span>附件（可多选，单个不超过 20 MB）</span><input name="attachments" type="file" multiple></label>
    <div class="form-actions"><a class="secondary-action" href="/inbox">取消</a><button class="primary-button">发送邮件 →</button></div>
  </form>`, status);
}

function passwordPage(user: User, error = "", status = 200): Response {
  return appPage("修改密码", user, `<section class="page-heading"><div><p class="eyebrow">SECURITY</p><h1>修改密码</h1><p>更新后所有设备都需要重新登录</p></div></section>${notice(error)}<form method="post" class="settings-card stack">
    <label><span>当前密码</span><input name="current_password" type="password" required></label>
    <label><span>新密码（至少 16 位）</span><input name="new_password" type="password" minlength="16" required></label>
    <label><span>确认新密码</span><input name="confirm_password" type="password" minlength="16" required></label>
    <button class="primary-button">保存并重新登录</button>
  </form>`, status);
}

type NavSection = "inbox" | "sent" | "compose" | "sync" | "settings" | "admin";

function appPage(title: string, user: User, content: string, status = 200, activeSection?: NavSection): Response {
  const active = activeSection || navSectionForTitle(title);
  const navClass = (section: NavSection) => active === section ? ' class="active" aria-current="page"' : "";
  const adminLink = user.is_admin ? `<a${navClass("admin")} href="/admin/users">♙<span>邮箱账号</span></a>` : "";
  return htmlPage(title, `<div class="app-shell"><aside class="sidebar"><a class="logo" href="/inbox"><span>M</span><strong>Mini Mail</strong></a><nav><a${navClass("inbox")} href="/inbox">⌂<span>收件箱</span></a><a${navClass("sent")} href="/sent">↗<span>已发送</span></a><a${navClass("compose")} href="/compose">✎<span>写邮件</span></a><form method="post" action="/sync"><button class="nav-button${active === "sync" ? " active" : ""}"${active === "sync" ? ' aria-current="page"' : ""}>↻<span>立即同步</span></button></form><a${navClass("settings")} href="/settings/password">⚙<span>账户安全</span></a>${adminLink}</nav><div class="account"><span class="avatar">${escapeHtml(user.username.charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(user.username)}</strong><small>${user.is_admin ? "管理员" : "邮箱用户"}</small></div><form method="post" action="/logout"><button title="退出登录">↪</button></form></div></aside><main class="main-content">${content}</main></div>`, status);
}

function navSectionForTitle(title: string): NavSection {
  if (title === "已发送") return "sent";
  if (title === "写邮件") return "compose";
  if (title.startsWith("同步")) return "sync";
  if (title === "修改密码") return "settings";
  if (title === "邮箱账号") return "admin";
  return "inbox";
}

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f6fa;line-height:1.5;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0,#e9efff 0,transparent 32rem),#f4f6fa}a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}.center-shell{min-height:100vh;display:grid;place-items:center;padding:32px}.auth-card{width:min(100%,420px);padding:42px;background:rgba(255,255,255,.94);border:1px solid rgba(214,220,232,.85);border-radius:24px;box-shadow:0 24px 70px rgba(35,48,78,.14);text-align:center;backdrop-filter:blur(12px)}.brand-mark,.logo>span{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 22px;border-radius:15px;background:linear-gradient(145deg,#315bea,#703de7);color:#fff;font-weight:800;box-shadow:0 10px 28px rgba(66,71,211,.3)}.auth-card h1{margin:4px 0 8px;font-size:30px;letter-spacing:-.04em}.muted,.page-heading p{margin:0;color:#6e778c}.eyebrow{margin:0!important;color:#5a64d8!important;font-size:11px!important;font-weight:800;letter-spacing:.16em}.stack{display:grid;gap:18px}.auth-form{margin-top:28px;text-align:left}label{display:grid;gap:8px;color:#40495e;font-size:13px;font-weight:650}input,select,textarea{width:100%;padding:12px 14px;border:1px solid #d6dce8;border-radius:11px;background:#fff;color:#172033;outline:none;transition:border-color .15s,box-shadow .15s}input:focus,select:focus,textarea:focus{border-color:#5a64d8;box-shadow:0 0 0 4px rgba(90,100,216,.12)}textarea{resize:vertical;line-height:1.7}.primary-button,.primary-action,.button-link{display:inline-flex;align-items:center;justify-content:center;padding:12px 18px;border:0;border-radius:11px;background:linear-gradient(135deg,#315bea,#6742db);color:#fff;font-weight:750;cursor:pointer;box-shadow:0 8px 20px rgba(65,73,205,.22)}.heading-actions{display:flex;align-items:center;gap:10px}.heading-actions form{margin:0}.secondary-button{display:inline-flex;align-items:center;justify-content:center;padding:11px 16px;border:1px solid #d6dce8;border-radius:11px;background:#fff;color:#465066;font-weight:750;cursor:pointer}.secondary-button:hover{border-color:#9aa5bd;background:#f8f9fc}.auth-form .primary-button{width:100%;margin-top:4px}.security-note{margin:24px 0 0;color:#8a92a5;font-size:12px}.app-shell{min-height:100vh;display:grid;grid-template-columns:250px minmax(0,1fr)}.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:26px 18px;background:#111827;color:#dfe5f1}.logo{display:flex;align-items:center;gap:12px;padding:0 10px 24px;font-size:18px}.logo>span{width:38px;height:38px;margin:0;border-radius:12px;font-size:14px}.sidebar nav{display:grid;gap:7px}.sidebar nav a,.nav-button{width:100%;display:flex;align-items:center;gap:13px;padding:11px 13px;border:0;border-radius:10px;background:transparent;color:#aeb8ca;font-size:14px;text-align:left;cursor:pointer;transition:.15s}.sidebar nav a:hover,.nav-button:hover{background:#202b3d;color:#fff}.sidebar nav a.active,.nav-button.active{background:#25314a;color:#fff;box-shadow:inset 3px 0 #7787ff}.account{margin-top:auto;display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:10px;padding:14px 10px 0;border-top:1px solid #2a3446}.avatar{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:#e6e9ff;color:#4c55c7;font-weight:800}.account strong,.account small{display:block}.account small{color:#8994a8;font-size:11px}.account form button{padding:8px;border:0;background:transparent;color:#8994a8;cursor:pointer}.main-content{width:100%;max-width:1180px;margin:0 auto;padding:46px 48px}.page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:26px}.page-heading h1{margin:5px 0 3px;font-size:32px;letter-spacing:-.04em}.mail-list,.compose-card,.settings-card,.message-card{overflow:hidden;background:#fff;border:1px solid #e0e5ee;border-radius:17px;box-shadow:0 8px 28px rgba(31,42,68,.06)}.message-row{display:grid;grid-template-columns:42px minmax(150px,230px) minmax(220px,1fr) 170px;align-items:center;gap:14px;padding:15px 18px;border-bottom:1px solid #edf0f5;transition:background .15s}.message-row:last-child{border-bottom:0}.message-row:hover{background:#f8f9fd}.message-row.unread{background:#f4f6ff}.message-row.unread .message-subject{font-weight:800}.message-person,.message-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.message-person{font-size:13px;font-weight:650}.message-subject{color:#495268}.status-badge{display:inline-block;margin-left:7px;padding:2px 7px;border-radius:999px;background:#e8f8ef;color:#18864b;font-size:10px;font-weight:800;vertical-align:middle}.message-row time{color:#8992a5;font-size:12px;text-align:right}.compose-card,.settings-card,.message-card{padding:28px}.compose-card{max-width:900px}.settings-card{max-width:620px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.form-actions{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:4px}.secondary-action,.back-link{color:#697386;font-weight:650}.message-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px}.message-actions{display:flex;align-items:center;gap:8px}.message-actions .secondary-button{padding:7px 11px;font-size:12px}.recipient-options{border:1px solid #e1e5ed;border-radius:11px;background:#fafbfc}.recipient-options summary{padding:11px 14px;cursor:pointer;color:#626c80;font-size:13px;font-weight:750}.recipient-options .form-grid{padding:0 14px 14px}.direction-badge{padding:4px 10px;border-radius:999px;background:#eef1ff;color:#515bd2;font-size:11px;font-weight:800}.mail-header{padding:28px 0 24px;border-bottom:1px solid #e8ebf1}.mail-header h1{max-width:820px;margin:7px 0 24px;font-size:clamp(24px,3vw,36px);line-height:1.22;letter-spacing:-.035em;overflow-wrap:anywhere}.sender-card{display:grid;grid-template-columns:46px minmax(0,1fr) auto;align-items:center;gap:13px}.sender-avatar{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:linear-gradient(145deg,#e5e9ff,#f1eaff);color:#5059ce;font-size:17px;font-weight:850}.sender-identity{min-width:0}.sender-identity strong,.sender-identity span,.sender-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sender-identity strong{font-size:15px}.sender-identity span{color:#606a7f;font-size:13px}.sender-identity small,.sender-card time{color:#9098aa;font-size:11px}.sender-card time{text-align:right}.mail-content{max-width:820px;min-height:180px;padding:30px 2px 16px;color:#273044;font-size:15px;line-height:1.8}.body-copy{white-space:pre-wrap;overflow-wrap:anywhere}.forwarded-block{margin-top:8px;border:1px solid #dde2ec;border-radius:13px;background:#f8f9fc;overflow:hidden}.forwarded-block summary{padding:13px 16px;cursor:pointer;color:#596277;font-size:13px;font-weight:800;background:#f1f3f8}.forwarded-block pre,.quoted-block pre{margin:0;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace;color:#4b556b}.quoted-block{margin:20px 0 0;border-left:4px solid #cbd2e1;background:#f8f9fc}.empty-body{color:#929aab}.mail-body{min-height:180px;margin:24px 0 0;padding:0;white-space:pre-wrap;overflow-wrap:anywhere;background:transparent;font-family:inherit;line-height:1.75}.attachments{margin-top:24px;padding-top:20px;border-top:1px solid #e8ebf1}.attachments h2{font-size:15px}.attachments a{color:#4e5bd5}.notice{max-width:900px;margin:0 0 20px;padding:16px 18px;border:1px solid #f1b8b3;border-radius:12px;background:#fff1f0;color:#8f2620;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.empty-state{padding:70px 20px;text-align:center;color:#8891a4}.empty-state span{font-size:34px}.empty-state h2{margin:10px 0 4px;color:#3d4659}.error-card .brand-mark{background:#d54444}.error-details{padding:14px;border-radius:10px;background:#fff1f0;color:#8f2620;text-align:left;white-space:pre-wrap}.button-link{margin-top:12px}@media(max-width:860px){.app-shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;display:grid;grid-template-columns:1fr auto;padding:14px 18px}.logo{padding:0}.sidebar nav{display:none}.account{margin:0;padding:0;border:0}.main-content{padding:28px 18px}.message-row{grid-template-columns:38px 1fr}.message-subject{grid-column:2}.message-row time{grid-column:2;text-align:left}.form-grid{grid-template-columns:1fr}.page-heading{align-items:flex-start}.primary-action{white-space:nowrap}}@media(max-width:620px){.message-toolbar{align-items:flex-start}.message-actions{flex-wrap:wrap;justify-content:flex-end}.sender-card{grid-template-columns:42px 1fr}.sender-card time{grid-column:2;text-align:left}.mail-content{padding-top:24px}.mail-header h1{font-size:25px}}@media(max-width:520px){.center-shell{padding:18px}.auth-card{padding:30px 22px}.account>div{display:none}.main-content{padding:24px 14px}.page-heading{display:grid}.heading-actions{width:100%}.heading-actions form,.heading-actions button,.heading-actions .primary-action{flex:1}.compose-card,.settings-card,.message-card{padding:20px}.message-row{padding:14px}.page-heading h1{font-size:28px}}
  </style></head><body>${body}</body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PASSWORD_ITERATIONS }, key, 256);
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(saltBytes), iterations: PASSWORD_ITERATIONS };
}

async function verifyPassword(password: string, salt: string, expected: string, iterations: number): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(salt), iterations }, key, 256);
  return timingSafeEqual(toBase64(new Uint8Array(bits)), expected);
}

async function verifyMailgunSignature(key: string, timestamp: string, token: string, signature: string): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(timestamp + token));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, signature.toLowerCase());
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64(new Uint8Array(digest));
}

function formatMailBody(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return `<p class="empty-body">这封邮件没有纯文本正文。</p>`;
  const lines = normalized.split("\n");
  const forwardedAt = lines.findIndex((line) => /-{3,}.*(?:转发消息|forwarded message).*-{3,}/i.test(line.replace(/^>\s?/, "")));
  const renderLines = (items: string[]) => items.map((line) => escapeHtml(line.replace(/^>\s?/, ""))).join("\n");
  if (forwardedAt >= 0) {
    const intro = lines.slice(0, forwardedAt).filter((line) => line.trim());
    const forwarded = lines.slice(forwardedAt + 1);
    return `${intro.length ? `<div class="body-copy">${renderLines(intro)}</div>` : ""}<details class="forwarded-block" open><summary>转发的邮件</summary><pre>${renderLines(forwarded)}</pre></details>`;
  }
  const hasQuotedLines = lines.some((line) => /^>/.test(line));
  if (hasQuotedLines) {
    const own: string[] = [];
    const quoted: string[] = [];
    for (const line of lines) (/^>/.test(line) ? quoted : own).push(line);
    return `${own.some((line) => line.trim()) ? `<div class="body-copy">${renderLines(own)}</div>` : ""}${quoted.length ? `<blockquote class="quoted-block"><pre>${renderLines(quoted)}</pre></blockquote>` : ""}`;
  }
  return `<div class="body-copy">${renderLines(lines)}</div>`;
}

function parseRecipientList(value: string): string[] {
  return [...new Set(extractAddresses(value))];
}

function quoteText(value: string): string {
  return value.replace(/\r\n/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
}

function stripOwnerMessagePrefix(value: string): string {
  return value.replace(/^\d+:/, "");
}

function extractAddresses(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) || [];
}

async function findMailboxOwner(env: Env, recipient: string): Promise<User | null> {
  const addresses = extractAddresses(recipient);
  for (const address of addresses) {
    const owner = await env.MAIL_DB.prepare(
      "SELECT id, username, is_admin, enabled FROM users WHERE lower(username) = lower(?) AND enabled = 1",
    ).bind(address).first<User>();
    if (owner) return owner;
  }
  return null;
}

function mailgunDomain(env: Env): string {
  return env.MAILGUN_DOMAIN || env.INITIAL_EMAIL.split("@")[1] || "";
}

function joinAddresses(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join(", ");
  if (typeof value === "string") return value;
  return "";
}

function mailgunErrorHint(status: number, response: string, domain: string, apiBase: string): string {
  const normalized = response.toLowerCase();
  if (status === 401) return "MAILGUN_API_KEY 无效、已撤销，或误用了 Signing Key。请使用 Mailgun Private API Key。";
  if (status === 403) return `API Key 没有发送权限，域名 ${domain} 未验证，或免费/按量套餐限制了该收件人。`;
  if (status === 404) return `Mailgun 找不到域名 ${domain}。请确认域名拼写、账号归属以及 Region；当前 API Base 是 ${apiBase}。`;
  if (status === 400 && (normalized.includes("recipient") || normalized.includes("to parameter"))) return "收件地址格式无效，或者 sandbox 域名只能发送给已授权收件人。";
  if (status === 400) return "请求参数被 Mailgun 拒绝，请根据 Response 内容检查发件人、收件人和域名。";
  if (status === 429) return "达到 Mailgun 发送速率或套餐额度限制，请稍后重试并检查 Billing。";
  if (status >= 500) return "Mailgun 服务端暂时异常，请记录 Request ID 后稍后重试。";
  return "请根据 HTTP 状态、Response 和 Request ID 到 Mailgun Logs/API Keys 页面核对。";
}

function isTrustedFormPost(request: Request): boolean {
  // Sec-Fetch-Site survives reverse proxies better than a strict Origin/URL
  // comparison. Normal forms from this application report same-origin.
  const site = request.headers.get("Sec-Fetch-Site");
  return !site || site === "same-origin" || site === "none";
}
function sessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${maxAge}`;
}
function randomToken(): string { return toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, ""); }
function toBase64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string): ArrayBuffer { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer; }
async function attachmentContentToArrayBuffer(content: string | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (typeof content === "string") return encoder.encode(content).buffer;
  if (content instanceof ArrayBuffer) return content;
  return content.slice().buffer as ArrayBuffer;
}
function timingSafeEqual(a: string, b: string): boolean { if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0; }
function parseCookies(header: string): Record<string, string> { return Object.fromEntries(header.split(";").map((item) => item.trim().split("=", 2)).filter((item) => item.length === 2).map(([key, value]) => [key, decodeURIComponent(value)])); }
function redirect(location: string): Response { return new Response(null, { status: 303, headers: { Location: location } }); }
function notice(message: string): string { return message ? `<p class="notice">${escapeHtml(message)}</p>` : ""; }
function safeFilename(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "attachment"; }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!); }
function parseMessageHeaders(headersJson: string): Record<string, string> {
  try {
    const headers = JSON.parse(headersJson) as Array<[string, string]>;
    return Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value]));
  } catch {
    return {};
  }
}
