(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  async function api(url, opts = {}) {
    const r = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Please log in again.'); }
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }

  function toast(msg, isErr) {
    const t = el('div', 'toast' + (isErr ? ' err' : ''), msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  const fmtDate = iso => iso ? new Date(iso).toLocaleString() : '';
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  let data = null;

  function showLogin() { $('login').hidden = false; $('app').hidden = true; $('logout').hidden = true; }
  function showApp() { $('login').hidden = true; $('app').hidden = false; $('logout').hidden = false; }

  /* ---------- Render ---------- */
  function render() {
    const c = data.config, s = data.stats;

    const tiles = $('tiles'); tiles.replaceChildren();
    [
      ['Sign-ins', s.logins], ['Verify runs', s.verifyRuns], ['Unlocked players', s.unlocks],
      ['Downloads', s.downloads], ['Online now', data.activeSessions],
      ['Failed: watch', s.fails.watch], ['Failed: subscribe', s.fails.subscribe],
      ['Failed: like', s.fails.like], ['Failed: comment', s.fails.comment]
    ].forEach(([label, val]) => {
      const t = el('div', 'tile'); t.append(el('b', '', String(val)), el('span', '', label)); tiles.append(t);
    });

    $('siteTitle').value = c.siteTitle;
    $('rewardName').value = c.rewardName;
    $('tagline').value = c.tagline;
    $('videoId').value = c.videoId;
    $('channelId').value = c.channelId;
    ['watch', 'subscribe', 'like', 'comment'].forEach(k => { $('req-' + k).checked = !!c.require[k]; });
    $('watchPercent').value = c.watchPercent;
    $('linkTtlMinutes').value = c.linkTtlMinutes;
    $('maxDownloadsPerUser').value = c.maxDownloadsPerUser;

    $('mode').value = c.download.mode;
    $('url').value = c.download.url;
    toggleMode();
    $('fileInfo').textContent = c.download.fileName
      ? `Current file: ${c.download.fileName} (${fmtSize(c.download.fileSize)})`
      : `No file uploaded yet. Max upload size: ${data.maxUploadMb} MB.`;
    $('delFile').hidden = !c.download.fileName;

    const ub = $('unlocks'); ub.replaceChildren();
    if (!data.unlocks.length) {
      const tr = el('tr'), td = el('td', '', 'Nobody has unlocked the vault yet.'); td.colSpan = 4; tr.append(td); ub.append(tr);
    }
    data.unlocks.forEach(u => {
      const tr = el('tr');
      const who = el('td'); who.append(el('div', '', u.name || '(no name)'), el('div', '', u.channelId));
      who.lastChild.style.cssText = 'color:var(--muted);font-size:.72rem';
      const act = el('td');
      const rev = el('button', 'btn ghost', 'Revoke');
      rev.onclick = async () => { if (confirm('Reset this player? They will need to verify again.')) { await act_(() => api('/admin/api/unlocks/' + encodeURIComponent(u.channelId), { method: 'DELETE' })); } };
      const blk = el('button', 'btn danger', 'Block');
      blk.style.marginLeft = '6px';
      blk.onclick = async () => { if (confirm('Block this account?')) { await act_(() => api('/admin/api/block', { method: 'POST', body: JSON.stringify({ channelId: u.channelId, name: u.name }) })); } };
      act.append(rev, blk);
      tr.append(who, el('td', '', fmtDate(u.lastUnlockedAt)), el('td', '', String(u.downloads)), act);
      ub.append(tr);
    });

    const bb = $('blocked'); bb.replaceChildren();
    if (!data.blocked.length) {
      const tr = el('tr'), td = el('td', '', 'No blocked accounts.'); td.colSpan = 3; tr.append(td); bb.append(tr);
    }
    data.blocked.forEach(b => {
      const tr = el('tr');
      const who = el('td'); who.append(el('div', '', b.name || '(no name)'), el('div', '', b.channelId));
      who.lastChild.style.cssText = 'color:var(--muted);font-size:.72rem';
      const act = el('td'), un = el('button', 'btn ghost', 'Unblock');
      un.onclick = () => act_(() => api('/admin/api/block/' + encodeURIComponent(b.channelId), { method: 'DELETE' }));
      act.append(un);
      tr.append(who, el('td', '', fmtDate(b.at)), act);
      bb.append(tr);
    });
  }

  async function act_(fn) {
    try { await fn(); await load(); toast('Done'); } catch (e) { toast(e.message, true); }
  }

  function toggleMode() {
    const file = $('mode').value === 'file';
    $('fileBox').hidden = !file;
    $('urlBox').hidden = file;
  }

  async function load() {
    data = await api('/admin/api/overview');
    showApp();
    render();
  }

  /* ---------- Actions ---------- */
  $('loginBtn').onclick = async () => {
    $('loginErr').textContent = '';
    try {
      await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) });
      $('pw').value = '';
      await load();
    } catch (e) { $('loginErr').textContent = e.message; }
  };
  $('pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

  $('logout').onclick = async () => { await api('/admin/api/logout', { method: 'POST', body: '{}' }); showLogin(); };

  $('saveCfg').onclick = () => act_(() => api('/admin/api/config', {
    method: 'PUT',
    body: JSON.stringify({
      siteTitle: $('siteTitle').value,
      rewardName: $('rewardName').value,
      tagline: $('tagline').value,
      videoId: $('videoId').value,
      channelId: $('channelId').value,
      watchPercent: $('watchPercent').value,
      linkTtlMinutes: $('linkTtlMinutes').value,
      maxDownloadsPerUser: $('maxDownloadsPerUser').value,
      require: {
        watch: $('req-watch').checked, subscribe: $('req-subscribe').checked,
        like: $('req-like').checked, comment: $('req-comment').checked
      }
    })
  }));

  $('mode').onchange = async () => {
    toggleMode();
    try {
      await api('/admin/api/config', { method: 'PUT', body: JSON.stringify({ download: { mode: $('mode').value } }) });
      toast('Delivery mode saved');
    } catch (e) { toast(e.message, true); }
  };
  $('saveUrl').onclick = () => act_(() => api('/admin/api/config', {
    method: 'PUT', body: JSON.stringify({ download: { mode: 'url', url: $('url').value } })
  }));
  $('delFile').onclick = () => { if (confirm('Remove the uploaded file?')) act_(() => api('/admin/api/file', { method: 'DELETE' })); };

  $('blockBtn').onclick = () => act_(async () => {
    await api('/admin/api/block', { method: 'POST', body: JSON.stringify({ channelId: $('blockId').value }) });
    $('blockId').value = '';
  });

  // Upload with progress (raw PUT, streamed to disk by the server)
  $('fileInput').onchange = () => {
    const f = $('fileInput').files[0];
    if (!f) return;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/admin/api/upload?name=' + encodeURIComponent(f.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = Math.round(e.loaded / e.total * 100);
      $('upBar').style.width = pct + '%';
      $('upText').textContent = `Uploading ${pct}%`;
    };
    xhr.onload = async () => {
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 200) { $('upText').textContent = 'Upload complete.'; await load(); toast('File uploaded'); }
      else { $('upText').textContent = j.error || 'Upload failed.'; toast(j.error || 'Upload failed', true); }
      $('fileInput').value = '';
    };
    xhr.onerror = () => { $('upText').textContent = 'Upload failed.'; toast('Upload failed', true); };
    xhr.send(f);
  };

  /* ---------- Boot ---------- */
  load().catch(() => showLogin());
})();
