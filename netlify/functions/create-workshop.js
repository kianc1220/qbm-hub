// netlify/functions/create-workshop.js
// DJI Queensbay – Auto-create workshop from poster image
// Requires env vars: ANTHROPIC_API_KEY, NETLIFY_ACCESS_TOKEN, NETLIFY_SITE_ID, GOOGLE_SCRIPT_URL

const crypto = require('crypto');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ─── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Derive site URL from request so this works on any Netlify deployment
  const host = event.headers['host'] || event.headers['x-forwarded-host'] || '';
  const SITE_URL = process.env.SITE_URL || `https://${host}`;

  try {
    const { imageData, imageType = 'image/jpeg' } = JSON.parse(event.body || '{}');
    if (!imageData) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No image data provided' }) };

    const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;
    const siteId = process.env.NETLIFY_SITE_ID;

    // Step 1 (parallel): extract event details + get existing deploy SHAs + fetch current workshop index
    const [workshopData, existingFileShas, currentIndexHtml] = await Promise.all([
      extractEventDetails(imageData, imageType),
      getDeployFileShas(netlifyToken, siteId),
      fetch(`${SITE_URL}/workshop/index.html`).then(r => r.text())
    ]);

    const { slug, name, date, dateShort, time, venue, contact } = workshopData;

    // Step 2: Call Google Apps Script to auto-create Google Form + linked Sheet
    const googleData = await createGoogleFormAndSheet({ name, date, time, venue, contact, slug });

    const formActionUrl = googleData?.formActionUrl || 'https://docs.google.com/forms/d/e/1FAIpQLSdfePHe8IjdqwcwK9If52RTPUaenttr3XTkomqzJcJ1P9gNJQ/formResponse';
    const entryIds = googleData?.entryIds || null;
    const sheetUrl = googleData?.sheetUrl || null;

    // Generate HTML files
    const formHtml = buildFormHtml({ name, date, dateShort, time, venue, contact, slug, formActionUrl, entryIds });
    const dashboardHtml = buildDashboardHtml({ name, date, time, venue, contact, slug, sheetUrl, siteUrl: SITE_URL });
    const updatedIndexHtml = injectWorkshopCard(currentIndexHtml, { name, date, time, venue, slug });

    // Deploy to Netlify
    const newFiles = {
      '/workshop/index.html': updatedIndexHtml,
      [`/workshop/form-${slug}.html`]: formHtml,
      [`/workshop/dashboard-${slug}.html`]: dashboardHtml
    };

    const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

    const fileDigests = { ...existingFileShas };
    for (const [path, content] of Object.entries(newFiles)) {
      fileDigests[path] = sha1(content);
    }

    const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: fileDigests, async: false })
    });
    const deploy = await deployRes.json();

    if (deploy.required && deploy.required.length > 0) {
      const required = new Set(deploy.required);
      const uploads = Object.entries(newFiles)
        .filter(([, content]) => required.has(sha1(content)))
        .map(([path, content]) =>
          fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files${path}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/octet-stream' },
            body: content
          })
        );
      await Promise.all(uploads);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        name, date, slug,
        formUrl: `${SITE_URL}/workshop/form-${slug}.html`,
        dashboardUrl: `${SITE_URL}/workshop/dashboard-${slug}.html`,
        sheetUrl: sheetUrl || null,
        hubUrl: `${SITE_URL}/workshop/`,
        deployId: deploy.id
      })
    };
  } catch (err) {
    console.error('create-workshop error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
};

// ─── Extract event details from image via Anthropic ───────────────────────────
async function extractEventDetails(imageData, imageType) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: imageType, data: imageData }
          },
          {
            type: 'text',
            text: `Read this workshop poster and return ONLY a JSON object (no markdown, no explanation) with these fields:
{
  "name": "Full workshop name",
  "slug": "url-slug-name-monthDD (e.g. drone-workshop-jul15)",
  "date": "Full date e.g. 15 July 2026 (Wednesday)",
  "dateShort": "e.g. Jul 15",
  "time": "e.g. 4:00 PM – 5:00 PM",
  "venue": "Full venue name",
  "contact": "Phone number"
}
If any field is not visible in the poster, use a sensible placeholder.`
          }
        ]
      }]
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse event details from AI response');
  return JSON.parse(match[0]);
}

// ─── Call Google Apps Script to create Form + Sheet ───────────────────────────
async function createGoogleFormAndSheet({ name, date, time, venue, contact, slug }) {
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (!scriptUrl) return null;
  try {
    const res = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, date, time, venue, contact, slug }),
      redirect: 'follow'
    });
    const data = await res.json();
    return data.success ? data : null;
  } catch (err) {
    console.error('Google Apps Script error:', err.message);
    return null;
  }
}

// ─── Get SHA1 map of files in latest deploy ──────────────────────────────────
async function getDeployFileShas(token, siteId) {
  try {
    const deploysRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys?per_page=1&state=ready`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const deploys = await deploysRes.json();
    if (!deploys.length) return {};

    const filesRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deploys[0].id}/files`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const files = await filesRes.json();
    const map = {};
    for (const f of files) map[f.path] = f.sha;
    return map;
  } catch {
    return {};
  }
}

// ─── Inject new workshop card into workshop/index.html ────────────────────────
function injectWorkshopCard(html, { name, date, time, venue, slug }) {
  const card = `
    <!-- Workshop: ${slug} -->
    <div class="workshop-card">
      <div class="accent"></div>
      <div class="body">
        <div class="meta">
          <span class="badge upcoming">Registration Open</span>
        </div>
        <h2>${name}</h2>
        <div class="info">
          <span>📅 ${date}</span>
          <span>⏰ ${time}</span>
          <span>📍 ${venue}</span>
        </div>
        <div class="stats">
          <div class="stat-pill">👥 <strong>0</strong> Registrants</div>
          <div class="stat-pill">🟢 <strong>Open</strong></div>
        </div>
        <div class="actions">
          <a href="/workshop/dashboard-${slug}.html" class="btn btn-gold">📊 View Dashboard</a>
          <a href="/workshop/form-${slug}.html" target="_blank" class="btn btn-primary">📝 Registration Form</a>
        </div>
      </div>
    </div>
`;
  return html.replace('<!-- Placeholder for next workshop -->', card + '\n    <!-- Placeholder for next workshop -->');
}

// ─── Build Registration Form HTML ─────────────────────────────────────────────
function buildFormHtml({ name, date, dateShort, time, venue, contact, slug, formActionUrl, entryIds }) {
  const e = entryIds || {};
  const EN = (field, fallback) => `entry.${e[field] || fallback}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name} – Registration</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; min-height: 100vh; padding: 16px 12px 60px; }
    .page-wrap { max-width: 640px; margin: 0 auto; }
    .banner { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%); border-radius: 12px 12px 0 0; padding: 28px 20px 20px; color: #fff; position: relative; overflow: hidden; }
    .banner::before { content: ''; position: absolute; top: -40px; right: -40px; width: 160px; height: 160px; background: rgba(230,160,20,.15); border-radius: 50%; }
    .banner .dji-logo { font-size: 12px; font-weight: 800; letter-spacing: 4px; color: #e6a014; margin-bottom: 10px; display: block; }
    .banner h1 { font-size: clamp(18px,4vw,24px); font-weight: 800; line-height: 1.2; }
    .banner h1 span { color: #e6a014; }
    .banner p { font-size: 13px; color: rgba(255,255,255,.7); margin-top: 6px; }
    .info-bar { background: #e6a014; padding: 12px 20px; display: flex; flex-wrap: wrap; gap: 10px; }
    .info-bar .info-item { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #1a1a2e; }
    .features { background: #fff8ec; padding: 10px 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; border-bottom: 1px solid #fde8a0; }
    .features .feat { font-size: 11px; color: #7a5a00; display: flex; align-items: center; gap: 5px; }
    .card { background: #fff; border-radius: 0 0 12px 12px; padding: 20px; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
    .notice { background: #fff8ec; border: 1px solid #fde8a0; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #7a5a00; margin-bottom: 20px; }
    .section-label { font-size: 10px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: #e6a014; margin: 20px 0 12px; }
    .form-group { margin-bottom: 16px; }
    label.field-label { display: block; font-size: 13px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px; }
    label.field-label .req { color: #e6a014; }
    input[type="text"], input[type="email"], input[type="tel"], textarea {
      width: 100%; padding: 12px 14px; border: 1.5px solid #e0e0e0;
      border-radius: 8px; font-size: 16px; color: #333; background: #fafafa;
      -webkit-appearance: none; transition: border-color .2s;
    }
    input:focus, textarea:focus { outline: none; border-color: #e6a014; background: #fff; }
    textarea { min-height: 90px; resize: vertical; }
    .options-list { display: flex; flex-direction: column; gap: 8px; }
    .option-item { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border: 1.5px solid #e8e8e8; border-radius: 8px; cursor: pointer; min-height: 48px; -webkit-tap-highlight-color: transparent; }
    .option-item.checked { border-color: #e6a014; background: #fff8ec; }
    .option-item input { accent-color: #e6a014; width: 16px; height: 16px; flex-shrink: 0; }
    .checkbox-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    @media (max-width: 459px) { .checkbox-grid { grid-template-columns: 1fr; } }
    .btn-submit { width: 100%; padding: 15px; background: #e6a014; color: #1a1a2e; font-size: 15px; font-weight: 800; border: none; border-radius: 10px; cursor: pointer; margin-top: 8px; }
    .btn-submit:hover { background: #d4910f; }
    .footer-note { text-align: center; font-size: 11px; color: #aaa; margin-top: 14px; }
    .success-screen { display: none; text-align: center; padding: 40px 20px; }
    .success-screen .checkmark { font-size: 52px; margin-bottom: 14px; }
    .success-screen h2 { font-size: 22px; font-weight: 800; color: #1a1a2e; margin-bottom: 10px; }
    .success-screen p { font-size: 14px; color: #555; line-height: 1.7; }
    @media (min-width: 520px) { .btn-submit { width: auto; padding: 13px 36px; } }
  </style>
</head>
<body>
<div class="page-wrap">
  <div class="banner">
    <span class="dji-logo">D J I</span>
    <h1>${name}</h1>
    <p>Hands-On Experience · Beginners Welcome</p>
  </div>
  <div class="info-bar">
    <div class="info-item">📅 ${date}</div>
    <div class="info-item">⏰ ${time}</div>
    <div class="info-item">📍 ${venue}</div>
  </div>
  <div class="features">
    <div class="feat">✅ Free Registration</div>
    <div class="feat">✅ Exclusive Discount for Attendees</div>
    <div class="feat">✅ Guided by Professional DJI Instructor</div>
    <div class="feat">✅ Beginners Welcome</div>
  </div>

  <iframe name="gform_target" style="display:none"></iframe>

  <div class="card">
    <div class="notice">⚠️ <strong>One registration per attendee.</strong> Please fill in your own details accurately.</div>

    <form id="regForm"
          action="${formActionUrl}"
          method="POST"
          target="gform_target"
          novalidate>

      <div class="section-label">Personal Details</div>
      <div class="form-group">
        <label class="field-label">Full Name <span class="req">*</span></label>
        <input type="text" name="${EN('name','209527932')}" placeholder="e.g. Ahmad bin Khalid" required />
      </div>
      <div class="form-group">
        <label class="field-label">Phone Number <span class="req">*</span></label>
        <input type="tel" name="${EN('phone','1387483835')}" placeholder="e.g. 012-345 6789" required />
      </div>
      <div class="form-group">
        <label class="field-label">Email Address <span class="req">*</span></label>
        <input type="email" name="${EN('email','1027429684')}" placeholder="e.g. you@email.com" required />
      </div>

      <div class="section-label">About You</div>
      <div class="form-group">
        <label class="field-label">Age Group <span class="req">*</span></label>
        <div class="options-list">
          <label class="option-item"><input type="radio" name="${EN('age','1270537140')}" value="Under 18" required /> Under 18</label>
          <label class="option-item"><input type="radio" name="${EN('age','1270537140')}" value="18-25" /> 18 – 25</label>
          <label class="option-item"><input type="radio" name="${EN('age','1270537140')}" value="26-35" /> 26 – 35</label>
          <label class="option-item"><input type="radio" name="${EN('age','1270537140')}" value="36 and above" /> 36 and above</label>
        </div>
      </div>
      <div class="form-group">
        <label class="field-label">Drone Flying Experience Level <span class="req">*</span></label>
        <div class="options-list">
          <label class="option-item"><input type="radio" name="${EN('experience','1993393856')}" value="Complete Beginner" required /> Complete Beginner</label>
          <label class="option-item"><input type="radio" name="${EN('experience','1993393856')}" value="Some Experience" /> Some Experience</label>
          <label class="option-item"><input type="radio" name="${EN('experience','1993393856')}" value="Intermediate" /> Intermediate</label>
          <label class="option-item"><input type="radio" name="${EN('experience','1993393856')}" value="Advanced" /> Advanced</label>
        </div>
      </div>

      <div class="section-label">DJI Products</div>
      <div class="form-group">
        <label class="field-label">Which DJI products do you own?</label>
        <div class="checkbox-grid">
          <label class="option-item"><input type="checkbox" name="${EN('products','1178857045')}" value="DJI Drones" /> DJI Drones</label>
          <label class="option-item"><input type="checkbox" name="${EN('products','1178857045')}" value="DJI Mini Series" /> DJI Mini Series</label>
          <label class="option-item"><input type="checkbox" name="${EN('products','1178857045')}" value="DJI Ronin Series" /> DJI Ronin Series</label>
          <label class="option-item"><input type="checkbox" name="${EN('products','1178857045')}" value="DJI Osmo Mobile" /> DJI Osmo Mobile</label>
          <label class="option-item"><input type="checkbox" name="${EN('products','1178857045')}" value="DJI Osmo Pocket" /> DJI Osmo Pocket</label>
          <label class="option-item"><input type="checkbox" name="${EN('products','1178857045')}" value="DJI Action Series" /> DJI Action Series</label>
          <label class="option-item"><input type="checkbox" name="${EN('products','1178857045')}" value="Don't own any" /> Don't own any</label>
        </div>
      </div>

      <div class="section-label">How You Heard About Us</div>
      <div class="form-group">
        <label class="field-label">Where did you hear about this workshop? <span class="req">*</span></label>
        <div class="options-list">
          <label class="option-item"><input type="radio" name="${EN('heard','1820079204')}" value="Social Media" required /> Social Media</label>
          <label class="option-item"><input type="radio" name="${EN('heard','1820079204')}" value="WhatsApp Group" /> WhatsApp Group</label>
          <label class="option-item"><input type="radio" name="${EN('heard','1820079204')}" value="Staff Recommendation" /> Staff Recommendation</label>
          <label class="option-item"><input type="radio" name="${EN('heard','1820079204')}" value="Friend or Family" /> Friend or Family</label>
          <label class="option-item"><input type="radio" name="${EN('heard','1820079204')}" value="Walk-In or Poster at Queensbay" /> Walk-In or Poster at Queensbay</label>
          <label class="option-item"><input type="radio" name="${EN('heard','1820079204')}" value="Other" /> Other</label>
        </div>
      </div>

      <div class="section-label">Anything Else?</div>
      <div class="form-group">
        <label class="field-label">Anything specific you would like to learn or ask?</label>
        <textarea name="${EN('specific','494757212')}" placeholder="Optional — let us know if you have any questions or topics you'd like covered!"></textarea>
      </div>

      <button type="submit" class="btn-submit">Register Now →</button>
      <p class="footer-note">*T&Cs Apply | Contact: ${contact} | DJI Authorised Store, Queensbay</p>
    </form>

    <div class="success-screen" id="successScreen">
      <div class="checkmark">🎉</div>
      <h2>You're registered!</h2>
      <p>Thanks for signing up for <strong>${name}</strong>.<br/>
      We'll see you on <strong>${dateShort}</strong> at<br/>${venue}.<br/><br/>
      For enquiries, call <strong>${contact}</strong>.</p>
    </div>
  </div>
</div>

<script>
  document.querySelectorAll('.option-item input').forEach(input => {
    const syncCheck = () => {
      if (input.type === 'radio') {
        document.querySelectorAll('[name="' + input.name + '"]').forEach(r => {
          r.closest('.option-item').classList.remove('checked');
        });
      }
      input.closest('.option-item').classList.toggle('checked', input.checked);
    };
    input.addEventListener('change', syncCheck);
  });

  document.getElementById('regForm').addEventListener('submit', function(e) {
    const required = this.querySelectorAll('[required]');
    for (let f of required) {
      if (f.type === 'radio') {
        const group = this.querySelectorAll('[name="' + f.name + '"]');
        if (![...group].some(r => r.checked)) {
          group[0].closest('.options-list').scrollIntoView({ behavior: 'smooth', block: 'center' });
          return false;
        }
      } else if (!f.value.trim()) {
        f.focus();
        return false;
      }
    }
    setTimeout(() => {
      document.getElementById('regForm').style.display = 'none';
      document.getElementById('successScreen').style.display = 'block';
    }, 1200);
  });
</script>
</body>
</html>`;
}

// ─── Build Dashboard HTML ──────────────────────────────────────────────────────
function buildDashboardHtml({ name, date, time, venue, contact, slug, sheetUrl, siteUrl }) {
  const sheetBtn = sheetUrl
    ? `<a href="${sheetUrl}" target="_blank" style="background:#1a1a2e;color:#fff;text-decoration:none;padding:6px 14px;border-radius:8px;font-size:11px;font-weight:700;">📋 Google Sheets</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name} – Dashboard</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
  <script>(function(){if(!localStorage.getItem('dji_auth')){window.location.replace('/workshop/login.html');}})();<\/script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; min-height: 100vh; }
    .topbar { background: linear-gradient(135deg, #1a1a2e 0%, #0f3460 100%); color: #fff; padding: 18px 28px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .topbar .brand { font-size: 12px; letter-spacing: 4px; color: #e6a014; font-weight: 800; }
    .topbar h1 { font-size: 18px; font-weight: 700; margin-top: 4px; }
    .topbar .badge { background: #e6a014; color: #1a1a2e; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }
    .event-bar { background: #fff; border-radius: 10px; padding: 14px 20px; display: flex; flex-wrap: wrap; gap: 18px; border-left: 4px solid #e6a014; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .event-bar span { font-size: 13px; color: #444; }
    .event-bar strong { color: #1a1a2e; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 10px; padding: 20px 16px; box-shadow: 0 2px 8px rgba(0,0,0,.06); text-align: center; }
    .card .num { font-size: 36px; font-weight: 800; color: #1a1a2e; line-height: 1; }
    .card .lbl { font-size: 12px; color: #888; margin-top: 6px; text-transform: uppercase; letter-spacing: .5px; }
    .card.gold .num { color: #e6a014; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .chart-box { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .chart-box h3 { font-size: 13px; color: #1a1a2e; font-weight: 700; margin-bottom: 14px; text-transform: uppercase; letter-spacing: .5px; }
    .table-box { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,.06); overflow-x: auto; }
    .table-box h3 { font-size: 13px; color: #1a1a2e; font-weight: 700; margin-bottom: 14px; text-transform: uppercase; letter-spacing: .5px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #1a1a2e; color: #fff; padding: 10px 12px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
    td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; color: #333; }
    .empty-row { text-align: center; color: #aaa; font-style: italic; }
    .footer { text-align: center; margin-top: 32px; font-size: 11px; color: #aaa; }
  </style>
</head>
<body>
<div class="topbar">
  <div>
    <div class="brand">D J I</div>
    <h1>${name} – Dashboard</h1>
  </div>
  <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
    <div class="badge">${date}</div>
    ${sheetBtn}
    <a href="/workshop/" style="background:#e6a014;color:#1a1a2e;text-decoration:none;padding:6px 14px;border-radius:8px;font-size:11px;font-weight:700;">← Workshop Hub</a>
  </div>
</div>

<div class="container">
  <div class="event-bar">
    <span>📅 <strong>${date}</strong></span>
    <span>⏰ <strong>${time}</strong></span>
    <span>📍 <strong>${venue}</strong></span>
    <span>📞 <strong>${contact}</strong></span>
    <span>🟢 <strong>Registration Open</strong></span>
  </div>

  <div class="cards">
    <div class="card gold"><div class="num" id="total">0</div><div class="lbl">Total Registrants</div></div>
    <div class="card"><div class="num" id="beginners">0</div><div class="lbl">Complete Beginners</div></div>
    <div class="card"><div class="num" id="someExp">0</div><div class="lbl">Some Experience</div></div>
    <div class="card"><div class="num" id="intermediate">0</div><div class="lbl">Intermediate</div></div>
  </div>

  <div class="charts">
    <div class="chart-box"><h3>Experience Level</h3><canvas id="expChart" height="200"></canvas></div>
    <div class="chart-box"><h3>How They Heard</h3><canvas id="heardChart" height="200"></canvas></div>
    <div class="chart-box"><h3>Age Group</h3><canvas id="ageChart" height="200"></canvas></div>
  </div>

  <div class="table-box">
    <h3>Registered Attendees</h3>
    <table>
      <thead>
        <tr><th>#</th><th>Full Name</th><th>Phone</th><th>Email</th><th>Age</th><th>Experience</th><th>Heard From</th></tr>
      </thead>
      <tbody id="attendeeTable">
        <tr><td colspan="7" class="empty-row">No registrations yet — data will appear here once people sign up.</td></tr>
      </tbody>
    </table>
  </div>

  <div class="footer">DJI Authorised Store, Queensbay &nbsp;|&nbsp; ${name} &nbsp;|&nbsp; Dashboard</div>
</div>

<script>
  const navy = '#1a1a2e', gold = '#e6a014', blue = '#457b9d';
  new Chart(document.getElementById('expChart'), {
    type: 'doughnut',
    data: { labels: ['Beginner','Some Exp','Intermediate','Advanced'], datasets: [{ data: [0,0,0,0], backgroundColor: [navy,gold,blue,'#e94560'], borderWidth: 2 }] },
    options: { plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } } }
  });
  new Chart(document.getElementById('heardChart'), {
    type: 'bar',
    data: { labels: ['WhatsApp','Staff','Social','Friend','Walk-In','Other'], datasets: [{ data: [0,0,0,0,0,0], backgroundColor: [navy,gold,blue,'#e94560','#16213e','#aaa'], borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });
  new Chart(document.getElementById('ageChart'), {
    type: 'pie',
    data: { labels: ['36+','26-35','18-25','Under 18'], datasets: [{ data: [0,0,0,0], backgroundColor: [navy,gold,blue,'#e94560'], borderWidth: 2 }] },
    options: { plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } } }
  });
<\/script>
</body>
</html>`;
}
