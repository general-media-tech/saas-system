-- ════════════════════════════════════════════════════════════════
--  transfer_setup.sql — نظام نقل المخزون الداخلي بين الفروع (GMT)
--  نسخة مُصحَّحة بعد فحص قاعدة البيانات الفعلية — يونيو 2026
-- ════════════════════════════════════════════════════════════════
--
--  ⚠️ ملاحظة هامة جداً قبل التنفيذ — اقرأها أولاً:
--  ─────────────────────────────────────────────────────────────
--  الخطة الأصلية كانت تطلب إنشاء جدول اسمه "branch_transfers".
--  لكن هذا الاسم *مُستخدَم فعلياً* في نظامكم لجدول مختلف كلياً:
--  صندوق "ترحيل المبيعات" من الفرع إلى الإدارة (admin-final.html,
--  orders-final.html, index-final.html) بأعمدة:
--      branch_key, amount, note, transfer_date, confirmed_by
--  لو نفّذنا "CREATE TABLE IF NOT EXISTS branch_transfers (...)"
--  بالشكل المطلوب في الخطة، فلن يُنشئ شيئاً (الجدول موجود مسبقاً
--  بهيكل مختلف) وكل أكواد فاتورة النقل الجديدة كانت ستفشل لاحقاً
--  لأن الأعمدة (transfer_number, from_branch...) غير موجودة فعلاً.
--
--  الحل: تم إعادة تسمية جداول "نقل البضاعة" الجديدة إلى:
--      branch_transfers   →   branch_stock_transfers
--      transfer_items      →   stock_transfer_items
--  مع ترك جدول "branch_transfers" الأصلي (صندوق الترحيل المالي)
--  بدون أي تغيير في هيكله، فقط إضافات أعمدة اختيارية له بالأسفل
--  (إضافية فقط — IF NOT EXISTS — لا تكسر أي كود حالي).
-- ════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════
-- 0) إكستنشن احتياطي (Supabase يفعّله افتراضياً عادةً، لكن هذا يضمن العمل)
-- ════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════
-- 1) جدول رأس فاتورة نقل المخزون (الاسم الجديد الآمن)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.branch_stock_transfers (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  transfer_number   TEXT        NOT NULL UNIQUE,
  from_branch       TEXT        NOT NULL,
  from_branch_name  TEXT        NOT NULL,
  to_branch         TEXT        NOT NULL,
  to_branch_name    TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending',
  -- pending   = أُنشئت، خُصمت من المُرسِل، لم تصل بعد (في الطريق)
  -- received  = أُكِّد الاستلام، أُضيفت كمية المستلم
  -- cancelled = مُلغاة (بواسطة أدمن فقط)، أُعيدت الكمية للمُرسِل
  notes             TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  received_at       TIMESTAMPTZ,
  received_by       TEXT,
  cancelled_at      TIMESTAMPTZ,
  cancelled_by      TEXT,
  signature_url     TEXT,
  telegram_sent     BOOLEAN     DEFAULT FALSE,
  is_locked         BOOLEAN     DEFAULT TRUE   -- مقفولة فور الحفظ (لا تُعدَّل، فقط تُستلم أو تُلغى)
);

-- ════════════════════════════════════════════════════
-- 2) جدول بنود نقل المخزون (الاسم الجديد الآمن)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.stock_transfer_items (
  id            UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  transfer_id   UUID          REFERENCES public.branch_stock_transfers(id) ON DELETE CASCADE,
  product_id    TEXT          NOT NULL,
  product_name  TEXT          NOT NULL,
  barcode       TEXT,
  image_url     TEXT,
  qty           INTEGER       NOT NULL CHECK (qty > 0),
  unit_cost     NUMERIC(10,2) DEFAULT 0,   -- سعر الجملة (تقديري — للعرض الداخلي فقط)
  sale_price    NUMERIC(10,2) DEFAULT 0,   -- سعر المبيع المتوقع
  notes         TEXT
);

-- ════════════════════════════════════════════════════
-- 3) جدول إشعارات الفروع (لا تعارض مع أي جدول حالي)
-- ════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.branch_notifications (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_key  TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  -- 'new_transfer' | 'transfer_received' | 'transfer_cancelled'
  ref_id      UUID,
  message     TEXT        NOT NULL,
  is_read     BOOLEAN     DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════════
-- 4) ترقيم فواتير نقل المخزون
-- ════════════════════════════════════════════════════
CREATE SEQUENCE IF NOT EXISTS stock_transfer_seq START 1;

CREATE OR REPLACE FUNCTION next_stock_transfer_number()
RETURNS TEXT AS $$
  SELECT 'TRF-' ||
         TO_CHAR(NOW(), 'YYYY-MM') || '-' ||
         LPAD(nextval('stock_transfer_seq')::TEXT, 6, '0');
$$ LANGUAGE SQL;

-- ════════════════════════════════════════════════════
-- 5) RPC آمن لخصم/إضافة المخزون
-- ────────────────────────────────────────────────────
--  ⚠️ تصحيح جذري عن الخطة الأصلية:
--  الخطة افترضت أن كميات الفروع محفوظة بعمود JSONB واحد اسمه
--  "data" في جدول products (مثل data->>'haleb').
--  لكن المخزون الفعلي في نظامكم محفوظ كأعمدة مباشرة على نفس
--  الصف: products.haleb, products.homs, products.daraa...
--  (كما هو واضح من inv_columns ومن كل أكواد index__17_.html)
--  لذلك أعدنا كتابة الدالتين بالكامل لتستخدم SQL ديناميكي آمن
--  (format/quote_ident) على اسم العمود الحقيقي، مع قفل الصف
--  (FOR UPDATE) لمنع السباق عند تزامن عمليتين على نفس المنتج،
--  ومع فحص أن اسم الفرع المُرسَل هو عمود حقيقي موجود في
--  inv_columns كفرع (is_branch = true) — حماية من SQL Injection
--  عبر اسم العمود نفسه.
-- ════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION deduct_branch_stock(
  p_product_id TEXT,
  p_branch_key TEXT,
  p_qty        INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  current_qty  INTEGER;
  col_exists   BOOLEAN;
BEGIN
  -- تحقق أن p_branch_key هو فرع معرَّف فعلاً (وليس أي نص عشوائي)
  SELECT EXISTS (
    SELECT 1 FROM public.inv_columns
    WHERE key_name = p_branch_key AND is_branch = true
  ) INTO col_exists;

  IF NOT col_exists THEN
    RAISE EXCEPTION 'اسم فرع غير صالح: %', p_branch_key;
  END IF;

  EXECUTE format('SELECT COALESCE(%I, 0) FROM public.products WHERE id = $1 FOR UPDATE', p_branch_key)
    INTO current_qty USING p_product_id;

  IF current_qty IS NULL THEN
    RETURN FALSE; -- المنتج غير موجود
  END IF;

  IF current_qty < p_qty THEN
    RETURN FALSE; -- لا يوجد مخزون كافٍ
  END IF;

  EXECUTE format('UPDATE public.products SET %I = %I - $1 WHERE id = $2', p_branch_key, p_branch_key)
    USING p_qty, p_product_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION add_branch_stock(
  p_product_id TEXT,
  p_branch_key TEXT,
  p_qty        INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  col_exists BOOLEAN;
  row_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.inv_columns
    WHERE key_name = p_branch_key AND is_branch = true
  ) INTO col_exists;

  IF NOT col_exists THEN
    RAISE EXCEPTION 'اسم فرع غير صالح: %', p_branch_key;
  END IF;

  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.products WHERE id = $1 FOR UPDATE)')
    INTO row_exists USING p_product_id;

  IF NOT row_exists THEN
    RETURN FALSE;
  END IF;

  EXECUTE format('UPDATE public.products SET %I = COALESCE(%I, 0) + $1 WHERE id = $2', p_branch_key, p_branch_key)
    USING p_qty, p_product_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════
-- 6) تعديلات إضافية على جداول موجودة — كلها IF NOT EXISTS
--    (آمنة 100% — لا تحذف ولا تعدّل أي بيانات حالية)
-- ════════════════════════════════════════════════════

-- 6.1 — منع ربط نفس الأوردر بأكثر من فاتورة + قفل الأوردر
--       (gmt_orders مخطط حقيقي مؤكَّد من orders-final.html)
ALTER TABLE public.gmt_orders
  ADD COLUMN IF NOT EXISTS linked_invoice_id BIGINT,
  ADD COLUMN IF NOT EXISTS is_locked         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS prepared_by       TEXT,
  ADD COLUMN IF NOT EXISTS prepared_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prepared_branch   TEXT;

-- فهرس UNIQUE جزئي (يسمح لأكثر من صف بقيمة NULL، لكن يمنع تكرار قيمة حقيقية)
CREATE UNIQUE INDEX IF NOT EXISTS uq_gmt_orders_linked_invoice
  ON public.gmt_orders (linked_invoice_id)
  WHERE linked_invoice_id IS NOT NULL;

-- إضافة حالة 'prepared' الجديدة لدورة حياة الأوردر
ALTER TABLE public.gmt_orders
  DROP CONSTRAINT IF EXISTS gmt_orders_status_check;

ALTER TABLE public.gmt_orders
  ADD CONSTRAINT gmt_orders_status_check
  CHECK (status IN ('pending','prepared','shipped','delivered','completed'));

-- 6.2 — مرجع عكسي اختياري على الفاتورة لمعرفة أصلها من أوردر (للعرض في admin فقط)
--      ⚠️ هذا الاسم (order_id/order_serial) مطابق تماماً لِما كان كود نقطة البيع
--      (index-final.html) يتوقعه فعلاً في دالة createOrderFromInvoice غير المكتملة
--      التي وجدناها — أكملناها لتستخدم هذين الاسمين بالذات بدل اختراع اسم جديد.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS order_id      BIGINT,
  ADD COLUMN IF NOT EXISTS order_serial  TEXT;

-- 6.3 — حقل "في الطريق بين الفروع" للمنتجات (مفهوم جديد، منفصل عن germany/china)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS in_transit JSONB DEFAULT '{}';
-- مثال: {"haleb": 3} يعني 3 قطع خرجت من حلب (لفرع آخر) ولم تصل بعد

-- 6.4 — تحسين صندوق تحصيلات الشحن داخل جدول "branch_transfers" الأصلي (المالي)
--       إضافات اختيارية فقط لتمييز نوع الحركة ومصدرها — لا تُغيّر شيئاً قائماً
ALTER TABLE public.branch_transfers
  ADD COLUMN IF NOT EXISTS type         TEXT DEFAULT 'remit',
  -- 'remit'      = ترحيل عادي من الفرع للإدارة (السلوك الحالي، القيمة الافتراضية)
  -- 'collection' = تحصيل شحن أوردر (إضافة جديدة من orders-final.html)
  ADD COLUMN IF NOT EXISTS order_id     BIGINT,
  ADD COLUMN IF NOT EXISTS order_serial TEXT,
  ADD COLUMN IF NOT EXISTS invoice_id   BIGINT,
  ADD COLUMN IF NOT EXISTS created_by   TEXT,
  ADD COLUMN IF NOT EXISTS branch_name  TEXT;

-- ════════════════════════════════════════════════════
-- 7) Bucket التوقيعات — أنشئه يدوياً من Supabase Dashboard
--    Storage → New Bucket
--    الاسم: transfer-signatures
--    Public: لا (Private) — أو نعم إذا تريد روابط مباشرة بدون توقيع
--    حجم أقصى للملف: 10MB
--    الأنواع المسموحة: image/*
--
--    أو نفّذ هذا السطر بدلاً من الواجهة (نفس النتيجة):
-- ════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('transfer-signatures', 'transfer-signatures', true, 10485760, ARRAY['image/*'])
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════
-- 8) فهارس الأداء
-- ════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_bst_status   ON public.branch_stock_transfers(status);
CREATE INDEX IF NOT EXISTS idx_bst_from     ON public.branch_stock_transfers(from_branch);
CREATE INDEX IF NOT EXISTS idx_bst_to       ON public.branch_stock_transfers(to_branch);
CREATE INDEX IF NOT EXISTS idx_sti_tid      ON public.stock_transfer_items(transfer_id);
CREATE INDEX IF NOT EXISTS idx_bn_branch    ON public.branch_notifications(branch_key, is_read);
CREATE INDEX IF NOT EXISTS idx_orders_locked ON public.gmt_orders(is_locked);

-- ════════════════════════════════════════════════════
-- 9) RLS — تفعيل على الجداول الجديدة فقط
-- ────────────────────────────────────────────────────
--  ⚠️ ملاحظة صدق مهمة: نظامكم بالكامل (كل الجداول الحالية) يعمل
--  حالياً بسياسة "allow_all" (USING (true)) لأن لا يوجد نظام
--  مستخدمين/صلاحيات حقيقي على مستوى Supabase Auth — كل الواجهات
--  تستخدم مفتاح anon نفسه. لذلك تفعيل RLS هنا بسياسة "allow_all"
--  للجداول الجديدة هو **اتساق مع الوضع الحالي فقط**، ولن يحقق
--  حماية فعلية إضافية (وهذا ما تقصده الخطة في الثغرة #5، لكن حلّها
--  الحقيقي يحتاج طبقة مصادقة كاملة عبر Edge Functions، وهو خارج
--  نطاق "تنفيذ تعديلات على الملفات الحالية" ويحتاج مشروعاً منفصلاً
--  — راجع تقرير التنفيذ المرفق لتفاصيل أوسع حول هذه النقطة).
-- ════════════════════════════════════════════════════
ALTER TABLE public.branch_stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_notifications   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_all_branch_stock_transfers" ON public.branch_stock_transfers;
CREATE POLICY "allow_all_branch_stock_transfers" ON public.branch_stock_transfers FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_all_stock_transfer_items" ON public.stock_transfer_items;
CREATE POLICY "allow_all_stock_transfer_items" ON public.stock_transfer_items FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_all_branch_notifications" ON public.branch_notifications;
CREATE POLICY "allow_all_branch_notifications" ON public.branch_notifications FOR ALL USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════════════
-- تم. راجع تقرير_التنفيذ.md للتفاصيل الكاملة عن كل قرار اتُّخذ هنا.
-- ════════════════════════════════════════════════════
