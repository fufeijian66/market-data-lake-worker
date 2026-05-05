// 管理后台单页 HTML（vanilla JS，零前端构建）
// 通过 /api/* 调用后端；动态渲染只用 createElement + textContent，杜绝 innerHTML 注入

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Market Data Lake — Dashboard</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;margin:0;padding:24px;background:#f5f6f8;color:#222}
  h1{font-size:20px;margin:0 0 16px}
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
  button{margin-right:4px;padding:4px 10px;border:1px solid #ccc;border-radius:5px;background:#fff;cursor:pointer;font-size:12px}
  button:hover{background:#f0f2f5}
  button.danger{color:#a50e0e}
  .pager{margin-top:12px;display:flex;gap:8px;align-items:center;font-size:13px}
  .err-msg{color:#a50e0e;font-size:11px;display:block;margin-top:2px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
  .empty{text-align:center;color:#888;padding:24px}
</style>
</head>
<body>
<h1>Market Data Lake — Dashboard</h1>

<div class="stats" id="stats">Loading...</div>

<div class="filters">
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
    <th>Ticker</th><th>Market</th><th>Interval</th><th>Status</th>
    <th>Last updated</th><th>Errors</th><th>Actions</th>
  </tr></thead>
  <tbody id="rows"><tr><td colspan="7">Loading...</td></tr></tbody>
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

  // —— 安全的 DOM 构造工具：所有用户/服务端数据只通过 textContent 注入 ——
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
  function setOnly(parent, child){
    parent.replaceChildren(child);
  }

  function statusPill(r){
    if(!r.is_active) return el('span', {className:'pill paused', text:'Paused'});
    if(r.error_flag) return el('span', {className:'pill err', text:'Error'});
    return el('span', {className:'pill ok', text:'Active'});
  }

  function emptyRow(text, color){
    var tr = document.createElement('tr');
    var td = el('td', {className:'empty', text:text, attrs:{colspan:'7'}});
    if(color) td.style.color = color;
    tr.appendChild(td);
    return tr;
  }

  async function load(){
    var market = document.getElementById('market').value;
    var interval = document.getElementById('interval').value;
    var status = document.getElementById('status').value;
    var params = new URLSearchParams({page: String(page), pageSize: String(PAGE_SIZE)});
    if(market) params.set('market', market);
    if(interval) params.set('interval', interval);
    if(status) params.set('status', status);
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
      setOnly(document.getElementById('rows'), emptyRow('Error: ' + msg, '#a50e0e'));
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

      // Ticker（加粗）
      var tdTicker = document.createElement('td');
      tdTicker.appendChild(el('b', {text: r.ticker}));
      tr.appendChild(tdTicker);

      tr.appendChild(el('td', {text: r.market}));
      tr.appendChild(el('td', {text: r.interval}));

      // Status + 错误信息
      var tdStatus = document.createElement('td');
      tdStatus.appendChild(statusPill(r));
      if(r.error_message){
        tdStatus.appendChild(el('span', {
          className: 'err-msg',
          text: '⚠ ' + String(r.error_message).slice(0, 80),
          title: r.error_message,
        }));
      }
      tr.appendChild(tdStatus);

      tr.appendChild(el('td', {text: fmtTime(r.last_updated_at)}));
      tr.appendChild(el('td', {text: r.error_count}));

      // Actions
      var tdAct = document.createElement('td');
      var primary = el('button', {
        text: r.is_active ? 'Pause' : 'Resume',
        data: { action: r.is_active ? 'pause' : 'resume', ticker: r.ticker, interval: r.interval },
      });
      var retry = el('button', {
        className: 'danger',
        text: 'Retry',
        data: { action: 'retry', ticker: r.ticker, interval: r.interval },
      });
      tdAct.appendChild(primary);
      tdAct.appendChild(document.createTextNode(' '));
      tdAct.appendChild(retry);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    }
  }

  async function act(ticker, interval, action){
    var resp = await fetch('/api/jobs/' + encodeURIComponent(ticker) + '/' + encodeURIComponent(interval) + '/' + action, {method: 'POST'});
    if(!resp.ok){ alert('Failed: ' + (await resp.text())); return; }
    load();
  }

  document.getElementById('refresh').addEventListener('click', function(){ page = 1; load(); });
  document.getElementById('prev').addEventListener('click', function(){ page = Math.max(1, page - 1); load(); });
  document.getElementById('next').addEventListener('click', function(){ page = page + 1; load(); });
  document.addEventListener('change', function(e){
    if(e.target && e.target.matches && e.target.matches('select')){ page = 1; load(); }
  });
  document.addEventListener('click', function(e){
    var btn = e.target && e.target.closest && e.target.closest('button[data-action]');
    if(btn) act(btn.dataset.ticker, btn.dataset.interval, btn.dataset.action);
  });

  load();
  setInterval(load, 30000);
})();
</script>
</body>
</html>
`;
