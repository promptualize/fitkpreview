// /api/approve.js
// One-tap approve: Mark clicks the link in the draft email, this function
// reads the draft from Supabase, commits the post + updated index to GitHub,
// and Vercel auto-deploys.
//
// Reliability hardening (2026-04-18):
//   - Every GitHub API call logs status + response body to the Vercel runtime
//     logs and surfaces it in the failure page so we can see WHY a push failed.
//   - Transient 5xx / network errors are retried once before giving up.
//   - If a direct push to main fails after retries, we fall back to creating a
//     branch + PR named "daily-dink/<edition_date>". Mark can merge from
//     GitHub Desktop or the web UI. The draft stays in 'pending' so the
//     approve link can still be retapped once the root cause is fixed.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { token, debug } = req.query;
  if (!token) {
    return sendPage(res, 400, 'Missing Token', 'No approval token was provided. Check the link in your email.');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo  = process.env.GITHUB_REPO || 'gradesenseai/fitkpreview';

  // Collect a diagnostic trail we can print on failure pages.
  const trail = [];
  const log = (msg) => {
    const line = `[approve ${new Date().toISOString()}] ${msg}`;
    console.log(line);
    trail.push(line);
  };

  const errPage = (status, title, detail) => {
    const body = debug ? detail + '\n\n---\n' + trail.join('\n') : detail;
    return sendPage(res, status, title, body);
  };

  try {
    // 1. Look up the draft by token
    log(`lookup draft token=${token.slice(0, 8)}...`);
    const draftRes = await fetch(
      `${supabaseUrl}/rest/v1/daily_dink_drafts?approve_token=eq.${token}&status=eq.pending&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    if (!draftRes.ok) {
      const body = await draftRes.text();
      return errPage(500, 'Database Error', `Supabase lookup failed (${draftRes.status}): ${body.slice(0, 400)}`);
    }
    const drafts = await draftRes.json();
    if (!drafts.length) {
      return errPage(404, 'Draft Not Found',
        'This draft was already published, rejected, or the link has expired. Status must be "pending" for the token to resolve.');
    }
    const draft = drafts[0];
    log(`draft id=${draft.id} edition=${draft.edition_date} slug=${draft.slug}`);

    // Normalize logo: scheduler may emit the uncommitted icon filename; swap for the
    // deployed primary logo so headers never render broken regardless of scheduler version.
    if (draft.post_html) {
      draft.post_html = draft.post_html.replace(
        /images\/logos\/2026-02-11_FIK-Logo-Icon\.png/g,
        'images/logos/FIK_Logo_Primary_CR.png'
      );
    }

    // 1b. Structural validation. Broken templates (e.g. ones that link to
    // ../../styles.css instead of inlining the full design system, or pages
    // that contain unresolved git merge markers) must NOT be allowed to
    // publish. Lessons learned from 4/27, 4/30, 5/4, 5/5 outages.
    const validation = validatePostHtml(draft.post_html);
    if (!validation.ok) {
      log(`STRUCTURAL VALIDATION FAILED: ${validation.reasons.join('; ')}`);
      return errPage(422, 'Draft Failed Structural Check',
        `This draft did not pass the post-HTML structural check, so it was NOT published.<br><br>` +
        `Reasons:<br>&bull; ` + validation.reasons.join('<br>&bull; ') + `<br><br>` +
        `The draft has been left in 'pending' so a corrected build can replace it.<br><br>` +
        `<small>Edition: ${draft.edition_date} &middot; size: ${(draft.post_html || '').length} bytes</small>`
      );
    }
    log(`structural check passed (size=${draft.post_html.length}, inline-style-bytes=${validation.inlineStyleBytes})`);

    // 2. Try direct push to main (fast path). On any failure fall through to PR path.
    const liveSlug = String(draft.slug).replace(/-daily-dink$/, '');
    const postPath = `news/daily-dink/${liveSlug}.html`;
    const indexPath = 'news/index.html';

    const pushResult = await pushDirectToMain({
      githubToken, githubRepo, draft, postPath, indexPath, log,
    });

    if (pushResult.ok) {
      log(`pushed commit ${pushResult.commitSha.slice(0, 7)} to main`);
      await markApproved(supabaseUrl, supabaseKey, draft.id);
      return sendPage(res, 200, 'Published',
        `FITK Daily Dink for ${draft.edition_date} is live. Vercel will deploy in about 30 seconds.<br><br>` +
        `<a href="https://faithinthekitchen.com/news/daily-dink/${liveSlug}.html" style="color:#C8963E;">View the post &rarr;</a>`
      );
    }

    // 3. Direct push failed. Try PR fallback.
    log(`direct push failed at "${pushResult.step}" (${pushResult.status}). Falling back to PR.`);
    const prResult = await pushAsPullRequest({
      githubToken, githubRepo, draft, postPath, indexPath, log,
    });

    if (prResult.ok) {
      await markApproved(supabaseUrl, supabaseKey, draft.id);
      return sendPage(res, 200, 'Pull Request Opened',
        `Direct push to main failed, so I opened a PR instead.<br><br>` +
        `<a href="${prResult.prUrl}" style="color:#C8963E;">Open PR on GitHub &rarr;</a><br><br>` +
        `Merge it there and Vercel will deploy. Draft has been marked approved in the database.<br><br>` +
        `<details><summary>Why direct push failed</summary><pre style="text-align:left;font-size:11px;white-space:pre-wrap;">` +
        `${escapeHtml(pushResult.detail || '').slice(0, 800)}</pre></details>`
      );
    }

    // 4. Both paths failed. Surface everything.
    return errPage(500, 'Publish Failed',
      `Neither direct push nor PR fallback worked.<br><br>` +
      `<strong>Direct push:</strong> ${escapeHtml(pushResult.step)} returned ${pushResult.status}<br>` +
      `<pre style="text-align:left;font-size:11px;white-space:pre-wrap;background:#f5f5f0;padding:8px;">${escapeHtml(pushResult.detail || '').slice(0, 600)}</pre>` +
      `<strong>PR fallback:</strong> ${escapeHtml(prResult.step)} returned ${prResult.status}<br>` +
      `<pre style="text-align:left;font-size:11px;white-space:pre-wrap;background:#f5f5f0;padding:8px;">${escapeHtml(prResult.detail || '').slice(0, 600)}</pre>` +
      `Most common cause: GITHUB_TOKEN expired or is missing "contents: write" scope on the repo.`
    );

  } catch (err) {
    console.error('approve: uncaught error', err);
    return errPage(500, 'Error', `Unexpected error: ${escapeHtml(err.message)}`);
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ghFetch(url, init, { retries = 1, log } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return r;
      // Retry only on 5xx; 4xx means a real problem (bad token, etc.)
      if (r.status >= 500 && attempt < retries) {
        log && log(`gh ${init?.method || 'GET'} ${url.split('/repos/')[1] || url} -> ${r.status}, retrying`);
        await sleep(600);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        log && log(`gh fetch threw ${e.message}, retrying`);
        await sleep(600);
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ghHeaders(token) {
  return {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'fitkpreview-approve',
  };
}

function insertCard(indexHtml, cardHtml) {
  const beginMarker = '<!-- BEGIN_NEWS_GRID -->';
  const endMarker = '<!-- END_NEWS_GRID -->';
  if (indexHtml.includes(beginMarker)) {
    return indexHtml.replace(beginMarker, beginMarker + '\n\n      ' + cardHtml);
  }
  const gridOpenRe = /(<div[^>]*class="[^"]*\bnews-grid\b[^"]*"[^>]*>)/;
  if (gridOpenRe.test(indexHtml)) {
    return indexHtml.replace(gridOpenRe, (m) => m + '\n\n      ' + cardHtml);
  }
  if (indexHtml.includes(endMarker)) {
    return indexHtml.replace(endMarker, cardHtml + '\n\n      ' + endMarker);
  }
  return null;
}

async function pushDirectToMain({ githubToken, githubRepo, draft, postPath, indexPath, log }) {
  const H = ghHeaders(githubToken);

  // Read current news/index.html
  let step = 'get contents news/index.html';
  let r = await ghFetch(`https://api.github.com/repos/${githubRepo}/contents/${indexPath}`, { headers: H }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const indexFile = await r.json();
  const indexContent = Buffer.from(indexFile.content, 'base64').toString('utf-8');
  const updatedIndex = insertCard(indexContent, draft.card_html);
  if (!updatedIndex) return { ok: false, step: 'insert card marker', status: 0, detail: 'No news-grid marker or opening tag found in news/index.html' };

  // Latest commit on main
  step = 'get ref heads/main';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/ref/heads/main`, { headers: H }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const { object: { sha: latestCommitSha } } = await r.json();

  step = 'get commit';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/commits/${latestCommitSha}`, { headers: H }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const { tree: { sha: baseTreeSha } } = await r.json();

  // Create blobs
  step = 'create blob post_html';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/blobs`, {
    method: 'POST', headers: H, body: JSON.stringify({ content: draft.post_html, encoding: 'utf-8' })
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const postBlob = await r.json();

  step = 'create blob index.html';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/blobs`, {
    method: 'POST', headers: H, body: JSON.stringify({ content: updatedIndex, encoding: 'utf-8' })
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const indexBlob = await r.json();

  // Tree + commit
  step = 'create tree';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/trees`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [
        { path: postPath, mode: '100644', type: 'blob', sha: postBlob.sha },
        { path: indexPath, mode: '100644', type: 'blob', sha: indexBlob.sha },
      ],
    }),
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const treeData = await r.json();

  step = 'create commit';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/commits`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      message: `Publish FITK Daily Dink - ${draft.edition_date}`,
      tree: treeData.sha,
      parents: [latestCommitSha],
    }),
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const newCommit = await r.json();

  step = 'update ref heads/main';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/refs/heads/main`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ sha: newCommit.sha }),
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };

  return { ok: true, commitSha: newCommit.sha };
}

async function pushAsPullRequest({ githubToken, githubRepo, draft, postPath, indexPath, log }) {
  const H = ghHeaders(githubToken);
  const branch = `daily-dink/${draft.edition_date}`;

  // Re-fetch the latest main to branch from (in case pushDirectToMain created dangling objects)
  let step = 'get ref heads/main';
  let r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/ref/heads/main`, { headers: H }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const { object: { sha: mainSha } } = await r.json();

  // Create branch (PUT-like via POST)
  step = `create branch ${branch}`;
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/git/refs`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainSha }),
  }, { log });
  // 422 = already exists, that's fine — we'll reuse it
  if (!r.ok && r.status !== 422) return { ok: false, step, status: r.status, detail: await r.text() };

  // Put post file via contents API (this endpoint creates or updates files atomically)
  step = `put ${postPath}`;
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/contents/${postPath}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({
      message: `Publish FITK Daily Dink - ${draft.edition_date}`,
      content: Buffer.from(draft.post_html, 'utf-8').toString('base64'),
      branch,
    }),
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };

  // Get current index.html on THIS branch to get its SHA
  step = `get ${indexPath}?ref=${branch}`;
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/contents/${indexPath}?ref=${branch}`, { headers: H }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const indexFile = await r.json();
  const indexContent = Buffer.from(indexFile.content, 'base64').toString('utf-8');
  const updatedIndex = insertCard(indexContent, draft.card_html);
  if (!updatedIndex) return { ok: false, step: 'insert card', status: 0, detail: 'No news-grid marker or opening tag found on branch' };

  step = `put ${indexPath}`;
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/contents/${indexPath}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({
      message: `Update news index for ${draft.edition_date}`,
      content: Buffer.from(updatedIndex, 'utf-8').toString('base64'),
      sha: indexFile.sha,
      branch,
    }),
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };

  // Open PR
  step = 'create pull request';
  r = await ghFetch(`https://api.github.com/repos/${githubRepo}/pulls`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      title: `FITK Daily Dink - ${draft.edition_date}`,
      head: branch,
      base: 'main',
      body: `Automated publish via /api/approve.\n\nDirect push to main was not possible, so this PR was opened as a fallback.`,
    }),
  }, { log });
  if (!r.ok) return { ok: false, step, status: r.status, detail: await r.text() };
  const pr = await r.json();
  return { ok: true, prUrl: pr.html_url };
}

async function markApproved(supabaseUrl, supabaseKey, draftId) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/daily_dink_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ status: 'approved', approved_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn('markApproved failed (non-fatal):', e.message);
  }
}

// Structural sanity check on the post HTML before it's pushed to GitHub.
// Hard-won rules — each one corresponds to a real outage:
//   - 4/27, 4/30, 5/4, 5/5: pages came in tiny (~10-15KB), linking to
//     ../../styles.css instead of inlining the full design system. The
//     rendered page had no nav / header / footer styling.
//   - earlier outage: pages contained unresolved git merge markers because
//     a manual push left HEAD/======= literals in the file.
// If any check fails, approve refuses to publish so a broken page can
// never reach production. Draft stays 'pending' until a clean rebuild
// arrives.
function validatePostHtml(html) {
  const reasons = [];
  if (!html || typeof html !== 'string') {
    return { ok: false, reasons: ['post_html is missing or not a string'], inlineStyleBytes: 0 };
  }

  // 1. Minimum size — a real edition with the inlined design system is ~100KB.
  //    A broken externalstyles.css edition is ~10-15KB. Pick a floor that is
  //    well above broken and well below working, with margin.
  const MIN_BYTES = 60000;
  if (html.length < MIN_BYTES) {
    reasons.push(`post_html is only ${html.length} bytes (need >= ${MIN_BYTES}). A working edition inlines the design system and runs ~100KB.`);
  }

  // 2. Must NOT link to the external ../../styles.css. That file exists, but
  //    does not contain the site nav/header chrome the daily dink template
  //    needs, so its presence here is the signature of the broken template.
  if (/href=["']\.\.\/\.\.\/styles\.css["']/.test(html)) {
    reasons.push('post_html links to ../../styles.css externally. Daily Dink editions must inline the full design system.');
  }

  // 3. Must NOT contain unresolved git merge markers.
  if (/^<{7} HEAD$/m.test(html) || /^={7}$/m.test(html) || /^>{7} [a-f0-9]{7,}/m.test(html)) {
    reasons.push('post_html contains unresolved git merge markers (<<<<<<< / ======= / >>>>>>>).');
  }

  // 4. Must contain a substantial inline <style> block. The working template
  //    has ~4000 lines / ~80KB of inline CSS. We require at least 30KB to
  //    catch any future "minimal style" template that slips through.
  let inlineStyleBytes = 0;
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  for (const block of styleBlocks) inlineStyleBytes += block.length;
  if (inlineStyleBytes < 30000) {
    reasons.push(`inline <style> blocks total only ${inlineStyleBytes} bytes (need >= 30000). Design system not inlined.`);
  }

  // 5. Required structural anchors — these come from the working template.
  //    Some are matched as "any of" because the active template uses one set
  //    of class names while older fixed pages may carry a different set.
  const requiredAll = [
    { needle: '<article class="news-post">',  label: '<article class="news-post"> wrapper' },
    { needle: 'class="news-post-title"',      label: '.news-post-title element' },
    { needle: 'class="dink-headlines"',       label: '.dink-headlines list container' },
    { needle: 'class="news-post-dek"',        label: '.news-post-dek paragraph' },
  ];
  for (const r of requiredAll) {
    if (!html.includes(r.needle)) reasons.push(`missing required marker: ${r.label}`);
  }
  // Footer: at least one of these has to be present.
  const footerAnchors = ['class="footer-container"', 'class="site-footer"'];
  if (!footerAnchors.some(a => html.includes(a))) {
    reasons.push(`missing footer anchor (need one of: ${footerAnchors.join(', ')})`);
  }
  // Header chrome: at least one of these has to be present.
  const headerAnchors = ['class="header-container"', 'class="site-header"'];
  if (!headerAnchors.some(a => html.includes(a))) {
    reasons.push(`missing site header anchor (need one of: ${headerAnchors.join(', ')})`);
  }

  return { ok: reasons.length === 0, reasons, inlineStyleBytes };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendPage(res, status, title, message) {
  res.status(status).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - FITK Daily Dink</title>
      <style>
        body { font-family: 'Inter', Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #F5F5F0; color: #000; }
        .card { background: #fff; border: 1px solid rgba(0,0,0,0.12); padding: 3rem 2.5rem; max-width: 560px; text-align: center; }
        .label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; color: #C8963E; margin-bottom: 1rem; }
        h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 1rem; }
        p, div { font-size: 0.95rem; color: #464646; line-height: 1.6; margin: 0; }
        a { color: #C8963E; text-decoration: none; }
        a:hover { text-decoration: underline; }
        pre { margin-top: 1rem; text-align: left; }
        details { margin-top: 1rem; text-align: left; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="label">FITK Daily Dink</div>
        <h1>${title}</h1>
        <div>${message}</div>
      </div>
    </body>
    </html>
  `);
}
