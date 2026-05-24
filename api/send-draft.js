// /api/send-draft.js
// Called by the scheduled Cowork task after building a Daily Dink draft.
// Stores the draft in Supabase, then emails it to Mark for approval via Resend.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Simple auth: shared secret so only the scheduled task can call this
  const authHeader = req.headers['x-api-key'];
  if (authHeader !== process.env.DRAFT_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { edition_date, slug, post_title, dek, post_html } = req.body;
    let { headlines, card_html } = req.body;

    if (!edition_date || !slug || !post_title || !post_html) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Hard-reject gate: post_html must be a full ~100KB edition (inlined CSS).
    // Generating HTML from scratch produces ~15KB; surgical swap from template produces ~100KB.
    // If this check fails, the caller MUST do a surgical swap from the prior day's file.
    if (typeof post_html !== 'string' || post_html.length < 60000) {
      return res.status(400).json({
        error: 'post_html too small',
        bytes: typeof post_html === 'string' ? post_html.length : 0,
        minimum: 60000,
        hint: 'Use surgical swap from prior day\'s ~100KB edition; do not generate from scratch.'
      });
    }

    // Normalize headline shape so a scheduler drift (e.g. {url, source, preview})
    // doesn't render "undefined" in the approval email. Canonical shape is:
    //   { title, summary, source_url, source_name, tags }
    const pickFirst = (obj, keys) => {
      for (const k of keys) {
        if (obj && obj[k] != null && obj[k] !== '') return obj[k];
      }
      return undefined;
    };
    const normalizeHeadline = (h) => {
      if (!h || typeof h !== 'object') return h;
      return {
        title:       pickFirst(h, ['title', 'headline', 'name']) || '',
        summary:     pickFirst(h, ['summary', 'preview', 'description', 'body', 'snippet']) || '',
        source_url:  pickFirst(h, ['source_url', 'url', 'link', 'href']) || '',
        source_name: pickFirst(h, ['source_name', 'source', 'outlet', 'publisher', 'site']) || '',
        tags:        Array.isArray(h.tags) ? h.tags : []
      };
    };
    headlines = Array.isArray(headlines) ? headlines.map(normalizeHeadline) : [];

    // Always rebuild card_html server-side from canonical template so scheduler
    // drift on the card markup (missing image placeholder, wrong class names,
    // data-filter vs data-category, etc.) cannot reach the live archive grid.
    // We ignore whatever the scheduler sent for card_html.
    const displayDate = (() => {
      try {
        const d = new Date(`${edition_date}T12:00:00Z`);
        const months = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
        return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
      } catch (e) {
        return edition_date;
      }
    })();
    const escapeAttr = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const cardExcerpt = dek && String(dek).trim()
      ? String(dek).trim()
      : `Today's top stories in pro pickleball.`;
    card_html = `      <a href="daily-dink/${slug}.html" class="news-card" data-category="daily-dink">
        <div class="news-card-image">
          <div class="news-card-image-placeholder">DAILY DINK | <span style="font-size:0.6em; letter-spacing:0.05em;">${escapeAttr(displayDate)}</span></div>
        </div>
        <div class="news-card-body">
          <div class="news-card-meta">
            <span class="news-card-category">Daily Dink</span>
          </div>
          <h3 class="news-card-title">${escapeAttr(post_title)}</h3>
          <p class="news-card-excerpt">${escapeAttr(cardExcerpt)}</p>
          <span class="news-card-readmore">Read More &rarr;</span>
        </div>
      </a>`;

    // 1. Store draft in Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/daily_dink_drafts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        edition_date,
        slug,
        post_title,
        post_html,
        card_html,
        headlines: headlines || []
      })
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      return res.status(500).json({ error: 'Supabase insert failed', detail: err });
    }

    const [draft] = await insertRes.json();
    const approveToken = draft.approve_token;

    // 2. Build the email HTML
    const siteUrl = process.env.SITE_URL || 'https://faithinthekitchen.com';
    const approveLink = `${siteUrl}/api/approve?token=${approveToken}`;

    // Normalize a tag value to a plain string. Tags may arrive as strings
    // ("Legal") or as objects ({ name: "Legal" }, { label: "Legal" }, etc.)
    // depending on how the upstream builder serialized Supabase rows.
    const tagToString = (t) => {
      if (t == null) return '';
      if (typeof t === 'string') return t;
      if (typeof t === 'number' || typeof t === 'boolean') return String(t);
      if (typeof t === 'object') {
        return t.name || t.label || t.text || t.value || t.tag || t.title || '';
      }
      return '';
    };

    const escapeHtml = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const headlineList = (headlines || []).map(h => {
      const tagsHtml = Array.isArray(h.tags)
        ? h.tags
            .map(tagToString)
            .filter(Boolean)
            .map(t => `<span style="display:inline-block;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.6px;background:#f0f2f5;color:#0a1d3c;padding:3px 8px;border-radius:999px;text-transform:uppercase;margin:0 4px 4px 0;line-height:1.2;">${escapeHtml(t)}</span>`)
            .join('')
        : '';
      return `<tr>
        <td style="padding:16px 0;border-bottom:1px solid #e5e5e5;">
          <div style="font-weight:600;font-size:15px;color:#000;margin-bottom:8px;line-height:1.25;">${h.title}</div>
          ${tagsHtml ? `<div style="margin-bottom:8px;">${tagsHtml}</div>` : ''}
          <div style="font-size:14px;color:#464646;line-height:1.5;margin-bottom:8px;">${h.summary}</div>
          <a href="${h.source_url}" style="font-size:12px;color:#C8963E;text-transform:uppercase;letter-spacing:0.1em;text-decoration:underline;text-decoration-color:#C8963E;">Read at ${h.source_name} &rarr;</a>
        </td>
      </tr>`;
    }).join('');

    const emailHtml = `
    <div style="max-width:600px;margin:0 auto;font-family:'Inter',Helvetica,Arial,sans-serif;color:#000;">
      <div style="background:#000;padding:16px 24px;text-align:center;">
        <span style="color:#C8963E;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;font-weight:600;">FITK DAILY DINK</span>
      </div>
      <div style="padding:24px;">
        <h1 style="font-size:22px;font-weight:700;margin:0 0 8px;color:#000;">${post_title}</h1>
        <p style="font-size:13px;color:#464646;margin:0 0 12px;">${edition_date}</p>
        <p style="font-size:14px;font-style:italic;color:#333;margin:0 0 20px;line-height:1.5;">${dek || 'Some of the top stories moving in pro pickleball today.'}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e5e5;">
          ${headlineList}
        </table>
        <div style="margin-top:32px;text-align:center;">
          <a href="${approveLink}" style="display:inline-block;background:#C8963E;color:#fff;padding:14px 40px;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;text-decoration:none;">APPROVE AND PUBLISH</a>
        </div>
        <p style="text-align:center;font-size:12px;color:#999;margin-top:16px;">
          Tap above to publish this edition to faithinthekitchen.com/news/. To pause today's subscriber send, reply with the word HOLD. For edits, open Cowork.
        </p>
      </div>
      <div style="background:#f5f5f0;padding:16px 24px;text-align:center;">
        <span style="font-size:11px;color:#999;">Faith in the Kitchen - Draft Review</span>
      </div>
    </div>`;

    // 3. Send via Resend
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'FITK Daily Dink <team@faithinthekitchen.com>',
        to: [process.env.REVIEW_EMAIL || 'team@faithinthekitchen.com'],
        reply_to: 'hold@inbound.faithinthekitchen.com',
        subject: `FITK Daily Dink Draft - ${edition_date}`,
        html: emailHtml
      })
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      return res.status(500).json({ error: 'Resend email failed', detail: err });
    }

    return res.status(200).json({
      success: true,
      draft_id: draft.id,
      approve_token: approveToken,
      approve_link: approveLink
    });

  } catch (err) {
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
}
