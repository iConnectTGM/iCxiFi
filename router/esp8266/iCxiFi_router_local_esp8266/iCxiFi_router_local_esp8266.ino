#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <ESP8266HTTPClient.h>
#include <LittleFS.h>
#include <ArduinoJson.h>

// Requested pin defaults:
// - coin pulse input: D4
// - coin set/powercut relay: D8
// - blinker LED: RX (GPIO3)
static const uint8_t COIN_PIN = D4;      // coin pulse input
static const uint8_t COIN_SET_PIN = D8;  // coin acceptor / powercut relay enable
static const uint8_t LED_PIN = 3;        // RX (GPIO3) local blinker

static const char *CONFIG_PATH = "/config.json";
static const char *QUEUE_PATH = "/queue.txt";
static const uint16_t DEFAULT_PORT = 2080;
static const char *DEFAULT_HOST = "10.0.0.1:2080";
// Router-local CGI may call cloud and can exceed 2s on free-tier cold starts.
// Keep this generous to avoid false deactivation on transient latency.
static const uint16_t HTTP_TIMEOUT_MS = 8000;
static const unsigned long ACTIVATION_POLL_MS = 60000;
static const unsigned long STATE_POLL_MS = 90000;
static const unsigned long PROFILE_POLL_MS = 600000;
static const unsigned long RECONNECT_INTERVAL_MS = 20000;
// Default hidden management WLAN for ESP fleet (override per device in UI if needed)
static const char *DEFAULT_MGMT_SSID = "iCxiFi-MGMT";
static const char *DEFAULT_MGMT_PASS = "icxifi12345";

static const IPAddress AP_IP(172, 217, 28, 1);
static const IPAddress AP_GW(172, 217, 28, 1);
static const IPAddress AP_MASK(255, 255, 255, 0);

struct Config {
  String ssid;
  String pass;
  String host;         // router local host:port
  String deviceIdTag;  // optional deviceId override
  uint16_t coinValue;  // value per pulse
  uint16_t debounceMs;
  uint16_t gapMs;
  uint8_t coinPin;
  uint8_t coinSetPin;
};

static Config cfg;
static ESP8266WebServer server(80);
static DNSServer dnsServer;

static bool portalActive = false;
static bool wifiConnected = false;
static bool staServerStarted = false;
static bool coinEnabled = false;
static bool coinForcedOff = false;
static uint32_t coinEnableUntilMs = 0;
static bool usingDefaultMgmt = false;

static volatile uint16_t pulseCount = 0;
static volatile unsigned long lastPulseMs = 0;
static uint32_t pendingAmount = 0;

static bool routerActivated = false;
static String routerState = "unknown";
static String lastStateError = "";

static String lastProfileJson = "";
static unsigned long lastProfileAtMs = 0;

static bool lastVendOk = false;
static int lastVendCode = 0;
static String lastVendErr = "";
static String lastVoucherCode = "";
static uint16_t lastVoucherMinutes = 0;
static uint32_t lastVoucherAmount = 0;
static bool lastVoucherOffline = false;
static unsigned long lastVendAtMs = 0;

static int lastActivationCode = 0;
static String lastActivationErr = "";
static unsigned long lastActivationAtMs = 0;

static unsigned long lastActivationPollMs = 0;
static unsigned long lastStatePollMs = 0;
static unsigned long lastProfilePollMs = 0;
static unsigned long lastSendMs = 0;
static unsigned long lastReconnectMs = 0;
static unsigned long vendRetryAfterUntilMs = 0;

static String deviceId() {
  return WiFi.macAddress();
}

static uint8_t parsePin(const String &value, uint8_t fallback) {
  String v = value;
  v.trim();
  v.toUpperCase();
  if (v.startsWith("D")) {
    v = v.substring(1);
  }
  if (v == "0") return 16;
  if (v == "1") return 5;
  if (v == "2") return 4;
  if (v == "3") return 0;
  if (v == "4") return 2;
  if (v == "5") return 14;
  if (v == "6") return 12;
  if (v == "7") return 13;
  if (v == "8") return 15;
  long asNum = v.toInt();
  if (asNum >= 0 && asNum <= 16) return (uint8_t)asNum;
  return fallback;
}

static String pinLabel(uint8_t gpio) {
  switch (gpio) {
    case 16: return "D0";
    case 5: return "D1";
    case 4: return "D2";
    case 0: return "D3";
    case 2: return "D4";
    case 14: return "D5";
    case 12: return "D6";
    case 13: return "D7";
    case 15: return "D8";
    case 1: return "TX";
    case 3: return "RX";
    default: return String(gpio);
  }
}

static bool parseBool(const String &value, bool fallback) {
  String v = value;
  v.trim();
  v.toLowerCase();
  if (v == "1" || v == "true" || v == "on" || v == "yes") return true;
  if (v == "0" || v == "false" || v == "off" || v == "no") return false;
  return fallback;
}

static String normalizeHost(String host) {
  host.trim();
  if (host.startsWith("http://")) host = host.substring(7);
  if (host.startsWith("https://")) host = host.substring(8);
  int slash = host.indexOf('/');
  if (slash >= 0) host = host.substring(0, slash);
  if (host.length() == 0) return DEFAULT_HOST;
  if (host.indexOf(':') < 0) host += ":" + String(DEFAULT_PORT);
  return host;
}

static String displayHost() {
  String host = normalizeHost(cfg.host);
  String suffix = ":" + String(DEFAULT_PORT);
  if (host.endsWith(suffix)) {
    host.remove(host.length() - suffix.length());
  }
  return host;
}

static String baseUrl() {
  String host = normalizeHost(cfg.host);
  if (host.length() == 0) return "";
  return "http://" + host;
}

static String htmlEscape(const String &s) {
  String out;
  out.reserve(s.length());
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '&') out += "&amp;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

static String urlEncode(const String &in) {
  String out;
  out.reserve(in.length() * 3);
  for (size_t i = 0; i < in.length(); i++) {
    char c = in[i];
    bool safe =
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '-' || c == '_' || c == '.' || c == ':';
    if (safe) {
      out += c;
      continue;
    }
    static const char *hex = "0123456789ABCDEF";
    out += '%';
    out += hex[((uint8_t)c >> 4) & 0x0F];
    out += hex[(uint8_t)c & 0x0F];
  }
  return out;
}

static void blink(uint16_t ms) {
  digitalWrite(LED_PIN, HIGH);
  delay(ms);
  digitalWrite(LED_PIN, LOW);
}

static void setCoinAcceptorEnabled(bool enabled) {
  coinEnabled = enabled;
  digitalWrite(cfg.coinSetPin, enabled ? HIGH : LOW);
  if (!enabled) coinEnableUntilMs = 0;
}

static void applyCoinEnableTimeout() {
  if (!coinEnabled || coinEnableUntilMs == 0) return;
  if ((int32_t)(millis() - coinEnableUntilMs) >= 0) {
    coinForcedOff = true;
    setCoinAcceptorEnabled(false);
  }
}

static void saveQueue() {
  File f = LittleFS.open(QUEUE_PATH, "w");
  if (!f) return;
  f.print(pendingAmount);
  f.close();
}

static void loadQueue() {
  if (!LittleFS.exists(QUEUE_PATH)) return;
  File f = LittleFS.open(QUEUE_PATH, "r");
  if (!f) return;
  pendingAmount = f.readString().toInt();
  f.close();
}

static void saveConfig() {
  DynamicJsonDocument doc(512);
  doc["ssid"] = cfg.ssid;
  doc["pass"] = cfg.pass;
  doc["host"] = cfg.host;
  doc["deviceIdTag"] = cfg.deviceIdTag;
  doc["coinValue"] = cfg.coinValue;
  doc["debounceMs"] = cfg.debounceMs;
  doc["gapMs"] = cfg.gapMs;
  doc["coinPin"] = cfg.coinPin;
  doc["coinSetPin"] = cfg.coinSetPin;
  File f = LittleFS.open(CONFIG_PATH, "w");
  if (!f) return;
  serializeJson(doc, f);
  f.close();
}

static void loadConfig() {
  cfg.ssid = DEFAULT_MGMT_SSID;
  cfg.pass = DEFAULT_MGMT_PASS;
  cfg.host = DEFAULT_HOST;
  cfg.deviceIdTag = "";
  cfg.coinValue = 1;
  cfg.debounceMs = 30;
  cfg.gapMs = 700;
  cfg.coinPin = COIN_PIN;
  cfg.coinSetPin = COIN_SET_PIN;

  if (!LittleFS.exists(CONFIG_PATH)) return;

  File f = LittleFS.open(CONFIG_PATH, "r");
  if (!f) return;

  DynamicJsonDocument doc(512);
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) return;

  cfg.ssid = String(doc["ssid"] | "");
  cfg.pass = String(doc["pass"] | "");
  cfg.host = normalizeHost(String(doc["host"] | DEFAULT_HOST));
  cfg.deviceIdTag = String(doc["deviceIdTag"] | "");
  cfg.coinValue = uint16_t(doc["coinValue"] | 1);
  cfg.debounceMs = uint16_t(doc["debounceMs"] | 30);
  cfg.gapMs = uint16_t(doc["gapMs"] | 700);
  cfg.coinPin = uint8_t(doc["coinPin"] | COIN_PIN);
  cfg.coinSetPin = uint8_t(doc["coinSetPin"] | COIN_SET_PIN);
}

static String ssidListHtml() {
  int n = WiFi.scanNetworks();
  String out = "<table>";
  out += "<tr><th>SSID</th><th>RSSI</th><th>Use</th></tr>";
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    int rssi = WiFi.RSSI(i);
    out += "<tr><td>" + htmlEscape(ssid) + "</td><td>" + String(rssi) + "</td>";
    out += "<td><button type='button' onclick=\"sel('" + htmlEscape(ssid) + "')\">Select</button></td></tr>";
  }
  out += "</table>";
  if (n <= 0) out += "<div>No networks found.</div>";
  return out;
}

static void handleStatus() {
  DynamicJsonDocument doc(2048);
  doc["ok"] = true;
  doc["mac"] = WiFi.macAddress();
  doc["ip"] = WiFi.localIP().toString();
  doc["ssid"] = WiFi.SSID();
  doc["rssi"] = WiFi.RSSI();
  doc["host"] = normalizeHost(cfg.host);
  doc["usingDefaultMgmt"] = usingDefaultMgmt;
  doc["deviceId"] = cfg.deviceIdTag.length() ? cfg.deviceIdTag : deviceId();
  doc["pendingAmount"] = pendingAmount;
  doc["portalActive"] = portalActive;
  doc["coinEnabled"] = coinEnabled;
  doc["coinForcedOff"] = coinForcedOff;
  doc["coinPin"] = pinLabel(cfg.coinPin);
  doc["coinSetPin"] = pinLabel(cfg.coinSetPin);
  doc["blinkerPin"] = pinLabel(LED_PIN);
  doc["routerActivated"] = routerActivated;
  doc["routerState"] = routerState;
  doc["lastStateError"] = lastStateError;
  doc["lastActivationCode"] = lastActivationCode;
  doc["lastActivationErr"] = lastActivationErr;
  doc["lastActivationAtMs"] = lastActivationAtMs;
  doc["lastVendOk"] = lastVendOk;
  doc["lastVendCode"] = lastVendCode;
  doc["lastVendErr"] = lastVendErr;
  doc["lastVendAtMs"] = lastVendAtMs;
  doc["lastVoucherCode"] = lastVoucherCode;
  doc["lastVoucherMinutes"] = lastVoucherMinutes;
  doc["lastVoucherAmount"] = lastVoucherAmount;
  doc["lastVoucherOffline"] = lastVoucherOffline;
  doc["lastProfileAtMs"] = lastProfileAtMs;
  doc["profileCachedBytes"] = lastProfileJson.length();

  String body;
  serializeJson(doc, body);
  server.send(200, "application/json", body);
}

static void handleRoot() {
  String page = "<!doctype html><html><head><meta charset='utf-8'/>";
  page += "<meta name='viewport' content='width=device-width, initial-scale=1'/>";
  page += "<title>iCxiFi ESP8266 Setup</title>";
  page += "<style>";
  page += "body{margin:0;font-family:Arial,sans-serif;background:#0f1721;color:#e6edf3;}";
  page += ".wrap{min-height:100vh;display:grid;place-items:center;padding:16px;}";
  page += ".card{width:100%;max-width:760px;background:#17212b;border:1px solid rgba(255,255,255,0.12);";
  page += "border-radius:14px;padding:18px;}";
  page += "h1{margin:0 0 4px;font-size:22px;}";
  page += "p{opacity:.85;margin:0 0 10px;}";
  page += "label{display:block;margin:10px 0 6px;font-weight:700;}";
  page += "input,select{width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.18);";
  page += "background:#0e141c;color:#fff;box-sizing:border-box;}";
  page += ".row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}";
  page += ".btn{margin-top:12px;padding:10px 12px;border-radius:10px;border:0;background:#5ce1e6;color:#0b1016;font-weight:800;cursor:pointer;width:100%;}";
  page += ".muted{opacity:.8;font-size:13px;margin-top:8px;}";
  page += "table{width:100%;border-collapse:collapse;margin-top:10px;}";
  page += "th,td{padding:8px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:left;font-size:13px;}";
  page += "button{padding:7px 9px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);background:#202935;color:#fff;cursor:pointer;}";
  page += "a{color:#5ce1e6;}";
  page += "@media(max-width:700px){.row{grid-template-columns:1fr;}}";
  page += "</style></head><body><div class='wrap'><div class='card'>";
  page += "<h1>iCxiFi ESP8266 Router Mode</h1>";
  page += "<p>Default pins: Coin <b>D4</b>, Coin Set/Powercut <b>D8</b>, Blinker <b>RX</b>.";
  page += " Router local API: <code>/cgi-bin/icxifi</code>.</p>";
  page += "<p class='muted'>Default management WLAN: <b>" + String(DEFAULT_MGMT_SSID) + "</b> (hidden supported).</p>";
  page += "<form method='POST' action='/save'>";
  page += "<label>Router Host (IP:PORT)</label>";
  page += "<input name='host' value='" + htmlEscape(displayHost()) + "' placeholder='10.0.0.1:2080'/>";
  page += "<div class='row'>";
  page += "<div><label>WiFi SSID</label><input id='ssid' name='ssid' value='" + htmlEscape(cfg.ssid) + "'/></div>";
  page += "<div><label>WiFi Password</label><input type='password' name='pass' value='" + htmlEscape(cfg.pass) + "'/></div>";
  page += "</div>";
  page += "<div class='row'>";
  page += "<div><label>Device ID (optional)</label><input name='deviceIdTag' value='" + htmlEscape(cfg.deviceIdTag) + "' placeholder='vendo-1'/></div>";
  page += "<div><label>Coin Value (PHP per pulse)</label><input type='number' min='1' step='1' name='coinValue' value='" + String(cfg.coinValue) + "'/></div>";
  page += "</div>";
  page += "<div class='row'>";
  page += "<div><label>Debounce (ms)</label><input type='number' min='10' max='1000' name='debounceMs' value='" + String(cfg.debounceMs) + "'/></div>";
  page += "<div><label>Gap (ms)</label><input type='number' min='100' max='10000' name='gapMs' value='" + String(cfg.gapMs) + "'/></div>";
  page += "</div>";

  page += "<div class='row'>";
  page += "<div><label>Coin Slot Pin</label><select name='coinPin'>";
  page += "<option value='D0'" + String(cfg.coinPin == 16 ? " selected" : "") + ">D0 (GPIO16)</option>";
  page += "<option value='D1'" + String(cfg.coinPin == 5 ? " selected" : "") + ">D1 (GPIO5)</option>";
  page += "<option value='D2'" + String(cfg.coinPin == 4 ? " selected" : "") + ">D2 (GPIO4)</option>";
  page += "<option value='D3'" + String(cfg.coinPin == 0 ? " selected" : "") + ">D3 (GPIO0)</option>";
  page += "<option value='D4'" + String(cfg.coinPin == 2 ? " selected" : "") + ">D4 (GPIO2)</option>";
  page += "<option value='D5'" + String(cfg.coinPin == 14 ? " selected" : "") + ">D5 (GPIO14)</option>";
  page += "<option value='D6'" + String(cfg.coinPin == 12 ? " selected" : "") + ">D6 (GPIO12)</option>";
  page += "<option value='D7'" + String(cfg.coinPin == 13 ? " selected" : "") + ">D7 (GPIO13)</option>";
  page += "<option value='D8'" + String(cfg.coinPin == 15 ? " selected" : "") + ">D8 (GPIO15)</option>";
  page += "</select></div>";

  page += "<div><label>Coin Set Pin</label><select name='coinSetPin'>";
  page += "<option value='D0'" + String(cfg.coinSetPin == 16 ? " selected" : "") + ">D0 (GPIO16)</option>";
  page += "<option value='D1'" + String(cfg.coinSetPin == 5 ? " selected" : "") + ">D1 (GPIO5)</option>";
  page += "<option value='D2'" + String(cfg.coinSetPin == 4 ? " selected" : "") + ">D2 (GPIO4)</option>";
  page += "<option value='D3'" + String(cfg.coinSetPin == 0 ? " selected" : "") + ">D3 (GPIO0)</option>";
  page += "<option value='D4'" + String(cfg.coinSetPin == 2 ? " selected" : "") + ">D4 (GPIO2)</option>";
  page += "<option value='D5'" + String(cfg.coinSetPin == 14 ? " selected" : "") + ">D5 (GPIO14)</option>";
  page += "<option value='D6'" + String(cfg.coinSetPin == 12 ? " selected" : "") + ">D6 (GPIO12)</option>";
  page += "<option value='D7'" + String(cfg.coinSetPin == 13 ? " selected" : "") + ">D7 (GPIO13)</option>";
  page += "<option value='D8'" + String(cfg.coinSetPin == 15 ? " selected" : "") + ">D8 (GPIO15)</option>";
  page += "</select></div>";
  page += "</div>";

  page += "<button class='btn' type='submit'>Save and Reboot</button>";
  page += "</form>";

  page += "<div class='muted'>Status: <a href='/status'>/status</a> | Test vend: /vend?amount=5 | Coin on/off: /coin?state=1 or /coin?state=0</div>";
  page += "<h3>Available WiFi</h3>";
  page += ssidListHtml();
  page += "</div></div>";
  page += "<script>function sel(s){document.getElementById('ssid').value=s;}</script>";
  page += "</body></html>";

  server.send(200, "text/html", page);
}

static void handleSave() {
  cfg.host = normalizeHost(server.arg("host"));
  cfg.ssid = server.arg("ssid");
  cfg.pass = server.arg("pass");
  cfg.deviceIdTag = server.arg("deviceIdTag");

  if (server.hasArg("coinValue")) {
    int v = server.arg("coinValue").toInt();
    if (v > 0 && v < 1000) cfg.coinValue = (uint16_t)v;
  }
  if (server.hasArg("debounceMs")) {
    int v = server.arg("debounceMs").toInt();
    if (v >= 10 && v <= 1000) cfg.debounceMs = (uint16_t)v;
  }
  if (server.hasArg("gapMs")) {
    int v = server.arg("gapMs").toInt();
    if (v >= 100 && v <= 10000) cfg.gapMs = (uint16_t)v;
  }
  if (server.hasArg("coinPin")) {
    cfg.coinPin = parsePin(server.arg("coinPin"), cfg.coinPin);
  }
  if (server.hasArg("coinSetPin")) {
    cfg.coinSetPin = parsePin(server.arg("coinSetPin"), cfg.coinSetPin);
  }

  saveConfig();
  server.send(200, "text/plain", "Saved. Rebooting...");
  delay(200);
  ESP.restart();
}

static void handleReset() {
  LittleFS.remove(CONFIG_PATH);
  LittleFS.remove(QUEUE_PATH);
  server.send(200, "text/plain", "Resetting...");
  delay(200);
  ESP.restart();
}

static void handleCoinControl() {
  bool requested = coinEnabled;
  if (server.hasArg("enabled")) {
    requested = parseBool(server.arg("enabled"), requested);
  } else if (server.hasArg("state")) {
    requested = parseBool(server.arg("state"), requested);
  }

  uint32_t durationMs = 0;
  if (server.hasArg("durationMs")) durationMs = (uint32_t)server.arg("durationMs").toInt();
  if (server.hasArg("duration")) durationMs = (uint32_t)server.arg("duration").toInt();

  if (requested) {
    coinForcedOff = false;
    if (routerActivated) {
      setCoinAcceptorEnabled(true);
      if (durationMs > 0) {
        coinEnableUntilMs = millis() + durationMs;
      } else {
        coinEnableUntilMs = 0;
      }
    } else {
      setCoinAcceptorEnabled(false);
    }
  } else {
    coinForcedOff = true;
    setCoinAcceptorEnabled(false);
  }

  DynamicJsonDocument doc(256);
  doc["ok"] = true;
  doc["enabled"] = coinEnabled;
  doc["forcedOff"] = coinForcedOff;
  doc["routerActivated"] = routerActivated;
  String body;
  serializeJson(doc, body);
  server.send(200, "application/json", body);
}

static void handleVendNow() {
  uint32_t amount = (uint32_t)server.arg("amount").toInt();
  if (amount == 0) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"amount required\"}");
    return;
  }
  pendingAmount += amount;
  saveQueue();
  server.send(200, "application/json", "{\"ok\":true,\"queued\":true}");
}

static void handleCaptivePortal() {
  String url = String("http://") + WiFi.softAPIP().toString() + "/";
  server.sendHeader("Location", url, true);
  server.send(302, "text/plain", "");
}

static void handleNotFound() {
  handleCaptivePortal();
}

static void registerServerHandlers() {
  server.on("/", handleRoot);
  server.on("/index.html", handleRoot);
  server.on("/generate_204", handleCaptivePortal);
  server.on("/gen_204", handleCaptivePortal);
  server.on("/success.txt", handleCaptivePortal);
  server.on("/hotspot-detect.html", handleCaptivePortal);
  server.on("/library/test/success.html", handleCaptivePortal);
  server.on("/ncsi.txt", handleCaptivePortal);
  server.on("/connecttest.txt", handleCaptivePortal);
  server.on("/redirect", handleCaptivePortal);
  server.on("/wpad.dat", handleCaptivePortal);
  server.on("/favicon.ico", handleCaptivePortal);
  server.on("/fwlink", handleCaptivePortal);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/reset", HTTP_GET, handleReset);
  server.on("/coin", HTTP_POST, handleCoinControl);
  server.on("/coin", HTTP_GET, handleCoinControl);
  server.on("/vend", HTTP_GET, handleVendNow);
  server.onNotFound(handleNotFound);
}

static void startPortal() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(AP_IP, AP_GW, AP_MASK);
  WiFi.softAP("iCxiFI Setup");
  dnsServer.start(53, "*", WiFi.softAPIP());
  registerServerHandlers();
  server.begin();
  portalActive = true;
}

static void startStaServer() {
  if (portalActive) {
    dnsServer.stop();
    portalActive = false;
    WiFi.softAPdisconnect(true);
  }
  registerServerHandlers();
  server.begin();
}

static void connectWifi() {
  String primarySsid = cfg.ssid;
  String primaryPass = cfg.pass;

  if (primarySsid.length() == 0) {
    primarySsid = DEFAULT_MGMT_SSID;
    primaryPass = DEFAULT_MGMT_PASS;
  }

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
#ifdef WIFI_NONE_SLEEP
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
#endif
  WiFi.begin(primarySsid.c_str(), primaryPass.c_str());
  usingDefaultMgmt = (primarySsid == String(DEFAULT_MGMT_SSID));
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(200);
  }

  wifiConnected = (WiFi.status() == WL_CONNECTED);
  if (wifiConnected) return;

  // Retry with built-in management SSID before opening portal.
  if (primarySsid != String(DEFAULT_MGMT_SSID)) {
    WiFi.disconnect();
    delay(200);
    WiFi.begin(DEFAULT_MGMT_SSID, DEFAULT_MGMT_PASS);
    usingDefaultMgmt = true;
    start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
      delay(200);
    }
    wifiConnected = (WiFi.status() == WL_CONNECTED);
  }

  if (!wifiConnected) {
    usingDefaultMgmt = false;
    startPortal();
  }
}

static bool httpGetEx(const String &path, String *responseOut, int *codeOut, String *errOut) {
  if (codeOut) *codeOut = 0;
  if (errOut) *errOut = "";

  if (!wifiConnected) {
    if (errOut) *errOut = "wifi_disconnected";
    return false;
  }

  String url = baseUrl() + path;
  if (url.length() == 0) {
    if (errOut) *errOut = "missing_url";
    return false;
  }

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(client, url)) {
    if (errOut) *errOut = "begin_failed";
    return false;
  }

  int code = http.GET();
  String body = http.getString();
  if (responseOut) *responseOut = body;
  if (codeOut) *codeOut = code;

  if (code < 0) {
    if (errOut) *errOut = "http_error_" + String(code);
    http.end();
    return false;
  }

  http.end();
  return (code >= 200 && code < 300);
}

static String effectiveDeviceId() {
  if (cfg.deviceIdTag.length()) return cfg.deviceIdTag;
  String id = deviceId();
  id.toLowerCase();
  return id;
}

static void refreshActivation() {
  String resp;
  int code = 0;
  String err;
  bool ok = httpGetEx("/cgi-bin/icxifi/activation", &resp, &code, &err);

  lastActivationAtMs = millis();
  lastActivationCode = code;
  lastActivationErr = err;

  // Do not drop active state on transient transport failures.
  if (!ok) {
    if (!routerActivated) {
      routerActivated = false;
    } else {
      lastActivationErr = err.length() ? ("transient_" + err) : "transient_http_error";
    }
    return;
  }

  DynamicJsonDocument doc(512);
  DeserializationError jerr = deserializeJson(doc, resp);
  if (jerr) {
    if (!routerActivated) {
      routerActivated = false;
      lastActivationErr = "json_parse_failed";
    } else {
      lastActivationErr = "transient_json_parse_failed";
    }
    return;
  }

  if (!doc.containsKey("activated")) {
    if (!routerActivated) {
      routerActivated = false;
      lastActivationErr = "invalid_activation_payload";
    } else {
      lastActivationErr = "transient_invalid_activation_payload";
    }
    return;
  }

  routerActivated = doc["activated"] | false;
  if (!routerActivated) {
    setCoinAcceptorEnabled(false);
  }
}

static void refreshState() {
  String resp;
  int code = 0;
  String err;
  bool ok = httpGetEx("/cgi-bin/icxifi/state", &resp, &code, &err);

  if (!ok) {
    lastStateError = err.length() ? err : ("http_" + String(code));
    return;
  }

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, resp)) {
    lastStateError = "json_parse_failed";
    return;
  }

  routerState = String(doc["state"] | "unknown");
  lastStateError = String(doc["error"] | "");

  if (routerState == "active") {
    routerActivated = true;
  } else if (routerState == "inactive" || routerState == "no_license") {
    routerActivated = false;
  }
}

static void refreshProfile() {
  String resp;
  int code = 0;
  String err;
  bool ok = httpGetEx("/cgi-bin/icxifi/profile", &resp, &code, &err);
  if (!ok) {
    return;
  }

  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, resp)) {
    return;
  }

  lastProfileJson = resp;
  lastProfileAtMs = millis();
}

static uint16_t readRetryAfterSeconds(const String &resp) {
  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp)) return 0;
  uint16_t sec = uint16_t(doc["retryAfterSeconds"] | 0);
  return sec;
}

static bool vendAmount(uint32_t amount) {
  if (!wifiConnected) {
    lastVendOk = false;
    lastVendCode = 0;
    lastVendErr = "wifi_disconnected";
    lastVendAtMs = millis();
    return false;
  }

  if (!routerActivated) {
    lastVendOk = false;
    lastVendCode = 0;
    lastVendErr = "not_activated";
    lastVendAtMs = millis();
    return false;
  }

  String path = "/cgi-bin/icxifi/esp_vend?amount=" + String(amount) + "&deviceId=" + urlEncode(effectiveDeviceId());

  String resp;
  int code = 0;
  String err;
  bool ok = httpGetEx(path, &resp, &code, &err);

  lastVendAtMs = millis();
  lastVendCode = code;
  lastVendErr = err;
  lastVendOk = false;

  if (!ok) {
    if (code == 429) {
      uint16_t retrySec = readRetryAfterSeconds(resp);
      if (retrySec == 0) retrySec = 4;
      vendRetryAfterUntilMs = millis() + (uint32_t)retrySec * 1000UL;
      lastVendErr = "rate_limited";
    }
    return false;
  }

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, resp)) {
    lastVendErr = "json_parse_failed";
    return false;
  }

  bool vendOk = doc["ok"] | false;
  if (!vendOk) {
    lastVendErr = String(doc["error"] | "vend_failed");
    uint16_t retrySec = uint16_t(doc["retryAfterSeconds"] | 0);
    if (retrySec > 0) vendRetryAfterUntilMs = millis() + (uint32_t)retrySec * 1000UL;
    return false;
  }

  lastVendOk = true;
  lastVendErr = "";
  lastVoucherCode = String(doc["code"] | "");
  lastVoucherMinutes = uint16_t(doc["minutes"] | 0);
  lastVoucherAmount = uint32_t(doc["amount"] | amount);
  lastVoucherOffline = doc["offline"] | false;

  blink(60);
  return true;
}

ICACHE_RAM_ATTR static void coinPulseISR() {
  if (!coinEnabled) return;
  unsigned long now = millis();
  if (now - lastPulseMs >= cfg.debounceMs) {
    pulseCount++;
    lastPulseMs = now;
  }
}

static void processCoinPulses() {
  if (!coinEnabled) return;
  if (pulseCount == 0) return;

  unsigned long now = millis();
  if (now - lastPulseMs < cfg.gapMs) return;

  noInterrupts();
  uint16_t pulses = pulseCount;
  pulseCount = 0;
  interrupts();

  uint32_t amount = (uint32_t)pulses * (uint32_t)cfg.coinValue;
  pendingAmount += amount;
  saveQueue();

  blink(35);
}

static void flushQueue() {
  if (!wifiConnected || !routerActivated) return;
  if (pendingAmount == 0) return;

  if (vendRetryAfterUntilMs > 0 && (int32_t)(millis() - vendRetryAfterUntilMs) < 0) {
    return;
  }

  if (millis() - lastSendMs < 500) return;
  lastSendMs = millis();

  if (vendAmount(pendingAmount)) {
    pendingAmount = 0;
    saveQueue();
    vendRetryAfterUntilMs = 0;
    return;
  }

  // No immediate retry here to keep HTTP/UI responsiveness.
  // Next loop cycle retries automatically.
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  LittleFS.begin();
  loadConfig();
  loadQueue();

  WiFi.setAutoReconnect(true);

  pinMode(cfg.coinPin, INPUT_PULLUP);
  pinMode(cfg.coinSetPin, OUTPUT);
  setCoinAcceptorEnabled(false);

  connectWifi();
  if (wifiConnected) {
    startStaServer();
    staServerStarted = true;
    refreshActivation();
    refreshState();
    refreshProfile();
  }

  attachInterrupt(digitalPinToInterrupt(cfg.coinPin), coinPulseISR, RISING);
}

void loop() {
  if (portalActive) {
    dnsServer.processNextRequest();
  }
  server.handleClient();

  bool nowConnected = (WiFi.status() == WL_CONNECTED);
  if (nowConnected) {
    if (!wifiConnected) {
      wifiConnected = true;
      if (!staServerStarted) {
        startStaServer();
        staServerStarted = true;
      }
      refreshActivation();
      refreshState();
      refreshProfile();
    }
  } else {
    wifiConnected = false;
    routerActivated = false;
    setCoinAcceptorEnabled(false);

    if (millis() - lastReconnectMs > RECONNECT_INTERVAL_MS) {
      lastReconnectMs = millis();
      String rSsid = cfg.ssid;
      String rPass = cfg.pass;
      if (rSsid.length() == 0) {
        rSsid = DEFAULT_MGMT_SSID;
        rPass = DEFAULT_MGMT_PASS;
      }
      WiFi.mode(WIFI_STA);
      WiFi.persistent(false);
#ifdef WIFI_NONE_SLEEP
      WiFi.setSleepMode(WIFI_NONE_SLEEP);
#endif
      WiFi.begin(rSsid.c_str(), rPass.c_str());
      usingDefaultMgmt = (rSsid == String(DEFAULT_MGMT_SSID));
      // Non-blocking reconnect path: next loop handles status.
      // If saved SSID is wrong/unavailable, also try management SSID now.
      if (rSsid != String(DEFAULT_MGMT_SSID)) {
        WiFi.disconnect();
        delay(20);
        WiFi.begin(DEFAULT_MGMT_SSID, DEFAULT_MGMT_PASS);
        usingDefaultMgmt = true;
      }
    }
  }

  applyCoinEnableTimeout();

  if (wifiConnected) {
    unsigned long now = millis();

    if (now - lastActivationPollMs > ACTIVATION_POLL_MS) {
      lastActivationPollMs = now;
      refreshActivation();
    }
    if (now - lastStatePollMs > STATE_POLL_MS) {
      lastStatePollMs = now;
      refreshState();
    }
    if (now - lastProfilePollMs > PROFILE_POLL_MS) {
      lastProfilePollMs = now;
      refreshProfile();
    }

    if (!routerActivated || coinForcedOff) {
      if (coinEnabled) setCoinAcceptorEnabled(false);
    } else {
      if (!coinEnabled) setCoinAcceptorEnabled(true);
    }

    processCoinPulses();
    flushQueue();
  }
}
