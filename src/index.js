import puppeteer from "@cloudflare/puppeteer";

// chabadonemcp - auto-login prober + cookie-replay test.
// Logs into ChabadOne from secrets (never logged), and tests whether the
// exported session cookies can call the backend DIRECTLY (plain fetch, no browser).
// Secrets: CHABADONE_EMAIL, CHABADONE_PASSWORD, BEARER_TOKEN.

const ORIGIN = "https://www.chabadone.org";
const LOGIN_URL = ORIGIN + "/platform/login/login.asp";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    const token =
      url.searchParams.get("bearer_token") ||
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.BEARER_TOKEN || token !== env.BEARER_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!env.CHABADONE_EMAIL || !env.CHABADONE_PASSWORD) {
      return json({ error: "missing_secrets", need: ["CHABADONE_EMAIL", "CHABADONE_PASSWORD"] }, 500);
    }

    const site = url.searchParams.get("site") || "12599";
    try {
      if (url.pathname === "/login-test") return json(await loginTest(env, site));
      if (url.pathname === "/cookie-replay-test") return json(await cookieReplayTest(env, site));
    } catch (e) {
      return json({ result: "error", error: String((e && e.stack) || e) }, 500);
    }

    return json({
      ok: true,
      worker: "chabadonemcp",
      endpoints: [
        "/login-test?bearer_token=...&site=12599",
        "/cookie-replay-test?bearer_token=...&site=12599",
      ],
    });
  },
};

// Shared: launch, log in from secrets, select the site. Returns the live page.
async function login(browser, env, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(LOGIN_URL, { waitUntil: "networkidle0", timeout: 60000 });

  const body = (await page.evaluate(() => document.body.innerText || "")).slice(0, 200);
  if (/just a moment|checking your browser|enable javascript and cookies/i.test(body)) {
    throw new Error("cloudflare_challenge_on_login: " + body);
  }

  await page.waitForSelector('input[name="email"]', { timeout: 30000 });
  await page.type('input[name="email"]', env.CHABADONE_EMAIL, { delay: 25 });
  await page.type('input[name="password"]', env.CHABADONE_PASSWORD, { delay: 25 });
  await page.evaluate(() => {
    for (const n of ["userid_to_cookie", "saveID"]) {
      const el = document.querySelector(`input[name="${n}"]`);
      if (el && !el.checked) el.checked = true;
    }
  });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60000 }).catch(() => null),
    page.click('button[type="submit"], input[type="submit"], button.btn'),
  ]);

  if (/login\.asp/i.test(page.url())) throw new Error("login_failed");

  await page.goto(
    `${ORIGIN}/platform/sitecontrol/sitecontrol.asp?Sel_MosadID=${encodeURIComponent(site)}`,
    { waitUntil: "networkidle0", timeout: 60000 }
  );
  return page;
}

async function loginTest(env, site) {
  const report = { site, startedAt: new Date().toISOString() };
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await login(browser, env, site);
    report.loggedIn = true;
    report.probes = await page.evaluate(async () => {
      const t = async (u) => {
        try { const r = await fetch(u, { credentials: "include" }); return { status: r.status, len: (await r.text()).length }; }
        catch (e) { return { err: String(e) }; }
      };
      const text = async (u) => { try { return (await (await fetch(u, { credentials: "include" })).text()).trim().slice(0, 60); } catch (e) { return String(e); } };
      return {
        activeDomain: await text("/platform/sitecontrol/admin/scripts/session.ajax.asp?action=MosaddomainResponse"),
        check_valid_login: await text("/scripts/ajax.functions.asp?action=check_valid_login&isajaxcall=true"),
        legacy_tree: await t("/platform/global/co_tree/co_navBranch.ajax.asp?Type=A&id=7245483&isajaxcall=true&context=sitecontrol&foldersonly=false"),
        api_sites: await t("/api/v2/chabadone/sites/sites"),
        api_page_7245811: await t("/api/v2/chabadone/sites/pages/7245811"),
      };
    });
    const cookies = await page.cookies(ORIGIN);
    report.cookies = cookies.map((c) => ({ name: c.name, httpOnly: !!c.httpOnly, secure: !!c.secure }));
    report.apiRecovered = report.probes.api_sites && report.probes.api_sites.status === 200;
    report.result = "ok";
    return report;
  } finally {
    await browser.close();
  }
}

// The real experiment: export the session cookies, CLOSE the browser, then call
// the backend with a plain fetch carrying just the cookies. No browser driving it.
async function cookieReplayTest(env, site) {
  const report = { site, startedAt: new Date().toISOString() };
  const browser = await puppeteer.launch(env.BROWSER);
  let cookieHeader = "";
  let names = [];
  try {
    const page = await login(browser, env, site);
    const cookies = await page.cookies(ORIGIN);
    names = cookies.map((c) => c.name);
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } finally {
    await browser.close(); // browser is gone before we replay
  }
  report.cookieNames = names;
  report.browserClosed = true;

  // Plain server-side fetches from the Worker, carrying only the cookies.
  const probe = async (path, withCookie) => {
    const headers = { "User-Agent": UA, Accept: "application/json, text/plain, */*" };
    if (withCookie) headers["Cookie"] = cookieHeader;
    try {
      const r = await fetch(ORIGIN + path, { headers, redirect: "manual" });
      const text = await r.text();
      return {
        status: r.status,
        len: text.length,
        cfMitigated: r.headers.get("cf-mitigated") || null,
        looksChallenged: /just a moment|challenge-platform|cf-chl/i.test(text),
        peek: (r.status !== 200 ? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120) : undefined),
      };
    } catch (e) {
      return { err: String(e) };
    }
  };

  report.direct = {
    api_sites_withCookie: await probe("/api/v2/chabadone/sites/sites", true),
    api_sites_noCookie: await probe("/api/v2/chabadone/sites/sites", false),
    api_page_withCookie: await probe("/api/v2/chabadone/sites/pages/7245811", true),
    // Does a plain Worker fetch of a legacy .asp endpoint get the Cloudflare challenge
    // (like curl did) or go through? This decides whether writes can also skip the browser.
    legacy_tree_withCookie: await probe(
      "/platform/global/co_tree/co_navBranch.ajax.asp?Type=A&id=7245483&isajaxcall=true&context=sitecontrol&foldersonly=false",
      true
    ),
    check_valid_login_withCookie: await probe(
      "/scripts/ajax.functions.asp?action=check_valid_login&isajaxcall=true",
      true
    ),
  };
  report.apiReplayWorks = !!(report.direct.api_sites_withCookie && report.direct.api_sites_withCookie.status === 200);
  report.legacyReplayWorks = !!(report.direct.legacy_tree_withCookie && report.direct.legacy_tree_withCookie.status === 200);
  report.result = "ok";
  return report;
}
