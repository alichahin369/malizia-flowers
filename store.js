/* Malizia data layer — shared by the website and the owner dashboard.
   Live mode: Supabase (when config.js has the URL + key).
   Demo mode: everything is kept in this browser, so you can place an order on the site
   and watch it appear on the dashboard in the same browser. */
(function () {
  const C = window.MALIZIA_CONFIG || {};
  const LIVE = !!(C.supabaseUrl && C.supabaseAnonKey);
  const K_ORD = "malizia_demo_orders", K_PROD = "malizia_demo_products";
  let sb = null, libPromise = null;

  function loadLib() {
    if (!LIVE) return Promise.resolve(null);
    if (sb) return Promise.resolve(sb);
    if (!libPromise) libPromise = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
      s.onload = () => { sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, { auth: { persistSession: true } }); res(sb); };
      s.onerror = () => rej(new Error("Could not load the database library"));
      document.head.appendChild(s);
    });
    return libPromise;
  }
  const rd = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
  const catalog = () => (window.MALIZIA_CATALOG || []).map((p, i) => ({ id: p.id, name: p.name, category: p.cat[0], variants: p.v.map(v => ({ l: v.l, p: v.p, from: !!v.from })), available: true, sort: i }));

  function demoProducts() {
    const over = rd(K_PROD, {});
    return catalog().map(p => Object.assign(p, over[p.id] || {}));
  }
  function priceItems(items, prods, allowCustom) {
    const byId = Object.fromEntries(prods.map(p => [p.id, p]));
    let sub = 0; const out = [];
    for (const it of items) {
      const q = Math.min(Math.max(parseInt(it.q) || 1, 1), 50);
      const p = byId[it.id];
      if (!p || (!p.available && !allowCustom)) {
        if (allowCustom && it.price != null) { out.push({ id: it.id || "custom", q, name: it.name || "Custom item", label: it.label || "", price: +it.price }); sub += +it.price * q; }
        continue;
      }
      const v = p.variants[it.vi || 0]; if (!v) continue;
      out.push({ id: p.id, vi: it.vi || 0, q, name: p.name, label: v.l, price: v.p, from: !!v.from }); sub += v.p * q;
    }
    return { items: out, subtotal: sub };
  }

  const Store = {
    live: LIVE,
    config: C,
    uuid,
    ref: id => String(id).replace(/-/g, "").slice(0, 6).toUpperCase(),
    client: loadLib,

    /* ---------- website ---------- */
    async products() {
      if (!LIVE) return demoProducts();
      const c = await loadLib();
      const { data, error } = await c.from("products").select("*").order("sort");
      if (error) throw error;
      return data;
    },
    async placeOrder(o) {
      const id = uuid();
      const row = Object.assign({}, o, { id });
      if (!LIVE) {
        const pr = priceItems(o.items, demoProducts(), false);
        if (!pr.items.length) throw new Error("These items are no longer available.");
        const all = rd(K_ORD, []);
        const num = all.concat(Store._seed()).reduce((m, x) => Math.max(m, x.number || 0), 1000) + 1;
        all.push(Object.assign(row, pr, { number: num, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source: "website", status: "new", paid: false, delivery_fee: 0, total: pr.subtotal }));
        wr(K_ORD, all);
        return { id, ref: Store.ref(id) };
      }
      const c = await loadLib();
      const { error } = await c.from("orders").insert(row);   // no read-back: visitors can't read orders
      if (error) throw error;
      return { id, ref: Store.ref(id) };
    },

    /* ---------- dashboard ---------- */
    async session() {
      if (!LIVE) return { user: { email: "demo@malizia" }, demo: true };
      const c = await loadLib(); const { data } = await c.auth.getSession(); return data.session;
    },
    async signIn(email, password) { const c = await loadLib(); const { error } = await c.auth.signInWithPassword({ email, password }); if (error) throw error; },
    async signOut() { if (LIVE) { const c = await loadLib(); await c.auth.signOut(); } },
    async orders() {
      if (!LIVE) return rd(K_ORD, []).concat(Store._seed());
      const c = await loadLib();
      const { data, error } = await c.from("orders").select("*").order("created_at", { ascending: false }).limit(5000);
      if (error) throw error; return data;
    },
    async updateOrder(id, patch) {
      if (!LIVE) {
        const all = rd(K_ORD, []); let o = all.find(x => x.id === id);
        if (!o) { const seeds = rd("malizia_demo_seed_patch", {}); seeds[id] = Object.assign(seeds[id] || {}, patch); wr("malizia_demo_seed_patch", seeds); return; }
        Object.assign(o, patch, { updated_at: new Date().toISOString() }); o.total = (+o.subtotal || 0) + (+o.delivery_fee || 0); wr(K_ORD, all); return;
      }
      const c = await loadLib(); const { error } = await c.from("orders").update(patch).eq("id", id); if (error) throw error;
    },
    async createOrder(o) {   // manual order from the dashboard
      const id = uuid();
      if (!LIVE) {
        const pr = priceItems(o.items, demoProducts(), true);
        const all = rd(K_ORD, []); const num = all.concat(Store._seed()).reduce((m, x) => Math.max(m, x.number || 0), 1000) + 1;
        all.push(Object.assign({}, o, pr, { id, number: num, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), total: pr.subtotal + (+o.delivery_fee || 0) }));
        wr(K_ORD, all); return id;
      }
      const c = await loadLib(); const { error } = await c.from("orders").insert(Object.assign({}, o, { id })); if (error) throw error; return id;
    },
    async deleteOrder(id) {
      if (!LIVE) { wr(K_ORD, rd(K_ORD, []).filter(x => x.id !== id)); const h = rd("malizia_demo_hidden", []); h.push(id); wr("malizia_demo_hidden", h); return; }
      const c = await loadLib(); const { error } = await c.from("orders").delete().eq("id", id); if (error) throw error;
    },
    async updateProduct(id, patch) {
      if (!LIVE) { const over = rd(K_PROD, {}); over[id] = Object.assign(over[id] || {}, patch); wr(K_PROD, over); return; }
      const c = await loadLib(); const { error } = await c.from("products").update(patch).eq("id", id); if (error) throw error;
    },
    async subscribe(onChange) {
      if (!LIVE) { addEventListener("storage", e => { if (e.key && e.key.startsWith("malizia_demo")) onChange(e.key === K_ORD ? "order" : "other"); }); return; }
      const c = await loadLib();
      c.channel("orders-live").on("postgres_changes", { event: "*", schema: "public", table: "orders" }, p => onChange(p.eventType === "INSERT" ? "insert" : "order", p)).subscribe();
    },

    /* demo history so the dashboard isn't empty */
    _seedCache: null,
    _seed() {
      if (!this._seedCache) {
        const prods = catalog(); let s = 7;
        const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
        const pick = a => a[Math.floor(rnd() * a.length)];
        const names = ["Rana Haddad","Karim Saab","Lea Khoury","Maya Nassar","Omar Fares","Nour Aoun","Jad Mansour","Sara Hayek","Tarek Zein","Yara Daher","Hadi Karam","Lina Saliba","Rami Chamoun","Dana Rizk","Ziad Hobeika"];
        const areas = ["Achrafieh, Sursock St","Hamra, Bliss St","Verdun, Rachid Karami St","Mar Mikhael, Armenia St","Badaro, Main St","Jounieh, Kaslik","Dbayeh, Seaside Rd","Ras Beirut, Manara","Gemmayzeh, Gouraud St","Sin El Fil, Horsh Tabet"];
        const slots = ["Morning (9–12)","Afternoon (12–4)","Evening (4–8)"];
        const msgs = ["Happy birthday my love ❤️","Congratulations on the new baby!","Thank you for everything","Just because. Love you.","Happy anniversary","Get well soon","", ""];
        const out = []; const now = new Date(); const hidden = rd("malizia_demo_hidden", []); const patch = rd("malizia_demo_seed_patch", {});
        let num = 1000;
        for (let d = 64; d >= -2; d--) {
          const n = d < 0 ? 2 : Math.floor(rnd() * 4) + (d % 7 === 2 ? 3 : 1);
          for (let i = 0; i < n; i++) {
            const created = new Date(now); created.setDate(now.getDate() - Math.max(d, 0) - (d < 0 ? 0 : 0)); created.setHours(8 + Math.floor(rnd() * 12), Math.floor(rnd() * 60), 0, 0);
            if (created > now) created.setTime(now.getTime() - (i + 1) * 3600e3 * 2);
            const deliv = new Date(created); deliv.setDate(created.getDate() + (d < 0 ? -d : (rnd() < .6 ? 0 : 1)));
            const items = []; const k = rnd() < .8 ? 1 : 2;
            for (let j = 0; j < k; j++) { const p = pick(prods); const vi = Math.floor(rnd() * p.variants.length); items.push({ id: p.id, vi, q: 1, name: p.name, label: p.variants[vi].l, price: p.variants[vi].p, from: p.variants[vi].from }); }
            const sub = items.reduce((a, x) => a + x.price * x.q, 0);
            const fee = pick([3, 4, 5, 5, 6, 0]);
            const age = d;
            let status = age >= 2 ? (rnd() < .06 ? "cancelled" : "delivered") : age === 1 ? pick(["delivered", "delivered", "delivered", "out_for_delivery"]) : age === 0 ? (i === 0 ? "delivered" : i === 1 ? "new" : i === 2 ? "ready" : pick(["new", "ready", "out_for_delivery", "delivered"])) : "new";
            const cust = pick(names), rec = pick(names);
            const id = "seed-" + num;
            num++;
            if (hidden.includes(id)) continue;
            out.push(Object.assign({
              id, number: num, created_at: created.toISOString(), updated_at: created.toISOString(),
              source: pick(["website", "website", "website", "whatsapp", "instagram", "phone"]),
              status, items, subtotal: sub, delivery_fee: fee, total: sub + fee,
              paid: status === "delivered" ? rnd() < .92 : rnd() < .35, payment_method: pick(["Cash on delivery", "Whish", "OMT", "Card", "Cash on delivery"]),
              customer_name: cust, customer_phone: "+961 " + (70 + Math.floor(rnd() * 10)) + " " + String(100000 + Math.floor(rnd() * 899999)),
              recipient_name: rec, recipient_phone: "+961 " + (3 + Math.floor(rnd() * 5)) + " " + String(100000 + Math.floor(rnd() * 899999)),
              address: pick(areas) + ", Bldg " + (1 + Math.floor(rnd() * 40)) + ", Floor " + (1 + Math.floor(rnd() * 9)),
              delivery_date: deliv.toISOString().slice(0, 10), delivery_slot: pick(slots), card_message: pick(msgs),
              driver: status === "out_for_delivery" || status === "delivered" ? pick(["Ahmad", "Elie"]) : status === "ready" && rnd() < .5 ? pick(["Ahmad", "Elie"]) : null, notes: null
            }, patch[id] || {}));
            const o = out[out.length - 1]; o.total = (+o.subtotal) + (+o.delivery_fee || 0);
          }
        }
        this._seedCache = out;
      }
      const patch = rd("malizia_demo_seed_patch", {}), hidden = rd("malizia_demo_hidden", []);
      return this._seedCache.filter(o => !hidden.includes(o.id)).map(o => { const x = Object.assign({}, o, patch[o.id] || {}); x.total = (+x.subtotal) + (+x.delivery_fee || 0); return x; });
    },
    resetDemo() { ["malizia_demo_orders", "malizia_demo_products", "malizia_demo_seed_patch", "malizia_demo_hidden"].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} }); }
  };
  window.MaliziaStore = Store;
})();
