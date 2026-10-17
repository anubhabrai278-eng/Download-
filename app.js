(() => {
  const $ = s => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  async function api(url, opts) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(j.error || 'Request failed'); err.data = j; throw err; }
    return j;
  }

  const QUESTS = {
    watch:     { title: 'Watch the video',            hint: 'Press play and let the bar fill. Skipping ahead does not count.' },
    subscribe: { title: 'Subscribe to the channel',   hint: 'Subscribe on YouTube, then come back and verify.' },
    like:      { title: 'Like the video',             hint: 'Give the video a like on YouTube.' },
    comment:   { title: 'Comment on the video',       hint: 'Post a comment on the video, then verify.' }
  };

  let S = null, player = null, beatTimer = null;

  function setMsg(text, isErr) {
    const m = $('#msg');
    m.textContent = text || '';
    m.classList.toggle('err', !!isErr);
  }

  function activeKeys() { return Object.keys(QUESTS).filter(k => S.config.require[k]); }

  function render() {
    const c = S.config;
    document.title = c.siteTitle;
    $('#brand').textContent = c.siteTitle;
    $('#title').textContent = c.siteTitle;
    $('#tagline').textContent = c.tagline;

    $('#badge').hidden = !S.user;
    if (S.user) {
      $('#uname').textContent = S.user.name;
      if (S.user.avatar) $('#avatar').src = S.user.avatar; else $('#avatar').removeAttribute('src');
    }
    $('#signin').hidden = !!S.user || !S.configured;
    $('#questPanel').hidden = !S.configured;
    $('#verify').disabled = !S.user;

    if (!S.configured) { $('#tagline').textContent = 'The vault is not set up yet. Check back soon.'; return; }

    const steps = (S.progress && S.progress.steps) || {};
    const keys = activeKeys();

    const meter = $('#meter'); meter.replaceChildren();
    keys.forEach(k => meter.append(el('i', steps[k] && steps[k].ok ? 'on' : '')));

    const list = $('#quests'); list.replaceChildren();
    keys.forEach(k => {
      const st = steps[k];
      const li = el('li', 'quest ' + (st ? (st.ok ? 'ok' : 'bad') : ''));
      li.append(el('span', 'chip', st ? (st.ok ? 'DONE' : 'RETRY') : 'LOCKED'));
      const body = el('div');
      body.append(el('div', 'qtitle', QUESTS[k].title));
      body.append(el('div', 'qhint', st && !st.ok && st.msg ? st.msg : QUESTS[k].hint));
      if (k === 'watch') {
        const bar = el('div', 'bar'), fill = el('i'); fill.id = 'watchFill';
        bar.append(fill); body.append(bar);
      }
      li.append(body);
      if (k === 'subscribe' || k === 'like' || k === 'comment') {
        const a = el('a', 'btn ghost', k === 'subscribe' ? 'Subscribe' : 'Open video');
        a.href = k === 'subscribe'
          ? `https://www.youtube.com/channel/${encodeURIComponent(c.channelId)}?sub_confirmation=1`
          : `https://www.youtube.com/watch?v=${encodeURIComponent(c.videoId)}`;
        a.target = '_blank'; a.rel = 'noopener';
        li.append(a);
      }
      list.append(li);
    });
    updateWatch();
  }

  function updateWatch() {
    const f = $('#watchFill');
    if (!f || !S.progress || !S.progress.requiredSeconds) return;
    const pct = Math.min(100, Math.round(S.progress.watchSeconds / S.progress.requiredSeconds * 100));
    f.style.width = pct + '%';
  }

  /* ---- Watch tracking: heartbeat only while the video is actually playing ---- */
  async function beat(playing) {
    if (!S || !S.user) return;
    try {
      const r = await api('/api/beat', { method: 'POST', body: JSON.stringify({ playing }) });
      S.progress.watchSeconds = r.watchSeconds;
      if (r.requiredSeconds) S.progress.requiredSeconds = r.requiredSeconds;
      updateWatch();
    } catch (e) {
      if (e.message.startsWith('Sign in')) { S.user = null; render(); }
    }
  }
  function onPlayerState(ev) {
    const playing = ev.data === 1; // YT.PlayerState.PLAYING
    clearInterval(beatTimer);
    beat(playing);
    if (playing) beatTimer = setInterval(() => beat(true), 5000);
  }
  function loadPlayer() {
    window.onYouTubeIframeAPIReady = () => {
      player = new YT.Player('player', {
        videoId: S.config.videoId,
        playerVars: { rel: 0, playsinline: 1 },
        events: { onStateChange: onPlayerState }
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  }

  /* ---- Verify ---- */
  $('#verify').addEventListener('click', async () => {
    const btn = $('#verify');
    btn.disabled = true; btn.textContent = 'Scanning...'; setMsg('');
    try {
      const r = await api('/api/verify', { method: 'POST', body: '{}' });
      S.progress.steps = r.steps;
      render();
      if (r.unlocked) showLoot(r);
      else setMsg('Some quests are not done yet. Finish them and verify again.', true);
    } catch (e) {
      if (e.data && e.data.steps) { S.progress.steps = e.data.steps; render(); }
      setMsg(e.message, true);
    } finally {
      btn.textContent = 'Verify my quests';
      btn.disabled = !S.user;
    }
  });

  function showLoot(r) {
    $('#lootTitle').textContent = 'Vault unlocked: ' + S.config.rewardName;
    $('#lootNote').textContent = `Your link works for ${r.ttlMinutes} minutes.`;
    $('#claim').href = r.downloadUrl;
    $('#loot').hidden = false;
    $('#loot').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---- Boot ---- */
  (async () => {
    const err = new URLSearchParams(location.search).get('error');
    try {
      S = await api('/api/state');
      render();
      if (err) setMsg(err, true);
      if (S.configured) loadPlayer();
    } catch (e) {
      $('#tagline').textContent = 'Could not reach the server. Reload to try again.';
    }
  })();
})();
