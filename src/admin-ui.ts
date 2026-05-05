// 管理后台单页 HTML（vanilla JS，零前端构建）
// 通过 /api/* 调用后端；动态渲染只用 createElement + textContent，杜绝 innerHTML 注入
//
// 控制面板（顶部）能力：
//   - 显示 cron schedule（来自 wrangler.jsonc，D1 仅做镜像展示）
//   - cron 启停开关（runtime D1 标记；scheduled-handler 启动时检查）
//   - 立即手动触发一次抓取
//   - 一键导入 US / HK / CN 全市场标的清单

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Market Data Lake — Dashboard</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;margin:0;padding:24px;background:#f5f6f8;color:#222}
  h1{font-size:20px;margin:0 0 16px}
  h2{font-size:14px;margin:0 0 8px;color:#666;text-transform:uppercase;letter-spacing:.04em}
  .panel{background:#fff;padding:14px 16px;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.06);margin-bottom:16px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
  .row + .row{margin-top:8px}
  code{background:#f0f2f5;padding:2px 6px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .stats{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .stat{background:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.06);font-size:14px}
  .stat b{display:block;font-size:18px;margin-top:2px}
  .filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
  .filters select,.filters input{padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px}
  table{width:100%;background:#fff;border-collapse:collapse;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.06);font-size:13px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eee;vertical-align:top}
  th{background:#fafafa;font-weight:600;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em}
  tr:last-child td{border-bottom:none}
  .pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px}
  .pill.ok{background:#e6f4ea;color:#137333}
  .pill.paused{background:#eee;color:#555}
  .pill.err{background:#fce8e6;color:#a50e0e}
  button{margin-right:4px;padding:5px 12px;border:1px solid #ccc;border-radius:5px;background:#fff;cursor:pointer;font-size:12px}
  button:hover{background:#f0f2f5}
  button:disabled{opacity:.5;cursor:not-allowed}
  button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}
  button.primary:hover{background:#1557b0}
  button.danger{color:#a50e0e}
  .pager{margin-top:12px;display:flex;gap:8px;align-items:center;font-size:13px}
  .err-msg{color:#a50e0e;font-size:11px;display:block;margin-top:2px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
  .empty{text-align:center;color:#888;padding:24px}
  .toast{position:fixed;right:24px;top:24px;background:#222;color:#fff;padding:10px 14px;border-radius:6px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.2);max-width:360px;z-index:10}
  .bar{display:inline-block;width:90px;height:8px;background:#eee;border-radius:4px;overflow:hidden;vertical-align:middle}
  .bar-inner{height:100%;background:#137333;transition:width .3s}
  .bar-inner.warn{background:#f9ab00}
  .bar-inner.low{background:#a50e0e}
  .progress-text{margin-left:6px;font-size:11px;color:#666;vertical-align:middle}
</style>
</head>
<body>
<h1>Market Data Lake — Dashboard</h1>

<div class="panel" id="ctrl">
  <h2>Cron 调度</h2>
  <div class="row" id="ctrl-cron">Loading...</div>
  <div class="row" style="margin-top:14px">
    <h2 style="margin:0">批量导入全市场标的</h2>
  </div>
  <div class="row">
    <button data-import="US">Import US (~7000)</button>
    <button data-import="HK">Import HK (~80 HSI)</button>
    <button data-import="CN">Import CN (~5000)</button>
    <span style="color:#888;font-size:12px">导入只插 1d 作业，重复执行幂等</span>
  </div>
</div>

<div class="stats" id="stats">Loading...</div>

<div class="filters">
  <input id="search" type="search" placeholder="搜索 ticker / 名称（模糊）" style="min-width:240px">
  <select id="market">
    <option value="">All markets</option>
    <option>US</option><option>HK</option><option>CN</option>
  </select>
  <select id="interval">
    <option value="">All intervals</option>
    <option>1m</option><option>5m</option><option>15m</option><option>30m</option>
    <option>1h</option><option>1d</option><option>1wk</option><option>1mo</option>
  </select>
  <select id="status">
    <option value="">All status</option>
    <option value="active">Active</option>
    <option value="paused">Paused</option>
    <option value="error">Error</option>
  </select>
  <button id="refresh">Refresh</button>
</div>

<table>
  <thead><tr>
    <th>Ticker / Name</th><th>Market</th><th>Interval</th><th>Status</th>
    <th>Data range</th><th>Last updated</th><th>Progress</th><th>Errors</th><th>Actions</th>
  </tr></thead>
  <tbody id="rows"><tr><td colspan="9">Loading...</td></tr></tbody>
</table>

<div class="pager">
  <button id="prev">‹ Prev</button>
  <span>Page <span id="pageNum">1</span></span>
  <button id="next">Next ›</button>
</div>

<script>
(function(){
  var page = 1;
  var PAGE_SIZE = 50;

  function fmtTime(ts){ return ts ? new Date(ts).toLocaleString() : '—'; }

  function el(tag, opts){
    var n = document.createElement(tag);
    if(opts){
      if(opts.className) n.className = opts.className;
      if(opts.text != null) n.textContent = String(opts.text);
      if(opts.title != null) n.title = String(opts.title);
      if(opts.style) for(var k in opts.style) n.style[k] = opts.style[k];
      if(opts.data) for(var d in opts.data) n.dataset[d] = String(opts.data[d]);
      if(opts.attrs) for(var a in opts.attrs) n.setAttribute(a, String(opts.attrs[a]));
    }
    return n;
  }

  function statusPill(r){
    if(!r.is_active) return el('span', {className:'pill paused', text:'Paused'});
    if(r.error_flag) return el('span', {className:'pill err', text:'Error'});
    return el('span', {className:'pill ok', text:'Active'});
  }

  function emptyRow(text, color){
    var tr = document.createElement('tr');
    var td = el('td', {className:'empty', text:text, attrs:{colspan:'9'}});
    if(color) td.style.color = color;
    tr.appendChild(td);
    return tr;
  }

  function fmtDate(iso, withTime){
    if(!iso) return '—';
    var d = new Date(iso);
    if(isNaN(d.getTime())) return iso;
    var s = d.toISOString().slice(0, 10);
    if(withTime) s += ' ' + d.toISOString().slice(11, 16);
    return s;
  }

  // 各 interval 抓全的目标条数（理论"满格"参考）：
  //   1d  ≈ 20 年 × 252 = 5040       (Yahoo max / 东财 lmt=10000 都能覆盖)
  //   1wk ≈ 20 年 × 52  = 1040
  //   1mo ≈ 20 年 × 12  = 240
  //   1h  / 730d        ≈ 3300
  //   30m / 60d         ≈ 540
  //   15m / 60d         ≈ 1080
  //   5m  / 60d         ≈ 3240
  //   1m  / 7d          ≈ 1880
  // 老股票（>20 年）会到 100% 后封顶；新上市股票即便拉满也只到部分占比，这是正常的——
  // 进度反映的是"相对 20 年完整历史"的覆盖度。
  var EXPECTED_BARS = {
    '1m':  1880,
    '5m':  3240,
    '15m': 1080,
    '30m': 540,
    '1h':  3300,
    '1d':  5040,
    '1wk': 1040,
    '1mo': 240,
  };

  function progressCell(rowCount, interval){
    var target = EXPECTED_BARS[interval] || 1;
    var n = rowCount || 0;
    var pct = Math.min(100, Math.round(n / target * 100));
    var td = document.createElement('td');
    var bar = el('div', {className: 'bar'});
    var cls = 'bar-inner';
    if(pct < 30) cls += ' low';
    else if(pct < 80) cls += ' warn';
    var inner = el('div', {className: cls, style: { width: pct + '%' }});
    bar.appendChild(inner);
    td.appendChild(bar);
    td.appendChild(el('span', {className: 'progress-text', text: n + ' / ' + target + ' (' + pct + '%)'}));
    return td;
  }

  function toast(msg, isError){
    var t = el('div', {className:'toast', text: msg});
    if(isError) t.style.background = '#a50e0e';
    document.body.appendChild(t);
    setTimeout(function(){ t.remove(); }, 4000);
  }

  async function loadCtrl(){
    var ctrl = document.getElementById('ctrl-cron');
    var c;
    try { c = await (await fetch('/api/system')).json(); }
    catch(e){
      ctrl.replaceChildren();
      ctrl.appendChild(el('span', {style:{color:'#a50e0e'}, text:'Failed: ' + (e && e.message)}));
      return;
    }
    ctrl.replaceChildren();
    ctrl.appendChild(document.createTextNode('Schedule: '));
    ctrl.appendChild(el('code', {text: c.cron_schedule}));
    ctrl.appendChild(document.createTextNode('  ·  Status: '));
    ctrl.appendChild(el('span', {
      className: 'pill ' + (c.cron_enabled ? 'ok' : 'paused'),
      text: c.cron_enabled ? 'ON' : 'OFF',
    }));
    ctrl.appendChild(document.createTextNode(' '));
    ctrl.appendChild(el('button', {
      text: c.cron_enabled ? 'Stop cron' : 'Start cron',
      data: { action: 'cron-toggle' },
    }));
    ctrl.appendChild(el('button', {
      className: 'primary',
      text: 'Run now',
      data: { action: 'cron-run' },
    }));
    ctrl.appendChild(el('span', {
      style: { color: '#888', fontSize: '11px', marginLeft: '8px' },
      text: '改 schedule 需要编辑 wrangler.jsonc 后重 deploy',
    }));
  }

  async function load(){
    var market = document.getElementById('market').value;
    var interval = document.getElementById('interval').value;
    var status = document.getElementById('status').value;
    var q = document.getElementById('search').value.trim();
    var params = new URLSearchParams({page: String(page), pageSize: String(PAGE_SIZE)});
    if(market) params.set('market', market);
    if(interval) params.set('interval', interval);
    if(status) params.set('status', status);
    if(q) params.set('q', q);
    document.getElementById('pageNum').textContent = String(page);

    var jobs, health;
    try {
      var r = await Promise.all([
        fetch('/api/jobs?' + params.toString()),
        fetch('/api/health'),
      ]);
      jobs = await r[0].json();
      health = await r[1].json();
    } catch(e){
      var msg = (e && e.message) ? e.message : 'unknown error';
      var tbody = document.getElementById('rows');
      tbody.replaceChildren(emptyRow('Error: ' + msg, '#a50e0e'));
      return;
    }
    renderStats(health);
    renderRows(jobs.data || []);
  }

  function renderStats(h){
    var stats = document.getElementById('stats');
    stats.replaceChildren();
    var entries = [
      ['Total jobs', h.total],
      ['Active', h.active],
      ['Paused', h.paused],
      ['Errors', h.errors],
      ['Last cron', h.lastCronAt ? new Date(h.lastCronAt).toLocaleString() : '—'],
    ];
    for(var i = 0; i < entries.length; i++){
      var div = el('div', {className:'stat'});
      div.appendChild(document.createTextNode(entries[i][0]));
      div.appendChild(el('b', {text: entries[i][1] == null ? '0' : entries[i][1]}));
      stats.appendChild(div);
    }
  }

  function renderRows(rows){
    var tbody = document.getElementById('rows');
    tbody.replaceChildren();
    if(rows.length === 0){
      tbody.appendChild(emptyRow('No jobs'));
      return;
    }
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      var tr = document.createElement('tr');

      var tdTicker = document.createElement('td');
      tdTicker.appendChild(el('b', {text: r.ticker}));
      if(r.name){
        tdTicker.appendChild(document.createElement('br'));
        tdTicker.appendChild(el('span', {style:{color:'#888',fontSize:'11px'}, text: r.name}));
      }
      tr.appendChild(tdTicker);

      tr.appendChild(el('td', {text: r.market}));
      tr.appendChild(el('td', {text: r.interval}));

      var tdStatus = document.createElement('td');
      tdStatus.appendChild(statusPill(r));
      if(r.error_message){
        tdStatus.appendChild(el('span', {
          className: 'err-msg',
          text: '⚠ ' + r.error_message,
          title: r.error_message + '\\n\\n（点击复制）',
          data: { copy: r.error_message },
        }));
      }
      tr.appendChild(tdStatus);

      // Data range：分粒度选择是否带 HH:mm
      var subDaily = (r.interval === '1m' || r.interval === '5m' || r.interval === '15m' || r.interval === '30m' || r.interval === '1h');
      var rangeText = (r.data_start_at || r.data_end_at)
        ? fmtDate(r.data_start_at, subDaily) + ' → ' + fmtDate(r.data_end_at, subDaily)
        : '—';
      tr.appendChild(el('td', {text: rangeText, style:{fontSize:'12px',color:'#555'}}));

      tr.appendChild(el('td', {text: fmtTime(r.last_updated_at)}));
      tr.appendChild(progressCell(r.row_count, r.interval));
      tr.appendChild(el('td', {text: r.error_count}));

      var tdAct = document.createElement('td');
      tdAct.appendChild(el('button', {
        text: r.is_active ? 'Pause' : 'Resume',
        data: { action: r.is_active ? 'pause' : 'resume', ticker: r.ticker, interval: r.interval },
      }));
      tdAct.appendChild(document.createTextNode(' '));
      tdAct.appendChild(el('button', {
        className: 'primary',
        text: 'Fetch',
        data: { action: 'fetch', ticker: r.ticker, interval: r.interval },
      }));
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    }
  }

  async function rowAction(ticker, interval, action){
    var resp = await fetch('/api/jobs/' + encodeURIComponent(ticker) + '/' + encodeURIComponent(interval) + '/' + action, {method: 'POST'});
    if(!resp.ok){ toast('Failed: ' + (await resp.text()), true); return; }
    if(action === 'fetch'){
      toast('Fetch ' + ticker + ' ' + interval + ' triggered. Auto-refresh in ~30s.');
    }
    load();
  }

  async function cronToggle(){
    var resp = await fetch('/api/system/cron/toggle', {method:'POST'});
    if(!resp.ok){ toast('Toggle failed', true); return; }
    var c = await resp.json();
    toast('Cron is now ' + (c.cron_enabled ? 'ON' : 'OFF'));
    loadCtrl();
  }

  async function cronRun(){
    var resp = await fetch('/api/system/run', {method:'POST'});
    if(!resp.ok){ toast('Run failed', true); return; }
    toast('Cron triggered. Auto-refresh in ~30s.');
  }

  async function importMarket(market, btn){
    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Importing...';
    try {
      var resp = await fetch('/api/system/import?market=' + market, {method:'POST'});
      var body = await resp.json();
      if(!resp.ok){ toast('Import failed: ' + (body.error || resp.statusText), true); return; }
      toast(market + ': fetched ' + body.fetched + ', new tickers ' + body.inserted_tickers + ', new jobs ' + body.inserted_jobs);
      load();
    } catch(e){
      toast('Import error: ' + (e && e.message), true);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  document.getElementById('refresh').addEventListener('click', function(){ page = 1; load(); });
  document.getElementById('prev').addEventListener('click', function(){ page = Math.max(1, page - 1); load(); });
  document.getElementById('next').addEventListener('click', function(){ page = page + 1; load(); });
  document.addEventListener('change', function(e){
    if(e.target && e.target.matches && e.target.matches('select')){ page = 1; load(); }
  });

  // 搜索框：300ms debounce
  var searchTimer = null;
  document.getElementById('search').addEventListener('input', function(){
    if(searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ page = 1; load(); }, 300);
  });

  document.addEventListener('click', function(e){
    var t = e.target;
    if(!t || !t.closest) return;

    // 点错误信息复制全文
    var errEl = t.closest('.err-msg[data-copy]');
    if(errEl){
      var msg = errEl.dataset.copy;
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(msg).then(
          function(){ toast('Error message copied'); },
          function(){ fallbackCopy(msg); }
        );
      } else {
        fallbackCopy(msg);
      }
      return;
    }

    var ctrlBtn = t.closest('button[data-action]');
    if(ctrlBtn){
      var act = ctrlBtn.dataset.action;
      if(act === 'cron-toggle') return cronToggle();
      if(act === 'cron-run') return cronRun();
      return rowAction(ctrlBtn.dataset.ticker, ctrlBtn.dataset.interval, act);
    }
    var imp = t.closest('button[data-import]');
    if(imp) return importMarket(imp.dataset.import, imp);
  });

  function fallbackCopy(text){
    // 老浏览器或非 https 域名时降级：用临时 textarea + execCommand
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Error message copied'); }
    catch(e){ toast('Copy failed; long-press to select text', true); }
    document.body.removeChild(ta);
  }

  loadCtrl();
  load();
  setInterval(load, 30000);
  setInterval(loadCtrl, 30000);
})();
</script>
</body>
</html>
`;
