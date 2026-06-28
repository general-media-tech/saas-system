/* ════════════════════════════════════════════════════════════════
   GMT-CACHE — طبقة تخزين محلي موحّدة (IndexedDB) لكل أنظمة GMT
   ════════════════════════════════════════════════════════════════
   الهدف: تحميل البيانات الثابتة (منتجات/أسماء/صور/تصنيفات) مرة واحدة
   فقط، وتخزينها بالمتصفح، بحيث لا تُعاد من Supabase إلا عند تغيّرها
   فعلياً — لتقليل Supabase Egress وتسريع فتح التطبيق.

   البيانات السريعة التغيّر (الكميات بالفروع) تُحدَّث بطلب خفيف منفصل
   (id + أعمدة الفروع فقط، بدون صور ولا نصوص) في كل فتح للتطبيق.

   هذا الملف مشترك بين: نظام الجرد، فواتير الشراء، وأداة الربط —
   يكفي تضمينه بوسم <script src="gmt-cache.js"></script> في كل ملف.
   ════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const DB_NAME = 'gmt_local_cache';
  const DB_VERSION = 1;
  const STORES = ['inv_products', 'store_products', 'images', 'meta'];

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in global)) {
        reject(new Error('IndexedDB غير مدعوم في هذا المتصفح'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('inv_products'))   db.createObjectStore('inv_products',   { keyPath: 'id' });
        if (!db.objectStoreNames.contains('store_products')) db.createObjectStore('store_products', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images'))         db.createObjectStore('images',         { keyPath: 'url' });
        if (!db.objectStoreNames.contains('meta'))           db.createObjectStore('meta',           { keyPath: 'key' });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error('فشل فتح IndexedDB'));
    });
    return _dbPromise;
  }

  function tx(storeName, mode) {
    return openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    const store = await tx(storeName, 'readonly');
    return reqToPromise(store.getAll());
  }

  async function bulkPut(storeName, rows) {
    if (!rows || !rows.length) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      const store = t.objectStore(storeName);
      rows.forEach(r => store.put(r));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async function bulkDelete(storeName, keys) {
    if (!keys || !keys.length) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      const store = t.objectStore(storeName);
      keys.forEach(k => store.delete(k));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async function clearStore(storeName) {
    const store = await tx(storeName, 'readwrite');
    return reqToPromise(store.clear());
  }

  async function metaGet(key) {
    const store = await tx('meta', 'readonly');
    const r = await reqToPromise(store.get(key));
    return r ? r.value : undefined;
  }
  async function metaSet(key, value) {
    const store = await tx('meta', 'readwrite');
    return reqToPromise(store.put({ key, value }));
  }

  // ── تخزين الصور كـ Blob — لا تُعاد من Supabase Storage إلا مرة واحدة أبداً ──
  async function cacheImage(url) {
    if (!url) return url;
    try {
      const store = await tx('images', 'readonly');
      const hit = await reqToPromise(store.get(url));
      if (hit && hit.blob) return URL.createObjectURL(hit.blob);
    } catch (_) {}
    // غير موجود محلياً — حمّله مرة واحدة واحفظه كـ Blob دائماً
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) return url;
      const blob = await resp.blob();
      const wstore = await tx('images', 'readwrite');
      reqToPromise(wstore.put({ url, blob, cachedAt: Date.now() })).catch(()=>{});
      return URL.createObjectURL(blob);
    } catch (e) {
      // فشل الشبكة (غير متصل) — أعد الرابط الأصلي كحل بديل
      return url;
    }
  }

  // ── شريط/شاشة "التحميل لأول مرة" ──
  function showBootOverlay(msg) {
    let el = document.getElementById('gmt-cache-boot-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gmt-cache-boot-overlay';
      el.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(255,255,255,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"Cairo",sans-serif;gap:16px;direction:rtl;';
      el.innerHTML = `
        <div style="width:46px;height:46px;border:4px solid #f3f4f6;border-top-color:#C41230;border-radius:50%;animation:gmtspin .8s linear infinite;"></div>
        <div id="gmt-cache-boot-msg" style="font-size:14px;font-weight:800;color:#374151;"></div>
        <div id="gmt-cache-boot-sub" style="font-size:11px;font-weight:600;color:#9ca3af;"></div>
        <style>@keyframes gmtspin{to{transform:rotate(360deg)}}</style>`;
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
    document.getElementById('gmt-cache-boot-msg').textContent = msg || 'سيتم تحميل بيانات النظام لأول مرة...';
  }
  function updateBootProgress(text) {
    const sub = document.getElementById('gmt-cache-boot-sub');
    if (sub) sub.textContent = text || '';
  }
  function hideBootOverlay() {
    const el = document.getElementById('gmt-cache-boot-overlay');
    if (el) el.style.display = 'none';
  }

  // ── طلب REST بسيط لـ Supabase ──
  async function sbGet(sbConfig, path) {
    const r = await fetch(sbConfig.url + path, {
      headers: { apikey: sbConfig.key, Authorization: 'Bearer ' + sbConfig.key }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // كاش لمعرفة هل عمود updated_at موجود فعلياً بجدول معيّن (يُفحص مرة واحدة فقط)
  const _hasUpdatedAtCache = {};
  async function probeUpdatedAt(sbConfig, table) {
    if (table in _hasUpdatedAtCache) return _hasUpdatedAtCache[table];
    try {
      await sbGet(sbConfig, `/rest/v1/${table}?select=updated_at&limit=1`);
      _hasUpdatedAtCache[table] = true;
    } catch (_) {
      _hasUpdatedAtCache[table] = false;
    }
    return _hasUpdatedAtCache[table];
  }

  /**
   * مزامنة ذكية لمجموعة منتجات بين Supabase و IndexedDB.
   * @param {Object} opts
   *  - name: اسم object store المحلي ('inv_products' أو 'store_products')
   *  - table: اسم الجدول بـ Supabase (مثال: 'products')
   *  - sbConfig: {url, key}
   *  - liveFields: أعمدة "سريعة التغيّر" (الكميات) تُحدَّث في كل تحميل بطلب خفيف منفصل
   *  - idField: اسم عمود المعرّف (افتراضي 'id')
   *  - imageField: اسم عمود رابط الصورة (افتراضي 'image_url') — null لتعطيل كاش الصور
   *  - onProgress: (msg) => void
   *  - pageSize: حجم الصفحة عند التحميل الكامل الأول (افتراضي 1000)
   * @returns {Promise<{rows:Array, fromCache:boolean, offline:boolean}>}
   */
  async function syncCollection(opts) {
    const {
      name, table, sbConfig,
      liveFields = [], idField = 'id', imageField = 'image_url',
      onProgress = () => {}, pageSize = 1000
    } = opts;

    const bootKey = name + ':bootstrapped';
    const syncKey = name + ':last_sync';
    let offline = false;

    const bootstrapped = await metaGet(bootKey);

    if (!bootstrapped) {
      // ── أول تحميل بالكامل ──
      showBootOverlay('سيتم تحميل بيانات النظام لأول مرة...');
      try {
        let all = [];
        let from = 0;
        while (true) {
          updateBootProgress(`جارٍ تحميل المنتجات... (${all.length})`);
          const page = await sbGet(sbConfig, `/rest/v1/${table}?select=*&order=${idField}.asc&limit=${pageSize}&offset=${from}`);
          all = all.concat(page);
          if (page.length < pageSize) break;
          from += pageSize;
        }
        await clearStore(name);
        await bulkPut(name, all);
        await metaSet(bootKey, true);
        await metaSet(syncKey, new Date().toISOString());

        // كاش الصور بالخلفية (لا يوقف عمل التطبيق)
        if (imageField) {
          updateBootProgress(`جارٍ تحميل الصور... (0/${all.length})`);
          let done = 0;
          const CONCURRENCY = 6;
          let idx = 0;
          await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
            while (idx < all.length) {
              const row = all[idx++];
              if (row[imageField]) await cacheImage(row[imageField]).catch(() => {});
              done++;
              if (done % 10 === 0) updateBootProgress(`جارٍ تحميل الصور... (${done}/${all.length})`);
            }
          }));
        }
        hideBootOverlay();
      } catch (e) {
        hideBootOverlay();
        offline = true;
        console.warn('[gmt-cache] فشل التحميل الأول، سيعمل النظام بدون بيانات مؤقتاً:', e.message);
      }
    } else {
      // ── مزامنة خفيفة: فقط ما تغيّر فعلياً منذ آخر مزامنة ──
      try {
        const lastSync = (await metaGet(syncKey)) || new Date(0).toISOString();
        const hasUpdatedAt = await probeUpdatedAt(sbConfig, table);
        let changed = [];
        if (hasUpdatedAt) {
          changed = await sbGet(sbConfig, `/rest/v1/${table}?select=*&updated_at=gt.${encodeURIComponent(lastSync)}&order=updated_at.asc&limit=2000`);
        } else {
          // لا يوجد عمود updated_at بالجدول بعد — fallback: أعد كل الصفوف (بيانات نصية خفيفة فقط، الصور تبقى مخزّنة)
          changed = await sbGet(sbConfig, `/rest/v1/${table}?select=*&order=${idField}.asc&limit=5000`);
        }
        if (changed.length) {
          await bulkPut(name, changed);
          // صور جديدة/متغيّرة فقط
          if (imageField) {
            for (const row of changed) {
              if (row[imageField]) cacheImage(row[imageField]).catch(() => {});
            }
          }
        }
        await metaSet(syncKey, new Date().toISOString());
      } catch (e) {
        offline = true;
        console.warn('[gmt-cache] تعذّرت المزامنة الخفيفة — العمل بالبيانات المحلية المخزّنة:', e.message);
      }
    }

    // ── تحديث الكميات الحيّة (دائماً، حتى لو لم تتغيّر بيانات أخرى) ──
    let rows = await getAll(name);
    if (!offline && liveFields.length) {
      try {
        const selectCols = [idField, ...liveFields].join(',');
        const liveRows = await sbGet(sbConfig, `/rest/v1/${table}?select=${selectCols}&limit=20000`);
        const liveMap = {};
        liveRows.forEach(r => { liveMap[r[idField]] = r; });
        rows = rows.map(r => liveMap[r[idField]] ? { ...r, ...liveMap[r[idField]] } : r);
        await bulkPut(name, rows);
      } catch (e) {
        offline = true;
        console.warn('[gmt-cache] تعذّر تحديث الكميات الحيّة — استخدام آخر نسخة محفوظة محلياً:', e.message);
      }
    }

    return { rows, fromCache: !!bootstrapped, offline };
  }

  global.GMTCache = {
    openDB, getAll, bulkPut, bulkDelete, clearStore,
    metaGet, metaSet, cacheImage,
    showBootOverlay, updateBootProgress, hideBootOverlay,
    syncCollection,
    isOnline: () => navigator.onLine !== false
  };
})(window);
