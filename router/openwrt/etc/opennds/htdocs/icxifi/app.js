(function () {
  var API_BASE = "http://172.22.0.1:2080/cgi-bin/icxifi";
  var FALLBACK_RATES = [
    { amount: 5, minutes: 15 },
    { amount: 10, minutes: 35 },
    { amount: 20, minutes: 90 }
  ];

  var ratesEl = document.getElementById("rates");
  var statusEl = document.getElementById("statusBox");
  var modeHintEl = document.getElementById("modeHint");

  function setStatus(obj, ok) {
    statusEl.textContent = JSON.stringify(obj, null, 2);
    statusEl.className = ok ? "ok" : "";
  }

  function getClientHints() {
    var qs = new URLSearchParams(window.location.search);
    return {
      clientIp:
        qs.get("clientip") ||
        qs.get("clientIp") ||
        qs.get("ip") ||
        "",
      clientMac:
        qs.get("clientmac") ||
        qs.get("clientMac") ||
        qs.get("mac") ||
        ""
    };
  }

  function renderRates(profile) {
    var mode = (profile && profile.mode) || "hybrid";
    var rates = (profile && profile.rates && profile.rates.length) ? profile.rates : FALLBACK_RATES;
    ratesEl.innerHTML = "";

    if (mode === "voucher") {
      modeHintEl.textContent = "Router is in voucher-only mode. Insert-coin buttons are hidden.";
      setStatus({ ok: false, error: "Voucher mode is enabled on this router." }, false);
      return;
    }

    modeHintEl.textContent = mode === "hybrid"
      ? "Hybrid mode enabled. Vendo flow is available."
      : "Vendo mode enabled.";

    rates.forEach(function (rate) {
      var btn = document.createElement("button");
      btn.className = "rate-btn";
      btn.type = "button";
      btn.innerHTML = '<div class="price">PHP ' + rate.amount + '</div><div class="mins">' + rate.minutes + " minutes</div>";
      btn.addEventListener("click", function () {
        doVend(rate.amount);
      });
      ratesEl.appendChild(btn);
    });
  }

  function doVend(amount) {
    var hints = getClientHints();
    var url = API_BASE + "/vend?amount=" + encodeURIComponent(amount) +
      "&deviceId=vendo-1" +
      "&clientIp=" + encodeURIComponent(hints.clientIp) +
      "&clientMac=" + encodeURIComponent(hints.clientMac);

    setStatus({ ok: false, status: "Processing payment...", amount: amount }, false);

    fetch(url, { method: "GET", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          setStatus({
            ok: true,
            message: "Time added! You are online.",
            grantedMinutes: j.grant ? j.grant.minutes : null,
            voucher: j.voucher ? j.voucher.code : null,
            raw: j
          }, true);
          return;
        }
        setStatus(j || { ok: false, error: "Vend failed" }, false);
      })
      .catch(function (e) {
        setStatus({ ok: false, error: String(e) }, false);
      });
  }

  function redirectToRegister() {
    var qs = window.location.search || "";
    window.location.replace("/register.html" + qs);
  }

  function ensureRegistered() {
    return fetch(API_BASE + "/activation", { method: "GET", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : { activated: false }; })
      .then(function (j) {
        if (j && j.activated) return true;
        redirectToRegister();
        return false;
      })
      .catch(function () {
        redirectToRegister();
        return false;
      });
  }

  ensureRegistered().then(function (ok) {
    if (!ok) return;
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("Timeout")); }, 2500);
    });
    Promise.race([
      fetch(API_BASE + "/profile", { method: "GET", credentials: "omit" }).then(function (r) { return r.json(); }),
      timeout
    ])
      .then(function (j) {
        renderRates((j && j.profile) || null);
        if (!j || !j.ok) {
          setStatus(j || { ok: false, error: "Failed to load profile" }, false);
        } else {
          setStatus({ ok: true, mode: j.profile.mode, rates: j.profile.rates }, true);
        }
      })
      .catch(function () {
        renderRates({ mode: "hybrid", rates: FALLBACK_RATES });
        setStatus({ ok: true, fallback: true, message: "Ready. Tap a plan to connect." }, true);
      });
  });
})();
