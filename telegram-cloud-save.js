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
  const SYNC_INTERVAL = 25000;
  const STALL_LIMIT = 12000;
  const tg = window.Telegram?.WebApp || null;
  const isTelegram = Boolean(tg?.initData && tg?.initDataUnsafe?.user?.id);
  const userId = isTelegram ? String(tg.initDataUnsafe.user.id) : null;
  let cloud = isTelegram ? tg.CloudStorage : null;
  let booted = false, enabled = false, running = false, queued = false;
  let savedText = null, pendingText = null, debounce = null, lastError = null;
  let active = null, lastSyncedAt = 0, retryDelay = 0, flushing = null;

  function status(message, kind = 'info', sticky = false) {
    let n = document.getElementById('zona-cloud-status');
    if (!n) {
      n = document.createElement('div'); n.id = 'zona-cloud-status';
      n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite');
      n.style.cssText = 'position:fixed;bottom:78px;left:50%;transform:translateX(-50%);z-index:10020;max-width:calc(100% - 28px);padding:7px 12px;border-radius:7px;background:#14241a;box-shadow:0 3px 22px #000b;border:1px solid #355d42;color:#e7f6e7;font:11px/1.5 sans-serif;text-align:center;pointer-events:none;opacity:.96';
      document.body.append(n);
    }
    n.style.borderColor = kind === 'error' ? '#be5151' : kind === 'success' ? '#36ae72' : '#52694a';
    n.textContent = message;
    n.hidden = !message;
    clearTimeout(n._hide);
    if (!sticky && message) n._hide = setTimeout(() => { n.hidden = true; }, 3700);
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
  function schedule(delay = 1800) {
    if (!isTelegram || !enabled || !pendingText || pendingText === savedText) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {flush().catch(console.error);}, delay);
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
    if (running) {queued = true; return flushing;}
    running = true;
    flushing = (async () => {
      try {
        do {
          queued = false;
          const text = pendingText;
          if (!text || text === savedText) break;
          await writeBank(text);
        } while (queued || (pendingText && pendingText !== savedText));
      } catch (error) {
        lastError = error;
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : 7000, 60000);
        console.error('[ZONA] Cloud save failed', error);
        status('⚠ Не удалось сохранить в Telegram: ' + error.message, 'error', true);
        if (enabled) schedule(retryDelay);
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
      if (!text || text === savedText) return;
      pendingText = text;
      schedule();
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
    if (isTelegram) {const saveButton = document.getElementById('zona-save-now');if (saveButton) saveButton.style.display = 'inline-flex';}
    if (isTelegram && window.game?.state) {
      queueSave(window.game.state); // Migrate legacy save or persist initialization updates.
      setInterval(() => {if (window.game?.state) queueSave(window.game.state);}, SYNC_INTERVAL);
      document.addEventListener('visibilitychange', () => {if (document.hidden) {queueSave(window.game?.state);flush().catch(console.error);}});
      window.addEventListener('pagehide', () => {queueSave(window.game?.state);flush().catch(console.error);});
    }
  }
  window.addEventListener('DOMContentLoaded', () => {boot().catch(e => fatal(String(e)));}, {once:true});
})();
