// Shared AI-usage meter (pilot budget). Renders the physician's AI allowance as a %-only bar —
// raw $ and token counts are operator metrics that read as "spending" to a physician practising
// reasoning, so we show only how much of the allowance is used. Used by the dashboard (full card)
// and the chat page (compact). Extracted from dashboard.js so both render identically.
(function () {
  async function renderUsageBar(host, opts) {
    if (!host) return;
    opts = opts || {};
    var me;
    try { me = await api.me(); } catch (e) { return; }
    var u = me && me.user;
    if (!u) return;
    // Two caps share one meter: the $ cap and (with the local model) a token cap. The bar shows
    // whichever is closer to full, and "full" is either one reached — the labels are unit-neutral.
    var costLimit = Number(u.usage_limit_effective_usd);
    var hasCost = Number.isFinite(costLimit) && costLimit > 0;
    var tokenLimit = Number(u.usage_limit_effective_tokens);
    var hasTokens = Number.isFinite(tokenLimit) && tokenLimit > 0;
    if (!hasCost && !hasTokens) return; // nothing meaningful to show
    var costUsed = Number(u.usage_cost_usd != null ? u.usage_cost_usd : 0);
    var tokensUsed = Number(u.usage_input_tokens || 0) + Number(u.usage_output_tokens || 0);
    var costPct = hasCost ? costUsed / costLimit : 0;
    var tokenPct = hasTokens ? tokensUsed / tokenLimit : 0;
    var pct = Math.min(100, Math.round(Math.max(costPct, tokenPct) * 100));
    var over = (hasCost && costUsed >= costLimit) || (hasTokens && tokensUsed >= tokenLimit);
    var barColor  = over ? 'var(--error,#c64545)'    : pct >= 80 ? 'var(--warning,#d4a017)'    : 'var(--success,#5db872)';
    var textColor = over ? 'var(--error-text,#7a1c1c)' : pct >= 80 ? 'var(--warning-text,#7a5900)' : 'var(--success-text,#1a6630)';

    if (opts.mini) {
      // Minimal bar showing CURRENT usage — the fill is how much of the allowance is used,
      // climbing green → amber → red. Exact figure shown as text and in the tooltip.
      host.className = 'usage-mini';
      host.title = over ? 'ใช้โควตา AI ครบแล้ว — ติดต่อผู้ดูแลระบบ / AI allowance used up' : ('ใช้โควตา AI ไปแล้ว ' + pct + '% / ' + pct + '% of AI allowance used');
      host.innerHTML = '<span class="um-label">Token Usage</span>' +
        '<span class="um-track"><span class="um-fill" style="width:' + pct + '%;background:' + barColor + ';"></span></span>' +
        '<span class="um-pct" style="color:' + textColor + ';">' + (over ? 'เต็ม' : 'ใช้ไป ' + pct + '%') + '</span>';
      return;
    }

    if (opts.chip) {
      // Tiny pill for the slim chat header — "AI 7%", colour-coded; full text in the tooltip.
      host.className = 'usage-chip';
      host.style.color = textColor;
      host.style.borderColor = barColor;
      host.title = over ? 'ใช้โควตา AI ครบแล้ว — ติดต่อผู้ดูแลระบบ / AI allowance used up' : ('โควตา AI ของคุณ — ใช้ไปแล้ว ' + pct + '% / Your AI allowance — ' + pct + '% used');
      host.innerHTML = over ? 'AI · เต็ม' : ('AI ' + pct + '%');
      return;
    }

    if (opts.compact) {
      // Slim inline bar for the chat session — no boxed card, less vertical weight.
      host.className = 'usage-compact';
      host.innerHTML =
        '<div class="uc-row"><span>โควตา AI ของคุณ<span class="bi-en">Your AI allowance</span></span>' +
        '<span class="uc-pct" style="color:' + textColor + ';">ใช้ไปแล้ว ' + pct + '%<span class="bi-en">used</span></span></div>' +
        '<div class="uc-track"><div class="uc-fill" style="width:' + pct + '%;background:' + barColor + ';"></div></div>' +
        (over ? '<div style="color:var(--error-text,#7a1c1c);font-weight:600;margin-top:5px;font-size:12px;">ใช้โควตาครบแล้ว — ติดต่อผู้ดูแลระบบ / Allowance used up — contact an administrator.</div>' : '');
      return;
    }

    host.innerHTML =
      '<div style="background:var(--surface-card,#fff);border:1px solid var(--hairline,#e2e2e2);color:var(--body-color,#1a1a1a);border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:13px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;">' +
          '<span>โควตา AI ของคุณ<span class="bi-en">Your AI allowance</span></span>' +
          '<span style="font-variant-numeric:tabular-nums;color:' + textColor + ';font-weight:600;">ใช้ไปแล้ว ' + pct + '%<span class="bi-en">used</span></span>' +
        '</div>' +
        '<div style="height:8px;background:rgba(127,127,127,.22);border-radius:99px;overflow:hidden;margin-top:6px;">' +
          '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';transition:width .3s;"></div>' +
        '</div>' +
        (over ? '<div style="color:var(--error-text,#7a1c1c);font-weight:600;margin-top:5px;">ใช้โควตาครบแล้ว — ติดต่อผู้ดูแลระบบ / Allowance used up — contact an administrator.</div>' : '') +
      '</div>';
  }
  window.renderUsageBar = renderUsageBar;
})();
