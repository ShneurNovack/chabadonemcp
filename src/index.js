import puppeteer from "@cloudflare/puppeteer";

// chabadonemcp - milestone 1: auto-login prober.
// Logs into ChabadOne from secrets (never logged), selects a site, and reports
// whether the session is valid and whether the /api/v2 JSON side comes back to
// life after a fresh login. Secrets: CHABADONE_EMAIL, CHABADONE_PASSWORD, BEARER_TOKEN.

const ORIGIN = "https://www.chabadone.org";
const LOGIN_URL = ORIGIN + "/platform/login/login.asp";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Simple bearer gate, same pattern as the other workers.
    const token =
      url.searchParams.get("bearer_token") ||
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.BEARER_TOKEN || token !== env.BEARER_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!env.CHABADONE_EMAIL || !env.CHABADONE_PASSWORD) {
      return json(
        { error: "missing_secrets", need: ["CHABADONE_EMAIL", "CHABADONE_PASSWORD"] },
        500
      );
    }

    if (url.pathname === "/login-test") {
      const site = url.searchParams.get("site") || "12599";
      try {
        return json(await loginTest(env, site));
      } catch (e) {
        return json({ result: "error", error: String(e && e.stack || e) }, 500);
      }
    }

    return json({
      ok: true,
      worker: "chabadonemcp",
      milestone: "login prober",
      endpoints: ["/login-test?bearer_token=...&site=12599"],
    });
  },
};

async function loginTest(env, site) {
  const report = { site, startedAt: new Date().toISOString(), steps: [] };
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(LOGIN_URL, { waitUntil: "networkidle0", timeout: 60000 });
    report.steps.push({ step: "load_login", url: page.url(), title: await page.title() });

    const bodyNow = (await page.evaluate(() => document.body.innerText || "")).slice(0, 200);
    if (/just a moment|checking your browser|enable javascript and cookies/i.test(bodyNow)) {
      report.result = "cloudflare_challenge_on_login";
      report.note = bodyNow;
      return report;
    }

    // Fill and submit. Values come straight from secrets; never read back or logged.
    await page.waitForSelector('input[name="email"]', { timeout: 30000 });
    await page.type('input[name="email"]', env.CHABADONE_EMAIL, { delay: 25 });
    await page.type('input[name="password"]', env.CHABADONE_PASSWORD, { delay: 25 });
    // keep the session alive ("remember me") if the checkboxes exist
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

    const afterUrl = page.url();
    const loggedIn = !/login\.asp/i.test(afterUrl);
    report.steps.push({ step: "after_login", url: afterUrl, loggedIn });

    if (!loggedIn) {
      report.result = "login_failed";
      report.bodyText = (await page.evaluate(() => document.body.innerText || "")).slice(0, 300);
      return report;
    }

    // Select the target site in the server session.
    await page.goto(
      `${ORIGIN}/platform/sitecontrol/sitecontrol.asp?Sel_MosadID=${encodeURIComponent(site)}`,
      { waitUntil: "networkidle0", timeout: 60000 }
    );

    // Probe both auth systems from inside the page (rides the session cookies).
    report.probes = await page.evaluate(async () => {
      const t = async (u, opts = {}) => {
        try {
          const r = await fetch(u, { credentials: "include", ...opts });
          return { status: r.status, len: (await r.text()).length };
        } catch (e) {
          return { err: String(e) };
        }
      };
      const text = async (u) => {
        try {
          return (await (await fetch(u, { credentials: "include" })).text()).trim().slice(0, 60);
        } catch (e) {
          return String(e);
        }
      };
      return {
        activeDomain: await text("/platform/sitecontrol/admin/scripts/session.ajax.asp?action=MosaddomainResponse"),
        check_valid_login: await text("/scripts/ajax.functions.asp?action=check_valid_login&isajaxcall=true"),
        legacy_tree: await t("/platform/global/co_tree/co_navBranch.ajax.asp?Type=A&id=7245483&isajaxcall=true&context=sitecontrol&foldersonly=false"),
        api_sites: await t("/api/v2/chabadone/sites/sites"),
        api_page_7245811: await t("/api/v2/chabadone/sites/pages/7245811"),
      };
    });

    // Prove the session cookies are exportable for a future direct-API path.
    // Report names + httpOnly flags only, never the values.
    const cookies = await page.cookies(ORIGIN);
    report.cookies = cookies.map((c) => ({
      name: c.name,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      expires: c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session",
    }));

    const p = report.probes;
    report.apiRecovered = !!(p.api_sites && p.api_sites.status === 200);
    report.legacyWorks = !!(p.legacy_tree && p.legacy_tree.status === 200);
    report.result = "ok";
    return report;
  } finally {
    await browser.close();
  }
}
