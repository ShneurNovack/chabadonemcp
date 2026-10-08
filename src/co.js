// Self-contained in-page helper. Injected into a logged-in ChabadOne browser
// page via page.evaluate(installCO). Must reference nothing outside itself
// (it is serialized with Function.prototype.toString). Mirrors the tested
// ChabadOne plugin helper. The page is already logged in and on the target site.
export function installCO() {
  const ADMIN = "/platform/sitecontrol/admin";
  const PUB = ADMIN + "/publishing";
  const API = "/api/v2/chabadone/sites";

  const text = async (url, opts) => {
    const r = await fetch(url, { credentials: "include", ...(opts || {}) });
    const t = await r.text();
    if (/\/platform\/login\/login\.asp/i.test(r.url)) throw new Error("NOT_LOGGED_IN");
    if (/Security Alert/i.test(t)) throw new Error("SECURITY_ALERT");
    return { status: r.status, url: r.url, text: t };
  };
  const json = async (url, opts) => {
    const r = await fetch(url, { credentials: "include", ...(opts || {}) });
    const t = await r.text();
    if (r.status === 401) throw new Error("UNAUTHORIZED_401");
    if (r.status === 404) throw new Error("NOT_FOUND_404: " + url);
    if (!r.ok) throw new Error("HTTP_" + r.status + ": " + t.slice(0, 200));
    return t ? JSON.parse(t) : null;
  };
  const parseTree = (html) =>
    [...html.matchAll(/id="Node_(\w)(\d+)_Plus"[\s\S]*?class="(Tree_\w+)"[\s\S]*?id="Node_\w\d+_Actual"[^>]*nodeType="(\d*)"[\s\S]*?&nbsp;([^<]*)/g)].map((m) => ({
      prefix: m[1], id: +m[2], nodeType: m[4] === "" ? null : +m[4], title: m[5].trim(), hasChildren: m[3] !== "Tree_NoChildren",
    }));

  const CO = {
    async status() {
      const domain = (await text(ADMIN + "/scripts/session.ajax.asp?action=MosaddomainResponse")).text.trim();
      let ctx = null; try { ctx = await json(API + "/sites"); } catch (e) { ctx = { error: String(e.message) }; }
      const a = ctx && ctx["active-mosad"];
      return { activeDomain: domain, activeSiteId: a ? Number(a.id) : null, siteName: a ? a["site-name"] : null, role: a ? a["active-user-role"] : null, publicDomain: a ? a.listing["domain-name"] : null };
    },
    async listSites() {
      const { text: t } = await text("/platform/sitecontrol/sitecontrol.asp");
      const d = new DOMParser().parseFromString(t, "text/html");
      return [...d.querySelectorAll('a[onclick*="select_domain"]')].map((a) => ({ siteId: +((a.getAttribute("onclick").match(/select_domain\('(\d+)'\)/) || [])[1]), domain: a.textContent.trim() })).filter((s) => s.siteId);
    },
    async roots() {
      const { text: t } = await text(PUB + "/Tree/NavTreeImpl.asp?articleRoot=on&imageRoot=on&globalRoot=on&pdfRoot=on&templateRoot=on&showFeeds=on&nest=on&iconRoot=on&mediaRoot=on&hasRouter=true");
      return [...t.matchAll(/id="Node_(\w)(\d+)_Actual"([^>]*)>[\s\S]*?&nbsp;([^<\t\r\n]*)/g)].map((m) => { const nt = (m[3].match(/nodeType="(\d+)"/i) || [])[1]; return { prefix: m[1], id: +m[2], nodeType: nt ? +nt : null, title: m[4].trim() }; });
    },
    async children(id, prefix) {
      prefix = prefix || "A";
      const q = new URLSearchParams({ Type: prefix, id: String(id), isajaxcall: "true", context: "sitecontrol", foldersonly: "false", campussharefolder: "false", uploadRoot: "false" });
      return parseTree((await text("/platform/global/co_tree/co_navBranch.ajax.asp?" + q)).text);
    },
    async tree(rootId, prefix, maxDepth, _depth) {
      prefix = prefix || "A"; maxDepth = maxDepth || 4; _depth = _depth || 0;
      const kids = await this.children(rootId, prefix);
      if (_depth + 1 < maxDepth) for (const k of kids) if (k.hasChildren) k.children = await this.tree(k.id, k.prefix, maxDepth, _depth + 1);
      return kids;
    },
    async findPages(query, rootId, maxDepth) {
      const q = String(query).toLowerCase(); const out = [];
      const walk = (nodes, path) => nodes.forEach((n) => { const p = [...path, n.title]; if (n.title.toLowerCase().includes(q)) out.push({ id: n.id, prefix: n.prefix, nodeType: n.nodeType, title: n.title, path: p.join(" > ") }); if (n.children) walk(n.children, p); });
      walk(await this.tree(rootId, "A", maxDepth || 6), []);
      return out;
    },
    async isPublished(id) {
      return (await json(PUB + "/menu.ajax.asp", { method: "POST", body: new URLSearchParams({ action: "verify", txtArticle: String(id) }) })).published;
    },
    async getPage(id) {
      const [page, settings, breadcrumbs] = await Promise.all([json(API + "/pages/" + id), json(API + "/pages/" + id + "/settings"), json(API + "/pages/" + id + "/breadcrumbs")]);
      const published = await this.isPublished(id);
      const st = await this.status();
      return { ...page, settings, breadcrumbs, published, publicUrl: st.publicDomain ? "https://" + st.publicDomain + "/" + id : null };
    },
    versions(id) { return json(API + "/pages/" + id + "/versions"); },
    async createPage(parentId) {
      const { text: t } = await text(PUB + "/EditArticleBody_neweditor.asp?Act=New&AID=" + parentId);
      const m = t.match(/loadNewAppURL\(Number\('(\d+)'\)/);
      if (!m) throw new Error("CREATE_FAILED");
      return Number(m[1]);
    },
    async savePage(id, opts) {
      opts = opts || {};
      const cur = await json(API + "/pages/" + id);
      const title = opts.title != null ? opts.title : cur.title != null ? cur.title : "Untitled";
      const body = opts.body != null ? opts.body : cur.body != null ? cur.body : "";
      if (!body.trim() && (cur.body || "").trim() && !opts.allowEmptyBody) throw new Error("REFUSED_would_wipe_body");
      const fd = new FormData();
      fd.append("Title1", title);
      fd.append("hiddenTitleChange", String(title !== cur.title));
      fd.append("Body", body);
      const flag = (name, v) => { if (v === undefined) return; fd.append(name, v ? "ON" : "OFF"); fd.append(name + "Changed", "true"); };
      flag("hiddenHideLeft", opts.hideFromNav);
      flag("hiddenHideSearch", opts.hideFromSearch);
      flag("hiddenHideRightMenu", opts.hideFromLocalNav);
      if (opts.synopsis !== undefined) fd.append("Synopsis1", opts.synopsis);
      if (opts.title2 !== undefined) fd.append("Title2", opts.title2);
      if (opts.subTitle !== undefined) fd.append("SubTitle", opts.subTitle);
      const dt = (v) => (v === "" ? "" : new Date(v).toISOString().replace(/[tz]/gi, " ").trim());
      if (opts.publishDate !== undefined) fd.append("PublishDate", dt(opts.publishDate));
      if (opts.expireDate !== undefined) fd.append("ExpireDate", dt(opts.expireDate));
      fd.append("hiddenPublish", opts.publish ? "AsIs" : "");
      const { text: r } = await text(PUB + "/savechangesresponse.asp?Act=Update&AID=" + id, { method: "POST", body: fd });
      const result = /vSaveChangesComplete\(\)/.test(r) ? "published" : /setPending\(\)/.test(r) ? "draft" : "unknown";
      if (result === "unknown") throw new Error("SAVE_UNCONFIRMED");
      return { id, result, published: await this.isPublished(id) };
    },
    publishPage(id, opts) { return this.savePage(id, { ...(opts || {}), publish: true }); },
    revertToVersion(id, versionId) { return json(API + "/pages/" + id + "/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "version-id": Number(versionId) }) }); },
    async duplicatePage(id, nodeType, targetParentId) {
      const body = "Sourcearticleid=" + id + "&include_children=false&item_type=" + nodeType + "&language=en&target_AID=" + (targetParentId != null ? targetParentId : id);
      const { text: t } = await text(PUB + "/TemplateGallery.asp", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const m = t.trim().match(/^(\d+),/);
      if (!m) throw new Error("DUPLICATE_FAILED: " + t.trim().slice(0, 80));
      return Number(m[1]);
    },
    async movePage(id, newParentId) {
      const b = new URLSearchParams({ Act: "Move", AID: String(id), IID: "", BatchIID: "", Asoc: "", ArticleID: "", parent_IID: "", ToAID: String(newParentId), getbacktosub: "false", getPrefix: "" });
      await text(PUB + "/Confirm.asp", { method: "POST", body: b });
      const p = await json(API + "/pages/" + id);
      if (p["parent-article-id"] !== Number(newParentId)) throw new Error("MOVE_UNCONFIRMED");
      return p;
    },
    async siblingOrder(anySiblingId) {
      const { text: t } = await text(PUB + "/SortItem.asp?preview=sitecontrol&Aid=" + anySiblingId);
      const d = new DOMParser().parseFromString(t, "text/html");
      return [...d.querySelectorAll("#List1 option")].map((o, i) => ({ position: i + 1, id: Number(o.value), title: o.textContent.trim() }));
    },
    async reorderPage(id, action, position) {
      const order = await this.siblingOrder(id);
      const cur = order.find((o) => o.id === Number(id));
      const newpos = position != null ? position : { up: cur.position - 1, down: cur.position + 1, toTop: 1, toBottom: order.length + 1 }[action];
      await text(PUB + "/sortItem.asp?AID=" + id + "&ACT=" + action + "&isIcon=&asoc=&newposition=" + newpos);
      return this.siblingOrder(id);
    },
    async deletePage(id, parentId) {
      await text(PUB + "/Confirm.asp?Act=StartDelete&preview=sitecontrol&Aid=" + id);
      await text(PUB + "/Confirm.asp?Act=EndDelete&AID=" + id);
      const stillLive = await this.isPublished(id).catch(() => false);
      const inTree = parentId ? (await this.children(parentId)).some((c) => c.id === Number(id)) : null;
      return { id, deleted: !stillLive && inTree !== true, stillPublished: stillLive, stillInTree: inTree };
    },
    async uploadImageFromUrl(url, folderId, name) {
      const r = await fetch(url); if (!r.ok) throw new Error("FETCH_IMAGE_FAILED_" + r.status);
      const blob = await r.blob();
      const fd = new FormData();
      fd.append("file1", blob, name || url.split("/").pop().split("?")[0] || "image.jpg");
      if (folderId) fd.append("parent_IID", String(folderId));
      const { text: t } = await text("/platform/global/imagebrowser/uploadimage.asp?Type=IMG&Act=Upload&c=sitecontrol&fullSize=true", { method: "POST", body: fd });
      const m = t.match(/identity='(\d+)'/);
      if (!m) throw new Error("UPLOAD_FAILED");
      return Number(m[1]);
    },
    async setPageImage(pageId, imageId, type) {
      await fetch(API + "/pages/" + pageId + "/settings/images", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "image-id": Number(imageId), type: type === "icon" ? 0 : 1 }) });
      const s = await json(API + "/pages/" + pageId + "/settings");
      const path = type === "icon" ? s.icon : s.hero;
      const st = await this.status();
      return { settings: s, imageUrl: path && st.publicDomain ? "https://" + st.publicDomain + "/media/images/" + path : null };
    },
    async deleteImage(imageId) {
      await text(PUB + "/Confirm.asp?Act=StartDelete&preview=sitecontrol&IID=" + imageId);
      await text(PUB + "/Confirm.asp?Act=EndDelete&IID=" + imageId + "&Asoc=&ImageID=&isIcon=");
      return { imageId, requested: true };
    },
    async listEvents(date) {
      const { text: t } = await text(ADMIN + "/calendar/list.asp?tDate=" + encodeURIComponent(date));
      const out = []; const re = /class="cal_event_title">\s*<b>([^<]*)<\/b>[\s\S]*?nowrap valign="top">([^<]*)[\s\S]*?newevent\.asp\?EID=(\d+)&act=edit/gi;
      let m; while ((m = re.exec(t))) out.push({ eventId: Number(m[3]), title: m[1].trim(), time: m[2].trim() });
      return out;
    },
    async getEventForm(eventId) {
      const r = await text(eventId ? ADMIN + "/calendar/newevent.asp?EID=" + eventId + "&act=edit" : ADMIN + "/calendar/newEvent.asp?tDate=1/1/2030");
      const d = new DOMParser().parseFromString(r.text, "text/html");
      const p = new URLSearchParams(); const skip = new Set(["searchword", "scope"]);
      d.querySelectorAll("input[name], select[name], textarea[name]").forEach((el) => {
        if (skip.has(el.name) || el.disabled) return;
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (["button", "submit", "image", "file"].includes(type)) return;
        if ((type === "checkbox" || type === "radio") && !el.checked) return;
        if (el.tagName === "SELECT") { const o = el.querySelector("option[selected]") || el.options[0]; p.append(el.name, o ? o.value : ""); return; }
        p.append(el.name, el.tagName === "TEXTAREA" ? el.textContent : el.getAttribute("value") || "");
      });
      if (!p.has("act")) throw new Error("EVENT_FORM_NOT_FOUND");
      return p;
    },
    async saveEvent(ev, eventId) {
      const p = await this.getEventForm(eventId);
      const t12 = (s) => { const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i); if (!m) throw new Error("BAD_TIME_" + s); return [m[1].padStart(2, "0"), m[2], m[3].toUpperCase()]; };
      if (ev.title !== undefined) { p.set("title1", ev.title); if (ev.longTitle === undefined) p.set("title2", ev.title); }
      if (ev.longTitle !== undefined) p.set("title2", ev.longTitle);
      if (!p.get("title1")) throw new Error("EVENT_TITLE_REQUIRED");
      if (!eventId && !ev.date) throw new Error("EVENT_DATE_REQUIRED");
      if (ev.date !== undefined) p.set("eDate1", ev.date);
      if (ev.description !== undefined) p.set("eDesc", ev.description);
      if (ev.linkUrl !== undefined) p.set("eLinkURL", ev.linkUrl);
      if (ev.displayPriority !== undefined) p.set("displayPriority", String(ev.displayPriority));
      if (ev.eType !== undefined) p.set("eType", String(ev.eType));
      if (ev.allDay) p.set("eAllDay", "1"); else if (ev.allDay === false) p.delete("eAllDay");
      if (ev.start) { const [h, mi, ap] = t12(ev.start); p.set("txtHour1", h); p.set("txtMin1", mi); p.set("txtAmPm1", ap); }
      if (ev.end) { const [h, mi, ap] = t12(ev.end); p.set("txtHour2", h); p.set("txtMin2", mi); p.set("txtAmPm2", ap); p.delete("noEnd"); } else if (ev.end === null) p.set("noEnd", "1");
      p.set("submitted", "true"); p.set("act", eventId ? "update" : "create"); if (eventId) p.set("EID", String(eventId));
      await text(ADMIN + "/calendar/newEvent.asp", { method: "POST", body: p });
      const date = p.get("eDate1"); const shown = p.get("title2") || p.get("title1"); const onDate = await this.listEvents(date);
      if (eventId) { const now = await this.getEventForm(eventId); return { eventId: Number(eventId), date, saved: now.get("title1") === p.get("title1") && now.get("eDate1") === date, listed: onDate.some((e) => e.eventId === Number(eventId)) }; }
      const matches = onDate.filter((e) => e.title === shown);
      return { date, eventId: matches.length === 1 ? matches[0].eventId : null, matches };
    },
    createEvent(ev) { return this.saveEvent(ev, null); },
    updateEvent(eventId, ev) { return this.saveEvent(ev, eventId); },
    async deleteEvent(eventId, date) {
      await text(ADMIN + "/calendar/newevent.asp?EID=" + eventId + "&act=enddelete&ref=");
      const still = date ? (await this.listEvents(date)).some((e) => e.eventId === Number(eventId)) : null;
      return { eventId, deleted: still === null ? "unverified" : !still };
    },
    listForms() { return json(API + "/forms"); },
    formSubmissions(formId) { return json(API + "/forms/" + formId + "/submissions"); },
    contacts() { return json(API + "/sites/contacts"); },
  };
  window.CO = CO;
  return "ok";
}
