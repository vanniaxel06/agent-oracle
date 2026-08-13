// Agent Oracle — ESP32-2432S028R status display firmware.
//
// This device is a DUMB RENDERER. It asks the server what to show and shows it.
// There is no formatting logic here, no thresholds, no agent-specific knowledge:
// the server returns finished label/value lines, a state word and a colour.
// Changing what a screen says is an edit on the SERVER, not a reflash and not
// a site visit.
//
// The one piece of judgement that MUST live on the device is the offline rule.
// The server cannot tell you it is unreachable. If this device cannot complete a
// poll for OFFLINE_AFTER_MS, it stops showing the last payload and says OFFLINE.
// A screen quietly displaying two-hour-old "all good" is the failure mode this
// whole product exists to prevent.
//
// Server contract: docs/server-contract.md  ·  reference server: server/

#include <Arduino.h>
#include <esp32_smartdisplay.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>
#include <Preferences.h>

#include "config.h"
#include "root_ca.h"

// Palette matches the browser mock at /status/{key}/screen so the physical unit
// and the preview can be compared side by side.
#define COL_GREEN 0x22C55E
#define COL_AMBER 0xF59E0B
#define COL_RED 0xEF4444
#define COL_DIM 0x8A8A8A
#define COL_FG 0xEEEEEE

static const uint8_t MAX_ROWS = 5;  // server sends at most 5 lines

// ── UI objects ────────────────────────────────────────────────────────────────
static lv_obj_t *ui_dot, *ui_title, *ui_state, *ui_foot;
static lv_obj_t *ui_row_label[MAX_ROWS], *ui_row_value[MAX_ROWS];

// ── State ─────────────────────────────────────────────────────────────────────
static uint32_t last_poll_ms = 0;
static uint32_t last_ok_ms = 0;
static bool ever_connected = false;
static uint32_t last_ota_check_ms = 0;

static uint32_t lv_last_tick = 0;

// ── Device identity ───────────────────────────────────────────────────────────
// THE DEVICE KEY MUST NEVER LIVE IN THE FIRMWARE IMAGE.
//
// It used to be a compile-time #define. Every unit downloads the SAME binary over
// OTA, so the key travelled with it: the Hermes unit updated itself, inherited
// the key the build happened to be made with, and silently became a second Vega
// display. Both screens showed the same agent and the other one simply stopped
// being polled. On a desk that is confusing. In a client office it is a unit
// quietly reporting on somebody else's system.
//
// The key now lives in NVS, which OTA does not touch, and is entered through the
// WiFiManager portal. One binary, many units, identity that survives updates.
static Preferences prefs;
static String device_key;
static String status_host;
static char ap_name[40] = WIFI_AP_NAME;

static bool load_device_key() {
  prefs.begin("agentoracle", true);   // read-only
  device_key = prefs.getString("devkey", "");
  // The server host lives in NVS too, so a PUBLISHED binary can be pointed at
  // someone else's server from the setup portal. Without this a firmware image is
  // welded to whoever compiled it, which makes browser-flashing it pointless.
  // Falls back to the compile-time default, so existing units keep working across
  // an update without anyone re-entering anything.
  status_host = prefs.getString("host", "");
  if (!status_host.length()) status_host = STATUS_HOST;
  prefs.end();
  return device_key.length() >= 16;
}

static void save_device_key(const String &k) {
  prefs.begin("agentoracle", false);
  prefs.putString("devkey", k);
  prefs.end();
  device_key = k;
}

static void save_status_host(const String &h) {
  prefs.begin("agentoracle", false);
  prefs.putString("host", h);
  prefs.end();
  status_host = h;
}

// One copy of the save logic. The portal is opened from two places (boot with no
// key, and the 5s long press) and the two blocks had already drifted apart in
// formatting; duplicating validation as well is how they drift in behaviour.
static void apply_portal_values(const char *raw_key, const char *raw_host) {
  String k(raw_key);
  k.trim();
  if (k.length() >= 16) save_device_key(k);

  String h(raw_host);
  h.trim();
  // Host only. A pasted URL yields https://https://... and fails in a way that
  // reads like the server being down rather than a typo.
  h.replace("https://", "");
  h.replace("http://", "");
  while (h.endsWith("/")) h.remove(h.length() - 1);
  if (h.length() >= 4) save_status_host(h);
}

// Drive LVGL for a fixed wall-clock window.
//
// A single lv_timer_handler() call does NOT finish a frame. LVGL renders in
// strips — a full 240x320 screen on this board takes many flushes — and it needs
// the tick to advance between calls or it decides no work is due. Calling it
// once and then blocking, as setup() originally did before WiFiManager, left the
// panel showing three strips of a half-drawn black screen. That reads exactly
// like a dead display and cost us a hunt for a driver fault that did not exist.
//
// Anything that blocks must be preceded by a pump long enough to land the frame.
static void ui_pump(uint32_t ms) {
  const uint32_t until = millis() + ms;
  while ((int32_t)(millis() - until) < 0) {
    const uint32_t now = millis();
    lv_tick_inc(now - lv_last_tick);
    lv_last_tick = now;
    lv_timer_handler();
    delay(5);
  }
}

// Labels are ALIGNED, never absolutely positioned.
//
// The first version hard-coded x/y for a 320x240 landscape screen. On the actual
// panel the values sat at x=175 on a 240px-wide display, so every value column
// ran off the edge and the screen read as truncated gibberish. Alignment costs
// nothing and survives a rotation change, a different panel, or a longer string.
static lv_obj_t *make_label(const lv_font_t *font, uint32_t colour,
                            lv_align_t align, lv_coord_t x, lv_coord_t y) {
  lv_obj_t *l = lv_label_create(lv_screen_active());
  lv_obj_set_style_text_font(l, font, 0);
  lv_obj_set_style_text_color(l, lv_color_hex(colour), 0);
  lv_obj_align(l, align, x, y);
  lv_label_set_text(l, "");
  return l;
}

// Long-press anywhere = poll now instead of waiting out the 30s cycle. Useful
// the moment you restart an agent and want to watch it come back.
//
// ONE ACTION, NO MENU — deliberately. Page navigation was rejected because a wall
// unit parked on a green page while another agent is red is the exact failure the
// staleness rule exists to prevent. A button with no state cannot hide anything.
//
// LONG press, not tap: a wall-mounted unit gets brushed, and LVGL's built-in
// LV_EVENT_LONG_PRESSED (~400ms) gives the deliberate-press guard for free.
//
// The whole screen is the target, so this needs NO touch calibration — the panel
// is resistive and its raw coordinates may be well off, but every press lands on
// the screen regardless of where it thinks it is.
static volatile bool touch_refresh = false;
static volatile bool setup_requested = false;
static uint32_t press_start_ms = 0;
static bool rekey_armed = false;

// Two gestures on one target, separated by how long you hold:
//   ~0.4s  poll now
//   5s     reopen the setup portal
//
// The long hold exists because there was NO way to change a unit's key without
// wiping its flash over USB. On a desk that is annoying. For a unit already
// installed at a client, re-pointing it at a different agent meant a site visit,
// which is precisely what this product is supposed to remove.
static void screen_event_cb(lv_event_t *e) {
  switch (lv_event_get_code(e)) {
    case LV_EVENT_PRESSED:
      press_start_ms = millis();
      rekey_armed = false;
      break;
    case LV_EVENT_LONG_PRESSED_REPEAT:
      if (!press_start_ms) break;
      if (!rekey_armed && millis() - press_start_ms >= REKEY_HOLD_MS) {
        rekey_armed = true;
        setup_requested = true;
      } else if (!rekey_armed && millis() - press_start_ms >= 1500) {
        // Tell them something is coming, or a 5s hold feels like a dead screen.
        lv_label_set_text(ui_foot, "keep holding for setup...");
      }
      break;
    case LV_EVENT_RELEASED:
    case LV_EVENT_PRESS_LOST:
      // A hold that stopped short of the setup threshold is just a refresh.
      if (!rekey_armed && press_start_ms && millis() - press_start_ms >= 400)
        touch_refresh = true;
      press_start_ms = 0;
      break;
    default:
      break;
  }
}

static void build_ui() {
  lv_obj_t *scr = lv_screen_active();
  lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
  lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
  lv_obj_set_style_pad_all(scr, 0, 0);
  lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(scr, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(scr, screen_event_cb, LV_EVENT_ALL, NULL);

  const lv_coord_t h = lv_display_get_vertical_resolution(lv_disp_get_default());
  const lv_coord_t row_h = 28;
  const lv_coord_t top = 52;

  // Glance state: a colour dot beside the agent name. The text below it is for
  // when the dot isn't green.
  ui_dot = lv_obj_create(scr);
  lv_obj_set_size(ui_dot, 14, 14);
  lv_obj_align(ui_dot, LV_ALIGN_TOP_LEFT, 10, 16);
  lv_obj_set_style_radius(ui_dot, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_border_width(ui_dot, 0, 0);
  lv_obj_remove_flag(ui_dot, LV_OBJ_FLAG_SCROLLABLE);
  // lv_obj_create is clickable by default; leave it so and a press landing on
  // the dot never reaches the screen handler.
  lv_obj_remove_flag(ui_dot, LV_OBJ_FLAG_CLICKABLE);

  ui_title = make_label(&lv_font_montserrat_28, COL_FG, LV_ALIGN_TOP_LEFT, 32, 6);
  ui_state = make_label(&lv_font_montserrat_20, COL_DIM, LV_ALIGN_TOP_RIGHT, -10, 12);

  // Rows only fit while they stay above the footer; clamp rather than draw off
  // the bottom of whatever panel this turns out to be.
  for (uint8_t i = 0; i < MAX_ROWS; i++) {
    const lv_coord_t y = top + i * row_h;
    if (y + row_h > h - 18) {
      ui_row_label[i] = make_label(&lv_font_montserrat_14, COL_DIM, LV_ALIGN_TOP_LEFT, 10, 0);
      ui_row_value[i] = make_label(&lv_font_montserrat_14, COL_FG, LV_ALIGN_TOP_RIGHT, -10, 0);
      lv_obj_add_flag(ui_row_label[i], LV_OBJ_FLAG_HIDDEN);
      lv_obj_add_flag(ui_row_value[i], LV_OBJ_FLAG_HIDDEN);
      continue;
    }
    ui_row_label[i] = make_label(&lv_font_montserrat_20, COL_DIM, LV_ALIGN_TOP_LEFT, 10, y);
    ui_row_value[i] = make_label(&lv_font_montserrat_20, COL_FG, LV_ALIGN_TOP_RIGHT, -10, y);
  }

  ui_foot = make_label(&lv_font_montserrat_14, COL_DIM, LV_ALIGN_BOTTOM_LEFT, 10, -6);
}

// Boot self-test: flood the panel with known colours before drawing anything.
//
// Text legibility is a terrible first diagnostic — a half-working flush path,
// a wrong colour space and a layout bug all look like "mangled text" in a photo,
// and we burned several flash cycles telling them apart by eye. Solid colours
// are unambiguous: if RED shows red, the flush path, the colour space and the
// inversion are all correct, and any remaining problem is layout.
//
// Reported over serial as it goes, so the log and the eye can be compared.
static void selftest() {
  static const uint32_t cols[] = {0xFF0000, 0x00FF00, 0x0000FF};
  static const char *names[] = {"RED", "GREEN", "BLUE"};
  for (uint8_t i = 0; i < 3; i++) {
    lv_obj_set_style_bg_color(lv_screen_active(), lv_color_hex(cols[i]), 0);
    log_i("selftest: screen should now be %s", names[i]);
    ui_pump(1500);
  }
  lv_obj_set_style_bg_color(lv_screen_active(), lv_color_black(), 0);
  log_i("selftest: done, back to black");
  ui_pump(500);
}

static void set_colour(uint32_t colour) {
  lv_obj_set_style_bg_color(ui_dot, lv_color_hex(colour), 0);
  lv_obj_set_style_text_color(ui_state, lv_color_hex(colour), 0);
#ifdef BOARD_HAS_RGB_LED
  // Only 8 colours available; amber is red+green.
  smartdisplay_led_set_rgb(colour != COL_GREEN, colour != COL_RED, false);
#endif
}

static void set_rows(uint8_t used) {
  for (uint8_t i = used; i < MAX_ROWS; i++) {
    lv_label_set_text(ui_row_label[i], "");
    lv_label_set_text(ui_row_value[i], "");
  }
}

// Everything the device decides to show on its own — never a stale payload.
static void show_local(const char *title, const char *state, const char *line, uint32_t colour) {
  lv_label_set_text(ui_title, title);
  lv_label_set_text(ui_state, state);
  lv_label_set_text(ui_row_label[0], line);
  lv_label_set_text(ui_row_value[0], "");
  set_rows(1);
  set_colour(colour);
}

// ── Networking ────────────────────────────────────────────────────────────────
// One factory so every outbound request verifies against the pinned root. If
// this is ever loosened to setInsecure(), a spoofed feed can show a green tick
// for a dead agent, which is worse than the screen being blank.
static void secure_client(WiFiClientSecure &client) {
  client.setCACert(ROOT_CA_ISRG_X1);
  client.setTimeout(10);
}

static bool poll_status() {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  secure_client(client);
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(8000);

  String url = String("https://") + status_host + "/status/" + device_key;
  if (!http.begin(client, url)) return false;

  // Heap before the handshake. A TLS connect needs roughly 45KB here, and when
  // it cannot get it the error is "connection refused" — which points at the
  // network when the fault is entirely local. Log the number so the next person
  // sees the real cause immediately.
  const uint32_t heap_before = ESP.getFreeHeap();

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    log_w("poll failed: HTTP %d (free heap was %u, now %u)",
          code, (unsigned)heap_before, (unsigned)ESP.getFreeHeap());
    http.end();
    return false;
  }

  // The payload is deliberately small (~300 bytes) because this board has no
  // PSRAM. If it ever stops fitting, the server is doing too much.
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) {
    log_w("bad json: %s", err.c_str());
    return false;
  }

  const char *title = doc["title"] | "?";
  const char *state = doc["state"] | "?";
  const char *colour = doc["color"] | "amber";
  const char *age = doc["age"] | "";

  lv_label_set_text(ui_title, title);
  lv_label_set_text(ui_state, state);

  JsonArray lines = doc["lines"].as<JsonArray>();
  uint8_t i = 0;
  for (JsonObject line : lines) {
    if (i >= MAX_ROWS) break;
    lv_label_set_text(ui_row_label[i], line["l"] | "");
    lv_label_set_text(ui_row_value[i], line["v"] | "");
    i++;
  }
  set_rows(i);

  // Trust the server's colour verbatim — it owns the staleness rules for the
  // agent. The device only overrides when it can't reach the server at all.
  uint32_t c = COL_AMBER;
  if (!strcmp(colour, "green")) c = COL_GREEN;
  else if (!strcmp(colour, "red")) c = COL_RED;
  set_colour(c);

  // ASCII only in labels. The Montserrat subsets built into lv_conf.h do not
  // carry U+00B7, so a "·" separator renders as a tofu box on the panel.
  lv_label_set_text_fmt(ui_foot, "beat %s ago  -  fw %s", age, FIRMWARE_VERSION);
  return true;
}

// Is `candidate` a strictly higher semantic version than `current`?
//
// WHY THIS EXISTS: the first version of check_ota() updated whenever the manifest
// version merely DIFFERED from the running one. A unit freshly flashed with 0.2.0
// over USB immediately saw a manifest still advertising 0.1.3 and began
// downgrading itself — silently undoing the flash. Publish an old manifest by
// mistake and an entire fleet walks backwards.
//
// Upgrades happen automatically; going backwards has to be asked for explicitly
// via "allow_downgrade": true in the manifest, so a rollback is always deliberate.
static bool version_is_newer(const char *candidate, const char *current) {
  int a[3] = {0, 0, 0}, b[3] = {0, 0, 0};
  sscanf(candidate, "%d.%d.%d", &a[0], &a[1], &a[2]);
  sscanf(current, "%d.%d.%d", &b[0], &b[1], &b[2]);
  for (uint8_t i = 0; i < 3; i++)
    if (a[i] != b[i]) return a[i] > b[i];
  return false;
}

// ── OTA ───────────────────────────────────────────────────────────────────────
// Pull-based on purpose. Push-style OTA needs to reach the device, and these
// units live on client LANs behind NAT. Nothing inbound ever has to be opened.
#if OTA_ENABLED
static void check_ota() {
  if (WiFi.status() != WL_CONNECTED) return;

  // ONE TLS CLIENT ALIVE AT A TIME. This board cannot afford two: the manifest
  // client below used to still be in scope when the download client was created,
  // and the second handshake died with
  //   E ssl_client.cpp: (-10368) X509 - Allocation of memory failed
  // which surfaces as "connection refused" and looks like a server fault. The
  // inner scope exists purely so the manifest client is destroyed — with its TLS
  // context and parsed CA chain — before the download client is built. Do not
  // flatten it.
  String version, bin;
  bool allow_downgrade = false;
  {
    WiFiClientSecure client;
    secure_client(client);
    HTTPClient http;
    // Per-revision manifest. A unit can only ever be offered a build made for
    // its own display controller — see config.h.example.
    String url = String("https://") + status_host + OTA_MANIFEST_PREFIX + BOARD_NAME + ".json";
    if (!http.begin(client, url)) return;

    if (http.GET() != HTTP_CODE_OK) { http.end(); return; }
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, http.getStream());
    http.end();
    if (err) return;

    version = (const char *)(doc["version"] | "");
    bin = (const char *)(doc["url"] | "");
    allow_downgrade = doc["allow_downgrade"] | false;
  }

  if (!version.length() || !bin.length()) return;
  if (version == FIRMWARE_VERSION) return;  // already current
  if (!allow_downgrade && !version_is_newer(version.c_str(), FIRMWARE_VERSION)) {
    log_w("manifest %s is not newer than %s - ignoring", version.c_str(), FIRMWARE_VERSION);
    return;
  }

  log_i("OTA %s -> %s (free heap %u)", FIRMWARE_VERSION, version.c_str(),
        (unsigned)ESP.getFreeHeap());
  show_local("UPDATING", version.c_str(), "Do not unplug", COL_AMBER);
  ui_pump(400);  // land the frame before httpUpdate blocks for the download

  WiFiClientSecure ota_client;
  secure_client(ota_client);
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return ret = httpUpdate.update(ota_client, bin);
  if (ret == HTTP_UPDATE_FAILED)
    log_e("OTA failed: %s", httpUpdate.getLastErrorString().c_str());
}
#endif

// Open the setup portal on demand. Blocks, then restarts — restarting is the
// simplest way to guarantee a clean poll loop with whatever key was just saved,
// rather than trying to unpick partially-changed state at runtime.
static void open_setup_portal() {
  log_i("setup portal requested by long press");
  show_local("SETUP", "OPEN", ap_name, COL_AMBER);
  ui_pump(400);

  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_PORTAL_TIMEOUT_S);
  WiFiManagerParameter key_param("devkey", "Device key (32 hex)", device_key.c_str(), 40);
  WiFiManagerParameter host_param("host", "Server host (no https://)", status_host.c_str(), 64);
  wm.addParameter(&key_param);
  wm.addParameter(&host_param);
  wm.setSaveParamsCallback([&key_param, &host_param]() {
    apply_portal_values(key_param.getValue(), host_param.getValue());
  });
  wm.startConfigPortal(ap_name);
  ESP.restart();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  log_i("Board: %s  firmware: %s", BOARD_NAME, FIRMWARE_VERSION);
  // Print the buffer size actually compiled in. The board definition sets this
  // and we override it in platformio.ini; whichever -D the toolchain applies
  // last wins, and guessing at flag order cost real time once already.
  log_i("LVGL buffer: %d px, free heap %d, largest DMA block %d",
        (int)LVGL_BUFFER_PIXELS, (int)ESP.getFreeHeap(),
        (int)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));

  smartdisplay_init();
  lv_last_tick = millis();
  // Landscape, 320x240. The panel is natively 240x320 portrait, so this is a
  // software rotation — which is fine here BECAUSE the layout is alignment-
  // based rather than absolutely positioned.
  //
  // Do not remove this on the evidence of a photo taken with the board held
  // portrait: the text runs vertically in that orientation and looks broken,
  // but it is rendering correctly. Rotation was pulled once on exactly that
  // misreading and it turned a working screen into a mangled one.
  lv_display_set_rotation(lv_disp_get_default(), LV_DISPLAY_ROTATION_90);
  smartdisplay_lcd_set_backlight(1.0f);
  log_i("display: %dx%d after rotation",
        (int)lv_display_get_horizontal_resolution(lv_disp_get_default()),
        (int)lv_display_get_vertical_resolution(lv_disp_get_default()));
  build_ui();
  selftest();

  show_local("WIFI", "SETUP", WIFI_AP_NAME, COL_AMBER);
  ui_pump(400);  // WiFiManager blocks for up to 5 minutes after this line
  // Where things ACTUALLY landed. Label geometry has been guessed twice and
  // been wrong twice; this costs one line of log and ends the argument.
  log_i("geom %dx%d | title y=%d h=%d | state y=%d h=%d | row0 y=%d h=%d | foot y=%d",
        (int)lv_display_get_horizontal_resolution(lv_disp_get_default()),
        (int)lv_display_get_vertical_resolution(lv_disp_get_default()),
        (int)lv_obj_get_y(ui_title),  (int)lv_obj_get_height(ui_title),
        (int)lv_obj_get_y(ui_state),  (int)lv_obj_get_height(ui_state),
        (int)lv_obj_get_y(ui_row_label[0]), (int)lv_obj_get_height(ui_row_label[0]),
        (int)lv_obj_get_y(ui_foot));

  // Captive portal. Clients change router passwords; this is how the unit gets
  // back online without anyone driving out to it. The device key is entered here
  // too, so a unit can be re-pointed at a different agent without a cable.
  const bool have_key = load_device_key();

  // Unique AP name per unit. Two units raising an identically-named AP at the
  // same time (which is exactly what a fleet-wide update causes) is impossible to
  // tell apart from a phone, and you end up configuring one twice and the other
  // never. The MAC suffix is printed on the screen so you know which one you are
  // talking to.
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(ap_name, sizeof(ap_name), "%s-%02X%02X", WIFI_AP_NAME, mac[4], mac[5]);
  log_i("setup AP: %s", ap_name);
  if (!have_key) {
    log_w("no device key in NVS - forcing setup portal");
    show_local("SETUP", "NO KEY", ap_name, COL_AMBER);
    ui_pump(400);
  }

  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_PORTAL_TIMEOUT_S);
  WiFiManagerParameter key_param("devkey", "Device key (32 hex)", device_key.c_str(), 40);
  WiFiManagerParameter host_param("host", "Server host (no https://)", status_host.c_str(), 64);
  wm.addParameter(&key_param);
  wm.addParameter(&host_param);
  wm.setSaveParamsCallback([&key_param, &host_param]() {
    apply_portal_values(key_param.getValue(), host_param.getValue());
  });

  // No key means the unit cannot poll anything, so open the portal outright
  // rather than connecting to wifi and sitting there doing nothing useful.
  const bool ok = have_key ? wm.autoConnect(ap_name)
                           : wm.startConfigPortal(ap_name);
  if (!ok || !load_device_key()) {
    log_w("provisioning incomplete - restarting");
    ESP.restart();
  }
  log_i("device key ...%s", device_key.substring(device_key.length() - 6).c_str());

  show_local("CONNECTED", "...", WiFi.localIP().toString().c_str(), COL_AMBER);
  ui_pump(400);

#if OTA_ENABLED
  check_ota();  // before first poll, so a broken build can always be replaced
  last_ota_check_ms = millis();
#endif
}

void loop() {
  const uint32_t now = millis();

  // Acknowledge the press before polling. A poll can take several seconds over
  // TLS, and a button that appears to do nothing gets pressed again and again.
  if (setup_requested) {
    setup_requested = false;
    open_setup_portal();  // does not return
  }

  if (touch_refresh) {
    touch_refresh = false;
    lv_label_set_text(ui_foot, "refreshing...");
    ui_pump(80);
    last_poll_ms = 0;  // force the poll below to fire this iteration
  }

  if (now - last_poll_ms >= POLL_INTERVAL_MS || last_poll_ms == 0) {
    last_poll_ms = now;
    if (poll_status()) {
      last_ok_ms = now;
      ever_connected = true;
    }
  }

  // THE DEVICE-SIDE RULE. Past the window we stop rendering whatever the last
  // successful poll returned, because we no longer know if it is true. This must
  // never be relaxed into "keep showing the last good state".
  if (now - last_ok_ms > OFFLINE_AFTER_MS) {
    // Re-render only when the displayed minute changes; this branch is reached
    // on every loop iteration and rewriting the labels (and the LED) at 200Hz
    // buys nothing.
    const uint32_t mins = (now - last_ok_ms) / 60000;
    static uint32_t rendered_min = UINT32_MAX;
    if (mins != rendered_min) {
      rendered_min = mins;
      if (ever_connected) {
        char line[24];
        snprintf(line, sizeof(line), "%lum unreachable", (unsigned long)mins);
        show_local("OFFLINE", "NO SERVER", line, COL_RED);
      } else {
        show_local("OFFLINE", "NO SERVER", "never reached", COL_RED);
      }
    }
  }

#if OTA_ENABLED
  if (now - last_ota_check_ms >= OTA_CHECK_INTERVAL_MS) {
    last_ota_check_ms = now;
    check_ota();
  }
#endif

  lv_tick_inc(now - lv_last_tick);
  lv_last_tick = now;
  lv_timer_handler();
  delay(5);
}
