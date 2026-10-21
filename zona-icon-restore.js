/* ZONA: restore the correct inventory/trader icons after a Telegram cloud load.
 * Presentation only. Never modifies player state, inventory IDs, or save data.
 * Uses each item's canonical ID -> image mapping from the existing game.
 */
(() => {
  'use strict';
  window.addEventListener('zona:ready', () => {
    const g = window.game;
    const items = typeof DB !== 'undefined' ? DB.items : window.DB?.items;
    if (!g || !items || typeof g.itemIconURL !== 'function') return;
    const VERSION = '20261021-icon-sync';
    const escape = value => String(value).replace(/[&<>"']/g,
      character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
    // Do not use an inventory position or a saved icon URL to identify an item.
    function source(id) {
      if (!id || !Object.prototype.hasOwnProperty.call(items,id)) return '';
      const item = items[id];
      let path = item.buildingOnly && item.imagePath ? item.imagePath : g.itemIconURL(id);
      if (!path || typeof path !== 'string') return '';
      try {
        const resolved = new URL(path, document.baseURI);
        if (resolved.origin !== location.origin ||
            !/\/zona-item-icons\//.test(resolved.pathname)) return '';
        resolved.searchParams.set('z_icon_fix', VERSION);
        return resolved.href;
      } catch (_) { return ''; }
    }
    function makeImage(id, className) {
      const src = source(id);
      if (!src) return null;
      const image = document.createElement('img');
      image.className = className;
      image.src = src;
      image.alt = items[id]?.name || id;
      image.decoding = 'async';
      image.loading = 'lazy';
      image.dataset.itemId = id;
      return image;
    }
    function repair(target, id) {
      if (!target || !id || !items[id]) return;
      const src = source(id);
      if (!src) return; // Don't remove an existing drawing if an asset isn't mapped.
      const current = target.querySelector('img.item-portrait[data-item-id]');
      if (current && current.dataset.itemId === id && current.src === src &&
          target.children.length === 1) return;
      const image = makeImage(id,'item-portrait');
      if (!image) return;
      target.classList.remove('typed-item-art');
      target.classList.add('unique-item-art');
      target.dataset.iconId = id;
      target.removeAttribute('data-visual-type');
      target.title = items[id]?.name || id;
      target.style.setProperty('background', 'none', 'important');
      target.style.setProperty('background-image', 'none', 'important');
      target.replaceChildren(image);
    }
    // Use canonical image IDs for any UI that reads DB.items[id].icon directly.
    for (const [id, item] of Object.entries(items)) {
      if (!item) continue;
      const src = source(id);
      if (src) item.icon = '<img class="item-inline-icon" src="' + escape(src) +
        '" alt="' + escape(item.name || id) + '" decoding="async">';
    }
    let scheduled = false;
    function refresh() {
      scheduled = false;
      for (const selector of ['#inv-items-list', '#trader-list']) {
        const root = document.querySelector(selector);
        if (!root) continue;
        for (const card of root.querySelectorAll(':scope > .card[data-item-id]')) {
          const id = card.dataset.itemId;
          // Some cards are dynamically rewritten by other display layers.
          repair(card.querySelector('.supply-symbol'),id);
        }
      }
      for (const slot of ['weapon','armor','artifact']) {
        repair(document.querySelector('#slot-' + slot + ' .slot-picture'),
          g.state?.equipment?.[slot]);
      }
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(refresh);
    }
    const observer = new MutationObserver(schedule);
    for (const selector of ['#inv-items-list','#trader-list',
      '#slot-weapon','#slot-armor','#slot-artifact']) {
      const node = document.querySelector(selector);
      if (node) observer.observe(node,{childList:true});
    }
    // First pass also repairs cards drawn before all icon layers were set up.
    schedule();
    // Convenient manual diagnostic, doesn't affect save data.
    window.ZonaRepairItemIcons = refresh;
  });
})();
