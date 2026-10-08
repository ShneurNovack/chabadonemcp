# chabadonemcp

ChabadOne Site Control as an MCP connector, running on a Cloudflare Worker.

Reads go straight to the `/api/v2` JSON API with a cached session cookie (no browser). Writes and the legacy `.asp` reads (tree, calendar, uploads) run in a Cloudflare Browser Rendering session with the cached cookie injected, so they skip the password form. The full password login runs only when the cookie has gone stale, detected from a 401. Browser launches, the scarce and billable resource, are used as little as possible.

## Transport

MCP over HTTP (POST JSON-RPC). Add it in Claude as a custom connector:

```
https://chabadonemcp.shneur.workers.dev/?bearer_token=<BEARER_TOKEN>
```

## Secrets (set in the Cloudflare dashboard or `wrangler secret put`)

- `CHABADONE_EMAIL`
- `CHABADONE_PASSWORD`
- `BEARER_TOKEN`

## Tools

- Reads (API, no browser): `chabadone_status`, `get_page`, `get_page_versions`, `revert_page`, `set_page_image`, `list_forms`, `get_form_submissions`, `get_contacts`
- Reads (browser): `is_published`, `get_tree`, `find_pages`, `list_sites`
- Page writes (browser): `create_page`, `update_page`, `publish_page`, `delete_page`, `move_page`, `reorder_page`, `duplicate_page`
- Media (browser): `upload_image_from_url`, `delete_image`
- Calendar (browser): `list_events`, `create_event`, `update_event`, `delete_event`
- Reference: `list_settings_sections`

Default site is southsidechabad.com (mosad 6649); pass `site` to target another (test site 12599). Writes publish by default, matching how Rory uses ChabadOne.

## Endpoint map

### Two auth systems
- `/api/v2/chabadone/sites/...` (JSON): cookie auth, not Cloudflare-challenged. Reads + a few writes (version revert, image link).
- Legacy `.asp` under `/platform/...`: cookie auth, Cloudflare-challenged for non-browser clients. All page/calendar/upload writes and the nav tree live here, so they need a real browser.

### Calendar (all `/platform/sitecontrol/admin/calendar/`)
- Views: `month.asp`, `week.asp`, `day.asp`, `year.asp`, `list.asp` (`?tDate=M/D/YYYY`; `&mode=j` for the Jewish view)
- Create: POST `newEvent.asp` `act=create`; Update: POST `newEvent.asp` `act=update&EID=`; Delete: GET `newevent.asp?EID=&act=enddelete&ref=`; Edit form: `newevent.asp?EID=&act=edit`; Copy: `...&act=copy`
- Bulk add: `month.asp?add_events=true`, dialog `add_event_layer.asp`
- Categories: `categories.asp` (list), `?v=add` (form), POST `categories.asp` `v=save` with `keyword,eventType,displayPriority,EventIcon,iconName,EventDirectory,Color`
- Recurring exceptions: `customexclusions.asp?EID=<recurring event id>`
- Calendar settings wizard: `wizards/default.asp?wizaid=319883`
- Event types (`eType`): 8123 Prayer/Minyan, 8124 Class/Lecture, 8125 Children, 8127 Passover Seder, 8810 Women's Event, 11179 3 Tammuz Event, blank = Other
- Display priority: 1 all views, 2 all except home page, 3 day/week only
- Public ICS export: `/calendar/view/eventexport.asp?eid=&mid=`

### Settings
Framed wizards loaded at `/platform/sitecontrol/admin/wizards/default.asp?wizaid={id}` (or `/article.asp?aid={id}` in the admin frame). Sections and ids: General Settings 309262, Virtual Paths 309264, Site Alerts & Announcements 309361, Quick Links 309358, Site Template & Theme 309263, Site Branding 393260, Donation Page 309266, Social Integration 1538260, Language & Regional 591294, Email Subscriptions 309268, Passover 309329, Ask the Rabbi 309270, Contact Us Page 309269, About Us Page 309267, Location 309261, Site Search 309271, Kaddish Services 390611, Password Protected Sections 309866, ChabadOne CRM 2781961, Privacy Policy 4031583, Program Registration 4740812, Mobile Site Settings 1990728, Advertisement Sidebar 490797, JLI Link 309272, Kids Zone 442536. Each wizard's save is a per-wizard form; automate a specific one on request.
