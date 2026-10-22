/* ZONA — cloud saves for Telegram Mini Apps.
 * Requires the official https://telegram.org/js/telegram-web-app.js SDK.
 * All game bootstrap listeners use 'zona:ready', dispatched after cloud recovery.
 * The server-less CloudStorage API is scoped by Telegram to the bot + Telegram user.
 */
(() => {
  'use strict';
  const LOCAL_KEY = 'zona_z_save_v10';
  const BOUND_KEY = 'zona_telegram_cloud_bound_user_v1';
  const HEAD = 'ZONA_V1_HEAD';
  const CHUNK_SIZE = 3000; // Telegram limit is 4096 UTF-16 characters per value.
  const MAX_PARTS = 350; // two banks fit within 1024 cloud keys.
  const SYNC_INTERVAL = 180000; // Automatic cloud sync once every three minutes.
  const STALL_LIMIT = 12000;
  const tg = window.Telegram?.WebApp || null;
  const isTelegram = Boolean(tg?.initData && tg?.initDataUnsafe?.user?.id);
  const userId = isTelegram ? String(tg.initDataUnsafe.user.id) : null;
  let cloud = isTelegram ? tg.CloudStorage : null;
  let booted = false, enabled = false, running = false, queued = false;
  let savedText = null, pendingText = null, debounce = null, lastError = null;
  let active = null, lastSyncedAt = 0, retryDelay = 0, flushing = null;

  // A lightweight PDA-style notification. It never claims a cloud save succeeded
  // until Telegram has confirmed the bank contents and the HEAD pointer write.
  function installNoticeStyles() {
    if (document.getElementById('zona-pda-save-styles')) return;
    const css = document.createElement('style');
    css.id = 'zona-pda-save-styles';
    css.textContent = `
      #zona-cloud-status{position:fixed;z-index:100050;right:max(14px,calc((100vw - 1180px)/2 + 18px));bottom:96px;width:min(350px,calc(100vw - 28px));min-height:70px;box-sizing:border-box;pointer-events:none;display:flex;align-items:center;gap:11px;padding:12px 15px 13px 13px;overflow:hidden;border-radius:5px;border:1px solid #6b6747;background:linear-gradient(125deg,rgba(27,31,24,.985),rgba(12,19,15,.985));box-shadow:inset 3px 0 0 #c6a55d,0 8px 26px #000b,0 0 21px #c6a55d18;color:#e9e7dc;font-family:'Segoe UI',Arial,sans-serif;animation:zonaPdaNoticeIn .28s ease-out}
      #zona-cloud-status[hidden]{display:none!important}
      #zona-cloud-status:before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.08;background:repeating-linear-gradient(to bottom,transparent 0,transparent 3px,#fff 4px)}
      #zona-cloud-status .zona-pda-symbol{position:relative;flex:0 0 39px;height:39px;display:flex;align-items:center;justify-content:center;border:1px solid #b9a46d5e;border-radius:4px;background:#c6a55d13;color:#e2bf77;font:700 23px/1 monospace;text-shadow:0 0 10px #c6a55d5c}
      #zona-cloud-status .zona-pda-copy{position:relative;min-width:0;flex:1}
      #zona-cloud-status .zona-pda-kicker{font:700 9px/1.5 Consolas,monospace;color:#a3a78f;letter-spacing:1.6px;margin-bottom:2px}
      #zona-cloud-status .zona-pda-title{font:800 11px/1.5 'Segoe UI',Arial,sans-serif;letter-spacing:.7px;color:#edcd8f}
      #zona-cloud-status .zona-pda-description{font:11px/1.4 'Segoe UI',Arial,sans-serif;color:#d6d5c8;overflow-wrap:anywhere}
      #zona-cloud-status .zona-pda-line{position:absolute;bottom:0;left:0;width:100%;height:2px;background:linear-gradient(90deg,#e8be6f,#88ab82 75%,transparent);opacity:.8}
      #zona-cloud-status[data-kind="error"]{border-color:#a55342;box-shadow:inset 3px 0 0 #d6725d,0 8px 26px #000b,0 0 20px #b7433220}
      #zona-cloud-status[data-kind="error"] .zona-pda-title,#zona-cloud-status[data-kind="error"] .zona-pda-symbol{color:#f3a38b}
      #zona-cloud-status[data-kind="error"] .zona-pda-line{background:linear-gradient(90deg,#df755f,transparent)}
      #zona-cloud-status[data-kind="info"] .zona-pda-symbol{animation:zonaPdaBlink 1.4s ease-in-out infinite}
      @keyframes zonaPdaNoticeIn{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
      @keyframes zonaPdaBlink{50%{opacity:.45}}
      @media(max-width:550px){#zona-cloud-status{right:14px;bottom:90px;max-width:calc(100vw - 28px);padding:10px 12px}#zona-cloud-status .zona-pda-symbol{flex-basis:35px;height:35px}}
      @media(prefers-reduced-motion:reduce){#zona-cloud-status,#zona-cloud-status .zona-pda-symbol{animation:none!important}}
    `;
    (document.head || document.body).append(css);
  }
  function status(message, kind = 'info', sticky = false) {
    installNoticeStyles();
    let n = document.getElementById('zona-cloud-status');
    if (!n) {
      n = document.createElement('div');
      n.id = 'zona-cloud-status';
      n.setAttribute('role', 'status');
      n.setAttribute('aria-live', 'polite');
      const symbol = document.createElement('div');symbol.className = 'zona-pda-symbol';
      const copy = document.createElement('div');copy.className = 'zona-pda-copy';
      const kicker = document.createElement('div');kicker.className = 'zona-pda-kicker';
      const title = document.createElement('div');title.className = 'zona-pda-title';
      const description = document.createElement('div');description.className = 'zona-pda-description';
      const line = document.createElement('div');line.className = 'zona-pda-line';
      copy.append(kicker, title, description);
      n.append(symbol, copy, line);
      document.body.append(n);
      n._views = {symbol, kicker, title, description};
    }
    const loaded = kind === 'success' && /загружен/i.test(message);
    const upToDate = kind === 'success' && /актуален/i.test(message);
    n.dataset.kind = kind;
    n.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    n._views.symbol.textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : '↻';
    n._views.kicker.textContent = 'ZONA  /  КПК  /  CLOUD';
    n._views.title.textContent = kind === 'error' ? 'ОШИБКА СОХРАНЕНИЯ' : loaded ? 'ПРОГРЕСС ВОССТАНОВЛЕН' : upToDate ? 'ПРОГРЕСС АКТУАЛЕН' : kind === 'success' ? 'ПРОГРЕСС СОХРАНЁН' : 'СИНХРОНИЗАЦИЯ КПК';
    n._views.description.textContent = kind === 'success' ? loaded ? 'Данные получены из облака Telegram' : upToDate ? 'В облаке уже последняя версия' : 'Облачное хранилище Telegram · готово' : String(message).replace(/^[☁⚠]\s*/, '');
    n.hidden = !message;
    clearTimeout(n._hide);
    if (!sticky && message) n._hide = setTimeout(() => { n.hidden = true; }, kind === 'success' ? 3200 : 4400);
  }

  function fatal(message) {
    console.error('[ZONA CloudStorage]', message);
    const overlay = document.createElement('div');
    overlay.id = 'zona-cloud-blocker';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#08120d;color:#e1f3e2;display:flex;align-items:center;justify-content:center;padding:30px;text-align:center;font:14px/1.7 sans-serif';
    const container = document.createElement('div');
    container.style.cssText = 'max-width:390px';
    const title = document.createElement('h2');title.textContent = 'Облачное сохранение недоступно';title.style.color = '#f4c66b';
    const desc = document.createElement('p');desc.textContent = message + ' Игра не запущена, чтобы не перезаписать сохранение.';
    const retry = document.createElement('button');retry.textContent = 'Попробовать снова';
    retry.style.cssText = 'border:1px solid #30c27c;border-radius:8px;background:#143522;color:white;padding:12px 20px;margin-top:18px;font-size:14px';
    retry.addEventListener('click', () => location.reload());
    container.append(title, desc, retry);overlay.append(container);document.body.append(overlay);
  }

  function invoke(method, ...args) {
    return new Promise((resolve, reject) => {
      if (!cloud || typeof cloud[method] !== 'function') return reject(new Error('CloudStorage API is unavailable'));
      const timer = setTimeout(() => reject(new Error('Telegram CloudStorage: timeout ' + method)), STALL_LIMIT);
      try {
        cloud[method](...args, (err, result) => {
          clearTimeout(timer);
          if (err) reject(new Error(String(err.message || err)));
          else if ((method === 'setItem' || method === 'removeItem') && result === false) reject(new Error(method + ' returned false'));
          else resolve(result);
        });
      } catch (error) {clearTimeout(timer);reject(error);}
    });
  }
  const get = (key) => invoke('getItem', key);
  const put = (key, value) => invoke('setItem', key, value);
  const partKey = (bank, index) => `ZONA_V1_${bank}_${String(index).padStart(3, '0')}`;
  const metaKey = (bank) => `ZONA_V1_${bank}_META`;

  function checksum(s) { // FNV-1a in UTF-16; detects incomplete or corrupted cloud reads.
    let hash = 2166136261;
    for (let i = 0; i < s.length; i++) {hash ^= s.charCodeAt(i);hash = Math.imul(hash, 16777619);}
    return (hash >>> 0).toString(16);
  }
  function split(s) {
    const result = [];
    for (let i = 0; i < s.length; i += CHUNK_SIZE) result.push(s.slice(i, i + CHUNK_SIZE));
    if (result.length > MAX_PARTS) throw new Error('Прогресс слишком большой для Telegram CloudStorage');
    return result;
  }
  function parsedState(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.inventory)) throw new Error('Повреждены данные сохранения');
    return value;
  }
  async function readBank(bank, expected) {
    const raw = await get(metaKey(bank));
    if (!raw) throw new Error('Отсутствует индекс резервного сохранения ' + bank);
    const meta = JSON.parse(raw);
    if (!Number.isInteger(meta.parts) || meta.parts < 1 || meta.parts > MAX_PARTS || !meta.checksum) throw new Error('Повреждён индекс сохранения');
    if (expected?.checksum && meta.checksum !== expected.checksum) throw new Error('Несовпадение версии сохранения');
    let chunks = [];
    // Read in bounded batches to avoid a large burst of Telegram requests.
    for (let start = 0; start < meta.parts; start += 24) {
      const keys = Array.from({length: Math.min(24, meta.parts - start)}, (_, j) => partKey(bank, start + j));
      const map = await invoke('getItems', keys);
      chunks.push(...keys.map(k => {
        if (!map || typeof map[k] !== 'string') throw new Error('Не хватает части сохранения: ' + k);
        return map[k];
      }));
    }
    const text = chunks.join('');
    if (checksum(text) !== meta.checksum || text.length !== meta.length) throw new Error('Контрольная сумма сохранения не совпадает');
    parsedState(text);
    return {text, bank, meta};
  }
  async function loadCloud() {
    const rawHead = await get(HEAD);
    if (rawHead) {
      let head;
      try {head = JSON.parse(rawHead);} catch (_) {throw new Error('Повреждён указатель облачного сохранения');}
      if (head.deleted === true) return {deleted:true};
      if (!['A','B'].includes(head.bank)) throw new Error('Некорректный указатель сохранения');
      try {return await readBank(head.bank, head);} catch (error) {
        console.warn('[ZONA] Main cloud bank damaged, reading backup:', error);
        try {return await readBank(head.bank === 'A' ? 'B' : 'A');}
        catch (_) {throw new Error('Основное и резервное облачные сохранения недоступны: ' + error.message);}
      }
    }
    // Recover a crash that happened before the pointer was committed on the first save.
    const ma = await get(metaKey('A'));
    const mb = await get(metaKey('B'));
    if (ma || mb) {
      const banks = [ma && 'A', mb && 'B'].filter(Boolean);
      for (const b of banks) {try {return await readBank(b);} catch (e) {console.warn('[ZONA] Bad uncommitted bank', e);}}
      throw new Error('Найдено повреждённое незавершённое сохранение');
    }
    return null;
  }
  function localWrite(text) {
    try {localStorage.setItem(LOCAL_KEY, text);} catch (e) {console.warn('[ZONA] Local cache unavailable', e);}
  }
  async function writeBank(text) {
    const bank = active === 'A' ? 'B' : 'A';
    const chunks = split(text);
    const stamp = {bank, parts:chunks.length, checksum:checksum(text), length:text.length, savedAt:Date.now(), version:1};
    // Update only inactive bank; keep previous version readable until HEAD is committed.
    for (let i = 0; i < chunks.length; i += 5) {
      await Promise.all(chunks.slice(i, i + 5).map((piece, k) => put(partKey(bank, i+k), piece)));
    }
    await put(metaKey(bank), JSON.stringify(stamp));
    await put(HEAD, JSON.stringify(stamp)); // Commit pointer LAST.
    active = bank;
    savedText = text;
    lastSyncedAt = Date.now();
    lastError = null;
    retryDelay = 0;
    status('☁ Прогресс сохранён в Telegram', 'success');
  }
  async function flush() {
    if (!isTelegram || !enabled) return;
    if (running) return flushing;
    running = true;
    flushing = (async () => {
      try {
        const text = pendingText;
        if (text && text !== savedText) await writeBank(text);
        // Changes made during this upload wait for the next scheduled sync.
      } catch (error) {
        lastError = error;
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : 7000, 60000);
        console.error('[ZONA] Cloud save failed', error);
        status('⚠ Не удалось сохранить в Telegram: ' + error.message, 'error', true);
        // Retry on the next three-minute tick, or on an explicit save.
        throw error;
      } finally {running = false;flushing = null;}
    })();
    return flushing;
  }
  function queueSave(state) {
    if (!isTelegram) return;
    if (!enabled) return;
    try {
      const text = JSON.stringify(state);
      if (!text) return;
      pendingText = text;
    } catch (e) {lastError = e;status('⚠ Ошибка сериализации прогресса', 'error', true);}
  }
  async function clearForReset() {
    if (!isTelegram) return;
    enabled = false;
    clearTimeout(debounce);
    if (flushing) await flushing;
    await put(HEAD, JSON.stringify({deleted:true,savedAt:Date.now(),version:1}));
    active = null;savedText = null;pendingText = null;
  }
  const api = {isTelegram, queueSave, flush, reset:clearForReset,
    get status() {return {telegram:isTelegram, ready:booted, savedAt:lastSyncedAt, error:lastError?.message || null};}};
  window.ZonaTelegramCloud = api;

  async function boot() {
    if (booted) return;
    if (isTelegram) {
      try {
        tg.ready();
        if (!cloud || typeof cloud.getItems !== 'function' || typeof cloud.setItem !== 'function') throw new Error('Обновите Telegram: CloudStorage недоступен');
        status('☁ Загрузка прогресса из Telegram…', 'info', true);
        const data = await loadCloud();
        const prevUser = localStorage.getItem(BOUND_KEY);
        if (prevUser && prevUser !== userId) {
          // Do not leak one Telegram user's local cache into another user's profile.
          localStorage.removeItem(LOCAL_KEY);
          localStorage.removeItem('zona_z_save_v9');
          localStorage.removeItem('zona_z_save_v5');
        }
        localStorage.setItem(BOUND_KEY, userId);
        if (data?.deleted) {
          localStorage.removeItem(LOCAL_KEY);localStorage.removeItem('zona_z_save_v9');localStorage.removeItem('zona_z_save_v5');
          savedText = null;active = null;
        } else if (data?.text) {
          localWrite(data.text);
          // Clear stale legacy fallback saves: v10 now always has precedence.
          savedText = data.text;active = data.bank;
          status('☁ Прогресс загружен из Telegram', 'success');
        } else {
          // On first cloud launch, retain and migrate any previously stored progress.
          status('☁ Первое сохранение будет создано автоматически');
        }
      } catch (error) {
        lastError = error;
        fatal('Telegram не ответил или сохранение повреждено. ' + error.message);
        return; // NEVER start a fresh game when we cannot read the existing cloud save.
      }
    }
    booted = true;
    window.dispatchEvent(new Event('zona:ready'));
    enabled = isTelegram;
    if (isTelegram) {
      const saveButton = document.getElementById('zona-save-now');
      if (saveButton) {
        saveButton.style.display = 'inline-flex';
        saveButton.onclick = async () => {
          try {
            window.game?.saveState?.();
            const before = lastSyncedAt;
            await flush();
            if (before === lastSyncedAt) status('Прогресс актуален', 'success');
          } catch (e) {
            // flush() already displays a themed error notification.
            console.warn('[ZONA] Manual cloud save failed', e);
          }
        };
      }
    }
    if (isTelegram && window.game?.state) {
      queueSave(window.game.state); // Migrate legacy save or persist initialization updates.
      setInterval(() => {if (window.game?.state) {queueSave(window.game.state);flush().catch(console.error);}}, SYNC_INTERVAL);
      document.addEventListener('visibilitychange', () => {if (document.hidden) {queueSave(window.game?.state);flush().catch(console.error);}});
      window.addEventListener('pagehide', () => {queueSave(window.game?.state);flush().catch(console.error);});
    }
  }
  window.addEventListener('DOMContentLoaded', () => {boot().catch(e => fatal(String(e)));}, {once:true});
})();
