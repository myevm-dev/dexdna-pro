/* DexDNA provider UI. Keys and fee authority are held by /api/trading. */
const Trading = (() => {
  let triggers = [];
  try {
    const saved = store.get("triggers", []);
    const token = t => t && /^0x[\da-f]{40}$/i.test(t.address) && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36 && Number.isInteger(t.chainId);
    if(Array.isArray(saved)) triggers = saved.filter(t => t && typeof t.id === "string" && /^0x[\da-f]{40}$/i.test(t.user) && token(t.pay) && token(t.get) && /^\d{1,78}$/.test(t.amount) && /^\d{1,78}$/.test(t.target) && Number.isFinite(t.expires)).slice(0, 5);
  } catch {}
  let monitoring = false, bookSequence = 0;
  const ready = (provider = S.marketProvider) => !!S.server?.providers?.find(p => p.id === provider)?.market;
  const feeText = () => S.server?.fee?.bps != null ? `${S.server.fee.bps / 100}%` : "Not configured";
  const validTarget = () => {
    try { return !!getTk() && parseUnits($("#targetReceive").value, getTk().decimals) > 0n; } catch { return false; }
  };
  function targetUnits() { return parseUnits($("#targetReceive").value, getTk().decimals).toString(); }
  async function api(path, body) {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || "Trading request failed");
    return data;
  }
  async function loadConfiguration() {
    try {
      S.server = await api("/api/trading/config");
      if(!ready(S.marketProvider) && S.orderType === "market") S.marketProvider = S.server.providers.find(p => p.market)?.id || "relay";
    } catch { S.server = null; }
    updateControls();
  }
  function updateControls() {
    const select = $("#marketProvider");
    if(!select) return;
    for(const option of select.options) option.disabled = !ready(option.value);
    select.value = S.orderType === "market" ? S.marketProvider : (S.orderType === "trigger" ? "relay" : "kyber");
    // Limits use Kyber's orderbook even if the market gateway is disabled.
    if(S.orderType === "limit") select.options[1].disabled = false;
    select.disabled = S.executing || S.orderType !== "market";
    $("#conditionalFields").hidden = S.orderType === "market";
    $("#conditionHint").textContent = S.orderType === "limit"
      ? "Sign a Kyber order with an expiry. Native coins must first be wrapped (for example, select WETH instead of ETH). The displayed Kyber fee is charged to the taker."
      : "Save a minimum net receipt after app fees. This page must remain open with your wallet connected. You review and sign when the target is met; no unattended execution.";
    const provider = S.server?.providers?.find(p => p.id === (S.orderType === "market" ? S.marketProvider : S.orderType === "trigger" ? "relay" : "kyber"));
    $("#providerStatus").textContent = S.orderType === "limit"
      ? (S.server?.limit?.enabled ? "Kyber limit orders · developer fee verified on every order" : S.server?.limit?.reason || "Trading configuration is unavailable")
      : (provider?.market ? `${provider.label} · ${feeText()} DexDNA app fee` : provider?.reason || "Trading configuration is unavailable");
    $$("[data-order]").forEach(button => { const on = button.dataset.order === S.orderType; button.classList.toggle("on", on); button.setAttribute("aria-selected", String(on)); });
    renderTriggers();
  }
  function lockInputs() {
    $$(".ticket input,.ticket select,.ticket button,[data-order]").forEach(el => { el.disabled = S.executing; });
    $("#chainBtn").disabled = S.executing;
    $("#payTk").disabled = S.executing;
    $("#getTk").disabled = S.executing;
    $("#flipBtn").disabled = S.executing;
    $("#marketProvider").disabled = S.executing || S.orderType !== "market";
  }
  function renderTicket() {
    lockInputs();
    $("#dAppFee").textContent = S.quote?._appFee?.bps != null ? `${S.quote._appFee.bps / 100}%` : feeText();
    $("#targetLabel").textContent = `Minimum receive (${getTk()?.symbol || "token"})`;
    if(S.orderType === "limit") {
      $("#getAmt").value = $("#targetReceive").value;
      $("#getUsd").textContent = "Specified order receipt";
      $("#dRoute").textContent = "Kyber limit order";
      $("#dMin").textContent = validTarget() ? $("#targetReceive").value + " " + getTk().symbol : "—";
    }
  }
  function renderConditionalCta() {
    lockInputs();
    const button = $("#cta"), note = $("#note"), pay = payTk(), get = getTk();
    let label = S.orderType === "limit" ? "Review limit order" : "Save Relay trigger", disabled = false;
    note.className = "note"; note.hidden = true;
    if(S.executing) { label = S.execLabel || "Confirm in wallet…"; disabled = true; }
    else if(!S.account) label = "Connect Wallet";
    else if(!pay || !get || !S.amount || parseUnits(S.amount, pay.decimals) === 0n) { label = "Enter an amount"; disabled = true; }
    else if(!validTarget()) { label = "Enter minimum receive"; disabled = true; }
    else if(S.orderType === "limit" && (!S.server?.limit?.enabled || pay.address === ZERO || get.address === ZERO)) {
      disabled = true;
      label = S.server?.limit?.enabled ? "Select wrapped tokens" : "Limit trading unavailable";
    } else if(S.orderType === "trigger" && !ready("relay")) { disabled = true; label = "Relay trading unavailable"; }
    if(S.quoteErr && S.orderType === "trigger") { note.hidden = false; note.textContent = "The current quote is unavailable. Saved triggers will retry while this page is open."; }
    button.textContent = label; button.disabled = disabled; button.className = "cta buy";
  }
  function busy(value, label = "") { S.executing = value; S.execLabel = label; renderCta(); lockInputs(); }
  function context(pay = payTk(), get = getTk()) {
    if(!S.account || !S.provider || !pay || !get) throw new Error("Connect a wallet and select a pair");
    return { user: S.account, provider: S.provider, pay: { ...pay }, get: { ...get } };
  }
  async function assertWallet(ctx, chainId) {
    if(S.provider !== ctx.provider || lc(S.account) !== lc(ctx.user)) throw new Error("Wallet changed. Review the order again.");
    await ensureChain(Number(chainId));
    const accounts = await ctx.provider.request({ method: "eth_accounts" });
    if(lc(accounts?.[0]) !== lc(ctx.user)) throw new Error("Wallet account changed. Review the order again.");
  }
  async function allowance(ctx, token, spender, amount, chainId) {
    await assertWallet(ctx, chainId);
    const call = "0xdd62ed3e" + ctx.user.slice(2).toLowerCase().padStart(64, "0") + spender.slice(2).toLowerCase().padStart(64, "0");
    const current = BigInt(await ctx.provider.request({ method: "eth_call", params: [{ to: token, data: call }, "latest"] }));
    if(current >= BigInt(amount)) return;
    const send = async value => {
      await assertWallet(ctx, chainId);
      busy(true, `Approve ${ctx.pay.symbol || "token"} in wallet…`);
      const hash = await ctx.provider.request({ method: "eth_sendTransaction", params: [{ from: ctx.user, to: token, chainId: hex(chainId), value: "0x0", data: "0x095ea7b3" + spender.slice(2).padStart(64, "0") + BigInt(value).toString(16).padStart(64, "0") }] });
      busy(true, "Waiting for approval…"); await waitReceipt(hash);
    };
    // Supports tokens such as USDT that require resetting a nonzero allowance.
    if(current > 0n) await send("0");
    await send(amount);
  }
  async function signTyped(ctx, typedData) {
    const typed = { domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message ?? typedData.value };
    await assertWallet(ctx, typed.domain.chainId);
    busy(true, "Sign order in wallet…");
    return ctx.provider.request({ method: "eth_signTypedData_v4", params: [ctx.user, JSON.stringify(typed)] });
  }
  async function runSteps(quote, ctx, expiresAt = quote._expiresAt) {
    let transactionHash = null;
    const steps = quote.steps || [];
    for(const step of steps) for(const item of step.items || []) {
      if(item.status === "complete") continue;
      if(expiresAt && Date.now() >= expiresAt) throw new Error("Quote expired. Refresh and review again.");
      if(item.approval) {
        await allowance(ctx, item.approval.token, item.approval.spender, item.approval.amount, item.data.chainId);
        continue;
      }
      if(step.kind === "transaction") {
        const data = item.data;
        await assertWallet(ctx, data.chainId);
        if(data.from && lc(data.from) !== lc(ctx.user)) throw new Error("Transaction wallet does not match");
        const tx = { from: ctx.user, to: data.to, chainId: hex(data.chainId), data: data.data || "0x", value: hex(data.value || 0) };
        // Simulate the exact transaction before opening the wallet confirmation.
        await ctx.provider.request({ method: "eth_call", params: [tx, "latest"] });
        if(expiresAt && Date.now() >= expiresAt) throw new Error("Quote expired. Review again.");
        busy(true, step.id === "approve" ? "Approve in wallet…" : "Confirm trade in wallet…");
        transactionHash = await ctx.provider.request({ method: "eth_sendTransaction", params: [tx] });
        busy(true, "Waiting for confirmation…"); await waitReceipt(transactionHash);
      } else if(step.kind === "signature") {
        const sign = item.data.sign, post = item.data.post;
        let sig;
        if(sign.signatureKind === "eip191") {
          await assertWallet(ctx, ctx.pay.chainId);
          const message = /^0x[\da-f]*$/i.test(sign.message) ? sign.message : "0x" + [...new TextEncoder().encode(sign.message)].map(v => v.toString(16).padStart(2, "0")).join("");
          sig = await ctx.provider.request({ method: "personal_sign", params: [message, ctx.user] });
        } else {
          const domain = sign.domain || {};
          const domainTypes = [["name","string"],["version","string"],["chainId","uint256"],["verifyingContract","address"],["salt","bytes32"]].filter(([name]) => domain[name] != null).map(([name,type]) => ({name,type}));
          sig = await signTyped(ctx, { ...sign, types: { EIP712Domain: domainTypes, ...sign.types }, message: sign.value ?? sign.message });
        }
        if(post) await relay(post.endpoint + (post.endpoint.includes("?") ? "&" : "?") + "signature=" + encodeURIComponent(sig), { method: post.method || "POST", body: post.body });
      } else throw new Error("Unsupported provider execution step");
      if(item.check && !["approve", "approval"].includes(step.id)) {
        busy(true, "Waiting for provider settlement…"); await pollCheck(item.check.endpoint);
      }
    }
    return transactionHash;
  }
  function logTrade(quote, ctx, hash) {
    const list = store.get("trades", []);
    list.unshift({ t: Date.now(), tx: hash, chainId: ctx.pay.chainId, side: "swap", token: ctx.get,
      inAmt: quote.details?.currencyIn?.amountFormatted, outAmt: quote.details?.currencyOut?.amountFormatted,
      usd: quote.details?.currencyIn?.amountUsd, acct: ctx.user, provider: quote._provider });
    store.set("trades", list.slice(0, 50));
  }
  async function market(trigger = null) {
    if(S.executing) return;
    const ctx = trigger ? context(trigger.pay, trigger.get) : context();
    if(trigger && lc(trigger.user) !== lc(ctx.user)) throw new Error("Connect the wallet that owns this trigger");
    busy(true, "Refreshing quote…");
    try {
      let quote;
      if(trigger) quote = await quoteTrigger(trigger);
      else { clearTimeout(qTimer); await getQuote(true, true); quote = S.quote; }
      if(!quote) throw new Error("A fresh executable quote is required");
      if(trigger && !meets(quote, trigger.target)) throw new Error("Target is no longer met after fees and slippage. Trigger remains active.");
      S.quote = quote;
      const hash = await runSteps(quote, ctx);
      logTrade(quote, ctx, hash);
      if(trigger) { trigger.status = "filled"; persistTriggers(); }
      else { S.amount = ""; $("#payAmt").value = ""; }
      toast("ok", "Trade completed through " + (quote._provider === "kyber" ? "KyberSwap" : "Relay"));
    } catch(error) { toast("err", error.message || "Trade failed"); }
    finally { S.quote = null; busy(false); renderTicket(); loadBalances(); loadTape(); renderTriggers(); }
  }
  async function createLimit() {
    if(S.executing) return;
    const ctx = context();
    busy(true, "Preparing order…");
    try {
      const prepared = await api("/api/trading/limit", { action: "prepare", chainId: ctx.pay.chainId, maker: ctx.user,
        makerAsset: ctx.pay.address, takerAsset: ctx.get.address, makingAmount: parseUnits(S.amount, ctx.pay.decimals).toString(), takingAmount: targetUnits(),
        expiredAt: Math.floor(Date.now() / 1000) + Number($("#orderExpiry").value) });
      busy(false);
      const summary = prepared.summary;
      openModal("Review Kyber limit order", `<p>Sell <b>${esc(formatUnits(summary.makingAmount, ctx.pay.decimals))} ${esc(ctx.pay.symbol)}</b> for <b>${esc(formatUnits(summary.takingAmount, ctx.get.decimals))} ${esc(ctx.get.symbol)}</b>.</p>
        <p>Expires ${esc(new Date(summary.expiredAt * 1000).toLocaleString())}.</p><p>Kyber taker fee: <b>${summary.feeBps / 100}%</b> · developer wallet <span class="mono">${esc(short(summary.feeRecipient))}</span>.</p>
        <p class="note">Tokens remain in your wallet until filled. Approval may require a transaction. The signed order can fill while you are offline.</p><button class="cta buy" id="confirmLimit">Approve and sign order</button>`);
      $("#confirmLimit").onclick = async () => {
        closeModal(); busy(true, "Checking approval…");
        try {
          await allowance(ctx, ctx.pay.address, prepared.contract, prepared.allowanceAmount, ctx.pay.chainId);
          const signature = await signTyped(ctx, prepared.typedData);
          const result = await api("/api/trading/limit", { action: "submit", ticket: prepared.ticket, signature });
          toast("ok", "Limit order published · " + esc(result.id ?? result.orderId ?? "Kyber"));
          S.amount = ""; $("#payAmt").value = ""; S.tape = "orders"; loadTape();
        } catch(error) { toast("err", error.message || "Order was not submitted"); }
        finally { busy(false); renderTicket(); }
      };
    } catch(error) { busy(false); toast("err", error.message || "Cannot prepare this order"); }
  }
  async function loadBook() {
    const token = S.token, quoteToken = S.quoteTk, seq = ++bookSequence;
    if(!token || !quoteToken) return;
    $("#tapeTitle").textContent = "Kyber Limit Orders";
    $("#tapeSub").textContent = `${token.symbol}/${quoteToken.symbol} · only fee-compatible orders can be taken`;
    tableHeaders(["Maker", `Price (${quoteToken.symbol})`, `Available (${token.symbol})`, "Fill status", "Side", "Fee route", ""]);
    $("#tape").innerHTML = '<tr><td colspan="7" class="empty">Loading Kyber orders…</td></tr>';
    if(token.address === ZERO || quoteToken.address === ZERO) { $("#tape").innerHTML = '<tr><td colspan="7" class="empty">Choose wrapped token pairs, such as WETH/USDC, to use Kyber limits.</td></tr>'; return; }
    try {
      const query = new URLSearchParams({ chainId: String(token.chainId), makerAsset: token.address, takerAsset: quoteToken.address });
      const data = await api("/api/trading/limit?" + query);
      if(seq !== bookSequence || S.tape !== "kyber" || key(S.token) !== key(token) || key(S.quoteTk) !== key(quoteToken)) return;
      $("#tape").innerHTML = data.orders.slice(0, 25).map((order, i) => {
        const available = BigInt(order.availableMakingAmount ?? (BigInt(order.makingAmount) - BigInt(order.filledMakingAmount || 0)).toString());
        const maker = Number(formatUnits(order.makingAmount, token.decimals)), taker = Number(formatUnits(order.takingAmount, quoteToken.decimals));
        return `<tr><td class="mono">${esc(short(order.maker))}</td><td class="r mono">${fmtPrice(taker / maker)}</td><td class="r mono">${fmtAmt(formatUnits(available, token.decimals))}</td><td>${BigInt(order.filledMakingAmount || 0) > 0n ? "Partial" : "Open"}</td><td>Sell</td><td>${order.feeEligible ? "Verified" : "Read-only"}</td><td><button class="order-action" data-take="${i}" ${!order.feeEligible || S.executing ? "disabled" : ""}>Take</button></td></tr>`;
      }).join("") || '<tr><td colspan="7" class="empty">No active Kyber orders for this pair.</td></tr>';
      $$("[data-take]").forEach(button => button.onclick = () => take(data.orders[Number(button.dataset.take)], token, quoteToken));
    } catch(error) { if(seq === bookSequence) $("#tape").innerHTML = `<tr><td colspan="7" class="empty">${esc(error.message)}</td></tr>`; }
  }
  async function take(order, receive, pay) {
    if(S.executing) return;
    if(!S.account) { openWalletModal(); return; }
    openModal("Take Kyber order", `<p>Pay ${esc(pay.symbol)} to receive ${esc(receive.symbol)}. Only the available amount can be filled.</p><div class="field"><label for="fillAmount">Amount to pay (${esc(pay.symbol)}, before any input-side fee)</label><input id="fillAmount" inputmode="decimal" placeholder="0.0"></div><button class="cta buy" id="prepareFill">Review fill</button>`);
    $("#prepareFill").onclick = async () => {
      const amount = parseUnits($("#fillAmount").value, pay.decimals).toString();
      const ctx = context(pay, receive); closeModal(); busy(true, "Checking order availability…");
      try {
        const fill = await api("/api/trading/limit", { action: "fill", chainId: pay.chainId, makerAsset: receive.address, takerAsset: pay.address,
          user: ctx.user, orderId: order.id, takingAmount: amount, slippageTolerance: S.slippage });
        busy(false);
        openModal("Review order fill", `<p>Pay up to <b>${esc(formatUnits(fill.inputAmount, pay.decimals))} ${esc(pay.symbol)}</b>.</p><p>Receive at least <b>${esc(formatUnits(fill.minimumOutput, receive.decimals))} ${esc(receive.symbol)}</b> after fees.</p><p>Developer fee: ${fill.fee.bps / 100}% · ${esc(short(fill.fee.recipient))}. Network gas is separate.</p><button class="cta buy" id="confirmFill">Confirm fill in wallet</button>`);
        $("#confirmFill").onclick = async () => {
          closeModal(); busy(true, "Preparing fill…");
          try { await runSteps(fill, ctx, fill.expiresAt); toast("ok", "Kyber fill confirmed"); }
          catch(error) { toast("err", error.message || "Fill failed"); }
          finally { busy(false); loadBalances(); loadBook(); }
        };
      } catch(error) { busy(false); toast("err", error.message || "Cannot fill this order"); }
    };
  }
  function tableHeaders(labels) { $$(".tape thead th").forEach((th, i) => th.textContent = labels[i]); }
  async function loadOrders() {
    const seq = ++bookSequence, wallet = S.account;
    $("#tapeTitle").textContent = "My Kyber Orders"; $("#tapeSub").textContent = wallet ? short(wallet) : "";
    tableHeaders(["Created", "Sell token", "Sell amount", "Receive amount", "Order ID", "Status", ""]);
    if(!wallet) { $("#tape").innerHTML = '<tr><td colspan="7" class="empty">Connect your wallet to see your orders.</td></tr>'; return; }
    try {
      const data = await api("/api/trading/limit?" + new URLSearchParams({ action: "mine", maker: wallet, status: "active", chainId: String(S.chain.id) }));
      if(seq !== bookSequence || S.tape !== "orders" || S.account !== wallet) return;
      $("#tape").innerHTML = (data.orders || []).map((order, i) => `<tr><td>${esc(new Date(order.createdAt * 1000).toLocaleDateString())}</td><td>${esc(order.makerAssetSymbol || short(order.makerAsset))}</td><td class="r mono">${fmtAmt(formatUnits(order.makingAmount, order.makerAssetDecimals))}</td><td class="r mono">${fmtAmt(formatUnits(order.takingAmount, order.takerAssetDecimals))} ${esc(order.takerAssetSymbol || "")}</td><td>${esc(order.id)}</td><td>${esc(order.status)}</td><td><button class="order-action" data-cancel="${i}" ${S.executing || order.status === "cancelling" ? "disabled" : ""}>Cancel</button></td></tr>`).join("") || '<tr><td colspan="7" class="empty">No active orders on this network.</td></tr>';
      $$("[data-cancel]").forEach(button => button.onclick = () => cancel(data.orders[Number(button.dataset.cancel)]));
    } catch(error) { if(seq === bookSequence) $("#tape").innerHTML = `<tr><td colspan="7" class="empty">${esc(error.message)}</td></tr>`; }
  }
  async function cancel(order) {
    if(S.executing) return;
    const ctx = context(); busy(true, "Preparing cancellation…");
    try {
      const prepared = await api("/api/trading/limit", { action: "prepare-cancel", chainId: Number(order.chainId), maker: ctx.user, orderId: order.id });
      const signature = await signTyped(ctx, prepared.typedData);
      await api("/api/trading/limit", { action: "cancel", ticket: prepared.ticket, signature });
      toast("info", "Cancellation submitted. An order can still fill until existing operator signatures expire (up to five minutes).");
    } catch(error) { toast("err", error.message || "Cancellation failed"); }
    finally { busy(false); loadOrders(); }
  }
  function persistTriggers() { store.set("triggers", triggers); renderTriggers(); }
  function saveTrigger() {
    if(triggers.filter(t => !["filled", "expired", "cancelled"].includes(t.status)).length >= 5) throw new Error("Keep at most five active triggers");
    const ctx = context();
    triggers = triggers.filter(t => !["filled", "expired", "cancelled"].includes(t.status));
    triggers.unshift({ id: crypto.randomUUID(), user: ctx.user, pay: ctx.pay, get: ctx.get,
      amount: parseUnits(S.amount, ctx.pay.decimals).toString(), target: targetUnits(), slippage: S.slippage,
      expires: Date.now() + Number($("#orderExpiry").value) * 1000, status: "waiting" });
    persistTriggers(); toast("info", "Trigger saved. Keep this page open and confirm in your wallet when ready."); monitor();
  }
  function renderTriggers() {
    const list = $("#triggerList"); if(!list) return;
    list.innerHTML = triggers.length ? triggers.map(t => `<div class="trigger-card"><b>${esc(formatUnits(t.amount, t.pay.decimals))} ${esc(t.pay.symbol)} → at least ${esc(formatUnits(t.target, t.get.decimals))} ${esc(t.get.symbol)}</b><div>${esc(t.status)} · ${esc(short(t.user))}</div>${t.error ? `<div class="muted">${esc(t.error)}</div>` : ""}<button data-review-trigger="${esc(t.id)}" ${t.status !== "ready" || lc(t.user) !== lc(S.account) || S.executing ? "disabled" : ""}>Review trade</button><button data-remove-trigger="${esc(t.id)}" ${S.executing ? "disabled" : ""}>Remove</button></div>`).join("") : '<p class="note">No saved triggers.</p>';
  }
  function meets(quote, target) { try { return BigInt(quote.details.currencyOut.minimumAmount) >= BigInt(target); } catch { return false; } }
  function quoteTrigger(t) {
    return api("/api/trading/quote", { provider: "relay", user: t.user, originChainId: t.pay.chainId, destinationChainId: t.get.chainId,
      originCurrency: t.pay.address, destinationCurrency: t.get.address, amount: t.amount,
      originDecimals: t.pay.decimals, destinationDecimals: t.get.decimals, slippageTolerance: t.slippage });
  }
  async function monitor() {
    if(monitoring || S.executing || !ready("relay")) return;
    monitoring = true;
    try {
      for(const t of triggers) {
        if(["filled", "expired", "cancelled"].includes(t.status)) continue;
        if(Date.now() >= t.expires) { t.status = "expired"; continue; }
        if(lc(t.user) !== lc(S.account)) continue;
        try {
          const quote = await quoteTrigger(t), eligible = meets(quote, t.target);
          if(eligible && t.status !== "ready") toast("info", "Your Relay trigger is ready to review. Wallet confirmation is required.");
          t.status = eligible ? "ready" : "waiting"; delete t.error;
        } catch(error) { t.status = "waiting"; t.error = error.message; }
      }
      persistTriggers();
    } finally { monitoring = false; }
  }
  async function reviewTrigger(id) {
    const trigger = triggers.find(t => t.id === id);
    if(!trigger || trigger.status !== "ready" || S.executing) return;
    try {
      if(Date.now() >= trigger.expires) throw new Error("Trigger expired");
      const quote = await quoteTrigger(trigger);
      if(!meets(quote, trigger.target)) { trigger.status = "waiting"; persistTriggers(); throw new Error("Target is no longer met. Monitoring continues."); }
      openModal("Review Relay trigger", `<p>Sell ${esc(formatUnits(trigger.amount, trigger.pay.decimals))} ${esc(trigger.pay.symbol)}.</p><p>Receive at least ${esc(formatUnits(quote.details.currencyOut.minimumAmount, trigger.get.decimals))} ${esc(trigger.get.symbol)} after app fees and slippage. Network gas is separate.</p><p>DexDNA app fee: ${quote._appFee.bps / 100}%.</p><button class="cta buy" id="confirmTrigger">Refresh and confirm in wallet</button>`);
      $("#confirmTrigger").onclick = () => { closeModal(); if(Date.now() >= trigger.expires) { toast("err", "Trigger expired"); return; } market(trigger).catch(error => toast("err", error.message)); };
    } catch(error) { toast("err", error.message); }
  }
  function openSettings() {
    openModal("Trading settings", `<p>DexDNA app fee: <b>${esc(feeText())}</b>.</p><p>Fee recipient: <span class="mono">${esc(S.server?.fee?.recipient || "Not configured")}</span>.</p><p class="note">The app fee is included in market quotes. Kyber limit-order fees are verified before signing. Provider keys and fee settings are managed by the app operator.</p><p>Change slippage on the order ticket. Network gas is charged separately.</p>`);
  }
  async function primaryAction() {
    if(S.executing) return;
    if(!S.account) { openWalletModal(); return; }
    try { if(S.orderType === "limit") await createLimit(); else if(S.orderType === "trigger") saveTrigger(); else await market(); }
    catch(error) { toast("err", error.message || "Cannot place this order"); }
  }
  function init() {
    $$("[data-order]").forEach(button => button.onclick = () => {
      if(S.executing) return; S.orderType = button.dataset.order; S.quote = null; S.quoteErr = null; ++qSeq;
      updateControls(); renderTicket(); requestQuote();
    });
    $("#marketProvider").onchange = e => { S.marketProvider = e.target.value; S.quote = null; S.quoteErr = null; ++qSeq; updateControls(); requestQuote(); };
    $("#targetReceive").oninput = () => { renderTicket(); };
    document.addEventListener("click", e => {
      const remove = e.target.closest("[data-remove-trigger]"), review = e.target.closest("[data-review-trigger]");
      if(remove && !S.executing) { triggers = triggers.filter(t => t.id !== remove.dataset.removeTrigger); persistTriggers(); }
      if(review) reviewTrigger(review.dataset.reviewTrigger);
    });
    setInterval(monitor, 30000);
    updateControls();
  }
  return { api, init, loadConfiguration, renderTicket, renderConditionalCta, lockInputs, primaryAction, loadBook, loadOrders, openSettings, tableHeaders };
})();
