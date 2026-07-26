/* Neku tablet: pick a sprite, preview it, push it to the Drive staging folder. */
'use strict';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const LS = {
  clientId: 'neku.clientId',
  staging: 'neku.stagingName',
  stagingId: 'neku.stagingId', // cache: "<name>::<folder id>"
  sentOnce: 'neku.sentOnce',
};

/* The laptop stamps this on a staged file the moment it appears on the light
   table (markStagedSeen in laptop/src/main/drive.js). Drive is the only thing
   both surfaces can see, so the stamp is the whole handshake. */
const SEEN_KEY = 'nekuSeen';
const LANDED_POLL_MS = 3000;
const LANDED_GIVE_UP_MS = 150000; // the laptop polls staging every 15s

/* Config priority: what was typed in-app (localStorage) beats what the deployer
   baked into config.js, which beats defaults. A baked build never asks setup questions. */
const BAKED = window.NEKU_CONFIG || {};
const cfgClientId = () => localStorage.getItem(LS.clientId) || BAKED.clientId || '';
const cfgStaging = () =>
  localStorage.getItem(LS.staging) || BAKED.stagingFolder || 'Sprite Staging';

/* Demo mode (add ?demo to the URL): the whole UI with no Google sign-in and no
   upload, so the tablet can be hosted publicly as a portfolio piece. Pick any
   image, watch it "send" and get picked up by an imaginary laptop. It is off by
   default, so a real, configured install is completely untouched by it. */
const DEMO = new URLSearchParams(location.search).has('demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  previewUrl: null,
  token: null, // { access_token, expires_at }
  tokenClient: null,
  sending: false,
  landedTimer: null,
};

/* ---------- views ---------- */

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('on'));
  $(`view-${view}`).classList.add('on');
}

function boot() {
  registerServiceWorker();
  wireEvents();
  if (DEMO) {
    showDemoBanner();
    show('main');
    return;
  }
  if (!cfgClientId()) {
    show('setup');
  } else {
    show('main');
    checkForSharedSprite();
  }
}

/* A quiet strip so a visitor knows nothing is really being uploaded. */
function showDemoBanner() {
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  bar.textContent = 'Demo. Pick any image. Nothing is uploaded and no sign-in is needed.';
  document.body.prepend(bar);
}

/* ---------- events ---------- */

function wireEvents() {
  $('btn-save-setup').addEventListener('click', () => {
    const id = $('in-client-id').value.trim();
    const staging = $('in-staging').value.trim() || 'Sprite Staging';
    if (!id) {
      $('in-client-id').focus();
      return;
    }
    localStorage.setItem(LS.clientId, id);
    localStorage.setItem(LS.staging, staging);
    show('main');
  });

  $('btn-pick').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setFile(f);
    e.target.value = '';
  });

  $('btn-clear').addEventListener('click', clearFile);
  $('btn-send').addEventListener('click', send);
  $('btn-retry').addEventListener('click', send);
  $('btn-error-back').addEventListener('click', () => {
    clearFile();
    show('main');
  });
  $('btn-again').addEventListener('click', () => {
    stopLandedWatch();
    clearFile();
    show('main');
  });

  $('btn-settings').addEventListener('click', () => {
    $('set-client-id').value = cfgClientId();
    $('set-staging').value = cfgStaging();
    $('dlg-settings').showModal();
  });
  $('btn-close-settings').addEventListener('click', () => $('dlg-settings').close());
  $('btn-save-settings').addEventListener('click', () => {
    const id = $('set-client-id').value.trim();
    const staging = $('set-staging').value.trim() || 'Sprite Staging';
    if (id && id !== cfgClientId()) {
      localStorage.setItem(LS.clientId, id);
      state.tokenClient = null; // rebuild against the new client id
      state.token = null;
    }
    if (staging !== cfgStaging()) {
      localStorage.setItem(LS.staging, staging);
      localStorage.removeItem(LS.stagingId);
    }
    $('dlg-settings').close();
    if (cfgClientId()) show('main');
  });
  $('btn-install').addEventListener('click', () => {
    if (!installPrompt) return;
    installPrompt.prompt(); // Chrome takes over from here
    installPrompt = null; // a prompt event is single-use
    $('btn-install').hidden = true;
  });

  $('btn-signout').addEventListener('click', () => {
    const tok = state.token && state.token.access_token;
    if (tok && window.google) {
      google.accounts.oauth2.revoke(tok, () => {});
    }
    state.token = null;
    sessionStorage.removeItem('neku.token');
    $('dlg-settings').close();
  });
}

/* ---------- file selection & preview ---------- */

function setFile(f) {
  clearFile();
  state.file = f;
  state.previewUrl = URL.createObjectURL(f);
  $('preview-img').src = state.previewUrl;
  $('preview-img').hidden = false;
  $('file-name').textContent = f.name;
  $('file-size').textContent = fmtSize(f.size);
  $('filecard').hidden = false;
  $('table-empty').hidden = true;
  $('table').classList.add('checker');
  $('btn-send').hidden = false;
  $('btn-clear').hidden = false;
  $('pick-row').hidden = true;
  $('first-hint').hidden = Boolean(localStorage.getItem(LS.sentOnce));
}

function clearFile() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.file = null;
  state.previewUrl = null;
  $('preview-img').hidden = true;
  $('preview-img').removeAttribute('src');
  $('filecard').hidden = true;
  $('table-empty').hidden = false;
  $('table').classList.remove('checker');
  $('btn-send').hidden = true;
  $('btn-clear').hidden = true;
  $('pick-row').hidden = false;
  $('first-hint').hidden = true;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------- auth (Google Identity Services token client) ---------- */

function getToken() {
  // still-valid token from this session?
  if (!state.token) {
    try {
      const cached = JSON.parse(sessionStorage.getItem('neku.token'));
      if (cached && cached.expires_at) state.token = cached;
    } catch (_) { /* ignore */ }
  }
  if (state.token && state.token.expires_at - 60_000 > Date.now()) {
    return Promise.resolve(state.token.access_token);
  }

  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    return Promise.reject(
      new Error('Google sign-in script has not loaded. Check the connection and retry.')
    );
  }

  return new Promise((resolve, reject) => {
    if (!state.tokenClient) {
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfgClientId(),
        scope: SCOPE,
        callback: () => {},
        error_callback: () => {},
      });
    }
    state.tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(`Google auth: ${resp.error}`));
        return;
      }
      state.token = {
        access_token: resp.access_token,
        expires_at: Date.now() + Number(resp.expires_in || 3600) * 1000,
      };
      sessionStorage.setItem('neku.token', JSON.stringify(state.token));
      resolve(state.token.access_token);
    };
    state.tokenClient.error_callback = (err) => {
      reject(
        new Error(
          err && err.type === 'popup_closed'
            ? 'Sign-in window was closed before finishing.'
            : `Google auth: ${(err && err.type) || 'failed'}`
        )
      );
    };
    // Shows Google's consent UI only when needed; silent when a session exists.
    state.tokenClient.requestAccessToken({ prompt: '' });
  });
}

/* ---------- Drive helpers ---------- */

async function driveFetch(token, url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      const body = await resp.json();
      if (body.error && body.error.message) detail = `${resp.status}: ${body.error.message}`;
    } catch (_) { /* keep status only */ }
    const err = new Error(`Drive ${detail}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

const escQ = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function ensureStagingFolder(token) {
  const name = cfgStaging();

  // cached id still good?
  const cached = localStorage.getItem(LS.stagingId);
  if (cached && cached.startsWith(`${name}::`)) {
    const id = cached.slice(name.length + 2);
    try {
      const f = await driveFetch(token, `${API}/files/${id}?fields=id,trashed`);
      if (!f.trashed) return id;
    } catch (_) { /* fall through to re-find */ }
  }

  const q = encodeURIComponent(
    `name='${escQ(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`
  );
  const found = await driveFetch(
    token,
    `${API}/files?q=${q}&fields=files(id,name)&pageSize=5`
  );
  let id;
  if (found.files && found.files.length > 0) {
    id = found.files[0].id;
  } else {
    const created = await driveFetch(token, `${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    id = created.id;
  }
  localStorage.setItem(LS.stagingId, `${name}::${id}`);
  return id;
}

async function uploadToStaging(token, folderId, file) {
  const metadata = { name: file.name || 'sprite.png', parents: [folderId] };
  const boundary = `neku_${Date.now().toString(36)}`;
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${file.type || 'image/png'}\r\n\r\n`,
      file,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );
  return driveFetch(
    token,
    `${UPLOAD_API}/files?uploadType=multipart&fields=id,name`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  );
}

/* ---------- send ---------- */

async function send() {
  if (!state.file || state.sending) return;
  if (DEMO) return demoSend();
  state.sending = true;
  stopLandedWatch();
  $('busy-name').textContent = state.file.name;
  show('busy');
  try {
    let token = await getToken();
    let uploaded;
    try {
      uploaded = await doSend(token);
    } catch (err) {
      // one silent re-auth + retry on an expired/revoked token
      if (err.status === 401) {
        state.token = null;
        sessionStorage.removeItem('neku.token');
        token = await getToken();
        uploaded = await doSend(token);
      } else {
        throw err;
      }
    }
    localStorage.setItem(LS.sentOnce, '1');
    $('done-name').textContent = state.file.name;
    show('done');
    startLandedWatch(uploaded && uploaded.id);
  } catch (err) {
    $('error-text').textContent = err.message || String(err);
    show('error');
  } finally {
    state.sending = false;
  }
}

async function doSend(token) {
  const folderId = await ensureStagingFolder(token);
  return uploadToStaging(token, folderId, state.file);
}

/* The same three screens a real send walks through (busy -> done -> "the laptop
   has it"), on timers instead of Drive. Never touches Google or the network. */
async function demoSend() {
  state.sending = true;
  stopLandedWatch();
  $('busy-name').textContent = state.file.name;
  show('busy');
  await sleep(1100);
  localStorage.setItem(LS.sentOnce, '1');
  $('done-name').textContent = state.file.name;
  show('done');
  setLanded(false);
  await sleep(1700);
  setLanded(true);
  state.sending = false;
}

/* ---------- did the laptop actually get it? ----------

   Without this the screen just says "sent" and he has no way of knowing whether
   the laptop ever picked it up, which is exactly what makes him send a second
   time and end up with two sprites on the light table. The tablet uploaded the
   file, so it can read that file's appProperties back, and the laptop's stamp
   turns up there within a poll or two. */

/** A token we already hold. Never trigger sign-in from a background poll: the
    popup would be blocked anyway, having had no tap behind it. */
function cachedToken() {
  if (state.token && state.token.expires_at - 60_000 > Date.now()) {
    return state.token.access_token;
  }
  return null;
}

function setLanded(landed) {
  $('landed-strip').hidden = false;
  $('landed-dot').classList.toggle('on', landed);
  $('landed-text').textContent = landed
    ? 'The laptop has it'
    : 'Waiting for the laptop…';
  if (landed) {
    $('done-title').textContent = 'Landed on the laptop';
    $('done-sub').hidden = true;
  }
}

function stopLandedWatch() {
  clearInterval(state.landedTimer);
  state.landedTimer = null;
  $('landed-strip').hidden = true;
  $('landed-dot').classList.remove('on');
  $('done-title').textContent = 'On the laptop side';
  $('done-sub').hidden = false;
}

function startLandedWatch(fileId) {
  stopLandedWatch();
  if (!fileId) return;
  setLanded(false);
  const started = Date.now();
  state.landedTimer = setInterval(async () => {
    if (Date.now() - started > LANDED_GIVE_UP_MS) {
      // no news is not bad news: the file is in staging either way, the laptop
      // just isn't open yet. Leave the last state on screen and stop asking.
      clearInterval(state.landedTimer);
      state.landedTimer = null;
      return;
    }
    const token = cachedToken();
    if (!token) {
      clearInterval(state.landedTimer);
      state.landedTimer = null;
      return;
    }
    try {
      const meta = await driveFetch(token, `${API}/files/${fileId}?fields=appProperties`);
      if (meta.appProperties && meta.appProperties[SEEN_KEY]) {
        clearInterval(state.landedTimer);
        state.landedTimer = null;
        setLanded(true);
      }
    } catch (_) {
      /* a flaky poll is not worth showing; the next one will do */
    }
  }, LANDED_POLL_MS);
}

/* ---------- install button (real "add as app" without menu-hunting) ---------- */

/* Chrome fires beforeinstallprompt only when the page qualifies as an installable
   app AND isn't installed yet, so the button self-hides everywhere it makes no
   sense (installed app, iPad, plain browsers, the Electron check harness). */
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // suppress Chrome's own mini-infobar; our button triggers it
  installPrompt = e;
  $('btn-install').hidden = false;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('btn-install').hidden = true;
});

/* ---------- Web Share Target (share straight from the drawing app) ---------- */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

async function checkForSharedSprite() {
  const params = new URLSearchParams(location.search);
  if (!params.has('share-target')) return;
  history.replaceState(null, '', location.pathname); // don't re-trigger on reload
  try {
    const cache = await caches.open('neku-share');
    const match = await cache.match('shared-sprite');
    if (!match) return;
    const name = decodeURIComponent(match.headers.get('X-Name') || 'sprite.png');
    const type = match.headers.get('Content-Type') || 'image/png';
    const blob = await match.blob();
    await cache.delete('shared-sprite');
    setFile(new File([blob], name, { type }));
  } catch (_) { /* shared file unavailable; user can pick manually */ }
}

boot();
