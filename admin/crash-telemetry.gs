/**
 * nxs crash telemetry — Google Apps Script backend.
 *
 * ONE script does both jobs:
 *   • doPost(e)  — receives crash reports from the app, appends to the Sheet.
 *   • doGet(e)   — serves the admin dashboard (login-gated) that reads the Sheet.
 *
 * The whole thing lives in YOUR Google account, writes to YOUR Sheet. No third
 * party. When you deploy with "Execute as: Me" + "Who has access: Only myself",
 * opening the dashboard URL requires YOUR Google login — that's the admin auth,
 * for free. The app's POSTs still work because they carry the shared secret,
 * not a Google login (the app can't log in as you).
 *
 * ── One-time setup ───────────────────────────────────────────────────────────
 *  1. Create a Google Sheet. Note its ID (the long string in its URL between
 *     /d/ and /edit).
 *  2. Extensions → Apps Script. Delete the sample, paste this whole file.
 *  3. Set SHEET_ID and SHARED_SECRET below. Use the SAME secret you put in
 *     src-tauri/src/commands/telemetry.rs (SHARED_SECRET constant).
 *  4. Deploy → New deployment → type "Web app".
 *       Execute as:      Me
 *       Who has access:  Only myself   ← this is what gates the dashboard
 *     Copy the Web App URL (…/exec).
 *  5. Paste that URL into telemetry.rs's ENDPOINT constant, rebuild the app.
 *  6. Open the same URL in your browser → the admin dashboard (you'll be asked
 *     to authorize the script on first run).
 *
 * Note: "Only myself" means the app's POST would ALSO require login — which it
 * can't do. That's fine: Apps Script still executes doPost for anonymous
 * callers as long as the deployment allows it. If your POSTs get 401/redirected
 * to a login page, redeploy with "Who has access: Anyone" and rely on the
 * SHARED_SECRET for write auth; the dashboard's doGet then checks the secret in
 * the URL instead (see ADMIN_KEY below). Both modes are supported here.
 */

// ── Configuration ────────────────────────────────────────────────────────────
var SHEET_ID = 'REPLACE_WITH_YOUR_SHEET_ID';
var SHARED_SECRET = 'REPLACE_WITH_YOUR_SHARED_SECRET'; // must match telemetry.rs
var SHEET_NAME = 'crashes';

// If you deploy with "Who has access: Anyone" (needed when app POSTs get
// bounced to a Google login), the dashboard can't rely on Google auth. In that
// case set an ADMIN_KEY and open the dashboard as  …/exec?key=YOUR_ADMIN_KEY .
// Leave empty when deploying "Only myself" (Google login is the gate).
var ADMIN_KEY = '';

// Header row written once to a fresh sheet.
var HEADERS = ['received_at', 'ts', 'kind', 'app_version', 'os', 'arch', 'install_id', 'message', 'url', 'stack'];

function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ── Ingestion: the app POSTs here ────────────────────────────────────────────
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.secret !== SHARED_SECRET) {
      return json_({ ok: false, error: 'bad secret' });
    }
    if (body.type !== 'crash' || !body.report) {
      return json_({ ok: false, error: 'bad payload' });
    }
    var r = body.report;
    var sheet = getSheet_();
    var values = [
      new Date().toISOString(),         // received_at (ISO string, not a Date object)
      String(r.ts || ''),               // ts (client epoch seconds) — kept as text
      String(r.kind || '').slice(0, 60),
      String(r.app_version || '').slice(0, 40),
      String(r.os || '').slice(0, 40),
      String(r.arch || '').slice(0, 40),
      String(r.install_id || '').slice(0, 80),
      String(r.message || '').slice(0, 2000),
      String(r.url || '').slice(0, 500),
      String(r.stack || '').slice(0, 8000),
    ];
    // Force the target row to PLAIN TEXT format BEFORE writing, then setValues.
    // Otherwise Google Sheets auto-coerces values like "0.1.18" into dates (in
    // FR/EU locales especially), which would corrupt app_version and break the
    // version filter in the dashboard. appendRow can't do this ordering, so we
    // compute the row index and write with setValues after formatting.
    var row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, values.length).setNumberFormat('@'); // '@' = plain text
    sheet.getRange(row, 1, 1, values.length).setValues([values]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Admin dashboard: you GET here ────────────────────────────────────────────
function doGet(e) {
  // When deployed "Anyone", gate on the admin key in the query string.
  if (ADMIN_KEY) {
    var key = (e && e.parameter && e.parameter.key) || '';
    if (key !== ADMIN_KEY) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Unauthorized.</p>');
    }
  }
  // (When deployed "Only myself", Google already required your login to reach
  // this point, so no extra check is needed.)

  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  var rows = values.slice(1); // drop header
  // Newest first.
  rows.reverse();
  // Cap what we render so a huge sheet doesn't make the page enormous.
  rows = rows.slice(0, 500);

  var data = rows.map(function (row) {
    return {
      received_at: row[0] ? new Date(row[0]).toISOString() : '',
      ts: row[1],
      kind: row[2],
      app_version: row[3],
      os: row[4],
      arch: row[5],
      install_id: row[6],
      message: row[7],
      url: row[8],
      stack: row[9],
    };
  });

  var tmpl = HtmlService.createTemplate(DASHBOARD_HTML_);
  // Escape "<" so a "</script>" inside a crash message/stack can't break out of
  // the <script> tag we embed this into. Everything else JSON.stringify handles.
  tmpl.dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
  return tmpl.evaluate()
    .setTitle('nxs — crash reports')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Dashboard HTML+JS as a string template. Renders crash cards with filters by
// version / os / kind and a free-text search across message+stack.
var DASHBOARD_HTML_ = ''
+ '<!doctype html><html><head><meta charset="utf-8"><style>'
+ ':root{color-scheme:dark}'
+ 'body{margin:0;background:#141416;color:#e6e6e8;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}'
+ 'header{position:sticky;top:0;background:#1c1c1f;border-bottom:1px solid #2a2a2e;padding:12px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}'
+ 'h1{font-size:15px;margin:0 12px 0 0;font-weight:600}'
+ '.count{color:#8a8a92;font-size:12px}'
+ 'input,select{background:#141416;border:1px solid #2a2a2e;color:#e6e6e8;border-radius:6px;padding:6px 8px;font-size:12px}'
+ 'input#q{min-width:220px;flex:1}'
+ 'main{padding:16px;display:flex;flex-direction:column;gap:10px;max-width:1100px;margin:0 auto}'
+ '.card{background:#1c1c1f;border:1px solid #2a2a2e;border-radius:8px;padding:12px 14px}'
+ '.card .top{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}'
+ '.tag{font-size:11px;padding:2px 7px;border-radius:999px;background:#26262b;color:#c7c7cf}'
+ '.tag.kind{background:#3a1d1d;color:#ff9d9d}'
+ '.tag.ver{background:#1d2a3a;color:#9dc7ff}'
+ '.when{color:#8a8a92;font-size:11px;margin-left:auto}'
+ '.msg{font-weight:600;color:#fff;word-break:break-word}'
+ '.url{color:#8a8a92;font-size:11px;font-family:ui-monospace,monospace;margin-top:2px;word-break:break-all}'
+ '.stack{margin-top:8px;white-space:pre-wrap;font:11px/1.45 ui-monospace,monospace;color:#b8b8c0;background:#141416;border:1px solid #2a2a2e;border-radius:6px;padding:8px;max-height:220px;overflow:auto;display:none}'
+ '.card.open .stack{display:block}'
+ '.toggle{cursor:pointer;color:#7aa2ff;font-size:11px;margin-top:6px;user-select:none}'
+ '.empty{color:#8a8a92;text-align:center;padding:40px}'
+ '</style></head><body>'
+ '<header>'
+ '<h1>nxs crash reports</h1>'
+ '<span class="count" id="count"></span>'
+ '<input id="q" placeholder="Search message / stack…">'
+ '<select id="fver"><option value="">All versions</option></select>'
+ '<select id="fos"><option value="">All OS</option></select>'
+ '<select id="fkind"><option value="">All kinds</option></select>'
+ '</header><main id="list"></main>'
+ '<script>'
+ 'var DATA = <?!= dataJson ?>;'
+ 'function uniq(k){var s={};DATA.forEach(function(d){if(d[k])s[d[k]]=1});return Object.keys(s).sort()}'
+ 'function fill(id,vals){var el=document.getElementById(id);vals.forEach(function(v){var o=document.createElement("option");o.value=v;o.textContent=v;el.appendChild(o)})}'
+ 'fill("fver",uniq("app_version"));fill("fos",uniq("os"));fill("fkind",uniq("kind"));'
+ 'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})}'
+ 'function render(){'
+ 'var q=document.getElementById("q").value.toLowerCase();'
+ 'var fv=document.getElementById("fver").value,fo=document.getElementById("fos").value,fk=document.getElementById("fkind").value;'
+ 'var list=document.getElementById("list");list.innerHTML="";'
+ 'var n=0;'
+ 'DATA.forEach(function(d){'
+ 'if(fv&&d.app_version!==fv)return;if(fo&&d.os!==fo)return;if(fk&&d.kind!==fk)return;'
+ 'if(q&&(String(d.message)+String(d.stack)).toLowerCase().indexOf(q)<0)return;'
+ 'n++;'
+ 'var c=document.createElement("div");c.className="card";'
+ 'var when=d.received_at?new Date(d.received_at).toLocaleString():"";'
+ 'c.innerHTML='
+ '"<div class=\\"top\\">"'
+ '+"<span class=\\"tag kind\\">"+esc(d.kind)+"</span>"'
+ '+"<span class=\\"tag ver\\">"+esc(d.app_version)+"</span>"'
+ '+"<span class=\\"tag\\">"+esc(d.os)+" "+esc(d.arch)+"</span>"'
+ '+"<span class=\\"when\\">"+esc(when)+"</span></div>"'
+ '+"<div class=\\"msg\\">"+esc(d.message)+"</div>"'
+ '+(d.url?"<div class=\\"url\\">"+esc(d.url)+"</div>":"")'
+ '+(d.stack?"<div class=\\"toggle\\">Show stack ▾</div><pre class=\\"stack\\">"+esc(d.stack)+"</pre>":"");'
+ 'var t=c.querySelector(".toggle");if(t)t.onclick=function(){c.classList.toggle("open");t.textContent=c.classList.contains("open")?"Hide stack ▴":"Show stack ▾"};'
+ 'list.appendChild(c)});'
+ 'document.getElementById("count").textContent=n+" / "+DATA.length+" reports";'
+ 'if(n===0){list.innerHTML="<div class=\\"empty\\">No crash reports match.</div>"}'
+ '}'
+ '["q","fver","fos","fkind"].forEach(function(id){document.getElementById(id).addEventListener("input",render)});'
+ 'render();'
+ '</script></body></html>';
