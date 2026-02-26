(function () {
  var API_BASE_PRIMARY = "/cgi-bin/icxifi";
  var API_BASE_FALLBACK = "http://" + (typeof location !== "undefined" ? location.hostname : "10.0.0.1") + ":2080/cgi-bin/icxifi";
  var DEFAULT_RATES = [
    { amount: 5, minutes: 15, downloadKbps: 10000, uploadKbps: 10000 },
    { amount: 10, minutes: 35, downloadKbps: 10000, uploadKbps: 10000 },
    { amount: 20, minutes: 90, downloadKbps: 10000, uploadKbps: 10000 }
  ];

  var state = {
    profile: { rates: DEFAULT_RATES, mode: "hybrid" },
    timerId: null,
    sessionEndsAtMs: null,
    suspended: false,
    connected: false,
    paused: false,
    disconnectedWithTime: false,
    sessionPollId: null,
    timerSyncId: null
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
    showVoucherBtn: document.getElementById("showVoucherBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    resumeBtn: document.getElementById("resumeBtn")
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

  function parseFasParam(fasB64) {
    if (!fasB64 || typeof fasB64 !== "string") return {};
    try {
      var decoded = decodeURIComponent(escape(atob(fasB64.replace(/-/g, "+").replace(/_/g, "/"))));
      var ip = "";
      var mac = "";
      var parts = decoded.split(/[,;\s]+/);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (/^clientip=/i.test(p)) ip = p.replace(/^clientip=/i, "").trim();
        if (/^clientmac=/i.test(p)) mac = p.replace(/^clientmac=/i, "").trim();
        if (/^mac=/i.test(p) && !mac) mac = p.replace(/^mac=/i, "").trim();
      }
      return { ip: ip, mac: mac };
    } catch (e) {
      return {};
    }
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
    if ((!rawIp || rawIp === "unknown") && (!rawMac || rawMac === "unknown")) {
      var fas = findParam("fas");
      if (fas) {
        var parsed = parseFasParam(fas);
        if (parsed.ip) rawIp = parsed.ip;
        if (parsed.mac) rawMac = parsed.mac;
      }
    }
    var ip = typeof rawIp === "string" ? rawIp : "unknown";
    var mac = typeof rawMac === "string" ? rawMac : "unknown";
    return { ip: ip || "unknown", mac: mac || "unknown" };
  }

  function setStatusWord(connected, paused, disconnectedWithTime) {
    state.disconnectedWithTime = !!disconnectedWithTime;
    var hasTime = connected || paused || disconnectedWithTime;
    if (paused) {
      state.paused = true;
      state.connected = false;
      el.statusWord.textContent = "PAUSED";
      el.statusWord.className = "status paused";
      el.continueBtn.disabled = false;
      el.continueBtn.classList.remove("hidden");
    } else if (disconnectedWithTime) {
      state.paused = false;
      state.connected = false;
      el.statusWord.textContent = "PAUSED";
      el.statusWord.className = "status paused";
      el.continueBtn.disabled = false;
      el.continueBtn.classList.remove("hidden");
    } else if (connected) {
      state.paused = false;
      state.connected = true;
      el.statusWord.textContent = "CONNECTED";
      el.statusWord.className = "status connected";
      el.continueBtn.disabled = false;
      el.continueBtn.classList.remove("hidden");
    } else {
      state.paused = false;
      state.connected = false;
      el.statusWord.textContent = "DISCONNECTED";
      el.statusWord.className = "status disconnected";
      el.continueBtn.disabled = true;
      el.continueBtn.classList.add("hidden");
    }
    if (el.pauseBtn) el.pauseBtn.classList.toggle("hidden", !connected || !!paused || !!disconnectedWithTime);
    el.resumeBtn.classList.add("hidden");
    if (hasTime) {
      if (el.insertCoinBtn) el.insertCoinBtn.style.display = "none";
      if (el.showRatesBtn) el.showRatesBtn.style.display = "none";
      if (el.showVoucherBtn) el.showVoucherBtn.style.display = "none";
      if (el.ratesPanel) el.ratesPanel.classList.add("hidden");
      if (el.voucherPanel) el.voucherPanel.classList.add("hidden");
    } else {
      applyMode(state.profile.mode);
    }
  }

  var toastTimer = null;

  function showToast(message, type) {
    type = type || "info";
    var wrap = document.getElementById("toastWrap");
    if (!wrap) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    wrap.innerHTML = "";
    var toast = document.createElement("div");
    toast.className = "toast toast-" + (type === "error" ? "error" : type === "ok" ? "ok" : "");
    toast.textContent = message;
    wrap.appendChild(toast);
    toastTimer = setTimeout(function () {
      wrap.innerHTML = "";
      toastTimer = null;
    }, 3500);
  }

  function setStatusBox(message, extra) {
    el.statusBox.textContent = message || "Ready.";
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
    if (state.paused) {
      state.sessionEndsAtMs = null;
    }
  }

  function renderTimer(secondsLeft, allowWhenPaused) {
    if ((state.paused || state.disconnectedWithTime) && allowWhenPaused !== true) {
      return;
    }
    var secs = Math.max(0, Math.floor(secondsLeft));
    var dd = Math.floor(secs / 86400);
    secs -= dd * 86400;
    var hh = Math.floor(secs / 3600);
    secs -= hh * 3600;
    var mm = Math.floor(secs / 60);
    var ss = secs % 60;

    if ((!state.paused && !state.disconnectedWithTime) || allowWhenPaused === true) {
      el.tDays.textContent = String(dd).padStart(2, "0");
      el.tHours.textContent = String(hh).padStart(2, "0");
      el.tMins.textContent = String(mm).padStart(2, "0");
      el.tSecs.textContent = String(ss).padStart(2, "0");
    }
  }

  function startTimerByMinutes(minutes) {
    startTimerBySeconds((Number(minutes) || 0) * 60);
  }

  function startTimerBySeconds(seconds) {
    if (state.paused || state.disconnectedWithTime) {
      return;
    }
    var secs = Math.floor(Number(seconds) || 0);
    if (!Number.isFinite(secs) || secs <= 0) {
      stopTimer();
      if (!state.paused && !state.disconnectedWithTime) renderTimer(0);
      setStatusBox("Session active");
      return;
    }
    if (state.paused || state.disconnectedWithTime) {
      return;
    }

    stopTimer();
    if (state.paused || state.disconnectedWithTime) return;
    state.sessionEndsAtMs = Date.now() + secs * 1000;
    if (!state.paused && !state.disconnectedWithTime) renderTimer(secs);

    state.timerId = setInterval(function () {
      if (state.paused || state.disconnectedWithTime || !state.sessionEndsAtMs) {
        if (state.timerId) {
          clearInterval(state.timerId);
          state.timerId = null;
        }
        state.sessionEndsAtMs = null;
        return;
      }
      var remaining = Math.floor((state.sessionEndsAtMs - Date.now()) / 1000);
      if (remaining <= 0 || state.paused || state.disconnectedWithTime) {
        if (state.timerId) {
          clearInterval(state.timerId);
          state.timerId = null;
        }
        state.sessionEndsAtMs = null;
        if (!state.paused && !state.disconnectedWithTime) {
          renderTimer(0);
          setStatusBox("Session active");
        }
        return;
      }
      if (!state.paused && !state.disconnectedWithTime && state.sessionEndsAtMs) {
        renderTimer(remaining);
      }
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

  function stopSessionPoll() {
    if (state.sessionPollId) {
      clearInterval(state.sessionPollId);
      state.sessionPollId = null;
    }
  }

  function stopTimerSync() {
    if (state.timerSyncId) {
      clearInterval(state.timerSyncId);
      state.timerSyncId = null;
    }
  }

  function startTimerSync() {
    stopTimerSync();
    if (!state.connected) return;
    var hints = clientHintsFromEnvironment();
    var params = [];
    if (hints.mac && hints.mac !== "unknown") params.push("clientMac=" + encodeURIComponent(hints.mac));
    if (hints.ip && hints.ip !== "unknown") params.push("clientIp=" + encodeURIComponent(hints.ip));
    var sessionPath = "/session" + (params.length ? "?" + params.join("&") : "");
    state.timerSyncId = setInterval(function () {
      if (state.paused) {
        stopTimerSync();
        return;
      }
      if (!state.connected || state.disconnectedWithTime) {
        stopTimerSync();
        return;
      }
      fetch(API_BASE_PRIMARY + sessionPath, { method: "GET", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return fetch(API_BASE_FALLBACK + sessionPath).then(function (r) { return r.ok ? r.json() : null; }); })
        .then(function (j) {
          if (!j) return;
          if (state.paused) return;
          var secs = j.remainingSeconds !== undefined ? Number(j.remainingSeconds) : (Number(j.minutesLeft || 0) * 60);
          if (secs > 0 && state.connected && !state.paused) {
            state.sessionEndsAtMs = Date.now() + secs * 1000;
          } else if (secs <= 0 && !state.paused) {
            if (state.connected) loadSessionStatus();
          }
        });
    }, 5000);
  }

  function startSessionPoll() {
    stopSessionPoll();
    if (state.connected || state.paused || state.disconnectedWithTime || state.suspended) return;
    state.sessionPollId = setInterval(function () {
      if (state.connected || state.paused || state.disconnectedWithTime || state.suspended) {
        stopSessionPoll();
        return;
      }
      loadSessionStatus().then(function (restored) {
        if (restored) {
          stopSessionPoll();
          showToast("Connected.", "ok");
        }
      });
    }, 3000);
  }

  function loadSessionStatus(forceRefresh) {
    if (state.paused && !forceRefresh) return Promise.resolve(false);
    var hints = clientHintsFromEnvironment();
    var params = [];
    if (hints.mac && hints.mac !== "unknown") params.push("clientMac=" + encodeURIComponent(hints.mac));
    if (hints.ip && hints.ip !== "unknown") params.push("clientIp=" + encodeURIComponent(hints.ip));
    var sessionPath = "/session" + (params.length ? "?" + params.join("&") : "");
    return fetch(API_BASE_PRIMARY + sessionPath, { method: "GET", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : { ok: false }; })
      .catch(function () { return fetch(API_BASE_FALLBACK + sessionPath).then(function (r) { return r.ok ? r.json() : { ok: false }; }); })
      .catch(function () { return { ok: false }; })
      .then(function (j) {
        if (!j || !j.ok) return false;
        if (state.paused && !forceRefresh) return false;
        if (j.paused && (j.remainingSeconds > 0 || j.minutesLeft > 0)) {
          if (j.clientMac && el.clientMac) el.clientMac.textContent = j.clientMac;
          if (j.clientIp && el.clientIp) el.clientIp.textContent = j.clientIp;
          setPausedState({
            minutes: j.minutesLeft,
            remainingSeconds: j.remainingSeconds,
            downloadKbps: j.downloadKbps || 10000,
            uploadKbps: j.uploadKbps || 10000
          });
          return true;
        }
        if (j.disconnectedWithTime && (j.remainingSeconds > 0 || j.minutesLeft > 0)) {
          if (j.clientMac && el.clientMac) el.clientMac.textContent = j.clientMac;
          if (j.clientIp && el.clientIp) el.clientIp.textContent = j.clientIp;
          setDisconnectedWithTimeState({
            minutes: j.minutesLeft,
            remainingSeconds: j.remainingSeconds,
            downloadKbps: j.downloadKbps || 10000,
            uploadKbps: j.uploadKbps || 10000
          });
          return true;
        }
        if (j.connected && (j.remainingSeconds > 0 || j.minutesLeft > 0)) {
          if (j.clientMac && el.clientMac) el.clientMac.textContent = j.clientMac;
          if (j.clientIp && el.clientIp) el.clientIp.textContent = j.clientIp;
          setOnlineFromGrant(
            {
              minutes: j.minutesLeft,
              remainingSeconds: j.remainingSeconds,
              downloadKbps: j.downloadKbps || 10000,
              uploadKbps: j.uploadKbps || 10000
            },
            null
          );
          return true;
        }
        if (j.clientIp && el.clientIp) el.clientIp.textContent = j.clientIp;
        if (j.clientMac && el.clientMac) el.clientMac.textContent = j.clientMac;
        return false;
      });
  }

  function loadProfile() {
    var timeoutMs = 800;
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
          showToast("Router suspended. Contact administrator.", "error");
          setStatusBox("Router suspended.");
          document.body.classList.add("suspended");
          return;
        }
        state.suspended = false;
        document.body.classList.remove("suspended");
        var rates = state.profile && state.profile.rates && state.profile.rates.length ? state.profile.rates : DEFAULT_RATES;
        renderRates(rates);
        applyMode(state.profile.mode);
        if (!state.connected) setStatusBox("Ready. Tap VOUCHER or WIFI RATES to connect.", state.profile);
      })
      .catch(function (err) {
        state.profile = { rates: DEFAULT_RATES, mode: "hybrid" };
        renderRates(DEFAULT_RATES);
        applyMode("hybrid");
        if (!state.connected) setStatusBox("Ready. Tap VOUCHER or WIFI RATES to connect.", { fallback: true });
      });
  }

  function setOnlineFromGrant(grant, voucher) {
    var secs = grant && grant.remainingSeconds !== undefined ? Number(grant.remainingSeconds) : (grant && grant.minutes ? Number(grant.minutes) * 60 : 0);
    var down = grant && grant.downloadKbps ? Number(grant.downloadKbps) : 10000;
    var up = grant && grant.uploadKbps ? Number(grant.uploadKbps) : 10000;

    stopSessionPoll();
    state.connected = true;
    state.paused = false;
    state.disconnectedWithTime = false;
    setStatusWord(true, false, false);
    setSpeedPlaceholders(down, up);
    if (secs > 0) startTimerBySeconds(secs); else startTimerByMinutes(grant && grant.minutes ? grant.minutes : 0);
    startTimerSync();
  }

  function setPausedState(grant) {
    var secs = grant && grant.remainingSeconds !== undefined ? Number(grant.remainingSeconds) : (grant && grant.minutes ? Number(grant.minutes) * 60 : 0);
    var down = grant && grant.downloadKbps ? Number(grant.downloadKbps) : 10000;
    var up = grant && grant.uploadKbps ? Number(grant.uploadKbps) : 10000;

    var wasPaused = state.paused;
    state.paused = true;
    state.connected = false;
    state.disconnectedWithTime = false;
    state.sessionEndsAtMs = null;
    var timerIdToClear = state.timerId;
    var timerSyncIdToClear = state.timerSyncId;
    state.timerId = null;
    state.timerSyncId = null;
    if (timerIdToClear) {
      clearInterval(timerIdToClear);
    }
    if (timerSyncIdToClear) {
      clearInterval(timerSyncIdToClear);
    }
    stopSessionPoll();
    stopTimerSync();
    stopTimer();
    if (!wasPaused) {
      renderTimer(secs, true);
    }
    setSpeedPlaceholders(down, up);
    setStatusWord(false, true, false);
  }

  function setDisconnectedWithTimeState(grant) {
    var secs = grant && grant.remainingSeconds !== undefined ? Number(grant.remainingSeconds) : (grant && grant.minutes ? Number(grant.minutes) * 60 : 0);
    var down = grant && grant.downloadKbps ? Number(grant.downloadKbps) : 10000;
    var up = grant && grant.uploadKbps ? Number(grant.uploadKbps) : 10000;

    stopSessionPoll();
    state.connected = false;
    state.paused = true;
    state.disconnectedWithTime = true;
    state.sessionEndsAtMs = null;
    stopTimer();
    stopTimerSync();
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    if (state.timerSyncId) {
      clearInterval(state.timerSyncId);
      state.timerSyncId = null;
    }
    renderTimer(secs > 0 ? secs : 0, true);
    setSpeedPlaceholders(down, up);
    setStatusWord(false, true, true);
  }

  function vend(amount, rateMeta) {
    showToast("Processing coin...", "info");
    fetchJson("/vend?amount=" + encodeURIComponent(amount) + "&deviceId=vendo-1")
      .then(function (j) {
        if (!j || !j.ok) {
          setStatusWord(false, false, false);
          showToast("Vend failed.", "error");
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
        setStatusWord(false, false, false);
        showToast("Vend request failed.", "error");
      });
  }

  function redeemVoucher(code) {
    if (state.suspended) return;
    var clean = (code || "").trim();
    if (!clean) {
      showToast("Voucher code is required.", "error");
      return;
    }

    var redeemBtn = document.getElementById("redeemBtn");
    var coinRedeemBtn = document.getElementById("coinRedeemBtn");
    if (redeemBtn) redeemBtn.disabled = true;
    if (coinRedeemBtn) coinRedeemBtn.disabled = true;

    var hints = clientHintsFromEnvironment();
    var params = "code=" + encodeURIComponent(clean);
    if (hints.mac && hints.mac !== "unknown") params += "&clientMac=" + encodeURIComponent(hints.mac);
    if (hints.ip && hints.ip !== "unknown") params += "&clientIp=" + encodeURIComponent(hints.ip);

    showToast("Redeeming voucher...", "info");
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, 25000);

    function reenableButtons() {
      if (redeemBtn) redeemBtn.disabled = false;
      if (coinRedeemBtn) coinRedeemBtn.disabled = false;
    }

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
        reenableButtons();
        var ok = j && (j.ok || (j.data && j.data.ok));
        var grant = j && (j.grant || (j.data && j.data.grant));
        if (!ok || !grant) {
          var errMsg = j && j.data && j.data.error ? j.data.error : (j && j.error ? j.error : "Unknown error");
          var hint = errMsg && errMsg.toLowerCase().indexOf("already redeemed") >= 0 ? " Use a new voucher." : "";
          showToast("Voucher redeem failed." + hint, "error");
          setStatusWord(false, false, false);
          setTimeout(function () {
            loadSessionStatus().then(function (restored) {
              if (restored) showToast("Connected. Session restored.", "ok");
            });
          }, 800);
          return;
        }

        var grant = j.grant || (j.data && j.data.grant) || null;
        setOnlineFromGrant(grant, j.voucher || (j.data && j.data.voucher) || { code: clean });

        if (el.voucherInput) el.voucherInput.value = "";
        if (el.coinVoucherInput) el.coinVoucherInput.value = "";
        if (el.coinModal && typeof el.coinModal.close === "function") {
          el.coinModal.close();
        }

        loadSessionStatus().then(function (restored) {
          if (restored) showToast("Connected.", "ok");
        });
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        reenableButtons();
        setStatusWord(false, false, false);
        var msg = err && err.name === "AbortError" ? "Request timed out (cloud unreachable?)" : String(err && err.message ? err.message : err);
        var hint = msg && msg.toLowerCase().indexOf("already redeemed") >= 0 ? " Use a new voucher." : "";
        showToast("Voucher request failed." + hint, "error");
        loadSessionStatus().then(function (restored) {
          if (restored) showToast("Connected. Session restored.", "ok");
        });
      });
  }

  function initActions() {
    el.insertCoinBtn.addEventListener("click", function () {
      if (state.suspended) return;
      if (el.coinModal && typeof el.coinModal.showModal === "function") {
        el.coinModal.showModal();
      } else {
        showToast("Insert coin at vendo. Then use voucher redeem.", "info");
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
      if (state.paused || state.disconnectedWithTime) {
        var hints = clientHintsFromEnvironment();
        var path = "/resume";
        if (hints.mac && hints.mac !== "unknown") path += "?clientMac=" + encodeURIComponent(hints.mac);
        if (hints.ip && hints.ip !== "unknown") path += (path.indexOf("?") >= 0 ? "&" : "?") + "clientIp=" + encodeURIComponent(hints.ip);
        el.continueBtn.disabled = true;
        showToast("Resuming...", "info");
        fetchJson(path).then(function (j) {
          el.continueBtn.disabled = false;
          if (j && j.ok && j.connected) {
            setOnlineFromGrant(
              {
                minutes: j.minutesLeft,
                remainingSeconds: j.remainingSeconds,
                downloadKbps: j.downloadKbps,
                uploadKbps: j.uploadKbps
              },
              null
            );
            showToast("Connected.", "ok");
          } else {
            showToast(j && j.error ? j.error : "Resume failed.", "error");
          }
        }).catch(function () {
          el.continueBtn.disabled = false;
          showToast("Resume failed.", "error");
        });
      } else {
        window.location.href = "http://connectivitycheck.gstatic.com/generate_204";
      }
    });

    if (el.pauseBtn) {
      el.pauseBtn.addEventListener("click", function () {
        if (state.suspended || !state.connected || state.paused) return;
        state.paused = true;
        setStatusWord(false, true, false);
        state.sessionEndsAtMs = null;
        stopTimer();
        stopTimerSync();
        if (state.timerId) {
          clearInterval(state.timerId);
          state.timerId = null;
        }
        if (state.timerSyncId) {
          clearInterval(state.timerSyncId);
          state.timerSyncId = null;
        }
        var hints = clientHintsFromEnvironment();
        var path = "/pause";
        if (hints.ip && hints.ip !== "unknown") path += "?clientIp=" + encodeURIComponent(hints.ip);
        if (hints.mac && hints.mac !== "unknown") path += (path.indexOf("?") >= 0 ? "&" : "?") + "clientMac=" + encodeURIComponent(hints.mac);
        el.pauseBtn.disabled = true;
        showToast("Pausing...", "info");
        fetchJson(path).then(function (j) {
          el.pauseBtn.disabled = false;
          if (j && j.ok && j.paused) {
            setPausedState({
              minutes: j.minutesLeft,
              remainingSeconds: j.remainingSeconds,
              downloadKbps: j.downloadKbps,
              uploadKbps: j.uploadKbps
            });
            showToast("Session paused.", "ok");
          } else {
            var err = j && j.error ? String(j.error) : "";
            if (err.toLowerCase().indexOf("disconnected") >= 0) {
              loadSessionStatus(true).then(function (restored) {
                if (restored) {
                  showToast("Session saved. Timer frozen. Tap Continue anytime.", "ok");
                } else {
                  showToast("Disconnected.", "error");
                }
              });
            } else {
              showToast(err || "Pause failed.", "error");
              state.paused = false;
              loadSessionStatus(true);
            }
          }
        }).catch(function () {
          el.pauseBtn.disabled = false;
          showToast("Pause failed.", "error");
          state.paused = false;
          loadSessionStatus(true);
        });
      });
    }

    if (el.resumeBtn) {
      el.resumeBtn.addEventListener("click", function () {
        if (state.suspended || !state.paused) return;
        var hints = clientHintsFromEnvironment();
        var path = "/resume";
        if (hints.ip && hints.ip !== "unknown") path += "?clientIp=" + encodeURIComponent(hints.ip);
        if (hints.mac && hints.mac !== "unknown") path += (path.indexOf("?") >= 0 ? "&" : "?") + "clientMac=" + encodeURIComponent(hints.mac);
        el.resumeBtn.disabled = true;
        showToast("Resuming...", "info");
        fetchJson(path).then(function (j) {
          el.resumeBtn.disabled = false;
          if (j && j.ok && j.connected) {
            setOnlineFromGrant(
              {
                minutes: j.minutesLeft,
                remainingSeconds: j.remainingSeconds,
                downloadKbps: j.downloadKbps,
                uploadKbps: j.uploadKbps
              },
              null
            );
            showToast("Session resumed.", "ok");
          } else {
            showToast(j && j.error ? j.error : "Resume failed.", "error");
          }
        }).catch(function () {
          el.resumeBtn.disabled = false;
          showToast("Resume failed.", "error");
        });
      });
    }
  }

  function boot() {
    ensureRegistered().then(function (ok) {
      if (!ok) return;

      var hints = clientHintsFromEnvironment();
      el.clientIp.textContent = hints.ip;
      el.clientMac.textContent = hints.mac;
      setStatusWord(false, false, false);
      setSpeedPlaceholders(0, 0);
      renderTimer(0);
      renderRates(DEFAULT_RATES);
      applyMode("hybrid");
      setStatusBox("Ready. Tap VOUCHER or WIFI RATES to connect.", null);
      initActions();
      loadProfile();
      loadSessionStatus().then(function (restored) {
        if (!restored) {
          setStatusBox("Ready. Tap VOUCHER or WIFI RATES to connect.", null);
          startSessionPoll();
        }
      });
    });
  }

  boot();
})();
