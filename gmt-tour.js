/* ════════════════════════════════════════════════════════════════
   gmt-tour.js — البرنامج التعليمي المشترك لكل ملفات GMT Systems
   ════════════════════════════════════════════════════════════════
   يحتوي:
   1) class GMTTour            — الجولة التفاعلية (تمييز عنصر + بطاقة شرح)
   2) runLoadingSequence()     — شريط تحميل أول فتح + قرار إظهار الترحيب
   3) showWelcomeSlides()      — شاشات تعريفية بالشركة (٥ شرائح)
   4) restartTour()            — دالة عامة لزر "إعادة الجولة" في كل ملف

   طريقة الاستخدام في كل ملف HTML (مثال index__17_.html):
   ──────────────────────────────────────────────────────────────
     <script>
       const PAGE_ID = 'inventory';   // أول <script> في الملف
     </script>
     ...
     <script src="gmt-tour.js"></script>   <!-- قبل </body> -->
     <script>
       const inventoryTourSteps = [ {target:'#id', icon:'🔍', title:'...', description:'...'}, ... ];
       window._gmtTour = new GMTTour(inventoryTourSteps, 'tour_done_' + PAGE_ID);
       runLoadingSequence([
         { label:'تهيئة الاتصال...', fn: initSupabase },
         { label:'تحميل المنتجات...', fn: loadProducts },
       ]);
     </script>
   ──────────────────────────────────────────────────────────────
   ملاحظة: PAGE_ID يجب أن يكون معرَّفاً (متغيّر عام) قبل استدعاء
   runLoadingSequence() لأنها تستخدمه لبناء مفاتيح localStorage.
   ════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ════════════════════════════════════════════════════
  // 1) GMTTour — محرك الجولة التفاعلية
  // ════════════════════════════════════════════════════
  class GMTTour {
    constructor(steps, storageKey) {
      this.steps      = Array.isArray(steps) ? steps : [];
      this.storageKey = storageKey;
      this.current    = 0;
      this.overlay    = null;
      this.card       = null;
    }

    isDone() {
      try { return localStorage.getItem(this.storageKey) === 'true'; }
      catch (e) { return true; } // لو التخزين معطّل، لا تُحرج المستخدم بجولة لا تُحفظ
    }

    start(force = false) {
      if (!this.steps.length) return;
      if (this.isDone() && !force) return;
      this.cleanupExisting();
      this.current = 0;
      this.createOverlay();
      this.showStep(0);
    }

    cleanupExisting() {
      document.getElementById('gmt-tour-overlay')?.remove();
      document.getElementById('gmt-tour-card')?.remove();
    }

    createOverlay() {
      this.overlay = document.createElement('div');
      this.overlay.id = 'gmt-tour-overlay';
      this.overlay.style.cssText = `
        position:fixed;inset:0;z-index:999999;pointer-events:none;
        background:rgba(0,0,0,0.5);
      `;

      this.card = document.createElement('div');
      this.card.id = 'gmt-tour-card';
      this.card.style.cssText = `
        position:fixed;z-index:9999999;
        background:white;border-radius:16px;padding:20px 24px;
        max-width:320px;box-shadow:0 20px 60px rgba(0,0,0,0.3);
        font-family:'Cairo',sans-serif;direction:rtl;
        pointer-events:all;
      `;

      document.body.appendChild(this.overlay);
      document.body.appendChild(this.card);
    }

    showStep(index) {
      const step = this.steps[index];
      if (!step) { this.finish(); return; }

      const target = step.target ? document.querySelector(step.target) : null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline       = '3px solid #C41230';
        target.style.outlineOffset = '4px';
        target.style.borderRadius  = '8px';
        target.style.position      = target.style.position || 'relative';
        target.style.zIndex        = '1000000';

        setTimeout(() => {
          const rect = target.getBoundingClientRect();
          const cardH = this.card.offsetHeight || 220;
          let top = rect.bottom + 12 + cardH < window.innerHeight
            ? rect.bottom + 12
            : Math.max(12, rect.top - cardH - 12);
          this.card.style.top   = top + 'px';
          this.card.style.right = '16px';
          this.card.style.left  = '';
          this.card.style.transform = '';
        }, 0);
      } else {
        this.card.style.top   = '50%';
        this.card.style.right = '50%';
        this.card.style.transform = 'translate(50%,-50%)';
      }

      this.card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <span style="font-size:11px;color:#9ca3af;font-weight:700;">
            ${index + 1} / ${this.steps.length}
          </span>
          <button onclick="window._gmtTour.skip()"
            style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;">✕</button>
        </div>
        <div style="font-size:20px;margin-bottom:8px;">${step.icon || '💡'}</div>
        <div style="font-size:15px;font-weight:900;color:#111827;margin-bottom:8px;">
          ${step.title || ''}
        </div>
        <div style="font-size:13px;color:#374151;line-height:1.7;margin-bottom:16px;">
          ${step.description || ''}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          ${index > 0 ? `
            <button onclick="window._gmtTour.prev()"
              style="background:#f3f4f6;color:#374151;border:none;padding:8px 16px;
                     border-radius:8px;font-family:'Cairo',sans-serif;font-weight:700;cursor:pointer;">
              ← السابق
            </button>
          ` : ''}
          <button onclick="window._gmtTour.next()"
            style="background:#C41230;color:white;border:none;padding:8px 20px;
                   border-radius:8px;font-family:'Cairo',sans-serif;font-weight:800;cursor:pointer;">
            ${index === this.steps.length - 1 ? '✅ فهمت!' : 'التالي →'}
          </button>
        </div>
      `;
    }

    next() {
      this.clearHighlight();
      this.current++;
      if (this.current >= this.steps.length) this.finish();
      else this.showStep(this.current);
    }

    prev() {
      this.clearHighlight();
      this.current = Math.max(0, this.current - 1);
      this.showStep(this.current);
    }

    skip() {
      if (confirm('هل تريد تخطي الجولة التعليمية؟ يمكنك إعادتها في أي وقت من زر "إعادة الجولة".')) {
        this.finish();
      }
    }

    clearHighlight() {
      const step = this.steps[this.current];
      if (!step || !step.target) return;
      const target = document.querySelector(step.target);
      if (target) {
        target.style.outline       = '';
        target.style.outlineOffset = '';
        target.style.zIndex        = '';
      }
    }

    finish() {
      this.clearHighlight();
      this.overlay?.remove();
      this.card?.remove();
      try { localStorage.setItem(this.storageKey, 'true'); } catch (e) {}
    }
  }

  // دالة عامة لزر "🎓 إعادة الجولة" — أضِفها في أي ملف:
  // <button onclick="restartTour()">🎓 إعادة الجولة</button>
  function restartTour() {
    if (global._gmtTour) global._gmtTour.start(true);
    else console.warn('[gmt-tour] لا توجد جولة معرَّفة لهذه الصفحة (window._gmtTour غير موجود)');
  }

  // ════════════════════════════════════════════════════
  // 2) شاشة التحميل + تشغيل خطوات التحميل الفعلية
  // ════════════════════════════════════════════════════
  function ensureLoadingScreen() {
    if (document.getElementById('gmt-loading-screen')) return;
    const el = document.createElement('div');
    el.id = 'gmt-loading-screen';
    el.style.cssText = `
      position:fixed;inset:0;z-index:9999999;
      background:linear-gradient(135deg, #C41230 0%, #8B0000 100%);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      font-family:'Cairo',sans-serif;direction:rtl;
      transition:opacity 0.5s;
    `;
    el.innerHTML = `
      <div style="margin-bottom:24px;">
        <img src="logo.jpg" style="height:80px;filter:brightness(0) invert(1);"
             onerror="this.style.display='none'">
      </div>
      <div style="color:white;font-size:24px;font-weight:900;margin-bottom:4px;">General Media Tech</div>
      <div style="color:rgba(255,255,255,0.7);font-size:13px;font-weight:700;margin-bottom:32px;">مجموعة ميديا تيك التجارية</div>
      <div style="width:240px;background:rgba(255,255,255,0.2);border-radius:999px;height:6px;margin-bottom:12px;">
        <div id="gmt-loading-bar" style="width:0%;height:100%;background:white;border-radius:999px;transition:width 0.3s ease;"></div>
      </div>
      <div id="gmt-loading-text" style="color:rgba(255,255,255,0.8);font-size:11px;font-weight:700;">جارٍ تحميل الموارد...</div>
    `;
    document.body.appendChild(el);
  }

  // steps = [{ label: 'نص...', fn: async () => {...} }, ...]
  async function runLoadingSequence(steps) {
    ensureLoadingScreen();
    const bar  = document.getElementById('gmt-loading-bar');
    const text = document.getElementById('gmt-loading-text');
    const total = (steps && steps.length) || 1;

    for (let i = 0; i < (steps || []).length; i++) {
      try {
        if (text) text.textContent = steps[i].label || '';
        if (typeof steps[i].fn === 'function') await steps[i].fn();
      } catch (e) {
        console.warn('[gmt-tour] فشلت خطوة تحميل:', steps[i].label, e?.message || e);
      }
      if (bar) bar.style.width = ((i + 1) / total * 100) + '%';
      await new Promise(r => setTimeout(r, 120));
    }

    const screen = document.getElementById('gmt-loading-screen');
    if (screen) {
      screen.style.opacity = '0';
      setTimeout(() => screen.remove(), 500);
    }

    const pid = global.PAGE_ID || 'page';
    const onboardKey = 'gmt_onboarded_' + pid;
    let onboarded = true;
    try { onboarded = !!localStorage.getItem(onboardKey); } catch (e) {}

    if (!onboarded) {
      showWelcomeSlides();
    } else {
      const tourKey = 'tour_done_' + pid;
      let tourDone = true;
      try { tourDone = localStorage.getItem(tourKey) === 'true'; } catch (e) {}
      if (!tourDone) setTimeout(() => global._gmtTour?.start(), 500);
    }
  }

  // ════════════════════════════════════════════════════
  // 3) شاشات الترحيب التعريفية (Onboarding Slides)
  // ════════════════════════════════════════════════════
  const welcomeSlides = [
    {
      icon: '🏢',
      bg: 'linear-gradient(135deg,#C41230,#8B0000)',
      title: 'أهلاً بك في GMT Systems',
      subtitle: 'نظام إدارة محاسبي ذكي',
      body: 'صُمِّم هذا النظام خصيصاً لـ <b>مجموعة ميديا تيك التجارية</b> (General Media Tech) لإدارة المبيعات، المخزون، والشحن عبر جميع الفروع.'
    },
    {
      icon: '👤',
      bg: 'linear-gradient(135deg,#1d4ed8,#1e3a8a)',
      title: 'الإدارة المركزية',
      subtitle: 'المدير العام: محمد خير زيتوني',
      body: 'يُشرف المدير العام على كل العمليات من لوحة الأدمن. كل تصرف تقوم به في النظام — كل فاتورة، كل نقل، كل بيع — <b>مرئي بالكامل للإدارة</b> في الوقت الفعلي.'
    },
    {
      icon: '👁️',
      bg: 'linear-gradient(135deg,#d97706,#92400e)',
      title: 'الشفافية الكاملة',
      subtitle: 'كل شيء مُسجَّل ومُتتبَّع',
      body: '✅ كل فاتورة بيع — مسجلة باسمك<br>✅ كل نقل بضاعة — يحتاج توقيع<br>✅ كل تحصيل — يدخل الصندوق مباشرة<br>✅ الأدمن يرى كل شيء لحظة بلحظة<br><br><b>العمل بنزاهة يحميك ويحمي الجميع.</b>'
    },
    {
      icon: '🏪',
      bg: 'linear-gradient(135deg,#059669,#064e3b)',
      title: 'الفروع والأقسام',
      subtitle: 'نظام متكامل لكل نقطة بيع',
      body: 'كل فرع لديه:<br>📦 <b>مخزون مستقل</b> — تتابعه بالجرد<br>💰 <b>صندوق خاص</b> — يظهر غلتك اليومية<br>📋 <b>سجل كامل</b> — مشتريات + نقل + مبيعات<br>🚚 <b>نظام نقل</b> — بين الفروع بفواتير رسمية'
    },
    {
      icon: '🚀',
      bg: 'linear-gradient(135deg,#7c3aed,#4c1d95)',
      title: 'جاهز للبدء؟',
      subtitle: 'الجولة التعليمية ستشرح كل شيء',
      body: 'ستظهر لك الآن جولة تفاعلية قصيرة تشرح كل زر وكل ميزة في هذه الصفحة.<br><br>يمكنك إعادة الجولة في أي وقت من زر "🎓 إعادة الجولة".'
    }
  ];

  function showWelcomeSlides() {
    let current = 0;
    document.getElementById('welcome-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'welcome-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999998;
      display:flex;align-items:center;justify-content:center;
      font-family:'Cairo',sans-serif;direction:rtl;padding:16px;
    `;

    function renderSlide(idx) {
      const s = welcomeSlides[idx];
      overlay.style.background = s.bg;
      overlay.innerHTML = `
        <div style="max-width:400px;width:100%;text-align:center;color:white;">
          <div style="display:flex;gap:6px;justify-content:center;margin-bottom:32px;">
            ${welcomeSlides.map((_, i) => `
              <div style="width:${i === idx ? 24 : 8}px;height:8px;border-radius:999px;
                          background:${i === idx ? 'white' : 'rgba(255,255,255,0.3)'};
                          transition:all 0.3s;"></div>
            `).join('')}
          </div>
          <div style="font-size:64px;margin-bottom:16px;">${s.icon}</div>
          <div style="font-size:22px;font-weight:900;margin-bottom:6px;">${s.title}</div>
          <div style="font-size:13px;font-weight:700;opacity:0.8;margin-bottom:24px;">${s.subtitle}</div>
          <div style="font-size:14px;line-height:1.9;opacity:0.9;margin-bottom:40px;
                      background:rgba(0,0,0,0.15);border-radius:16px;padding:20px;text-align:right;">
            ${s.body}
          </div>
          <div style="display:flex;gap:12px;justify-content:center;">
            ${idx > 0 ? `
              <button onclick="window._gmtWelcomeChangeSlide(-1)"
                style="background:rgba(255,255,255,0.2);color:white;border:none;
                       padding:12px 24px;border-radius:12px;font-family:'Cairo',sans-serif;
                       font-size:13px;font-weight:700;cursor:pointer;">← السابق</button>
            ` : ''}
            <button onclick="window._gmtWelcomeChangeSlide(1)"
              style="background:white;color:#374151;border:none;
                     padding:12px 32px;border-radius:12px;font-family:'Cairo',sans-serif;
                     font-size:14px;font-weight:900;cursor:pointer;
                     box-shadow:0 4px 16px rgba(0,0,0,0.2);">
              ${idx === welcomeSlides.length - 1 ? '🚀 ابدأ الجولة' : 'التالي →'}
            </button>
          </div>
          ${idx < welcomeSlides.length - 1 ? `
            <button onclick="window._gmtWelcomeSkip()"
              style="background:none;color:rgba(255,255,255,0.5);border:none;
                     margin-top:16px;font-family:'Cairo',sans-serif;font-size:12px;cursor:pointer;">
              تخطي الكل
            </button>
          ` : ''}
        </div>
      `;
    }

    global._gmtWelcomeChangeSlide = (dir) => {
      current += dir;
      if (current >= welcomeSlides.length) finishWelcome();
      else { current = Math.max(0, current); renderSlide(current); }
    };
    global._gmtWelcomeSkip = () => finishWelcome();

    function finishWelcome() {
      overlay.remove();
      const pid = global.PAGE_ID || 'page';
      try { localStorage.setItem('gmt_onboarded_' + pid, 'true'); } catch (e) {}
      setTimeout(() => global._gmtTour?.start(), 300);
    }

    document.body.appendChild(overlay);
    renderSlide(0);
  }

  // ════════════════════════════════════════════════════
  // تصدير عام
  // ════════════════════════════════════════════════════
  global.GMTTour              = GMTTour;
  global.restartTour          = restartTour;
  global.runLoadingSequence   = runLoadingSequence;
  global.showWelcomeSlides    = showWelcomeSlides;

})(window);
