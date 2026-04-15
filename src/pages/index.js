import { useState, useReducer, useContext, createContext, useCallback, useEffect, useRef, useMemo } from "react";
import { supabase } from "../lib/supabaseClient";

// ============================================================
// § UTILS
// ============================================================
const nanoid = (size = 12) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: size }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

// Hydrationエラー対策: Math.random()はクライアント側でのみ実行
const genOrderId = () => {
  if (typeof window === "undefined") return "SHP-0000-0000";
  return `SHP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
};

const fmt    = (n) => Number(n || 0).toLocaleString("ja-JP");

// Hydrationエラー対策: new Date()はクライアント側でのみ実行
const today  = () => {
  if (typeof window === "undefined") return "2026-01-01";
  return new Date().toISOString().split("T")[0];
};
const nowStr = () => {
  if (typeof window === "undefined") return "";
  return new Date().toLocaleString("ja-JP");
};

const calcProfit = (sale, cost, shipping, feeRate = 0.03, extra = 0) => {
  const fee = Math.round(Number(sale) * feeRate);
  return Number(sale) - Number(cost) - Number(shipping) - fee - Number(extra);
};
const calcMargin = (sale, profit) =>
  Number(sale) > 0 ? Math.round((profit / Number(sale)) * 100) : 0;

// ============================================================
// § VALIDATION
// ============================================================
const validateProduct = (f) => {
  const e = {};
  if (!f.name?.trim())                                                 e.name        = "商品名は必須です";
  if (Number(f.sourceCost)  < 1)                                       e.sourceCost  = "仕入れ原価は1円以上にしてください";
  if (Number(f.shopeePrice) < 1)                                       e.shopeePrice = "販売価格は1円以上にしてください";
  if (f.sourceUrl && !/^https?:\/\/.+/.test(f.sourceUrl))              e.sourceUrl   = "URLはhttp://またはhttps://で始めてください";
  if (!e.shopeePrice && Number(f.shopeePrice) <= Number(f.sourceCost)) e.shopeePrice = "販売価格は仕入れ原価より高くしてください";
  return e;
};
const validateOrder = (f) => {
  const e = {};
  if (!f.buyer?.trim())        e.buyer     = "購入者名は必須です";
  if (Number(f.quantity) < 1)  e.quantity  = "数量は1以上にしてください";
  if (Number(f.salePrice) < 1) e.salePrice = "販売金額は1円以上にしてください";
  return e;
};

// ============================================================
// § RATE LIMITER（規約対応：最短5分間隔を強制）
// ============================================================
class RateLimiter {
  constructor(minMs) { this.minMs = minMs; this.last = 0; }
  canCall()  { return Date.now() - this.last >= this.minMs; }
  record()   { this.last = Date.now(); }
  waitSec()  { return Math.ceil(Math.max(0, this.minMs - (Date.now() - this.last)) / 1000); }
}
const globalRateLimiter = new RateLimiter(5 * 60 * 1000);

// ============================================================
// § RETRY HELPER
// ============================================================
const withRetry = async (fn, retries = 3, delayMs = 800) => {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
};

// ============================================================
// § STOCK SYNC SERVICE（規約準拠）
// ============================================================
const stockSyncService = {
  async fetchUpdates(products) {
    if (!globalRateLimiter.canCall())
      throw new Error(`レート制限: あと${globalRateLimiter.waitSec()}秒後に再試行できます`);
    const syncable = products.filter(p =>
      ["Amazon", "楽天", "AliExpress"].includes(p.sourcePlatform) && p.status !== "inactive"
    );
    // MOCK: 本番 → Supabase Edge Function `/functions/v1/stock-sync` に置き換え
    return new Promise(res =>
      setTimeout(() => {
        globalRateLimiter.record();
        res(syncable.map(p => ({
          id:       p.id,
          newStock: Math.max(0, p.stock + Math.floor(Math.random() * 21) - 10),
          platform: p.sourcePlatform,
        })));
      }, 600)
    );
  },
};

// ============================================================
// § SHOPEE LISTING SERVICE（規約準拠）
// ============================================================
const shopeeListingService = {
  async listProduct(product) {
    // MOCK: 本番 → Supabase Edge Function `/functions/v1/shopee-list` に置き換え
    await new Promise(r => setTimeout(r, 900));
    if (Math.random() < 0.2) throw new Error("Shopee API: タイムアウト（リトライ可能）");
    return { shopeeItemId: `SHOPEE-${nanoid(8).toUpperCase()}` };
  },
  async unlistProduct(product) {
    await new Promise(r => setTimeout(r, 700));
    if (Math.random() < 0.15) throw new Error("Shopee API: 取り下げに失敗しました（リトライ可能）");
    return { success: true };
  },
  generateCsv(products) {
    const header = ["商品名","カテゴリ","価格（円）","在庫数","商品説明","SKU","仕入れ原価","仕入れ先","仕入れURL"].join(",");
    const rows = products.map(p => [
      `"${p.name}"`, `"${p.category}"`, p.shopeePrice, p.stock,
      `"${p.notes || p.name}"`, `"${p.sku}"`, p.sourceCost,
      `"${p.sourcePlatform}"`, `"${p.sourceUrl || ""}"`,
    ].join(","));
    return [header, ...rows].join("\n");
  },
  generateUnlistCsv(products) {
    const header = ["商品名","SKU","Shopee商品ID","在庫数","対応状況"].join(",");
    const rows = products.map(p => [
      `"${p.name}"`, `"${p.sku}"`,
      `"${p.shopeeItemId || "（ID未取得）"}"`,
      p.stock,
      `"セラーセンターで非公開化してください"`,
    ].join(","));
    return [header, ...rows].join("\n");
  },
};

// ============================================================
// § STOCK CHANGE LOGIC
// ============================================================
const calcStockChange = (prev, next) => {
  if (next > prev) return "up";
  if (next < prev) return "down";
  return "same";
};
const STOCK_CHANGE_ICON  = { up: "⬆️", down: "↘️", same: "➡️" };
const STOCK_CHANGE_COLOR = { up: "#10B981", down: "#EF4444", same: "#9CA3AF" };

// ============================================================
// § CSV DOWNLOAD HELPER
// ============================================================
const downloadCsv = (csv, filename) => {
  const bom  = "\uFEFF";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

// ============================================================
// § PRODUCT FACTORY
// ============================================================
const mkProduct = (overrides) => ({
  previousStock:   overrides.stock ?? 0,
  lastSyncedStock: overrides.stock ?? 0,
  stockChangeType: "same",
  isListed:        false,
  listingStatus:   "unlisted",
  unlistRequired:  false,
  shopeeItemId:    undefined,
  listingLogs:     [],
  extraCost:       0,
  notes:           "",
  createdAt:       today(),
  ...overrides,
});

// Supabaseのsnake_caseをcamelCaseに変換
const rowToProduct = (row) => mkProduct({
  id:              row.id,
  name:            row.name,
  sku:             row.sku || "",
  sourceUrl:       row.source_url || "",
  sourcePlatform:  row.source_platform,
  sourceCost:      row.source_cost,
  shopeePrice:     row.shopee_price,
  stock:           row.stock,
  previousStock:   row.previous_stock || 0,
  lastSyncedStock: row.last_synced_stock || 0,
  stockChangeType: row.stock_change_type || "same",
  status:          row.status || "active",
  isListed:        row.is_listed || false,
  listingStatus:   row.listing_status || "unlisted",
  unlistRequired:  row.unlist_required || false,
  shopeeItemId:    row.shopee_item_id || undefined,
  category:        row.category || "",
  extraCost:       row.extra_cost || 0,
  notes:           row.notes || "",
  createdAt:       row.created_at,
});

const rowToOrder = (row) => ({
  id:           row.id,
  productId:    row.product_id,
  productName:  row.product_name || "",
  buyer:        row.buyer,
  quantity:     row.quantity,
  salePrice:    row.sale_price,
  sourceCost:   row.source_cost,
  shippingCost: row.shipping_cost || 0,
  shopeeFeeRate:row.shopee_fee_rate || 0.03,
  extraCost:    row.extra_cost || 0,
  status:       row.status || "pending",
  orderDate:    row.order_date || today(),
  trackingNo:   row.tracking_no || "",
  notes:        row.notes || "",
  history:      [],
});

// ============================================================
// § CONSTANTS
// ============================================================
const DEFAULT_SETTINGS = {
  syncIntervalMin: 30,
  shopeeFeeRate:   3,
  autoDeductStock: true,
  syncEnabled:     false,
  autoUnlist:      true,
  unlistDelayMin:  0,
};
const SYNC_OPTIONS   = [{ label:"5分（最短）", value:5 }, { label:"10分", value:10 }, { label:"30分", value:30 }, { label:"60分", value:60 }];
const DELAY_OPTIONS  = [{ label:"即時（0分）", value:0 }, { label:"5分後", value:5 }, { label:"10分後", value:10 }, { label:"30分後", value:30 }];
const PLATFORMS      = ["Amazon", "楽天", "AliExpress", "タオバオ", "その他"];
const CATEGORIES     = ["電子機器", "スマホアクセサリー", "家電", "ファッション", "美容・健康", "ホーム・ガーデン", "スポーツ", "その他"];
const ORDER_STATUSES   = { pending:"未対応", ordering:"仕入れ中", shipped:"発送済", delivered:"配達済", cancelled:"キャンセル" };
const PRODUCT_STATUSES = { active:"販売中", inactive:"停止中", out_of_stock:"在庫切れ" };
const LISTING_STATUSES = { unlisted:"未出品", active:"出品中", paused:"停止中", removed:"削除済", error:"エラー" };
const LISTING_COLORS   = {
  unlisted:["#6B7280","#F3F4F6"], active:["#10B981","#ECFDF5"],
  paused:["#F59E0B","#FFFBEB"], removed:["#6B7280","#F3F4F6"], error:["#EF4444","#FEF2F2"],
};
const STATUS_COLORS = {
  pending:["#FF6B35","#FFF0EB"], ordering:["#F59E0B","#FFFBEB"], shipped:["#3B82F6","#EFF6FF"],
  delivered:["#10B981","#ECFDF5"], cancelled:["#6B7280","#F3F4F6"],
  active:["#10B981","#ECFDF5"], inactive:["#6B7280","#F3F4F6"], out_of_stock:["#EF4444","#FEF2F2"],
};

// ============================================================
// § REDUCER
// ============================================================
const AppCtx = createContext(null);

const initState = {
  products:     [],   // Supabaseから取得
  orders:       [],   // Supabaseから取得
  settings:     DEFAULT_SETTINGS,
  syncLogs:     [],
  loadingSync:  false,
  listingQueue: new Set(),
  confirm:      null,
  modal:        null,
};

function reducer(state, action) {
  switch (action.type) {
    // 初回ロード
    case "LOAD_PRODUCTS": return { ...state, products: action.products };
    case "LOAD_ORDERS":   return { ...state, orders:   action.orders   };

    // Products CRUD
    case "ADD_PRODUCT":    return { ...state, products: [...state.products, action.p] };
    case "UPDATE_PRODUCT": return { ...state, products: state.products.map(p => p.id === action.p.id ? { ...p, ...action.p } : p) };
    case "DELETE_PRODUCT": return { ...state, products: state.products.filter(p => p.id !== action.id) };

    // 在庫バッチ更新（変動追跡 + unlistRequired マーキング）
    case "BATCH_STOCK":
      return {
        ...state,
        products: state.products.map(p => {
          const u = action.updates.find(u => u.id === p.id);
          if (!u) return p;
          const changeType     = calcStockChange(p.stock, u.newStock);
          const newStatus      = u.newStock === 0 ? "out_of_stock" : p.status === "out_of_stock" ? "active" : p.status;
          const unlistRequired = u.newStock === 0 && p.isListed && p.listingStatus === "active";
          return { ...p, previousStock:p.stock, stock:u.newStock, lastSyncedStock:u.newStock, stockChangeType:changeType, status:newStatus, unlistRequired };
        }),
      };

    // 出品/取り下げキュー
    case "SET_LISTING_LOADING": {
      const next = new Set(state.listingQueue);
      action.v ? next.add(action.id) : next.delete(action.id);
      return { ...state, listingQueue: next };
    }
    case "UPDATE_LISTING": {
      const { id, listingStatus, shopeeItemId, isListed, unlistRequired, logEntry } = action;
      return {
        ...state,
        products: state.products.map(p => {
          if (p.id !== id) return p;
          return { ...p, listingStatus, isListed:isListed??p.isListed, unlistRequired:unlistRequired??false, shopeeItemId:shopeeItemId??p.shopeeItemId, listingLogs:[logEntry,...p.listingLogs].slice(0,50) };
        }),
      };
    }

    // Orders CRUD
    case "ADD_ORDER":    return { ...state, orders: [...state.orders, action.o] };
    case "UPDATE_ORDER": return { ...state, orders: state.orders.map(o => o.id === action.o.id ? { ...o, ...action.o } : o) };
    case "DELETE_ORDER": return { ...state, orders: state.orders.filter(o => o.id !== action.id) };

    // Settings / Logs / UI
    case "SET_SETTINGS":     return { ...state, settings:  { ...state.settings, ...action.patch } };
    case "PUSH_LOG":         return { ...state, syncLogs:  [action.log, ...state.syncLogs].slice(0, 100) };
    case "SET_SYNC_LOADING": return { ...state, loadingSync: action.v };
    case "SHOW_CONFIRM":     return { ...state, confirm: { message:action.message, onOk:action.onOk, okLabel:action.okLabel, okColor:action.okColor } };
    case "HIDE_CONFIRM":     return { ...state, confirm: null };
    case "SHOW_MODAL":       return { ...state, modal: action.modal };
    case "HIDE_MODAL":       return { ...state, modal: null };

    default: return state;
  }
}

// ============================================================
// § APP PROVIDER（Supabaseからの初回データ取得）
// ============================================================
function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initState);

  useEffect(() => {
    const fetchData = async () => {
      const [{ data: pData, error: pErr }, { data: oData, error: oErr }] = await Promise.all([
        supabase.from("products").select("*").order("created_at", { ascending: false }),
        supabase.from("orders").select("*").order("created_at",   { ascending: false }),
      ]);
      if (!pErr && pData) dispatch({ type:"LOAD_PRODUCTS", products: pData.map(rowToProduct) });
      if (!oErr && oData) dispatch({ type:"LOAD_ORDERS",   orders:   oData.map(rowToOrder)   });
    };
    fetchData();
  }, []);

  return <AppCtx.Provider value={{ state, dispatch }}>{children}</AppCtx.Provider>;
}
const useStore = () => useContext(AppCtx);

// ============================================================
// § TOAST
// ============================================================
const ToastCtx = createContext(null);
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, type = "info", ms = 4000) => {
    const id = nanoid(6);
    setToasts(ts => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), ms);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <style>{`@keyframes tsin{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}`}</style>
      <div style={{ position:"fixed", bottom:24, right:24, zIndex:9999, display:"flex", flexDirection:"column", gap:8 }}>
        {toasts.map(t => (
          <div key={t.id} onClick={() => setToasts(ts => ts.filter(x => x.id !== t.id))}
            style={{ background:t.type==="success"?"#10B981":t.type==="error"?"#EF4444":t.type==="warn"?"#F59E0B":"#3B82F6", color:"#fff", padding:"11px 18px", borderRadius:10, fontSize:13, fontWeight:600, boxShadow:"0 4px 20px rgba(0,0,0,0.2)", maxWidth:340, cursor:"pointer", animation:"tsin 0.2s ease" }}>
            {t.type==="success"?"✅ ":t.type==="error"?"❌ ":t.type==="warn"?"⚠️ ":"ℹ️ "}{t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
const useToast = () => useContext(ToastCtx);

// ============================================================
// § HOOKS
// ============================================================
function useSyncScheduler() {
  const { state, dispatch } = useStore();
  const toast        = useToast();
  const productsRef  = useRef(state.products);
  const settingsRef  = useRef(state.settings);
  const isSyncing    = useRef(false);
  const timerRef     = useRef(null);
  const unlistTimers = useRef({});

  useEffect(() => { productsRef.current = state.products; }, [state.products]);
  useEffect(() => { settingsRef.current = state.settings; }, [state.settings]);

  const execUnlist = useCallback(async (product) => {
    dispatch({ type:"SET_LISTING_LOADING", id:product.id, v:true });
    try {
      await withRetry(() => shopeeListingService.unlistProduct(product), 3, 1000);
      const logEntry = { id:nanoid(6), at:nowStr(), action:"unlist", message:"在庫切れによる自動取り下げ（非公開化）" };
      dispatch({ type:"UPDATE_LISTING", id:product.id, listingStatus:"paused", isListed:false, unlistRequired:false, logEntry });
      toast(`「${product.name}」を自動取り下げしました`, "warn");
    } catch (e) {
      const logEntry = { id:nanoid(6), at:nowStr(), action:"error", message:`自動取り下げ失敗: ${e.message}` };
      dispatch({ type:"UPDATE_LISTING", id:product.id, listingStatus:"error", logEntry });
      toast(`取り下げ失敗: ${e.message} — 手動対応が必要です`, "error", 6000);
    } finally {
      dispatch({ type:"SET_LISTING_LOADING", id:product.id, v:false });
      delete unlistTimers.current[product.id];
    }
  }, [dispatch, toast]);

  const runSync = useCallback(async () => {
    if (isSyncing.current) return;
    isSyncing.current = true;
    dispatch({ type:"SET_SYNC_LOADING", v:true });
    const logBase = { id:nanoid(6), at:nowStr() };
    dispatch({ type:"PUSH_LOG", log:{ ...logBase, status:"running", message:"同期開始..." } });
    try {
      const updates  = await withRetry(() => stockSyncService.fetchUpdates(productsRef.current));
      dispatch({ type:"BATCH_STOCK", updates });
      const settings = settingsRef.current;
      const targets  = updates.filter(u => u.newStock === 0)
        .map(u => productsRef.current.find(p => p.id === u.id))
        .filter(p => p && p.isListed && p.listingStatus === "active");
      if (targets.length > 0 && settings.autoUnlist) {
        targets.forEach(p => {
          if (unlistTimers.current[p.id]) return;
          const delayMs = settings.unlistDelayMin * 60 * 1000;
          if (delayMs === 0) {
            execUnlist(p);
          } else {
            toast(`「${p.name}」: ${settings.unlistDelayMin}分後に自動取り下げします`, "warn");
            unlistTimers.current[p.id] = setTimeout(() => execUnlist(p), delayMs);
          }
        });
      } else if (targets.length > 0) {
        toast(`⚠️ 在庫切れ出品商品が${targets.length}件あります。手動で取り下げてください`, "warn", 6000);
      }
      dispatch({ type:"PUSH_LOG", log:{ ...logBase, id:nanoid(6), status:"success", message:`在庫更新: ${updates.length}件${targets.length?` / 取り下げ対象: ${targets.length}件`:""}` } });
      toast(`在庫を${updates.length}件更新しました`, "success");
    } catch (e) {
      dispatch({ type:"PUSH_LOG", log:{ ...logBase, id:nanoid(6), status:"error", message:e.message } });
      toast(e.message, "error");
    } finally {
      dispatch({ type:"SET_SYNC_LOADING", v:false });
      isSyncing.current = false;
    }
  }, [dispatch, toast, execUnlist]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!state.settings.syncEnabled) return;
    const ms = Math.max(state.settings.syncIntervalMin, 5) * 60 * 1000;
    timerRef.current = setInterval(runSync, ms);
    return () => {
      clearInterval(timerRef.current);
      Object.values(unlistTimers.current).forEach(clearTimeout);
    };
  }, [state.settings.syncEnabled, state.settings.syncIntervalMin, runSync]);

  return { runSync };
}

function useListingAction() {
  const { dispatch } = useStore();
  const toast = useToast();
  return useCallback(async (product) => {
    dispatch({ type:"SET_LISTING_LOADING", id:product.id, v:true });
    try {
      const result   = await withRetry(() => shopeeListingService.listProduct(product), 3, 1000);
      const logEntry = { id:nanoid(6), at:nowStr(), action:"list", message:`出品成功 (ID: ${result.shopeeItemId})` };
      dispatch({ type:"UPDATE_LISTING", id:product.id, listingStatus:"active", isListed:true, shopeeItemId:result.shopeeItemId, logEntry });
      toast(`「${product.name}」をShopeeに出品しました`, "success");
    } catch (e) {
      const logEntry = { id:nanoid(6), at:nowStr(), action:"error", message:e.message };
      dispatch({ type:"UPDATE_LISTING", id:product.id, listingStatus:"error", logEntry });
      toast(`出品エラー: ${e.message}`, "error");
    } finally {
      dispatch({ type:"SET_LISTING_LOADING", id:product.id, v:false });
    }
  }, [dispatch, toast]);
}

function useUnlistAction() {
  const { dispatch } = useStore();
  const toast = useToast();
  return useCallback(async (product) => {
    dispatch({ type:"SET_LISTING_LOADING", id:product.id, v:true });
    try {
      await withRetry(() => shopeeListingService.unlistProduct(product), 3, 1000);
      const logEntry = { id:nanoid(6), at:nowStr(), action:"unlist", message:"手動取り下げ（非公開化）" };
      dispatch({ type:"UPDATE_LISTING", id:product.id, listingStatus:"paused", isListed:false, unlistRequired:false, logEntry });
      toast(`「${product.name}」を取り下げました`, "success");
    } catch (e) {
      const logEntry = { id:nanoid(6), at:nowStr(), action:"error", message:`取り下げ失敗: ${e.message}` };
      dispatch({ type:"UPDATE_LISTING", id:product.id, listingStatus:"error", logEntry });
      toast(`取り下げエラー: ${e.message}`, "error");
    } finally {
      dispatch({ type:"SET_LISTING_LOADING", id:product.id, v:false });
    }
  }, [dispatch, toast]);
}

const useSearch = (items, fields, query) =>
  useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return items;
    return items.filter(item =>
      tokens.every(tok => fields.some(f => String(item[f] ?? "").toLowerCase().includes(tok)))
    );
  }, [items, fields, query]);

// ============================================================
// § STYLES
// ============================================================
const S = {
  inp:        { width:"100%", padding:"9px 12px", border:"1.5px solid #E5E7EB", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box", background:"#FAFAFA", fontFamily:"inherit" },
  inpErr:     { width:"100%", padding:"9px 12px", border:"1.5px solid #EF4444", borderRadius:8, fontSize:13, outline:"none", boxSizing:"border-box", background:"#FFF5F5", fontFamily:"inherit" },
  lbl:        { display:"block", fontSize:11, fontWeight:700, color:"#888", marginBottom:4, letterSpacing:0.5, textTransform:"uppercase" },
  btnPri:     { background:"linear-gradient(135deg,#FF6B35,#F7931E)", color:"#fff", border:"none", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnSec:     { background:"#F3F4F6", color:"#555", border:"none", borderRadius:8, padding:"9px 20px", fontWeight:600, fontSize:13, cursor:"pointer" },
  btnDng:     { background:"#FEF2F2", color:"#DC2626", border:"none", borderRadius:6, padding:"5px 10px", fontSize:11, cursor:"pointer", fontWeight:600 },
  card:       { background:"#fff", borderRadius:16, padding:24, boxShadow:"0 2px 12px rgba(0,0,0,0.06)" },
  btnList:    { background:"linear-gradient(135deg,#EE4D2D,#FF6B35)", color:"#fff", border:"none", borderRadius:6, padding:"5px 10px", fontSize:11, cursor:"pointer", fontWeight:700, whiteSpace:"nowrap" },
  btnListDis: { background:"#E5E7EB", color:"#9CA3AF", border:"none", borderRadius:6, padding:"5px 10px", fontSize:11, cursor:"default", fontWeight:700, whiteSpace:"nowrap" },
  btnUnlist:  { background:"linear-gradient(135deg,#F59E0B,#EF4444)", color:"#fff", border:"none", borderRadius:6, padding:"5px 10px", fontSize:11, cursor:"pointer", fontWeight:700, whiteSpace:"nowrap" },
};

// ============================================================
// § PRIMITIVE COMPONENTS
// ============================================================
const Field = ({ label, error, children }) => (
  <div>
    <label style={S.lbl}>{label}</label>
    {children}
    {error && <div style={{ color:"#EF4444", fontSize:11, marginTop:3 }}>⚠ {error}</div>}
  </div>
);

const Badge = ({ status, type = "order" }) => {
  const labels = type === "order" ? ORDER_STATUSES : type === "listing" ? LISTING_STATUSES : PRODUCT_STATUSES;
  const map    = type === "listing" ? LISTING_COLORS : STATUS_COLORS;
  const [color, bg] = map[status] || ["#6B7280","#F3F4F6"];
  return <span style={{ background:bg, color, padding:"2px 8px", borderRadius:20, fontSize:10, fontWeight:700 }}>{labels[status]}</span>;
};

const StatCard = ({ icon, label, value, sub, accent }) => (
  <div style={{ ...S.card, borderLeft:`4px solid ${accent}`, flex:1, minWidth:150 }}>
    <div style={{ fontSize:22, marginBottom:4 }}>{icon}</div>
    <div style={{ fontSize:11, color:"#888", fontWeight:600, letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>{label}</div>
    <div style={{ fontSize:26, fontWeight:800, color:"#1a1a2e" }}>{value}</div>
    {sub && <div style={{ fontSize:11, color:"#aaa", marginTop:2 }}>{sub}</div>}
  </div>
);

const Toggle = ({ value, onChange }) => (
  <div style={{ display:"flex", alignItems:"center", gap:10, height:38 }}>
    <div onClick={() => onChange(!value)} style={{ width:44, height:24, borderRadius:12, background:value?"#10B981":"#D1D5DB", cursor:"pointer", position:"relative", transition:"background 0.2s" }}>
      <div style={{ width:18, height:18, borderRadius:"50%", background:"#fff", position:"absolute", top:3, left:value?23:3, transition:"left 0.2s", boxShadow:"0 1px 4px rgba(0,0,0,0.2)" }} />
    </div>
    <span style={{ fontSize:13, color:value?"#10B981":"#888", fontWeight:600 }}>{value ? "有効" : "無効"}</span>
  </div>
);

const ProfitBar = ({ sale, cost, shipping, feeRate = 0.03, extra = 0 }) => {
  const p = calcProfit(sale, cost, shipping, feeRate, extra);
  const m = calcMargin(sale, p);
  return (
    <div style={{ background:p>=0?"#ECFDF5":"#FEF2F2", borderRadius:10, padding:"10px 14px", display:"flex", gap:20 }}>
      <span style={{ color:"#555", fontSize:13 }}>利益: <strong style={{ color:p>=0?"#10B981":"#EF4444" }}>¥{fmt(p)}</strong></span>
      <span style={{ color:"#555", fontSize:13 }}>利益率: <strong style={{ color:p>=0?"#10B981":"#EF4444" }}>{m}%</strong></span>
    </div>
  );
};

const StockChangeIcon = ({ changeType, prevStock, curStock }) => {
  if (!changeType || changeType === "same") return null;
  return (
    <span title={`前回: ${prevStock} → 今回: ${curStock}`}
      style={{ fontSize:12, color:STOCK_CHANGE_COLOR[changeType], marginLeft:4, cursor:"help" }}>
      {STOCK_CHANGE_ICON[changeType]}
    </span>
  );
};

// ============================================================
// § MODALS
// ============================================================
function ConfirmModal() {
  const { state, dispatch } = useStore();
  if (!state.confirm) return null;
  const { message, onOk, okLabel = "削除する", okColor = "#EF4444" } = state.confirm;
  const hide = () => dispatch({ type:"HIDE_CONFIRM" });
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:10000, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ background:"#fff", borderRadius:14, padding:28, minWidth:320, maxWidth:420, boxShadow:"0 8px 40px rgba(0,0,0,0.2)" }}>
        <p style={{ margin:"0 0 20px", fontSize:14, color:"#333", lineHeight:1.7, whiteSpace:"pre-line" }}>{message}</p>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={hide} style={S.btnSec}>キャンセル</button>
          <button onClick={() => { onOk(); hide(); }} style={{ ...S.btnPri, background:okColor }}>{okLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ListingGuideModal() {
  const { state, dispatch } = useStore();
  if (state.modal?.type !== "guide") return null;
  const { product } = state.modal;
  const hide = () => dispatch({ type:"HIDE_MODAL" });
  const csv  = shopeeListingService.generateCsv([product]);
  const steps = [
    ["1", "Shopeeセラーセンターにログイン", "https://seller.shopee.jp にアクセスしてログインします。"],
    ["2", "商品管理 → 商品追加", "「商品管理」>「商品を追加する」を選択します。"],
    ["3", "CSVから一括登録", "「一括登録」タブ → 下のCSV出力ボタンで生成したファイルをアップロードします。"],
    ["4", "画像・詳細を補完", "商品画像、詳細説明、カテゴリ属性を手動入力します。"],
    ["5", "審査・公開", "「保存して公開」をクリック。審査後に出品されます。"],
  ];
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:10001, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"100%", maxWidth:540, boxShadow:"0 8px 40px rgba(0,0,0,0.2)", maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
          <div>
            <h3 style={{ margin:0, fontWeight:800, color:"#1a1a2e" }}>📋 手動出品ガイド</h3>
            <p style={{ margin:"4px 0 0", fontSize:12, color:"#888" }}>{product.name}</p>
          </div>
          <button onClick={hide} style={{ ...S.btnSec, padding:"4px 12px", fontSize:12 }}>✕ 閉じる</button>
        </div>
        <div style={{ background:"#FFFBEB", border:"1px solid #FCD34D", borderRadius:10, padding:"10px 14px", marginBottom:18, fontSize:12, color:"#78350F", lineHeight:1.6 }}>
          <strong>⚖️ 自動出品について</strong><br/>
          本番環境ではSupabase Edge Function経由でShopee APIを呼び出します。
          現在は<strong>CSVエクスポート → セラーセンターへ手動アップロード</strong>をご利用ください。
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
          {steps.map(([num, title, desc]) => (
            <div key={num} style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
              <div style={{ width:24, height:24, borderRadius:"50%", background:"linear-gradient(135deg,#FF6B35,#F7931E)", color:"#fff", fontSize:11, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:1 }}>{num}</div>
              <div>
                <div style={{ fontWeight:700, fontSize:13, color:"#1a1a2e" }}>{title}</div>
                <div style={{ fontSize:12, color:"#666", lineHeight:1.6 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={() => downloadCsv(csv, `shopee_${product.sku}_${today()}.csv`)} style={{ ...S.btnPri, flex:1 }}>📥 CSV出力</button>
          <a href="https://seller.shopee.jp" target="_blank" rel="noreferrer"
            style={{ ...S.btnSec, flex:1, textDecoration:"none", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:600 }}>
            🔗 セラーセンターを開く
          </a>
        </div>
      </div>
    </div>
  );
}

function UnlistGuideModal() {
  const { state, dispatch } = useStore();
  if (state.modal?.type !== "unlistGuide") return null;
  const { products: targets } = state.modal;
  const hide = () => dispatch({ type:"HIDE_MODAL" });
  const csv  = shopeeListingService.generateUnlistCsv(targets);
  const steps = [
    ["1", "Shopeeセラーセンターにログイン", "https://seller.shopee.jp にアクセスします。"],
    ["2", "商品管理を開く", "「商品管理」>「商品一覧」を選択します。"],
    ["3", "対象商品を検索", "下のCSVに記載のSKUまたは商品名で検索します。"],
    ["4", "非公開に設定", "商品を選択 →「一括操作」→「非公開にする」を実行します。\n※「削除」は復元不可のため非推奨です。"],
    ["5", "在庫補充後に再公開", "仕入れで在庫が確保できたら「公開する」で再出品できます。"],
  ];
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:10001, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"100%", maxWidth:560, boxShadow:"0 8px 40px rgba(0,0,0,0.2)", maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
          <div>
            <h3 style={{ margin:0, fontWeight:800, color:"#1a1a2e" }}>🔕 手動取り下げガイド</h3>
            <p style={{ margin:"4px 0 0", fontSize:12, color:"#888" }}>対象: {targets.length}件</p>
          </div>
          <button onClick={hide} style={{ ...S.btnSec, padding:"4px 12px", fontSize:12 }}>✕ 閉じる</button>
        </div>
        <div style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", borderRadius:10, padding:"10px 14px", marginBottom:16 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#DC2626", marginBottom:8 }}>⚠️ 取り下げ対象商品</div>
          {targets.map(p => (
            <div key={p.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid #FEE2E2", fontSize:12 }}>
              <span style={{ color:"#333", fontWeight:600 }}>{p.name}</span>
              <span style={{ color:"#888" }}>在庫: {p.stock} | ID: {p.shopeeItemId || "未取得"}</span>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
          {steps.map(([num, title, desc]) => (
            <div key={num} style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
              <div style={{ width:24, height:24, borderRadius:"50%", background:"linear-gradient(135deg,#F59E0B,#EF4444)", color:"#fff", fontSize:11, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:1 }}>{num}</div>
              <div>
                <div style={{ fontWeight:700, fontSize:13, color:"#1a1a2e" }}>{title}</div>
                <div style={{ fontSize:12, color:"#666", lineHeight:1.6, whiteSpace:"pre-line" }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={() => downloadCsv(csv, `unlist_targets_${today()}.csv`)} style={{ ...S.btnPri, flex:1, background:"linear-gradient(135deg,#F59E0B,#EF4444)" }}>
            📥 取り下げ対象CSV出力
          </button>
          <a href="https://seller.shopee.jp" target="_blank" rel="noreferrer"
            style={{ ...S.btnSec, flex:1, textDecoration:"none", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:600 }}>
            🔗 セラーセンターを開く
          </a>
        </div>
      </div>
    </div>
  );
}

function ListingLogsModal() {
  const { state, dispatch } = useStore();
  if (state.modal?.type !== "listingLogs") return null;
  const product = state.products.find(p => p.id === state.modal.productId);
  if (!product) return null;
  const hide = () => dispatch({ type:"HIDE_MODAL" });
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:10001, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#fff", borderRadius:16, padding:28, width:"100%", maxWidth:480, boxShadow:"0 8px 40px rgba(0,0,0,0.2)", maxHeight:"80vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <h3 style={{ margin:0, fontWeight:800, color:"#1a1a2e", fontSize:15 }}>📋 出品ログ — {product.name}</h3>
          <button onClick={hide} style={{ ...S.btnSec, padding:"4px 12px", fontSize:12 }}>✕</button>
        </div>
        {product.listingLogs.length === 0
          ? <p style={{ color:"#aaa", textAlign:"center", padding:"20px 0" }}>ログはありません</p>
          : product.listingLogs.map(l => {
              const isError  = l.action === "error";
              const isUnlist = l.action === "unlist";
              const bg   = isError ? "#FEF2F2" : isUnlist ? "#FFFBEB" : "#ECFDF5";
              const icon = isError ? "❌" : isUnlist ? "🔕" : "✅";
              return (
                <div key={l.id} style={{ display:"flex", gap:10, alignItems:"flex-start", padding:"8px 12px", background:bg, borderRadius:8, marginBottom:6 }}>
                  <span>{icon}</span>
                  <div>
                    <div style={{ fontSize:11, color:"#888" }}>{l.at}</div>
                    <div style={{ fontSize:12, color:"#333" }}>{l.message}</div>
                  </div>
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

// ============================================================
// § PRODUCT FORM
// ============================================================
const EMPTY_P = { name:"", sku:"", sourceUrl:"", sourcePlatform:"AliExpress", sourceCost:"", shopeePrice:"", stock:0, status:"active", category:"電子機器", extraCost:0, notes:"" };

function ProductForm({ initial, onSave, onCancel }) {
  const [f, setF]       = useState(initial ? { ...initial } : { ...EMPTY_P });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const save = async () => {
    const e = validateProduct(f);
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    await onSave({ ...f, sourceCost:+f.sourceCost, shopeePrice:+f.shopeePrice, stock:+f.stock, extraCost:+f.extraCost });
    setBusy(false);
  };
  return (
    <div style={{ ...S.card, boxShadow:"0 4px 24px rgba(0,0,0,0.10)" }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
        <Field label="商品名 *" error={errs.name}><input style={errs.name?S.inpErr:S.inp} value={f.name} onChange={e=>set("name",e.target.value)} placeholder="商品名を入力"/></Field>
        <Field label="SKU"><input style={S.inp} value={f.sku} onChange={e=>set("sku",e.target.value)} placeholder="例: WEP-001"/></Field>
        <Field label="仕入れプラットフォーム">
          <select style={S.inp} value={f.sourcePlatform} onChange={e=>set("sourcePlatform",e.target.value)}>
            {PLATFORMS.map(p=><option key={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="カテゴリ">
          <select style={S.inp} value={f.category} onChange={e=>set("category",e.target.value)}>
            {CATEGORIES.map(c=><option key={c}>{c}</option>)}
          </select>
        </Field>
        <div style={{ gridColumn:"1/-1" }}>
          <Field label="仕入れURL" error={errs.sourceUrl}><input style={errs.sourceUrl?S.inpErr:S.inp} value={f.sourceUrl} onChange={e=>set("sourceUrl",e.target.value)} placeholder="https://..."/></Field>
        </div>
        <Field label="仕入れ原価 (円) *" error={errs.sourceCost}><input style={errs.sourceCost?S.inpErr:S.inp} type="number" value={f.sourceCost} onChange={e=>set("sourceCost",e.target.value)}/></Field>
        <Field label="Shopee販売価格 (円) *" error={errs.shopeePrice}><input style={errs.shopeePrice?S.inpErr:S.inp} type="number" value={f.shopeePrice} onChange={e=>set("shopeePrice",e.target.value)}/></Field>
        <Field label="雑費 (円)"><input style={S.inp} type="number" value={f.extraCost} onChange={e=>set("extraCost",e.target.value)}/></Field>
        <Field label="在庫数 (仮想)"><input style={S.inp} type="number" value={f.stock} onChange={e=>set("stock",e.target.value)}/></Field>
        <Field label="ステータス">
          <select style={S.inp} value={f.status} onChange={e=>set("status",e.target.value)}>
            {Object.entries(PRODUCT_STATUSES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <div style={{ gridColumn:"1/-1" }}>
          <Field label="メモ"><textarea style={{ ...S.inp, height:56, resize:"vertical" }} value={f.notes} onChange={e=>set("notes",e.target.value)}/></Field>
        </div>
      </div>
      {f.sourceCost && f.shopeePrice && (
        <div style={{ marginBottom:16 }}>
          <ProfitBar sale={+f.shopeePrice} cost={+f.sourceCost} shipping={0} extra={+f.extraCost}/>
        </div>
      )}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
        <button onClick={onCancel} style={S.btnSec}>キャンセル</button>
        <button onClick={save} style={{ ...S.btnPri, opacity:busy?0.6:1 }} disabled={busy}>{busy?"保存中...":"保存"}</button>
      </div>
    </div>
  );
}

// ============================================================
// § ORDER FORM
// ============================================================
const EMPTY_O = { productId:null, buyer:"", quantity:1, salePrice:"", sourceCost:"", shippingCost:0, shopeeFeeRate:0.03, extraCost:0, status:"pending", orderDate:"", trackingNo:"", notes:"" };

function OrderForm({ initial, products, onSave, onCancel }) {
  const [f, setF]       = useState(initial ? { ...initial } : { ...EMPTY_O, productId:products[0]?.id || null });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const applyProduct = (pid) => {
    const p = products.find(x => x.id === pid);
    if (p) setF(x => ({ ...x, productId:pid, salePrice:p.shopeePrice * x.quantity, sourceCost:p.sourceCost * x.quantity }));
    else setF(x => ({ ...x, productId:pid }));
  };
  const save = async () => {
    const e = validateOrder(f);
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    await onSave({ ...f, quantity:+f.quantity, salePrice:+f.salePrice, sourceCost:+f.sourceCost, shippingCost:+f.shippingCost, extraCost:+f.extraCost, shopeeFeeRate:+f.shopeeFeeRate });
    setBusy(false);
  };
  const sel = products.find(p => p.id === f.productId);
  return (
    <div style={{ ...S.card, boxShadow:"0 4px 24px rgba(0,0,0,0.10)" }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
        <div style={{ gridColumn:"1/-1" }}>
          <Field label="商品 *">
            <select style={S.inp} value={f.productId||""} onChange={e=>applyProduct(e.target.value)}>
              {products.map(p=><option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
            </select>
          </Field>
          {sel && (
            <div style={{ marginTop:6, background:"#F8F9FF", borderRadius:8, padding:"7px 12px", fontSize:12, color:"#666" }}>
              仕入れ先: {sel.sourcePlatform} | 原価: ¥{fmt(sel.sourceCost)} | 在庫: <strong style={{ color:sel.stock===0?"#EF4444":"inherit" }}>{sel.stock}</strong>
              {sel.sourceUrl && <> | <a href={sel.sourceUrl} target="_blank" rel="noreferrer" style={{ color:"#FF6B35" }}>仕入れURL ↗</a></>}
            </div>
          )}
        </div>
        <Field label="購入者名 *" error={errs.buyer}><input style={errs.buyer?S.inpErr:S.inp} value={f.buyer} onChange={e=>set("buyer",e.target.value)}/></Field>
        <Field label="注文日"><input style={S.inp} type="date" value={f.orderDate} onChange={e=>set("orderDate",e.target.value)}/></Field>
        <Field label="数量" error={errs.quantity}><input style={errs.quantity?S.inpErr:S.inp} type="number" min={1} value={f.quantity} onChange={e=>set("quantity",e.target.value)}/></Field>
        <Field label="販売金額合計 (円)" error={errs.salePrice}><input style={errs.salePrice?S.inpErr:S.inp} type="number" value={f.salePrice} onChange={e=>set("salePrice",e.target.value)}/></Field>
        <Field label="仕入れ原価合計 (円)"><input style={S.inp} type="number" value={f.sourceCost} onChange={e=>set("sourceCost",e.target.value)}/></Field>
        <Field label="送料 (円)"><input style={S.inp} type="number" value={f.shippingCost} onChange={e=>set("shippingCost",e.target.value)}/></Field>
        <Field label="Shopee手数料率">
          <select style={S.inp} value={f.shopeeFeeRate} onChange={e=>set("shopeeFeeRate",+e.target.value)}>
            {[0.01,0.02,0.03,0.05,0.08].map(r=><option key={r} value={r}>{(r*100).toFixed(0)}%</option>)}
          </select>
        </Field>
        <Field label="雑費 (円)"><input style={S.inp} type="number" value={f.extraCost} onChange={e=>set("extraCost",e.target.value)}/></Field>
        <Field label="ステータス">
          <select style={S.inp} value={f.status} onChange={e=>set("status",e.target.value)}>
            {Object.entries(ORDER_STATUSES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="追跡番号"><input style={S.inp} value={f.trackingNo} onChange={e=>set("trackingNo",e.target.value)} placeholder="TRK123456789"/></Field>
        <div style={{ gridColumn:"1/-1" }}>
          <Field label="メモ"><textarea style={{ ...S.inp, height:56, resize:"vertical" }} value={f.notes} onChange={e=>set("notes",e.target.value)}/></Field>
        </div>
      </div>
      {f.salePrice && (
        <div style={{ marginBottom:16 }}>
          <ProfitBar sale={+f.salePrice} cost={+f.sourceCost} shipping={+f.shippingCost} feeRate={+f.shopeeFeeRate} extra={+f.extraCost}/>
        </div>
      )}
      <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
        <button onClick={onCancel} style={S.btnSec}>キャンセル</button>
        <button onClick={save} style={{ ...S.btnPri, opacity:busy?0.6:1 }} disabled={busy}>{busy?"保存中...":"保存"}</button>
      </div>
    </div>
  );
}

// ============================================================
// § DASHBOARD
// ============================================================
function Dashboard({ setTab }) {
  const { state } = useStore();
  const { products, orders } = state;
  const active       = orders.filter(o => o.status !== "cancelled");
  const rev          = active.reduce((s, o) => s + o.salePrice, 0);
  const prof         = active.reduce((s, o) => s + calcProfit(o.salePrice, o.sourceCost, o.shippingCost, o.shopeeFeeRate, o.extraCost), 0);
  const pending      = orders.filter(o => o.status === "pending").length;
  const listedCnt    = products.filter(p => p.isListed && p.listingStatus === "active").length;
  const unlistReqCnt = products.filter(p => p.unlistRequired).length;
  const oos          = products.filter(p => p.stock === 0 && p.status !== "inactive");
  return (
    <div>
      <h2 style={{ margin:"0 0 20px", fontWeight:800, color:"#1a1a2e" }}>ダッシュボード</h2>
      <div style={{ display:"flex", gap:16, marginBottom:24, flexWrap:"wrap" }}>
        <StatCard icon="💴" label="総売上"       value={`¥${fmt(rev)}`}  sub="キャンセル除く"                     accent="#3B82F6"/>
        <StatCard icon="📈" label="総利益"       value={`¥${fmt(prof)}`} sub={`利益率: ${calcMargin(rev,prof)}%`} accent="#10B981"/>
        <StatCard icon="⏳" label="未対応注文"   value={`${pending}件`}  sub="要対応"                             accent="#FF6B35"/>
        <StatCard icon="🏪" label="Shopee出品中" value={`${listedCnt}点`} sub={`全${products.length}点`}          accent="#EE4D2D"/>
      </div>
      {unlistReqCnt > 0 && (
        <div style={{ background:"#FEF2F2", border:"2px solid #EF4444", borderRadius:12, padding:"14px 18px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <strong style={{ color:"#DC2626", fontSize:13 }}>🔕 取り下げが必要な商品: {unlistReqCnt}件</strong>
            <div style={{ fontSize:12, color:"#666", marginTop:2 }}>{products.filter(p=>p.unlistRequired).map(p=>p.name).join("、")}</div>
          </div>
          <button onClick={() => setTab("products")} style={{ ...S.btnPri, background:"#EF4444", fontSize:12, padding:"7px 14px", flexShrink:0 }}>商品管理へ →</button>
        </div>
      )}
      <div style={{ ...S.card, marginBottom:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <h3 style={{ margin:0, fontSize:15, fontWeight:700 }}>最近の注文</h3>
          <button onClick={() => setTab("orders")} style={{ ...S.btnSec, padding:"6px 14px", fontSize:12 }}>すべて見る</button>
        </div>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
          <thead>
            <tr style={{ borderBottom:"2px solid #F3F4F6" }}>
              {["注文ID","商品名","購入者","金額","利益","ステータス"].map(h=>(
                <th key={h} style={{ textAlign:"left", padding:"8px 12px", color:"#888", fontWeight:600, fontSize:11, textTransform:"uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.slice(0,5).map(o => {
              const p = calcProfit(o.salePrice, o.sourceCost, o.shippingCost, o.shopeeFeeRate, o.extraCost);
              return (
                <tr key={o.id} style={{ borderBottom:"1px solid #F9FAFB" }}>
                  <td style={{ padding:"10px 12px", color:"#FF6B35", fontWeight:600, fontSize:12 }}>{o.id}</td>
                  <td style={{ padding:"10px 12px" }}>{o.productName}</td>
                  <td style={{ padding:"10px 12px", color:"#666" }}>{o.buyer}</td>
                  <td style={{ padding:"10px 12px", fontWeight:600 }}>¥{fmt(o.salePrice)}</td>
                  <td style={{ padding:"10px 12px", color:p>=0?"#10B981":"#EF4444", fontWeight:600 }}>¥{fmt(p)}</td>
                  <td style={{ padding:"10px 12px" }}><Badge status={o.status}/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {oos.length > 0 && (
        <div style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", borderRadius:12, padding:"14px 18px" }}>
          <strong style={{ color:"#DC2626", fontSize:13 }}>⚠️ 在庫切れ商品: </strong>
          <span style={{ color:"#666", fontSize:13 }}>{oos.map(p=>p.name).join("、")}</span>
        </div>
      )}
    </div>
  );
}

// ============================================================
// § PRODUCTS TAB
// ============================================================
function ProductsTab() {
  const { state, dispatch } = useStore();
  const toast      = useToast();
  const runListing = useListingAction();
  const runUnlist  = useUnlistAction();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [search, setSearch]     = useState("");
  const [sfilt, setSfilt]       = useState("all");
  const [lsfilt, setLsfilt]     = useState("all");

  const searched      = useSearch(state.products, ["name","sku","category","sourcePlatform"], search);
  const filtered      = searched.filter(p => sfilt==="all"||p.status===sfilt).filter(p => lsfilt==="all"||p.listingStatus===lsfilt);
  const unlistTargets = state.products.filter(p => p.unlistRequired);

  const handleSave = async (data) => {
    if (editing) {
      const { error } = await supabase.from("products").update({
        name: data.name, sku: data.sku, source_url: data.sourceUrl,
        source_platform: data.sourcePlatform, source_cost: data.sourceCost,
        shopee_price: data.shopeePrice, stock: data.stock, status: data.status,
        category: data.category, extra_cost: data.extraCost, notes: data.notes,
        updated_at: new Date().toISOString(),
      }).eq("id", editing.id);
      if (error) { toast("更新に失敗しました", "error"); return; }
      dispatch({ type:"UPDATE_PRODUCT", p:{ ...editing, ...data } });
      toast("商品を更新しました", "success");
    } else {
      const newId = nanoid();
      const { error } = await supabase.from("products").insert({
        id: newId, name: data.name, sku: data.sku, source_url: data.sourceUrl,
        source_platform: data.sourcePlatform, source_cost: data.sourceCost,
        shopee_price: data.shopeePrice, stock: data.stock, previous_stock: data.stock,
        last_synced_stock: data.stock, stock_change_type: "same", status: data.status,
        is_listed: false, listing_status: "unlisted", unlist_required: false,
        category: data.category, extra_cost: data.extraCost, notes: data.notes,
      });
      if (error) { toast("追加に失敗しました", "error"); return; }
      dispatch({ type:"ADD_PRODUCT", p:mkProduct({ ...data, id:newId }) });
      toast("商品を追加しました", "success");
    }
    setShowForm(false); setEditing(null);
  };

  const confirmDelete = (id, name) =>
    dispatch({ type:"SHOW_CONFIRM", message:`「${name}」を削除しますか？\nこの操作は元に戻せません。`, okLabel:"削除する", okColor:"#EF4444",
      onOk: async () => {
        const { error } = await supabase.from("products").delete().eq("id", id);
        if (error) { toast("削除に失敗しました", "error"); return; }
        dispatch({ type:"DELETE_PRODUCT", id });
        toast("商品を削除しました", "info");
      }
    });

  const confirmUnlist = (p) =>
    dispatch({ type:"SHOW_CONFIRM", message:`「${p.name}」をShopeeで非公開にしますか？\n在庫補充後に再公開できます。`, okLabel:"取り下げる", okColor:"#F59E0B",
      onOk: () => runUnlist(p),
    });

  const handleList     = (p) => dispatch({ type:"SHOW_MODAL", modal:{ type:"guide", product:p } });
  const handleCsvExport = () => {
    downloadCsv(shopeeListingService.generateCsv(filtered), `shopee_export_${today()}.csv`);
    toast("CSVを出力しました", "success");
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <h2 style={{ margin:0, fontWeight:800, color:"#1a1a2e" }}>商品管理</h2>
        <div style={{ display:"flex", gap:8 }}>
          {unlistTargets.length > 0 && (
            <button onClick={() => dispatch({ type:"SHOW_MODAL", modal:{ type:"unlistGuide", products:unlistTargets } })}
              style={{ ...S.btnUnlist, borderRadius:8, padding:"8px 14px", fontSize:12 }}>
              🔕 取り下げ対象 {unlistTargets.length}件
            </button>
          )}
          <button onClick={handleCsvExport} style={{ ...S.btnSec, fontSize:12, padding:"8px 14px" }}>📥 CSV出力</button>
          <button onClick={() => { setEditing(null); setShowForm(true); }} style={S.btnPri}>+ 商品追加</button>
        </div>
      </div>
      {showForm && (
        <div style={{ marginBottom:20 }}>
          <ProductForm initial={editing} onSave={handleSave} onCancel={() => { setShowForm(false); setEditing(null); }}/>
        </div>
      )}
      {unlistTargets.length > 0 && (
        <div style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", borderRadius:12, padding:"12px 16px", marginBottom:16, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontSize:13, color:"#DC2626" }}>
            <strong>🔕 在庫切れ出品商品:</strong>
            <span style={{ color:"#666", marginLeft:8 }}>{unlistTargets.map(p=>p.name).join("、")}</span>
          </div>
          <button onClick={() => dispatch({ type:"SHOW_MODAL", modal:{ type:"unlistGuide", products:unlistTargets } })}
            style={{ ...S.btnDng, whiteSpace:"nowrap", marginLeft:12 }}>手動対応ガイド</button>
        </div>
      )}
      <div style={{ ...S.card, padding:"12px 16px", marginBottom:16, display:"flex", gap:10, flexWrap:"wrap" }}>
        <input style={{ ...S.inp, flex:2, minWidth:200 }} value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 複数キーワード検索（スペース区切り）"/>
        <select style={{ ...S.inp, width:120 }} value={sfilt} onChange={e=>setSfilt(e.target.value)}>
          <option value="all">全ステータス</option>
          {Object.entries(PRODUCT_STATUSES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select>
        <select style={{ ...S.inp, width:120 }} value={lsfilt} onChange={e=>setLsfilt(e.target.value)}>
          <option value="all">全出品状態</option>
          {Object.entries(LISTING_STATUSES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div style={{ ...S.card, padding:0, overflow:"hidden" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
          <thead>
            <tr style={{ background:"#F8F9FF", borderBottom:"2px solid #E5E7EB" }}>
              {["商品名 / SKU","仕入れ先","原価","販売価格","利益/利益率","在庫","出品状態","操作"].map(h=>(
                <th key={h} style={{ textAlign:"left", padding:"12px 14px", color:"#888", fontWeight:600, fontSize:11, textTransform:"uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const prof         = calcProfit(p.shopeePrice, p.sourceCost, 0, state.settings.shopeeFeeRate/100, p.extraCost);
              const isProcessing = state.listingQueue.has(p.id);
              const rowBg        = p.unlistRequired ? "#FFF5F5" : "transparent";
              const canUnlist    = p.isListed && ["active","error"].includes(p.listingStatus);
              const canList      = !p.isListed && p.listingStatus !== "removed";
              return (
                <tr key={p.id} style={{ borderBottom:"1px solid #F3F4F6", background:rowBg }}>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontWeight:600, color:"#1a1a2e" }}>{p.name}</span>
                      {p.unlistRequired && <span title="在庫切れ・取り下げ必要">🔕</span>}
                    </div>
                    <div style={{ fontSize:11, color:"#aaa" }}>{p.sku} · {p.category}</div>
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ fontSize:12, fontWeight:600, color:"#555" }}>{p.sourcePlatform}</div>
                    {p.sourceUrl && <a href={p.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize:11, color:"#FF6B35" }}>仕入れURL ↗</a>}
                  </td>
                  <td style={{ padding:"12px 14px", fontWeight:600 }}>¥{fmt(p.sourceCost)}</td>
                  <td style={{ padding:"12px 14px", fontWeight:600 }}>¥{fmt(p.shopeePrice)}</td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ color:prof>=0?"#10B981":"#EF4444", fontWeight:700 }}>¥{fmt(prof)}</div>
                    <div style={{ fontSize:11, color:"#aaa" }}>{calcMargin(p.shopeePrice,prof)}%</div>
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", alignItems:"center" }}>
                      <span style={{ fontWeight:600, color:p.stock===0?"#EF4444":"#1a1a2e" }}>{p.stock}</span>
                      <StockChangeIcon changeType={p.stockChangeType} prevStock={p.previousStock} curStock={p.stock}/>
                    </div>
                    {p.stockChangeType !== "same" && <div style={{ fontSize:10, color:STOCK_CHANGE_COLOR[p.stockChangeType] }}>前回: {p.previousStock}</div>}
                    {p.stock===0 && p.isListed && <div style={{ fontSize:10, color:"#EF4444", fontWeight:700 }}>⚠ 出品中</div>}
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <Badge status={p.listingStatus} type="listing"/>
                    {p.shopeeItemId && <div style={{ fontSize:10, color:"#aaa", marginTop:2 }}>ID: {p.shopeeItemId}</div>}
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                      {canList && (
                        <button onClick={() => !isProcessing && handleList(p)} style={isProcessing?S.btnListDis:S.btnList} disabled={isProcessing}>
                          {isProcessing ? "⏳" : "🏪 出品"}
                        </button>
                      )}
                      {canUnlist && (
                        <button onClick={() => !isProcessing && confirmUnlist(p)} style={isProcessing?S.btnListDis:S.btnUnlist} disabled={isProcessing}>
                          {isProcessing ? "⏳" : "🔕 取り下げ"}
                        </button>
                      )}
                      {p.listingLogs.length > 0 && (
                        <button onClick={() => dispatch({ type:"SHOW_MODAL", modal:{ type:"listingLogs", productId:p.id } })}
                          style={{ ...S.btnSec, padding:"5px 8px", fontSize:10 }}>
                          📋 {p.listingLogs.length}
                        </button>
                      )}
                      <button onClick={() => { setEditing(p); setShowForm(true); }} style={{ ...S.btnSec, padding:"5px 10px", fontSize:11 }}>編集</button>
                      <button onClick={() => confirmDelete(p.id, p.name)} style={S.btnDng}>削除</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={8} style={{ textAlign:"center", padding:40, color:"#aaa" }}>商品がありません</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// § ORDERS TAB
// ============================================================
function OrdersTab() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { products, orders, settings } = state;
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [search, setSearch]     = useState("");
  const [sfilt, setSfilt]       = useState("all");

  const searched = useSearch(orders, ["id","buyer","productName","trackingNo"], search);
  const filtered = sfilt === "all" ? searched : searched.filter(o => o.status === sfilt);

  const handleSave = async (data) => {
    const prod = products.find(p => p.id === data.productId);
    const productName = prod?.name || editing?.productName || "";
    if (editing) {
      const { error } = await supabase.from("orders").update({
        product_id: data.productId, product_name: productName, buyer: data.buyer,
        quantity: data.quantity, sale_price: data.salePrice, source_cost: data.sourceCost,
        shipping_cost: data.shippingCost, shopee_fee_rate: data.shopeeFeeRate,
        extra_cost: data.extraCost, status: data.status, order_date: data.orderDate,
        tracking_no: data.trackingNo, notes: data.notes,
      }).eq("id", editing.id);
      if (error) { toast("更新に失敗しました", "error"); return; }
      const hist = data.status !== editing.status
        ? [...(editing.history||[]), { at:today(), status:data.status, note:`${ORDER_STATUSES[editing.status]} → ${ORDER_STATUSES[data.status]}` }]
        : editing.history;
      dispatch({ type:"UPDATE_ORDER", o:{ ...editing, ...data, productName, history:hist } });
      toast("注文を更新しました", "success");
    } else {
      const newId = genOrderId();
      const { error } = await supabase.from("orders").insert({
        id: newId, product_id: data.productId, product_name: productName,
        buyer: data.buyer, quantity: data.quantity, sale_price: data.salePrice,
        source_cost: data.sourceCost, shipping_cost: data.shippingCost,
        shopee_fee_rate: data.shopeeFeeRate, extra_cost: data.extraCost,
        status: data.status, order_date: data.orderDate || today(),
        tracking_no: data.trackingNo, notes: data.notes,
      });
      if (error) { toast("追加に失敗しました", "error"); return; }
      if (settings.autoDeductStock && prod) {
        const ns = Math.max(0, prod.stock - data.quantity);
        const ct = calcStockChange(prod.stock, ns);
        await supabase.from("products").update({
          stock: ns, previous_stock: prod.stock, stock_change_type: ct,
          status: ns===0 ? "out_of_stock" : prod.status,
          unlist_required: ns===0 && prod.isListed,
        }).eq("id", prod.id);
        dispatch({ type:"UPDATE_PRODUCT", p:{ ...prod, previousStock:prod.stock, stock:ns, stockChangeType:ct, status:ns===0?"out_of_stock":prod.status, unlistRequired:ns===0&&prod.isListed } });
        if (ns === 0) toast(`⚠️ ${prod.name} の在庫が0になりました`, "warn");
      }
      dispatch({ type:"ADD_ORDER", o:{ ...data, id:newId, productName, history:[{ at:today(), status:"pending", note:"注文登録" }] } });
      toast("注文を追加しました", "success");
    }
    setShowForm(false); setEditing(null);
  };

  const confirmDelete = (id) =>
    dispatch({ type:"SHOW_CONFIRM", message:"この注文を削除しますか？", okLabel:"削除する", okColor:"#EF4444",
      onOk: async () => {
        const { error } = await supabase.from("orders").delete().eq("id", id);
        if (error) { toast("削除に失敗しました", "error"); return; }
        dispatch({ type:"DELETE_ORDER", id });
        toast("注文を削除しました", "info");
      }
    });

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <h2 style={{ margin:0, fontWeight:800, color:"#1a1a2e" }}>注文管理</h2>
        <button onClick={() => { setEditing(null); setShowForm(true); }} style={S.btnPri}>+ 注文追加</button>
      </div>
      {showForm && (
        <div style={{ marginBottom:20 }}>
          <OrderForm initial={editing} products={products} onSave={handleSave} onCancel={() => { setShowForm(false); setEditing(null); }}/>
        </div>
      )}
      <div style={{ ...S.card, padding:"12px 16px", marginBottom:16, display:"flex", gap:10 }}>
        <input style={{ ...S.inp, flex:1 }} value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 複数キーワード検索（スペース区切り）"/>
        <select style={{ ...S.inp, width:140 }} value={sfilt} onChange={e=>setSfilt(e.target.value)}>
          <option value="all">全ステータス</option>
          {Object.entries(ORDER_STATUSES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div style={{ ...S.card, padding:0, overflow:"hidden" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
          <thead>
            <tr style={{ background:"#F8F9FF", borderBottom:"2px solid #E5E7EB" }}>
              {["注文ID / 日付","商品名","購入者","数量","売上","利益","追跡番号","ステータス","操作"].map(h=>(
                <th key={h} style={{ textAlign:"left", padding:"12px 14px", color:"#888", fontWeight:600, fontSize:11, textTransform:"uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(o => {
              const p = calcProfit(o.salePrice, o.sourceCost, o.shippingCost, o.shopeeFeeRate, o.extraCost);
              return (
                <tr key={o.id} style={{ borderBottom:"1px solid #F3F4F6" }}>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ color:"#FF6B35", fontWeight:700, fontSize:12 }}>{o.id}</div>
                    <div style={{ fontSize:11, color:"#aaa" }}>{o.orderDate}</div>
                  </td>
                  <td style={{ padding:"12px 14px", fontWeight:600 }}>{o.productName}</td>
                  <td style={{ padding:"12px 14px", color:"#666" }}>{o.buyer}</td>
                  <td style={{ padding:"12px 14px", textAlign:"center" }}>{o.quantity}</td>
                  <td style={{ padding:"12px 14px", fontWeight:600 }}>¥{fmt(o.salePrice)}</td>
                  <td style={{ padding:"12px 14px", fontWeight:700, color:p>=0?"#10B981":"#EF4444" }}>¥{fmt(p)}</td>
                  <td style={{ padding:"12px 14px", fontSize:11, color:"#555" }}>{o.trackingNo||"—"}</td>
                  <td style={{ padding:"12px 14px" }}><Badge status={o.status}/></td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", gap:6 }}>
                      <button onClick={() => { setEditing(o); setShowForm(true); }} style={{ ...S.btnSec, padding:"5px 10px", fontSize:11 }}>編集</button>
                      <button onClick={() => confirmDelete(o.id)} style={S.btnDng}>削除</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={9} style={{ textAlign:"center", padding:40, color:"#aaa" }}>注文がありません</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// § PRICE CALCULATOR
// ============================================================
function Calculator() {
  const [cost, setCost]     = useState(1000);
  const [ship, setShip]     = useState(200);
  const [extra, setExtra]   = useState(0);
  const [target, setTarget] = useState(30);
  const [fee, setFee]       = useState(3);
  const rec  = Math.ceil((cost + ship + extra) / (1 - (target + fee) / 100));
  const feeY = Math.round(rec * fee / 100);
  const net  = rec - cost - ship - feeY - extra;
  const mar  = calcMargin(rec, net);
  return (
    <div>
      <h2 style={{ margin:"0 0 20px", fontWeight:800, color:"#1a1a2e" }}>価格計算</h2>
      <div style={S.card}>
        <h3 style={{ margin:"0 0 20px", fontSize:15, fontWeight:700 }}>💰 価格計算ツール</h3>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:12, marginBottom:20 }}>
          {[["仕入れ原価",cost,setCost],["送料",ship,setShip],["雑費",extra,setExtra]].map(([l,v,s])=>(
            <div key={l}><label style={S.lbl}>{l} (円)</label><input style={S.inp} type="number" value={v} onChange={e=>s(+e.target.value)}/></div>
          ))}
          <div><label style={S.lbl}>目標粗利率 (%)</label><input style={S.inp} type="number" value={target} onChange={e=>setTarget(+e.target.value)}/></div>
          <div><label style={S.lbl}>Shopee手数料 (%)</label><input style={S.inp} type="number" step={0.5} value={fee} onChange={e=>setFee(+e.target.value)}/></div>
        </div>
        <div style={{ background:"linear-gradient(135deg,#FF6B35,#F7931E)", borderRadius:12, padding:20, color:"#fff", display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:16, textAlign:"center" }}>
          {[["推奨販売価格",`¥${fmt(rec)}`],[`Shopee手数料(${fee}%)`,`¥${fmt(feeY)}`],["純利益",`¥${fmt(net)}`],["純利益率",`${mar}%`]].map(([l,v])=>(
            <div key={l}><div style={{ fontSize:11, opacity:0.85, marginBottom:4 }}>{l}</div><div style={{ fontSize:22, fontWeight:800 }}>{v}</div></div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// § SETTINGS & SYNC
// ============================================================
function SettingsTab() {
  const { state, dispatch } = useStore();
  const { settings, syncLogs, loadingSync } = state;
  const { runSync } = useSyncScheduler();
  const setSetting    = (k, v) => dispatch({ type:"SET_SETTINGS", patch:{ [k]:v } });
  const syncable      = state.products.filter(p => ["Amazon","楽天","AliExpress"].includes(p.sourcePlatform)).length;
  const nonSyncable   = state.products.filter(p => ["タオバオ","その他"].includes(p.sourcePlatform)).length;
  const unlistTargets = state.products.filter(p => p.unlistRequired);

  return (
    <div>
      <h2 style={{ margin:"0 0 20px", fontWeight:800, color:"#1a1a2e" }}>設定・在庫同期</h2>
      <div style={{ display:"grid", gap:20 }}>
        <div style={S.card}>
          <h3 style={{ margin:"0 0 4px", fontSize:15, fontWeight:700 }}>🔄 在庫同期設定</h3>
          <p style={{ margin:"0 0 18px", fontSize:12, color:"#888" }}>公式APIが提供されているプラットフォームのみ自動同期。タオバオ等は手動更新。</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
            <div>
              <label style={S.lbl}>同期間隔</label>
              <select style={S.inp} value={settings.syncIntervalMin} onChange={e=>setSetting("syncIntervalMin",+e.target.value)}>
                {SYNC_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div><label style={S.lbl}>自動同期</label><Toggle value={settings.syncEnabled} onChange={v=>setSetting("syncEnabled",v)}/></div>
            <div>
              <label style={S.lbl}>Shopee手数料率 (%)</label>
              <input style={S.inp} type="number" step={0.5} value={settings.shopeeFeeRate} onChange={e=>setSetting("shopeeFeeRate",+e.target.value)}/>
            </div>
            <div><label style={S.lbl}>注文時に在庫を自動減算</label><Toggle value={settings.autoDeductStock} onChange={v=>setSetting("autoDeductStock",v)}/></div>
          </div>
          <div style={{ background:"#F8F9FF", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:12, color:"#666" }}>
            <strong>同期対象:</strong> {syncable}件（Amazon/楽天/AliExpress）　<strong>手動のみ:</strong> {nonSyncable}件（タオバオ/その他）
          </div>
          <button onClick={runSync} disabled={loadingSync} style={{ ...S.btnPri, opacity:loadingSync?0.6:1 }}>
            {loadingSync ? "⏳ 同期中..." : "🔄 今すぐ同期"}
          </button>
        </div>

        <div style={S.card}>
          <h3 style={{ margin:"0 0 4px", fontSize:15, fontWeight:700 }}>🔕 在庫切れ取り下げ設定</h3>
          <p style={{ margin:"0 0 18px", fontSize:12, color:"#888" }}>在庫同期で stock=0 を検知した出品商品を取り下げます。</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
            <div><label style={S.lbl}>自動取り下げ</label><Toggle value={settings.autoUnlist} onChange={v=>setSetting("autoUnlist",v)}/></div>
            <div>
              <label style={S.lbl}>取り下げまでの猶予（誤検知対策）</label>
              <select style={{ ...S.inp, opacity:settings.autoUnlist?1:0.5 }} value={settings.unlistDelayMin} onChange={e=>setSetting("unlistDelayMin",+e.target.value)} disabled={!settings.autoUnlist}>
                {DELAY_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          {unlistTargets.length > 0 && (
            <div style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", borderRadius:10, padding:"12px 14px", marginBottom:12 }}>
              <div style={{ fontSize:12, fontWeight:700, color:"#DC2626", marginBottom:6 }}>🔕 手動対応が必要な商品</div>
              {unlistTargets.map(p=>(
                <div key={p.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", fontSize:12, borderBottom:"1px solid #FEE2E2" }}>
                  <span>{p.name} <span style={{ color:"#aaa" }}>({p.sku})</span></span>
                  <span style={{ color:"#888" }}>在庫: {p.stock} | ID: {p.shopeeItemId || "—"}</span>
                </div>
              ))}
              <button onClick={() => dispatch({ type:"SHOW_MODAL", modal:{ type:"unlistGuide", products:unlistTargets } })}
                style={{ ...S.btnUnlist, borderRadius:8, padding:"7px 14px", marginTop:10, fontSize:12 }}>
                手動取り下げガイドを開く
              </button>
            </div>
          )}
          <div style={{ background:"#F0FDF4", border:"1px solid #BBF7D0", borderRadius:10, padding:"10px 14px", fontSize:12, color:"#166534", lineHeight:1.7 }}>
            <strong>💡 取り下げ方針（推奨）:</strong><br/>
            ・非公開化（unlist）を使用 → 在庫補充後に再公開可能<br/>
            ・削除（delete）は復元不可のため非推奨<br/>
            ・猶予時間を設定することで誤検知による意図しない取り下げを防止
          </div>
        </div>

        <div style={S.card}>
          <h3 style={{ margin:"0 0 16px", fontSize:15, fontWeight:700 }}>📋 同期ログ</h3>
          {syncLogs.length === 0
            ? <div style={{ color:"#aaa", fontSize:13, padding:"16px 0", textAlign:"center" }}>ログはありません</div>
            : <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {syncLogs.map(l=>(
                  <div key={l.id} style={{ display:"flex", gap:12, alignItems:"center", padding:"8px 12px", background:l.status==="error"?"#FEF2F2":l.status==="success"?"#ECFDF5":"#F8F9FF", borderRadius:8 }}>
                    <span style={{ fontSize:14 }}>{l.status==="error"?"❌":l.status==="success"?"✅":"⏳"}</span>
                    <span style={{ fontSize:11, color:"#888", minWidth:140 }}>{l.at}</span>
                    <span style={{ fontSize:12, color:"#444" }}>{l.message}</span>
                  </div>
                ))}
              </div>
          }
        </div>

        <div style={{ background:"#FFFBEB", border:"1px solid #FCD34D", borderRadius:12, padding:"14px 18px" }}>
          <strong style={{ color:"#92400E", fontSize:13 }}>⚖️ 規約対応について</strong>
          <p style={{ margin:"6px 0 0", fontSize:12, color:"#78350F", lineHeight:1.7 }}>
            ・在庫自動同期: 公式APIが提供されているプラットフォームのみ（スクレイピング不使用）<br/>
            ・Shopee出品/取り下げ: Open Platform API経由（サーバーサイド認証必須）。デモはCSV+手動ガイド代替<br/>
            ・最短同期間隔: 5分（レートリミッター実装済み）<br/>
            ・タオバオ等API非公開PF: 手動更新のみ
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// § TABS / APP INNER
// ============================================================
const TABS = [
  { id:"dashboard",  label:"📊 ダッシュボード" },
  { id:"products",   label:"📦 商品管理" },
  { id:"orders",     label:"🛒 注文管理" },
  { id:"calculator", label:"💰 価格計算" },
  { id:"settings",   label:"⚙️ 設定・同期" },
];

function AppInner() {
  const [tab, setTab] = useState("dashboard");
  const { state }    = useStore();
  const pending      = state.orders.filter(o => o.status === "pending").length;
  const unlistReqCnt = state.products.filter(p => p.unlistRequired).length;

  return (
    <div style={{ minHeight:"100vh", background:"#F0F2F8", fontFamily:"'Noto Sans JP','Hiragino Sans',sans-serif" }}>
      <div style={{ background:"linear-gradient(135deg,#1a1a2e 0%,#16213e 100%)", padding:"0 24px", display:"flex", alignItems:"center", gap:24, boxShadow:"0 2px 16px rgba(0,0,0,0.3)", flexWrap:"wrap" }}>
        <div style={{ padding:"16px 0", display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, background:"linear-gradient(135deg,#FF6B35,#F7931E)", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>🛍</div>
          <span style={{ color:"#fff", fontWeight:800, fontSize:15 }}>Shopee無在庫販売ツール</span>
          {state.settings.syncEnabled && (
            <span style={{ background:"rgba(16,185,129,0.2)", color:"#10B981", fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:10, border:"1px solid #10B981" }}>
              SYNC {state.settings.syncIntervalMin}min
            </span>
          )}
          {state.settings.autoUnlist && (
            <span style={{ background:"rgba(239,68,68,0.2)", color:"#FCA5A5", fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:10, border:"1px solid rgba(239,68,68,0.5)" }}>
              AUTO-UNLIST {state.settings.unlistDelayMin > 0 ? `${state.settings.unlistDelayMin}min` : "即時"}
            </span>
          )}
        </div>
        <div style={{ display:"flex", gap:2, flex:1 }}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              background: tab===t.id?"rgba(255,107,53,0.2)":"transparent",
              color: tab===t.id?"#FF6B35":"rgba(255,255,255,0.6)",
              border:"none", borderBottom: tab===t.id?"2px solid #FF6B35":"2px solid transparent",
              padding:"17px 12px", cursor:"pointer", fontWeight:tab===t.id?700:400,
              fontSize:12, transition:"all 0.2s", fontFamily:"inherit", position:"relative",
            }}>
              {t.label}
              {t.id==="orders" && pending>0 && (
                <span style={{ position:"absolute", top:8, right:2, background:"#EF4444", color:"#fff", fontSize:9, fontWeight:800, borderRadius:"50%", width:16, height:16, display:"flex", alignItems:"center", justifyContent:"center" }}>{pending}</span>
              )}
              {t.id==="products" && unlistReqCnt>0 && (
                <span style={{ position:"absolute", top:8, right:2, background:"#F59E0B", color:"#fff", fontSize:9, fontWeight:800, borderRadius:"50%", width:16, height:16, display:"flex", alignItems:"center", justifyContent:"center" }}>{unlistReqCnt}</span>
              )}
            </button>
          ))}
        </div>
        <button onClick={() => supabase.auth.signOut()}
          style={{ color:"rgba(255,255,255,0.5)", background:"none", border:"none", fontSize:12, cursor:"pointer" }}>
          ログアウト
        </button>
      </div>

      <div style={{ maxWidth:1200, margin:"0 auto", padding:"28px 20px" }}>
        {tab==="dashboard"  && <Dashboard setTab={setTab}/>}
        {tab==="products"   && <ProductsTab/>}
        {tab==="orders"     && <OrdersTab/>}
        {tab==="calculator" && <Calculator/>}
        {tab==="settings"   && <SettingsTab/>}
      </div>

      <ConfirmModal/>
      <ListingGuideModal/>
      <UnlistGuideModal/>
      <ListingLogsModal/>
    </div>
  );
}

// ============================================================
// § LOGIN SCREEN
// ============================================================
function LoginScreen() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const handleLogin = async () => {
    setLoading(true); setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError("メールアドレスまたはパスワードが正しくありません");
    setLoading(false);
  };

  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", background:"#F0F2F8", fontFamily:"'Noto Sans JP',sans-serif" }}>
      <div style={{ background:"#fff", borderRadius:16, padding:40, width:360, boxShadow:"0 4px 24px rgba(0,0,0,0.10)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:28 }}>
          <div style={{ width:36, height:36, background:"linear-gradient(135deg,#FF6B35,#F7931E)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🛍</div>
          <div>
            <div style={{ fontWeight:800, fontSize:15, color:"#1a1a2e" }}>Shopee無在庫販売ツール</div>
            <div style={{ fontSize:11, color:"#aaa" }}>ログインしてください</div>
          </div>
        </div>
        <div style={{ marginBottom:14 }}>
          <label style={S.lbl}>メールアドレス</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
            style={{ ...S.inp }} placeholder="your@email.com"/>
        </div>
        <div style={{ marginBottom:20 }}>
          <label style={S.lbl}>パスワード</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            style={{ ...S.inp }} placeholder="••••••••"/>
        </div>
        {error && <div style={{ color:"#EF4444", fontSize:12, marginBottom:12 }}>⚠ {error}</div>}
        <button onClick={handleLogin} disabled={loading}
          style={{ ...S.btnPri, width:"100%", padding:"11px", fontSize:14, opacity:loading?0.6:1 }}>
          {loading ? "ログイン中..." : "ログイン"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// § ROOT — Hydration対策 + ログイン制御
// ============================================================
export default function App() {
  // Hooksはすべてトップレベルに配置（条件分岐の外）
  const [mounted, setMounted]   = useState(false);
  const [session, setSession]   = useState(null);
  const [loading, setLoading]   = useState(true);

  // マウント確認（Hydrationエラー対策）
  useEffect(() => {
    setMounted(true);
  }, []);

  // Supabase認証状態の監視
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  // SSR中は何も表示しない（Hydration対策）
  if (!mounted) return null;

  // 認証確認中
  if (loading) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontFamily:"sans-serif", color:"#888" }}>
      読み込み中...
    </div>
  );

  // 未ログイン
  if (!session) return <LoginScreen />;

  // ログイン済み
  return (
    <AppProvider>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </AppProvider>
  );
}