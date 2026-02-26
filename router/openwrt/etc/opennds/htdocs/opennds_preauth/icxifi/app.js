(function () {
  var API_BASE_PRIMARY = "/cgi-bin/icxifi";
  var API_BASE_FALLBACK = "http://172.22.0.1:2080/cgi-bin/icxifi";
  var DEFAULT_RATES = [
    { amount: 5, minutes: 15, downloadKbps: 10000, uploadKbps: 10000 },
    { amount: 10, minutes: 35, downloadKbps: 10000, uploadKbps: 10000 },
    { amount: 20, minutes: 90, downloadKbps: 10000, uploadKbps: 10000 }
  ];

  var state = {
    profile: { rates: DEFAULT_RATES, mode: "hybrid" },
    timerId: null,
    sessionEndsAtMs: null,
    suspended: false
  };

  var el = {
    statusWord: document.getElementById("statusWord"),
    clientIp: document.getElementById("clientIp"),
    clientMac: document.getElementById("clientMac"),
    downSpeed: document.getElementById("downSpeed"),
    upSpeed: document.getElementById("upSpeed"),
    tDays: document.getElementById("tDays"),
    tHours: document.getElementById("tHours"),
    tMins: document.getElementById("tMins"),
    tSecs: document.getElementById("tSecs"),
    continueBtn: document.getElementById("continueBtn"),
    ratesPanel: document.getElementById("ratesPanel"),
    voucherPanel: document.getElementById("voucherPanel"),
    ratesGrid: document.getElementById("ratesGrid"),
    statusBox: document.getElementById("statusBox"),
    voucherInput: document.getElementById("voucherInput"),
    coinModal: document.getElementById("coinModal"),
    coinVoucherInput: document.getElementById("coinVoucherInput"),
    insertCoinBtn: document.getElementById("insertCoinBtn"),
    showRatesBtn: document.getElementById("showRatesBtn"),
    showVoucherBtn: document.getElementById("showVoucherBtn")
  };

  function findParam() {
    var qs = new URLSearchParams(window.location.search);
    var keys = Array.prototype.slice.call(arguments);
    for (var i = 0; i < keys.length; i += 1) {
      var v = qs.get(keys[i]);
      if (v) {
        return v;
      }
    }
    return "";
  }

  function clientHintsFromEnvironment() {
    var rawIp =
      findParam("clientip", "clientIp", "ip") ||
      (typeof window.clientip === "string" ? window.clientip : "") ||
      (typeof window.clientIp === "string" ? window.clientIp : "") ||
      (typeof window.ndsclientip === "string" ? window.ndsclientip : "") ||
      "";
    var rawMac =
      findParam("clientmac", "clientMac", "mac") ||
      (typeof window.clientmac === "string" ? window.clientmac : "") ||
      (typeof window.clientMac === "string" ? window.clientMac : "") ||
      (typeof window.ndsclientmac === "string" ? window.ndsclientmac : "") ||
      "";
    var ip = typeof rawIp === "string" ? rawIp : "unknown";
    var mac = typeof rawMac === "string" ? rawMac : "unknown";
    return { ip: ip || "unknown", mac: mac || "unknown" };
  }

  function setStatusWord(connected) {
    el.statusWord.textContent = connected ? "CONNECTED" : "DISCONNECTED";
    el.statusWord.className = connected ? "status connected" : "status disconnected";
    el.continueBtn.disabled = !connected;
  }

  function setStatusBox(message, extra) {
    el.statusBox.textContent = JSON.stringify(
      {
        message: message,
        data: extra || null
      },
      null,
      2
    );
  }

  function setSpeedPlaceholders(downloadKbps, uploadKbps) {
    var down = Number(downloadKbps || 0);
    var up = Number(uploadKbps || 0);
    el.downSpeed.textContent = down > 0 ? (down / 1000).toFixed(1) : "--";
    el.upSpeed.textContent = up > 0 ? (up / 1000).toFixed(1) : "--";
  }

  function stopTimer() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function renderTimer(secondsLeft) {
    var secs = Math.max(0, Math.floor(secondsLeft));
    var dd = Math.floor(secs / 86400);
    secs -= dd * 86400;
    var hh = Math.floor(secs / 3600);
    secs -= hh * 3600;
    var mm = Math.floor(secs / 60);
    var ss = secs % 60;

    el.tDays.textContent = String(dd).padStart(2, "0");
    el.tHours.textContent = String(hh).padStart(2, "0");
    el.tMins.textContent = String(mm).padStart(2, "0");
    el.tSecs.textContent = String(ss).padStart(2, "0");
  }

  function startTimerByMinutes(minutes) {
    var mins = Number(minutes || 0);
    if (!Number.isFinite(mins) || mins <= 0) {
      stopTimer();
      renderTimer(0);
      setStatusBox("Session active");
      return;
    }

    stopTimer();
    state.sessionEndsAtMs = Date.now() + mins * 60 * 1000;
    renderTimer(mins * 60);

    state.timerId = setInterval(function () {
      var remaining = Math.floor((state.sessionEndsAtMs - Date.now()) / 1000);
      if (remaining <= 0) {
        stopTimer();
        renderTimer(0);
        setStatusBox("Session active");
        return;
      }
      renderTimer(remaining);
    }, 1000);
  }

  function fetchJson(path) {
    return fetch(API_BASE_PRIMARY + path, { method: "GET", credentials: "omit" })
      .then(function (r) {
        if (!r.ok) {
          throw new Error("Primary endpoint failed: " + r.status);
        }
        return r.json();
      })
      .catch(function () {
        return fetch(API_BASE_FALLBACK + path, { method: "GET", credentials: "omit" }).then(function (r2) {
          if (!r2.ok) {
            throw new Error("Fallback endpoint failed: " + r2.status);
          }
          return r2.json();
        });
      });
  }

  function redirectToRegister() {
    var qs = window.location.search || "";
    window.location.replace("/register.html" + qs);
  }

  function ensureRegistered() {
    return fetchJson("/activation")
      .then(function (j) {
        if (j && j.activated) {
          return true;
        }
        redirectToRegister();
        return false;
      })
      .catch(function () {
        redirectToRegister();
        return false;
      });
  }

  function applyMode(mode) {
    var m = (mode || "hybrid").toLowerCase();

    if (m === "vendo") {
      el.showVoucherBtn.style.display = "none";
      el.voucherPanel.classList.add("hidden");
      el.insertCoinBtn.style.display = "";
      el.showRatesBtn.style.display = "";
      return;
    }

    if (m === "voucher") {
      el.insertCoinBtn.style.display = "none";
      el.showRatesBtn.style.display = "none";
      el.ratesPanel.classList.add("hidden");
      el.showVoucherBtn.style.display = "";
      return;
    }

    el.insertCoinBtn.style.display = "";
    el.showRatesBtn.style.display = "";
    el.showVoucherBtn.style.display = "";
  }

  function renderRates(rates) {
    el.ratesGrid.innerHTML = "";
    rates.forEach(function (rate) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "rate-btn";
      button.innerHTML =
        "<strong>PHP " +
        rate.amount +
        "</strong><span>" +
        rate.minutes +
        " mins | DL " +
        Number(rate.downloadKbps || 10000) / 1000 +
        " Mbps | UL " +
        Number(rate.uploadKbps || 10000) / 1000 +
        " Mbps</span>";
      button.addEventListener("click", function () {
        vend(rate.amount, rate);
      });
      el.ratesGrid.appendChild(button);
    });
  }

  function loadProfile() {
    setStatusBox("Loading profile...");
    var timeoutMs = 2500;
    var timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("Timeout")); }, timeoutMs);
    });
    return Promise.race([fetchJson("/profile"), timeoutPromise])
      .then(function (j) {
        if (j && j.ok && j.profile) {
          state.profile = j.profile;
        }
        if (j && (j.status === "disabled" || j.status === "revoked")) {
          state.suspended = true;
          setStatusBox("Router suspended. Contact administrator.", { status: j.status });
          document.body.classList.add("suspended");
          return;
        }
        state.suspended = false;
        document.body.classList.remove("suspended");
        var rates = state.profile && state.profile.rates && state.profile.rates.length ? state.profile.rates : DEFAULT_RATES;
        renderRates(rates);
        applyMode(state.profile.mode);
        setStatusBox("Profile loaded", state.profile);
      })
      .catch(function (err) {
        state.profile = { rates: DEFAULT_RATES, mode: "hybrid" };
        renderRates(DEFAULT_RATES);
        applyMode("hybrid");
        setStatusBox("Ready. Tap VOUCHER or WIFI RATES to connect.", { fallback: true });
      });
  }

  function setOnlineFromGrant(grant, voucher) {
    var mins = grant && grant.minutes ? Number(grant.minutes) : 0;
    var down = grant && grant.downloadKbps ? Number(grant.downloadKbps) : 10000;
    var up = grant && grant.uploadKbps ? Number(grant.uploadKbps) : 10000;

    setStatusWord(true);
    setSpeedPlaceholders(down, up);
    startTimerByMinutes(mins);

    setStatusBox("You are online.", {
      voucherCode: voucher && voucher.code ? voucher.code : null,
      grant: grant || null
    });
  }

  function vend(amount, rateMeta) {
    setStatusBox("Creating voucher...", { amount: amount });
    fetchJson("/vend?amount=" + encodeURIComponent(amount) + "&deviceId=vendo-1")
      .then(function (j) {
        if (!j || !j.ok) {
          setStatusWord(false);
          setStatusBox("Vend failed", j || { error: "Unknown error" });
          return;
        }

        var grant = j.grant || {
          minutes: rateMeta ? rateMeta.minutes : 0,
          downloadKbps: rateMeta && rateMeta.downloadKbps ? rateMeta.downloadKbps : 10000,
          uploadKbps: rateMeta && rateMeta.uploadKbps ? rateMeta.uploadKbps : 10000
        };

        setOnlineFromGrant(grant, j.voucher || null);
      })
      .catch(function (err) {
        setStatusWord(false);
        setStatusBox("Vend request failed", { error: String(err) });
      });
  }

  function redeemVoucher(code) {
    if (state.suspended) return;
    var clean = (code || "").trim();
    if (!clean) {
      setStatusBox("Voucher code is required.");
      return;
    }

    var hints = clientHintsFromEnvironment();
    var params = "code=" + encodeURIComponent(clean);
    if (hints.mac && hints.mac !== "unknown") {
      params += "&clientMac=" + encodeURIComponent(hints.mac);
    }

    setStatusBox("Redeeming voucher...", { code: clean });
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, 25000);

    fetch(API_BASE_PRIMARY + "/redeem?" + params, {
      method: "GET",
      credentials: "omit",
      signal: controller.signal
    })
      .then(function (r) {
        clearTimeout(timeoutId);
        return r.json().then(function (j) {
          if (!r.ok) {
            throw new Error(j && j.error ? j.error : "HTTP " + r.status);
          }
          return j;
        });
      })
      .catch(function () {
        return fetch(API_BASE_FALLBACK + "/redeem?" + params, {
          method: "GET",
          credentials: "omit",
          signal: controller.signal
        }).then(function (r2) {
          clearTimeout(timeoutId);
          return r2.json().then(function (j) {
            if (!r2.ok) {
              throw new Error(j && j.error ? j.error : "HTTP " + r2.status);
            }
            return j;
          });
        });
      })
      .then(function (j) {
        if (!j || !j.ok) {
          setStatusWord(false);
          setStatusBox("Voucher redeem failed", j || null);
          return;
        }

        setOnlineFromGrant(j.grant || null, j.voucher || { code: clean });

        if (el.coinModal && typeof el.coinModal.close === "function") {
          el.coinModal.close();
        }
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        setStatusWord(false);
        var msg = err && err.name === "AbortError" ? "Request timed out (cloud unreachable?)" : String(err);
        setStatusBox("Voucher request failed", { error: msg });
      });
  }

  function initActions() {
    el.insertCoinBtn.addEventListener("click", function () {
      if (state.suspended) return;
      if (el.coinModal && typeof el.coinModal.showModal === "function") {
        el.coinModal.showModal();
      } else {
        setStatusBox("Insert coin at vendo. Then use voucher redeem.");
      }
    });

    document.getElementById("closeCoinModal").addEventListener("click", function () {
      if (el.coinModal && typeof el.coinModal.close === "function") {
        el.coinModal.close();
      }
    });

    document.getElementById("coinRedeemBtn").addEventListener("click", function () {
      redeemVoucher((el.coinVoucherInput.value || "").trim());
    });

    el.showRatesBtn.addEventListener("click", function () {
      if (state.suspended) return;
      el.ratesPanel.classList.toggle("hidden");
      el.voucherPanel.classList.add("hidden");
    });

    el.showVoucherBtn.addEventListener("click", function () {
      if (state.suspended) return;
      el.voucherPanel.classList.toggle("hidden");
      el.ratesPanel.classList.add("hidden");
    });

    document.getElementById("redeemBtn").addEventListener("click", function () {
      redeemVoucher((el.voucherInput.value || "").trim());
    });

    el.continueBtn.addEventListener("click", function () {
      window.location.href = "http://connectivitycheck.gstatic.com/generate_204";
    });
  }

  function boot() {
    ensureRegistered().then(function (ok) {
      if (!ok) return;

      var hints = clientHintsFromEnvironment();
      el.clientIp.textContent = hints.ip;
      el.clientMac.textContent = hints.mac;
      setStatusWord(false);
      setSpeedPlaceholders(0, 0);
      renderTimer(0);
      initActions();
      loadProfile();
    });
  }

  boot();
})();
