// ==UserScript==
// @name         B站动态广告过滤（UP主推荐/带货商品/淘宝闪购）
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  过滤B站动态带货广告。默认直接过滤；Alt+Shift+A 或 ?adfMark=1 可临时切到只标记模式
// @author       You
// @match        *://t.bilibili.com/*
// @match        *://www.bilibili.com/*
// @match        *://space.bilibili.com/*
// @match        *://m.bilibili.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== 配置 ===================== */
  const DEFAULT_KEYWORDS = ['UP主的推荐', '淘宝闪购', '密令', '淘口令', '【广告】'];
  const KEY_MODE = 'biliAdf.mode';
  const KEY_KW = 'biliAdf.keywords';

  // 配置存在浏览器本地，刷新/重开脚本都保留；读不到则用默认值。
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  // URL 带 ?adfMark=1 临时进入高亮模式（不改持久设置）
  const urlMark = /(?:^|&)adfMark=1(?:&|$)/.test(location.search);

  const CONFIG = {
    // 'filter' = 真正过滤（默认）；'mark' = 只高亮标记不过滤
    mode: urlMark ? 'mark' : load(KEY_MODE, 'filter'),

    // 过滤时：true = 隐藏整条动态；false = 只摘掉商品卡，保留文字
    hideWholeItem: true,

    // 文本关键词（可在控制台改，见文件末尾 __biliAdFilter 一系列方法）
    keywords: load(KEY_KW, DEFAULT_KEYWORDS.slice()),

    // 接口层拦截（仅 filter 模式生效；广告不进入 DOM）
    hookNetwork: true,

    // 标记模式下，标签上是否显示命中原因
    showReason: true,

    // 过滤模式下是否显示「已过滤 N」角标（标记模式必定显示）
    showBadge: false,

    // 兜底轮询间隔(ms)，0 = 只靠 MutationObserver
    watchInterval: 1500
  };

  if (CONFIG.mode !== 'mark' && CONFIG.mode !== 'filter') CONFIG.mode = 'filter';
  if (!Array.isArray(CONFIG.keywords)) CONFIG.keywords = DEFAULT_KEYWORDS.slice();
  CONFIG.keywords = CONFIG.keywords.filter(k => typeof k === 'string' && k);
  /* ================================================ */

  const MARKED = 'data-ad-marked';     // 已标记
  const HIDDEN = 'data-ad-hidden';     // 已隐藏
  const TAG = 'bili-adf-tag';

  // DOM 层广告特征
  const AD_SELECTORS = [
    '[class*="card-goods"]',
    'a.goods-taobao',
    'a[href*="uland.taobao.com"]',
    'a[href*="uland.tmall.com"]',
    'a[href*="s.click.taobao.com"]',
    'a[href*="item.taobao.com"]',
    'a[href*="detail.tmall.com"]',
    'a[href*="taobao.com/ccoupon"]',
    'a[href*="mobile.yangkeduo.com"]',
    'a[href*="union.jd.com"]',
    'a[href*="item.jd.com"]'
  ];
  const AD_SELECTOR = AD_SELECTORS.join(',');

  // 接口层广告特征（只扫 module_dynamic，开销极小）
  const AD_JSON_RE =
    /uland\.taobao\.com|s\.click\.taobao\.com|item\.taobao\.com|detail\.tmall\.com|uland\.tmall\.com|union\.jd\.com|mobile\.yangkeduo\.com|goods-taobao|module_goods|ADDITIONAL_TYPE_GOODS|UP主的推荐/;

  // 只有「接口层」需要累加计数（每次响应只发生一次）；
  // DOM 层的数量一律从当前 DOM 实际状态统计，避免重复扫描导致虚高。
  let netCount = 0;
  let hookOn = false;
  let lastShown = -1;

  const isMark = () => CONFIG.mode === 'mark';

  /* ================= ① 接口层拦截 ================= */

  const isFeedUrl = u => /(web-dynamic|dynamic\/v\d|\/opus|\/feed)/i.test(u || '');
  const isGoodsType = t => typeof t === 'string' && /GOODS/i.test(t);

  function isAdItem(it) {
    const mods = it && it.modules;
    if (!mods) return false;
    if (mods.module_goods) return true;

    const add = mods.module_additional;
    if (add && (isGoodsType(add.type) || add.module_goods)) return true;

    const dyn = mods.module_dynamic;
    if (!dyn) return false;
    if (dyn.additional && isGoodsType(dyn.additional.type)) return true;

    const s = JSON.stringify(dyn);
    return s.length < 100000 && AD_JSON_RE.test(s);
  }

  function cleanList(arr) {
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const el = arr[i];
      if (el && typeof el === 'object' && isAdItem(el)) {
        arr.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  // 先试已知字段，命中就不做全量递归
  function stripAds(data) {
    if (!data || typeof data !== 'object') return 0;

    for (const r of [data, data.data]) {
      if (!r) continue;
      for (const key of ['items', 'cards', 'list', 'dynamics']) {
        if (Array.isArray(r[key])) {
          const n = cleanList(r[key]);
          if (n) return n;
        }
      }
    }

    let n = 0;
    const seen = new Set();
    (function walk(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && node.some(e => e && e.modules)) n += cleanList(node);
        node.forEach(walk);
        return;
      }
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          const v = node[k];
          if (v && typeof v === 'object') walk(v);
        }
      }
    })(data);
    return n;
  }

  let origFetch = null, origOpen = null, origSend = null;

  function installNetworkHook() {
    if (hookOn) return;
    hookOn = true;

    /* ---- fetch ---- */
    origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = origFetch.call(this, input, init);
      if (!isFeedUrl(url)) return p;

      return p.then(res => {
        const ct = (res.headers && res.headers.get('content-type')) || '';
        if (!/json/i.test(ct)) return res;
        return res.clone().text().then(txt => {
          let data;
          try { data = JSON.parse(txt); } catch (e) { return res; }
          const n = stripAds(data);
          if (!n) return res;
          netCount += n;
          updateBadge();
          const nr = new Response(JSON.stringify(data), {
            status: res.status, statusText: res.statusText, headers: res.headers
          });
          ['url', 'ok', 'redirected', 'type'].forEach(k => {
            try { Object.defineProperty(nr, k, { value: res[k], configurable: true }); } catch (e) {}
          });
          return nr;
        }).catch(() => res);
      });
    };

    /* ---- XMLHttpRequest ---- */
    const P = XMLHttpRequest.prototype;
    origOpen = P.open;
    origSend = P.send;

    P.open = function (m, u) {
      this.__adfUrl = String(u || '');
      return origOpen.apply(this, arguments);
    };

    P.send = function () {
      if (isFeedUrl(this.__adfUrl)) {
        this.addEventListener('readystatechange', function () {
          if (this.readyState !== 4 || this.status !== 200) return;
          if (this.responseType && this.responseType !== 'text') return;
          try {
            const data = JSON.parse(this.responseText);
            const n = stripAds(data);
            if (!n) return;
            const txt = JSON.stringify(data);
            Object.defineProperty(this, 'responseText', { value: txt, configurable: true });
            Object.defineProperty(this, 'response', { value: txt, configurable: true });
            netCount += n;
            updateBadge();
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function uninstallNetworkHook() {
    if (!hookOn) return;
    hookOn = false;
    if (origFetch) window.fetch = origFetch;
    if (origOpen) XMLHttpRequest.prototype.open = origOpen;
    if (origSend) XMLHttpRequest.prototype.send = origSend;
    origFetch = origOpen = origSend = null;
  }

  /* ================= ② DOM 层 ================= */

  function injectStyle() {
    if (document.getElementById('bili-adf-style')) return;
    const s = document.createElement('style');
    s.id = 'bili-adf-style';
    s.textContent =
      '[data-ad-hidden]{display:none!important}' +
      '[data-ad-marked]{outline:2px dashed #ff4d4f!important;outline-offset:3px;' +
      'background:rgba(255,77,79,.07)!important;border-radius:6px}' +
      '.' + TAG + '{position:absolute;top:6px;right:8px;z-index:2147483647;' +
      'padding:2px 8px;border-radius:999px;background:#ff4d4f;color:#fff;' +
      'font:bold 11px/1.7 system-ui,sans-serif;pointer-events:none;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35);max-width:70%;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
    (document.head || document.documentElement).appendChild(s);
  }

  // 返回命中的原因，未命中返回 null
  function matchReason(el) {
    for (const s of AD_SELECTORS) {
      try { if (el.querySelector(s)) return s; } catch (e) {}
    }
    const text = el.textContent || '';
    for (const k of CONFIG.keywords) if (text.includes(k)) return '关键词 ' + k;
    return null;
  }

  function markItem(item, reason) {
    let tag = item.querySelector(':scope > .' + TAG);
    if (item.getAttribute(MARKED) === reason && tag) return; // 状态没变，不重复劳动

    item.setAttribute(MARKED, reason);
    if (item.style.position !== 'relative' &&
        getComputedStyle(item).position === 'static') {
      item.style.position = 'relative';  // 只在第一次标记时读一次布局
    }
    if (!tag) {
      tag = document.createElement('div');
      tag.className = TAG;
      item.appendChild(tag);
    }
    tag.textContent = CONFIG.showReason ? '广告 · ' + reason : '广告';
  }

  // 撤销标记（节点被 B 站复用成正常动态时自愈）
  function unmarkItem(item) {
    if (!item.hasAttribute(MARKED)) return;
    item.removeAttribute(MARKED);
    const tag = item.querySelector(':scope > .' + TAG);
    if (tag) tag.remove();
    if (item.style.position === 'relative') item.style.position = '';
  }

  function hideItem(item) {
    if (item.getAttribute(HIDDEN) === '1') return;
    item.setAttribute(HIDDEN, '1');
    item.style.setProperty('display', 'none', 'important');
  }

  function unhideItem(item) {
    if (!item.hasAttribute(HIDDEN)) return;
    item.removeAttribute(HIDDEN);
    item.style.display = '';
  }

  function scan() {
    injectStyle();

    // 列表页优先按「最外层条目」处理；详情页没有列表容器时再退回单条结构
    const outer = document.querySelectorAll('.bili-dyn-list__item');
    const list = outer.length
      ? outer
      : document.querySelectorAll('.bili-dyn-item, .opus-item');

    for (const item of list) {
      const reason = matchReason(item);

      if (reason) {
        if (isMark()) {
          markItem(item, reason);
        } else if (CONFIG.hideWholeItem) {
          hideItem(item);
        } else {
          item.querySelectorAll('[class*="card-goods"]').forEach(hideItem);
        }
      } else {
        // 不再命中 → 清理残留（规则调整 / 虚拟列表复用节点）
        unmarkItem(item);
        unhideItem(item);
        item.querySelectorAll('[' + HIDDEN + ']').forEach(unhideItem);
      }
    }

    updateBadge();
  }

  // 清空所有标记 / 隐藏，用于切换模式
  function reset() {
    document
      .querySelectorAll('[' + MARKED + '],[' + HIDDEN + ']')
      .forEach(el => {
        el.removeAttribute(MARKED);
        el.removeAttribute(HIDDEN);
        el.style.display = '';
        if (el.style.position === 'relative') el.style.position = '';
      });
    document.querySelectorAll('.' + TAG).forEach(t => t.remove());
    netCount = 0;
    lastShown = -1;
    updateBadge();
  }

  /* ================= 角标 ================= */

  // 数量直接从当前 DOM 实际状态统计，不做累加，天然不会虚高
  function countDom() {
    return document.querySelectorAll('[' + MARKED + '],[' + HIDDEN + ']').length;
  }

  function updateBadge() {
    if (!document.body) return;
    if (!isMark() && !CONFIG.showBadge) return;

    const domN = countDom();
    const total = isMark() ? domN : domN + netCount;
    const exists = document.getElementById('bili-adf-badge');
    if (exists && total === lastShown) return;
    lastShown = total;

    let el = exists;
    if (!el) {
      el = document.createElement('div');
      el.id = 'bili-adf-badge';
      Object.assign(el.style, {
        position: 'fixed', right: '14px', bottom: '14px', zIndex: '2147483647',
        padding: '6px 12px', borderRadius: '999px', pointerEvents: 'none',
        color: '#fff', font: '12px/1.5 system-ui,sans-serif', whiteSpace: 'nowrap'
      });
      document.body.appendChild(el);
    }
    if (isMark()) {
      el.style.background = 'rgba(255,77,79,.9)';
      el.textContent = '标记模式 · 已标记 ' + domN + ' 条（未过滤）';
    } else {
      el.style.background = 'rgba(0,0,0,.7)';
      el.textContent = '已过滤 ' + total + '（接口 ' + netCount + ' / 页面 ' + domN + '）';
    }
  }

  /* ================= 对外接口 ================= */

  function toast(text) {
    let el = document.getElementById('bili-adf-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bili-adf-toast';
      Object.assign(el.style, {
        position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '2147483647', padding: '8px 16px', borderRadius: '8px',
        background: 'rgba(0,0,0,.85)', color: '#fff',
        font: '13px/1.6 system-ui,sans-serif', pointerEvents: 'none',
        transition: 'opacity .3s'
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  function setMode(mode) {
    mode = mode === 'mark' ? 'mark' : 'filter';
    if (CONFIG.mode === mode) return;
    CONFIG.mode = mode;
    save(KEY_MODE, CONFIG.mode);
    reset();
    if (!isMark() && CONFIG.hookNetwork) installNetworkHook();
    else uninstallNetworkHook();
    scan();
    toast(isMark() ? '高亮模式已开启（只标记，不过滤）' : '高亮模式已关闭（开始过滤）');
  }

  function setKeywords(list) {
    CONFIG.keywords = Array.from(new Set(list.filter(k => typeof k === 'string' && k)));
    save(KEY_KW, CONFIG.keywords);
    scan();
  }

  if (!isMark() && CONFIG.hookNetwork) installNetworkHook();

  function boot() {
    scan();

    const mo = new MutationObserver(muts => {
      let dirty = false;
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains(TAG)) continue; // 跳过自己插的标签
          dirty = true;
        }
      }
      if (dirty) schedule();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    if (CONFIG.watchInterval > 0) setInterval(scan, CONFIG.watchInterval);

    // 快捷键 Alt + Shift + A 切换高亮 / 过滤
    document.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        setMode(isMark() ? 'filter' : 'mark');
      }
    });

    window.__biliAdFilter = {
      setMode,                                   // 'mark' | 'filter'
      config: CONFIG,
      count: () => ({ dom: countDom(), net: netCount }),

      getKeywords: () => CONFIG.keywords.slice(),
      addKeyword: (...words) => {
        setKeywords(CONFIG.keywords.concat(words));
        toast('已添加关键词：' + words.join('、'));
      },
      removeKeyword: (...words) => {
        setKeywords(CONFIG.keywords.filter(k => words.indexOf(k) < 0));
        toast('已移除关键词：' + words.join('、'));
      },
      resetKeywords: () => {
        setKeywords(DEFAULT_KEYWORDS.slice());
        toast('关键词已恢复默认');
      }
    };
  }

  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
