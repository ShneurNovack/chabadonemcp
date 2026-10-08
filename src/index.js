import puppeteer from "@cloudflare/puppeteer";
import { installCO } from "./co.js";

// chabadonemcp - ChabadOne as an MCP connector.
// Reads go to the /api/v2 JSON API with a cached session cookie (no browser).
// Writes and .asp reads run in a Cloudflare browser with the cached cookie
// injected (no password form unless the cookie is stale). The full password
// login runs only when the cookie has expired. Secrets: CHABADONE_EMAIL,
// CHABADONE_PASSWORD, BEARER_TOKEN.

const ORIGIN = "https://www.chabadone.org";
const LOGIN_URL = ORIGIN + "/platform/login/login.asp";
const API = "/api/v2/chabadone/sites";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const DEFAULT_SITE = "6649"; // southsidechabad.com; test site is 12599
const CACHE_KEY = "session";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/* ---------------- session cache ---------------- */

function keepCookies(all) {
  return all
    .filter((c) => !/^_ga|^_gcl|^_pk|^gtm_/.test(c.name) && c.name !== "__cf_bm")
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/", secure: !!c.secure, httpOnly: !!c.httpOnly }));
}
async function getCached(env) {
  try { return JSON.parse((await env.SESSIONS.get(CACHE_KEY)) || "null"); } catch (e) { return null; }
}
async function putCached(env, data) {
  await env.SESSIONS.put(CACHE_KEY, JSON.stringify(data));
}
function cookieHeader(cached, site) {
  const parts = cached.cookies
    .filter((c) => c.name !== "ccoWebID")
    .map((c) => `${c.name}=${c.value}`);
  parts.push("ccoWebID=" + site);
  return parts.join("; ");
}

/* ---------------- browser session ---------------- */

async function loginForm(page, env) {
  await page.goto(LOGIN_URL, { waitUntil: "networkidle0", timeout: 60000 });
  const body = (await page.evaluate(() => document.body.innerText || "")).slice(0, 200);
  if (/just a moment|checking your browser|enable javascript and cookies/i.test(body)) throw new Error("cloudflare_challenge_on_login");
  await page.waitForSelector('input[name="email"]', { timeout: 30000 });
  await page.type('input[name="email"]', env.CHABADONE_EMAIL, { delay: 20 });
  await page.type('input[name="password"]', env.CHABADONE_PASSWORD, { delay: 20 });
  await page.evaluate(() => { for (const n of ["userid_to_cookie", "saveID"]) { const el = document.querySelector(`input[name="${n}"]`); if (el && !el.checked) el.checked = true; } });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60000 }).catch(() => null),
    page.click('button[type="submit"], input[type="submit"], button.btn'),
  ]);
  if (/login\.asp/i.test(page.url())) throw new Error("login_failed");
}

// Open a logged-in page on the target site. Reuse the cached cookie if valid,
// otherwise do the full password login. Injects the CO helper. Returns the page.
async function openSession(browser, env, site) {
  const cached = await getCached(env);
  if (cached && cached.cookies && cached.cookies.length) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    try {
      await page.setCookie(...cached.cookies);
      await page.goto(`${ORIGIN}/platform/sitecontrol/sitecontrol.asp?Sel_MosadID=${encodeURIComponent(site)}`, { waitUntil: "networkidle0", timeout: 60000 });
      if (!/login\.asp/i.test(page.url())) {
        await page.evaluate(installCO);
        return page;
      }
    } catch (e) { /* fall through to login */ }
    await ctx.close();
  }
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent(UA);
  await loginForm(page, env);
  await page.goto(`${ORIGIN}/platform/sitecontrol/sitecontrol.asp?Sel_MosadID=${encodeURIComponent(site)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.evaluate(installCO);
  return page;
}

async function cacheFromPage(env, page, site) {
  const cookies = keepCookies(await page.cookies(ORIGIN));
  await putCached(env, { cookies, activeSite: String(site), savedAt: Date.now() });
}

// Run fn(page) in a logged-in browser on the target site, refresh the cache.
async function withBrowser(env, site, fn) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await openSession(browser, env, site);
    const out = await fn(page);
    await cacheFromPage(env, page, site);
    return out;
  } finally {
    await browser.close();
  }
}

// Ensure the cache is valid and on the target site (mints via browser if not).
async function ensureSession(env, site) {
  const cached = await getCached(env);
  if (cached && cached.activeSite === String(site) && cached.cookies && cached.cookies.length) return cached;
  await withBrowser(env, site, async () => true); // mint / switch site, refreshes cache
  return getCached(env);
}

/* ---------------- /api/v2 reads (no browser) ---------------- */

async function apiFetch(env, site, path, init = {}) {
  let cached = await ensureSession(env, site);
  const headers = (c) => ({ "User-Agent": UA, Accept: "application/json, text/plain, */*", ...(init.headers || {}), Cookie: cookieHeader(c, site) });
  let res = await fetch(ORIGIN + path, { ...init, headers: headers(cached) });
  if (res.status === 401) {
    await withBrowser(env, site, async () => true); // stale -> re-login
    cached = await getCached(env);
    res = await fetch(ORIGIN + path, { ...init, headers: headers(cached) });
  }
  return res;
}
async function apiJson(env, site, path, init) {
  const r = await apiFetch(env, site, path, init);
  const t = await r.text();
  if (!r.ok) throw new Error("API " + r.status + " on " + path + ": " + t.slice(0, 150));
  return t ? JSON.parse(t) : null;
}

/* ---------------- CO call in a browser ---------------- */

function co(env, site, method, args = []) {
  return withBrowser(env, site, (page) =>
    page.evaluate((m, a) => window.CO[m].apply(window.CO, a), method, args)
  );
}

/* ---------------- settings reference (mapped) ---------------- */

const SETTINGS_SECTIONS = [
  { id: 309262, name: "General Settings" }, { id: 309264, name: "Virtual Paths" },
  { id: 309361, name: "Site Alerts and Announcements" }, { id: 309358, name: "Quick Links" },
  { id: 309263, name: "Site Template & Theme" }, { id: 393260, name: "Site Branding" },
  { id: 309266, name: "Donation Page" }, { id: 1538260, name: "Social Integration" },
  { id: 591294, name: "Language & Regional Settings" }, { id: 309268, name: "Email Subscriptions" },
  { id: 309329, name: "Passover Site Settings" }, { id: 309270, name: "Ask the Rabbi" },
  { id: 309269, name: "Contact Us Page" }, { id: 309267, name: "About Us Page" },
  { id: 309261, name: "Location" }, { id: 309271, name: "Site Search" },
  { id: 390611, name: "Kaddish Services" }, { id: 309866, name: "Password Protected Sections" },
  { id: 2781961, name: "ChabadOne CRM" }, { id: 4031583, name: "Privacy Policy" },
  { id: 4740812, name: "Program Registration" }, { id: 1990728, name: "Mobile Site Settings" },
  { id: 490797, name: "Advertisement Sidebar" }, { id: 309272, name: "JLI Link Setting" },
  { id: 442536, name: "Kids Zone Home Page" },
];
const EVENT_TYPES = { "8123": "Prayer / Minyan", "8124": "Class / Lecture", "8125": "Children", "8127": "Passover Seder", "8810": "Women's Event", "11179": "3 Tammuz Event" };

/* ---------------- tools ---------------- */

const S = (props, required) => ({ type: "object", properties: { site: { type: "string", description: "Mosad id. Default southsidechabad.com (6649); test site 12599." }, ...props }, required: required || [] });
const site = (a) => String(a.site || DEFAULT_SITE);

const TOOLS = [
  // ---- reads via API (no browser) ----
  { name: "chabadone_status", description: "Session status and active site for ChabadOne.", inputSchema: S({}),
    handler: async (env, a) => { const d = await apiJson(env, site(a), API + "/sites"); const m = d["active-mosad"]; return { activeSiteId: m ? Number(m.id) : null, siteName: m ? m["site-name"] : null, role: m ? m["active-user-role"] : null, publicDomain: m ? m.listing["domain-name"] : null, mosdosSample: (d.mosdos || []).slice(0, 8) }; } },
  { name: "get_page", description: "Read a page: title, body (HTML with co: tags), settings, breadcrumbs. Fast API read; does not include the live/published flag (use is_published).", inputSchema: S({ id: { type: "number" } }, ["id"]),
    handler: async (env, a) => { const [p, s, b] = await Promise.all([apiJson(env, site(a), `${API}/pages/${a.id}`), apiJson(env, site(a), `${API}/pages/${a.id}/settings`), apiJson(env, site(a), `${API}/pages/${a.id}/breadcrumbs`)]); return { ...p, settings: s, breadcrumbs: b }; } },
  { name: "get_page_versions", description: "Version history of a page.", inputSchema: S({ id: { type: "number" } }, ["id"]),
    handler: (env, a) => apiJson(env, site(a), `${API}/pages/${a.id}/versions`) },
  { name: "revert_page", description: "Revert a page to an earlier version id (from get_page_versions).", inputSchema: S({ id: { type: "number" }, versionId: { type: "number" } }, ["id", "versionId"]),
    handler: (env, a) => apiJson(env, site(a), `${API}/pages/${a.id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "version-id": Number(a.versionId) }) }) },
  { name: "set_page_image", description: "Attach an uploaded image (image id) as a page's hero or icon.", inputSchema: S({ pageId: { type: "number" }, imageId: { type: "number" }, type: { type: "string", enum: ["hero", "icon"] } }, ["pageId", "imageId"]),
    handler: async (env, a) => { await apiFetch(env, site(a), `${API}/pages/${a.pageId}/settings/images`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "image-id": Number(a.imageId), type: a.type === "icon" ? 0 : 1 }) }); return apiJson(env, site(a), `${API}/pages/${a.pageId}/settings`); } },
  { name: "list_forms", description: "List the site's forms.", inputSchema: S({}),
    handler: (env, a) => apiJson(env, site(a), `${API}/forms`) },
  { name: "get_form_submissions", description: "Submissions for a form (personal data; summarize, do not export without asking).", inputSchema: S({ formId: { type: "number" } }, ["formId"]),
    handler: (env, a) => apiJson(env, site(a), `${API}/forms/${a.formId}/submissions`) },
  { name: "get_contacts", description: "Notification email recipients for forms.", inputSchema: S({}),
    handler: (env, a) => apiJson(env, site(a), `${API}/sites/contacts`) },

  // ---- reads via browser (.asp) ----
  { name: "is_published", description: "Whether a page is currently live.", inputSchema: S({ id: { type: "number" } }, ["id"]),
    handler: (env, a) => co(env, site(a), "isPublished", [a.id]) },
  { name: "get_tree", description: "The site's page tree (navigation structure). depth default 4.", inputSchema: S({ depth: { type: "number" } }),
    handler: (env, a) => withBrowser(env, site(a), (page) => page.evaluate(async (depth) => { const roots = await window.CO.roots(); const my = roots.find((r) => r.prefix === "A"); return window.CO.tree(my.id, "A", depth); }, a.depth || 4)) },
  { name: "find_pages", description: "Find pages by title across the site tree.", inputSchema: S({ query: { type: "string" } }, ["query"]),
    handler: (env, a) => withBrowser(env, site(a), (page) => page.evaluate(async (q) => { const roots = await window.CO.roots(); const my = roots.find((r) => r.prefix === "A"); return window.CO.findPages(q, my.id, 6); }, a.query)) },
  { name: "list_sites", description: "All ChabadOne sites this login can manage.", inputSchema: S({}),
    handler: (env, a) => co(env, site(a), "listSites", []) },

  // ---- page writes (browser) ----
  { name: "create_page", description: "Create a page under parentId. Publishes by default; set publish:false for a draft. New pages default to hidden from nav/search unless you set the hide flags false.", inputSchema: S({ parentId: { type: "number" }, title: { type: "string" }, body: { type: "string" }, publish: { type: "boolean" }, hideFromNav: { type: "boolean" }, hideFromSearch: { type: "boolean" }, hideFromLocalNav: { type: "boolean" } }, ["parentId", "title"]),
    handler: (env, a) => withBrowser(env, site(a), (page) => page.evaluate(async (parent, opts) => { const id = await window.CO.createPage(parent); const r = await window.CO.savePage(id, opts); return { id, ...r }; }, a.parentId, { title: a.title, body: a.body != null ? a.body : "", publish: a.publish !== false, hideFromNav: a.hideFromNav, hideFromSearch: a.hideFromSearch, hideFromLocalNav: a.hideFromLocalNav })) },
  { name: "update_page", description: "Edit a page. Reads the current page and sends the full title/body, so pass the complete new body. Publishes by default; set publish:false to save a draft.", inputSchema: S({ id: { type: "number" }, title: { type: "string" }, body: { type: "string" }, publish: { type: "boolean" }, hideFromNav: { type: "boolean" }, hideFromSearch: { type: "boolean" }, hideFromLocalNav: { type: "boolean" }, title2: { type: "string" }, subTitle: { type: "string" }, synopsis: { type: "string" }, publishDate: { type: "string" }, expireDate: { type: "string" } }, ["id"]),
    handler: (env, a) => co(env, site(a), "savePage", [a.id, { title: a.title, body: a.body, publish: a.publish !== false, hideFromNav: a.hideFromNav, hideFromSearch: a.hideFromSearch, hideFromLocalNav: a.hideFromLocalNav, title2: a.title2, subTitle: a.subTitle, synopsis: a.synopsis, publishDate: a.publishDate, expireDate: a.expireDate }]) },
  { name: "publish_page", description: "Publish a page's current working copy live.", inputSchema: S({ id: { type: "number" }, hideFromNav: { type: "boolean" }, hideFromSearch: { type: "boolean" }, hideFromLocalNav: { type: "boolean" } }, ["id"]),
    handler: (env, a) => co(env, site(a), "publishPage", [a.id, { hideFromNav: a.hideFromNav, hideFromSearch: a.hideFromSearch, hideFromLocalNav: a.hideFromLocalNav }]) },
  { name: "delete_page", description: "Delete a page (permanent, no recycle bin). Pass parentId to verify removal.", inputSchema: S({ id: { type: "number" }, parentId: { type: "number" } }, ["id"]),
    handler: (env, a) => co(env, site(a), "deletePage", [a.id, a.parentId]) },
  { name: "move_page", description: "Move a page under a new parent.", inputSchema: S({ id: { type: "number" }, newParentId: { type: "number" } }, ["id", "newParentId"]),
    handler: (env, a) => co(env, site(a), "movePage", [a.id, a.newParentId]) },
  { name: "reorder_page", description: "Reorder a page among its siblings. action: up|down|toTop|toBottom, or pass position (1-based).", inputSchema: S({ id: { type: "number" }, action: { type: "string", enum: ["up", "down", "toTop", "toBottom"] }, position: { type: "number" } }, ["id"]),
    handler: (env, a) => co(env, site(a), "reorderPage", [a.id, a.action, a.position]) },
  { name: "duplicate_page", description: "Copy a page. nodeType from get_tree (1=article). targetParentId optional.", inputSchema: S({ id: { type: "number" }, nodeType: { type: "number" }, targetParentId: { type: "number" } }, ["id", "nodeType"]),
    handler: (env, a) => co(env, site(a), "duplicatePage", [a.id, a.nodeType, a.targetParentId]) },

  // ---- media (browser) ----
  { name: "upload_image_from_url", description: "Upload an image from a URL into the site's image library. Returns the image id.", inputSchema: S({ url: { type: "string" }, folderId: { type: "number" }, name: { type: "string" } }, ["url"]),
    handler: (env, a) => withBrowser(env, site(a), (page) => page.evaluate(async (url, folderId, name) => { if (!folderId) { const roots = await window.CO.roots(); const img = roots.find((r) => r.prefix === "I"); folderId = img && img.id; } const imageId = await window.CO.uploadImageFromUrl(url, folderId, name); return { imageId, folderId }; }, a.url, a.folderId, a.name)) },
  { name: "delete_image", description: "Delete an image by id.", inputSchema: S({ imageId: { type: "number" } }, ["imageId"]),
    handler: (env, a) => co(env, site(a), "deleteImage", [a.imageId]) },

  // ---- calendar (browser) ----
  { name: "list_events", description: "List calendar events starting from a date (M/D/YYYY).", inputSchema: S({ date: { type: "string" } }, ["date"]),
    handler: (env, a) => co(env, site(a), "listEvents", [a.date]) },
  { name: "create_event", description: "Create a calendar event. Shows on the public site immediately. Times like '7:00 PM'. eType optional (8123 Prayer/Minyan, 8124 Class, 8125 Children, 8127 Seder, 8810 Women's).", inputSchema: S({ title: { type: "string" }, date: { type: "string" }, start: { type: "string" }, end: { type: "string" }, allDay: { type: "boolean" }, description: { type: "string" }, linkUrl: { type: "string" }, eType: { type: "string" }, displayPriority: { type: "number" } }, ["title", "date"]),
    handler: (env, a) => co(env, site(a), "createEvent", [{ title: a.title, date: a.date, start: a.start, end: a.end === undefined ? null : a.end, allDay: a.allDay, description: a.description, linkUrl: a.linkUrl, eType: a.eType, displayPriority: a.displayPriority }]) },
  { name: "update_event", description: "Edit a calendar event by id.", inputSchema: S({ eventId: { type: "number" }, title: { type: "string" }, date: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, linkUrl: { type: "string" }, eType: { type: "string" }, displayPriority: { type: "number" } }, ["eventId"]),
    handler: (env, a) => co(env, site(a), "updateEvent", [a.eventId, { title: a.title, date: a.date, start: a.start, end: a.end, description: a.description, linkUrl: a.linkUrl, eType: a.eType, displayPriority: a.displayPriority }]) },
  { name: "delete_event", description: "Delete a calendar event by id. Pass date (M/D/YYYY) to verify.", inputSchema: S({ eventId: { type: "number" }, date: { type: "string" } }, ["eventId"]),
    handler: (env, a) => co(env, site(a), "deleteEvent", [a.eventId, a.date]) },

  // ---- settings reference ----
  { name: "list_settings_sections", description: "The site settings sections and their ids. These are framed wizards edited in the browser UI; not yet automated as tools.", inputSchema: S({}),
    handler: async () => ({ sections: SETTINGS_SECTIONS, eventTypes: EVENT_TYPES, note: "Settings are legacy framed wizards at /platform/sitecontrol/admin/wizards/default.asp?wizaid={id}. Ask to automate a specific one if needed." }) },
];

/* ---------------- MCP dispatch ---------------- */

async function handleMcp(env, msg) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") return ok({ protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "chabadonemcp", version: "1.0.0" } });
  if (method && method.startsWith("notifications/")) return null;
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === "tools/call") {
    const t = TOOLS.find((x) => x.name === (params && params.name));
    if (!t) return fail(-32602, "Unknown tool: " + (params && params.name));
    try {
      const out = await t.handler(env, (params && params.arguments) || {});
      return ok({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return ok({ content: [{ type: "text", text: "ERROR: " + String((e && e.message) || e) }], isError: true });
    }
  }
  return fail(-32601, "Method not found: " + method);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const token = url.searchParams.get("bearer_token") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.BEARER_TOKEN || token !== env.BEARER_TOKEN) return json({ error: "unauthorized" }, 401);

    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
      if (Array.isArray(body)) {
        const out = [];
        for (const m of body) { const r = await handleMcp(env, m); if (r) out.push(r); }
        return out.length ? json(out) : new Response(null, { status: 202 });
      }
      const resp = await handleMcp(env, body);
      return resp === null ? new Response(null, { status: 202 }) : json(resp);
    }

    return json({ ok: true, worker: "chabadonemcp", transport: "MCP over HTTP (POST JSON-RPC)", tools: TOOLS.length });
  },
};
