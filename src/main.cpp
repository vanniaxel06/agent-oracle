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
#include <Update.h>
#include <mbedtls/sha256.h>

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
static uint32_t poll_interval_ms = POLL_INTERVAL_MS;

static uint32_t lv_last_tick = 0;

// ── Group rotation ────────────────────────────────────────────────────────────
// One key can name several agents ("vega,motoko"), and the server then returns
// { screens: [...] } instead of a single screen. The device cycles them and
// decides NOTHING: ordering, dwell time, whether to hold, and the group colour
// are all resolved server-side. That is the same rule as everywhere else here —
// the moment the device starts choosing what to show, a screen in someone
// else's office stops being re-specifiable from a config file.
//
// Screens are copied out of the JSON into fixed buffers rather than kept as a
// live JsonDocument, because rotation happens BETWEEN polls: the document is
// long gone by the time the second screen is due. Bounded at the server's own
// MAX_GROUP, so this costs ~1KB and cannot grow with the payload.
static const uint8_t MAX_SCREENS = 4;  // must match MAX_GROUP server-side

struct ScreenBuf {
  char title[20];
  char state[16];
  char age[12];
  uint32_t colour;
  uint8_t rows;
  char label[MAX_ROWS][20];
  char value[MAX_ROWS][20];
};

static ScreenBuf screens[MAX_SCREENS];
static uint8_t screen_count = 0;  // 0 = nothing polled yet, 1 = single, >1 = group
static uint8_t screen_idx = 0;
static uint32_t group_colour = COL_AMBER;
static bool group_hold = false;
static uint32_t dwell_ms = 30000;
static uint32_t last_rotate_ms = 0;

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
  const lv_coord_t w = lv_display_get_horizontal_resolution(lv_disp_get_default());
  const lv_coord_t row_h = 28;
  const lv_coord_t top = 52;

  // VALUE COLUMN IS A FIXED WIDTH, and this is not cosmetic tidying.
  //
  // An auto-sized right-aligned label moves its own left edge when the string
  // gets shorter. The strip it vacates falls between DMA flush bands, so part
  // of the PREVIOUS value survives on the panel until something else redraws
  // that area - seen on the Vega unit as "06:00 BTC" reading clipped, healing,
  // and coming back every time the value changed length.
  //
  // Pinning the width means the invalidated rectangle always covers both the
  // old and the new string, so there is nothing left behind to heal.
  //
  // DO NOT fix that symptom by raising SMARTDISPLAY_DMA_BUFFER_SIZE on the CYD.
  // That board has ~48KB left for a TLS handshake needing ~45KB, and starving
  // it surfaces as "connection refused" - which reads as the server being down.
  // This costs no RAM at all.
  //
  // Sized to hold the server's maximum 16-character value, so long strings
  // render exactly as they did before; only the shrinking case changes.
  const lv_coord_t value_w = (w * 55) / 100;

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
    // Fixed box, text right-aligned inside it — see value_w above. CLIP rather
    // than the default WRAP: an over-long value must never become a second line
    // and shunt every row below it down the screen.
    lv_obj_set_width(ui_row_value[i], value_w);
    lv_label_set_long_mode(ui_row_value[i], LV_LABEL_LONG_CLIP);
    lv_obj_set_style_text_align(ui_row_value[i], LV_TEXT_ALIGN_RIGHT, 0);
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

// The dot and the LED carry the WORST state in the group, never whichever
// screen happens to be up. A green light over a hidden red screen is the same
// lie as a stale green tick, arrived at from a different direction.
//
// On a board with no RGB LED (the 4.3" S3) the dot IS the LED — it is the only
// thing readable from across a room, so it must not be repurposed to describe
// the current screen.
static void set_group_colour(uint32_t colour) {
  lv_obj_set_style_bg_color(ui_dot, lv_color_hex(colour), 0);
#ifdef BOARD_HAS_RGB_LED
  // Only 8 colours available; amber is red+green.
  smartdisplay_led_set_rgb(colour != COL_GREEN, colour != COL_RED, false);
#endif
}

// The state word describes the screen you are actually looking at. Colouring it
// with the group's worst state would print "LIVE" in red on a healthy agent.
static void set_state_colour(uint32_t colour) {
  lv_obj_set_style_text_color(ui_state, lv_color_hex(colour), 0);
}

// Both together — for a single-agent screen, and for anything the device says
// on its own behalf, where there is no group and no distinction to draw.
static void set_colour(uint32_t colour) {
  set_group_colour(colour);
  set_state_colour(colour);
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
// An unrecognised colour word is amber, never green. Do not invent confidence
// the server did not report.
static uint32_t colour_from(const char *name) {
  if (!name) return COL_AMBER;
  if (!strcmp(name, "green")) return COL_GREEN;
  if (!strcmp(name, "red")) return COL_RED;
  return COL_AMBER;
}

static void copy_field(char *dst, size_t n, const char *src) {
  strncpy(dst, src ? src : "", n - 1);
  dst[n - 1] = '\0';
}

// Copy one screen out of the JSON into a fixed buffer. Values arrive already
// clipped server-side, but truncate here anyway rather than trusting a remote
// length limit to stay what it is today.
static void store_screen(JsonObject src, ScreenBuf &dst) {
  copy_field(dst.title, sizeof(dst.title), src["title"] | "?");
  copy_field(dst.state, sizeof(dst.state), src["state"] | "?");
  copy_field(dst.age, sizeof(dst.age), src["age"] | "");
  dst.colour = colour_from(src["color"] | "amber");

  uint8_t i = 0;
  for (JsonObject line : src["lines"].as<JsonArray>()) {
    if (i >= MAX_ROWS) break;
    copy_field(dst.label[i], sizeof(dst.label[i]), line["l"] | "");
    copy_field(dst.value[i], sizeof(dst.value[i]), line["v"] | "");
    i++;
  }
  dst.rows = i;
}

static void render_screen(const ScreenBuf &s) {
  lv_label_set_text(ui_title, s.title);
  lv_label_set_text(ui_state, s.state);
  for (uint8_t i = 0; i < s.rows; i++) {
    lv_label_set_text(ui_row_label[i], s.label[i]);
    lv_label_set_text(ui_row_value[i], s.value[i]);
  }
  set_rows(s.rows);
  set_state_colour(s.colour);

  // SIZE THE LABELS BEFORE REDRAWING THEM, THEN REDRAW THE ROWS EXPLICITLY.
  //
  // Diagnosed from the per-row log below, after three fixes guessed from
  // photographs missed it. On the FIRST render after boot the labels have not
  // been laid out yet - the log showed "Last job" at the right position with
  // WIDTH ZERO - so lv_label_set_text invalidated a zero-width area and the
  // glyphs were drawn into a region the flush never covered.
  //
  // It then never repairs itself, which is the part that matters: these labels
  // are STATIC. Setting a label to the string it already holds invalidates
  // nothing, so a row drawn wrong once at boot stays wrong forever. That is why
  // tapping to force a poll never fixed it - the poll re-rendered, and the
  // re-render correctly decided there was nothing to redraw.
  //
  // Row 0 always looked fine because show_local() gives it text during boot, so
  // it alone was already sized by the time the first real render ran.
  //
  // lv_obj_update_layout() forces the real sizes now; invalidating the ten row
  // objects then redraws them over their correct areas. Deliberately NOT
  // lv_obj_invalidate(lv_screen_active()) - a full-frame redraw was tried and
  // put a visible band line across a row on this panel. Small correct areas,
  // not one big one.
  lv_obj_update_layout(lv_screen_active());
  for (uint8_t i = 0; i < MAX_ROWS; i++) {
    lv_obj_invalidate(ui_row_label[i]);
    lv_obj_invalidate(ui_row_value[i]);
  }

  // WHAT THE DEVICE THINKS IT IS DRAWING, per row.
  //
  // Added because a label rendered as a garbled mark, in the wrong place, and
  // three separate fixes were attempted from photographs of the panel without
  // anyone knowing whether the string or the geometry was wrong. Those are
  // different bugs with nothing in common.
  //
  // Prints the string held in the buffer AND the coordinates LVGL actually
  // assigned. If the string is right and x is wrong, it is layout. If the
  // string is wrong, it is memory. Reading the glass cannot tell them apart.
  for (uint8_t i = 0; i < s.rows; i++) {
    log_i("row%u L=\"%s\"(x%d y%d w%d) V=\"%s\"(x%d y%d w%d)", i,
          s.label[i], (int)lv_obj_get_x(ui_row_label[i]),
          (int)lv_obj_get_y(ui_row_label[i]), (int)lv_obj_get_width(ui_row_label[i]),
          s.value[i], (int)lv_obj_get_x(ui_row_value[i]),
          (int)lv_obj_get_y(ui_row_value[i]), (int)lv_obj_get_width(ui_row_value[i]));
  }

  // NO FULL-SCREEN INVALIDATE HERE - it was tried and reverted.
  //
  // Forcing lv_obj_invalidate(lv_screen_active()) on every render sounds like a
  // clean way to avoid partial-flush artifacts. On the CYD it makes them worse:
  // a full frame at a 16KB DMA buffer is ~10 flush bands instead of the two or
  // three a changed row needs, and a visible horizontal line appeared across a
  // row within minutes of trying it. More bands means more band boundaries.
  //
  // Fewer, smaller redraws are the right direction on this board. The fixed
  // value-column width in build_ui() is the targeted fix for stale remnants.
  //
  // NOTE FOR ANYONE READING A PHOTO OF THIS SCREEN: labels are left-aligned and
  // values right-aligned across a wide gap, so the eye pairs each value with
  // the row BELOW its own. That is an optical illusion, not a bug, and it has
  // now been "discovered" twice. Check the serial geometry log before believing
  // the columns are misaligned.

  // ASCII only in labels. The Montserrat subsets built into lv_conf.h do not
  // carry U+00B7, so a "·" separator renders as a tofu box on the panel.
  //
  // A rotating unit says which screen of how many. Without it, a screen that
  // changes on its own looks like a fault rather than a rotation, and there is
  // no way to tell "showing 1 of 2" from "the other agent vanished".
  if (screen_count > 1)
    lv_label_set_text_fmt(ui_foot, "beat %s ago  -  %d/%d  -  fw %s",
                          s.age, (int)screen_idx + 1, (int)screen_count,
                          FIRMWARE_VERSION);
  else
    lv_label_set_text_fmt(ui_foot, "beat %s ago  -  fw %s", s.age, FIRMWARE_VERSION);
}

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

  // TWO SHAPES, DETECTED NOT CONFIGURED. A single agent returns its screen
  // fields at the top level, exactly as it always has. A group returns
  // { screens: [...] } with ordering, hold and the group colour already
  // resolved. Keying off the presence of "screens" means old firmware keeps
  // working against the new server, and a device can be moved between a single
  // key and a group key with no reflash — which is the whole point of the
  // server owning the decisions.
  if (doc["screens"].is<JsonArray>()) {
    uint8_t n = 0;
    for (JsonObject s : doc["screens"].as<JsonArray>()) {
      if (n >= MAX_SCREENS) break;
      store_screen(s, screens[n]);
      n++;
    }
    if (!n) {
      log_w("group payload with no screens");
      return false;
    }
    screen_count = n;
    group_colour = colour_from(doc["color"] | "amber");
    group_hold = doc["hold"] | false;

    uint32_t d = doc["dwell_s"].as<uint32_t>();
    if (d < 5) d = 5;
    if (d > 120) d = 120;
    dwell_ms = d * 1000UL;

    // Hold parks on index 0, where the server has sorted the worst screen. Also
    // reset if the group shrank under us, or the index now points past the end.
    if (group_hold || screen_idx >= screen_count) screen_idx = 0;
    last_rotate_ms = millis();
  } else {
    store_screen(doc.as<JsonObject>(), screens[0]);
    screen_count = 1;
    screen_idx = 0;
    group_colour = screens[0].colour;
    group_hold = false;
  }

  // Trust the server's colour verbatim — it owns the staleness rules for the
  // agent. The device only overrides when it can't reach the server at all.
  set_group_colour(group_colour);
  render_screen(screens[screen_idx]);

  // Cadence is the server's call too. It already sends poll_s and the device
  // used to ignore it, which meant changing how often a fleet polls needed a
  // reflash of every unit. Clamped so a bad value cannot stop a unit polling
  // altogether or turn it into a hot loop against the server.
  uint32_t ps = doc["poll_s"].as<uint32_t>();
  if (ps) {
    if (ps < 10) ps = 10;
    if (ps > 600) ps = 600;
    poll_interval_ms = ps * 1000UL;
  }
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
  String version, bin, expected_sha;
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
    expected_sha = (const char *)(doc["sha256"] | "");
    allow_downgrade = doc["allow_downgrade"] | false;
  }

  if (!version.length() || !bin.length()) return;
  if (version == FIRMWARE_VERSION) return;  // already current
  if (!allow_downgrade && !version_is_newer(version.c_str(), FIRMWARE_VERSION)) {
    log_w("manifest %s is not newer than %s - ignoring", version.c_str(), FIRMWARE_VERSION);
    return;
  }

  // A HASH IS REQUIRED, NOT PREFERRED. Without one there is no way to tell a
  // complete binary from a truncated one, or the build you meant to publish
  // from whatever else is sitting at that URL. TLS authenticates the server; it
  // says nothing about whether the bytes are the build you tested.
  //
  // Refusing is deliberate. A manifest with no hash means OTA stops for that
  // board until one is published — loudly, in the log, with the device still
  // running fine. The alternative is flashing unverified images by default,
  // which is the failure this whole project is a reaction to.
  if (expected_sha.length() != 64) {
    log_e("manifest for %s has no usable sha256 - REFUSING to update. "
          "Republish it with scripts/release.sh.", BOARD_NAME);
    return;
  }

  log_i("OTA %s -> %s (free heap %u)", FIRMWARE_VERSION, version.c_str(),
        (unsigned)ESP.getFreeHeap());
  show_local("UPDATING", version.c_str(), "Do not unplug", COL_AMBER);
  ui_pump(400);  // land the frame before httpUpdate blocks for the download

  // HAND-ROLLED DOWNLOAD, DELIBERATELY. httpUpdate.update() streams straight
  // into flash and offers no hook to hash the bytes on the way past, so
  // verifying the image means owning the loop. Everything below writes to the
  // INACTIVE app slot (this is why min_spiffs.csv and its two slots matter) —
  // the running firmware is never touched, and nothing boots until Update.end()
  // flips the boot partition. A failure here means the update does not happen,
  // never that the unit is left unbootable.
  WiFiClientSecure ota_client;
  secure_client(ota_client);
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(15000);
  if (!http.begin(ota_client, bin)) {
    log_e("OTA: cannot open %s", bin.c_str());
    return;
  }
  if (http.GET() != HTTP_CODE_OK) {
    log_e("OTA: binary fetch failed");
    http.end();
    return;
  }

  const int len = http.getSize();
  if (!Update.begin(len > 0 ? (size_t)len : UPDATE_SIZE_UNKNOWN)) {
    log_e("OTA: Update.begin failed: %s", Update.errorString());
    http.end();
    return;
  }

  mbedtls_sha256_context sha_ctx;
  mbedtls_sha256_init(&sha_ctx);
  mbedtls_sha256_starts(&sha_ctx, 0);  // 0 = SHA-256, not SHA-224

  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[1024];
  size_t written = 0;
  bool io_ok = true;
  uint32_t last_data_ms = millis();

  while (io_ok && (len < 0 || written < (size_t)len)) {
    const size_t avail = stream->available();
    if (!avail) {
      // A stalled socket must not spin here forever. The device would sit on
      // "UPDATING - do not unplug" indefinitely with no way to recover short of
      // a power cycle, which on a wall unit is a site visit.
      if (millis() - last_data_ms > 20000) {
        log_e("OTA: stalled after %u bytes", (unsigned)written);
        io_ok = false;
        break;
      }
      if (!http.connected() && len < 0) break;  // clean end of a chunked body
      delay(1);
      continue;
    }
    last_data_ms = millis();
    const int n = stream->readBytes(buf, avail > sizeof(buf) ? sizeof(buf) : avail);
    if (n <= 0) continue;
    mbedtls_sha256_update(&sha_ctx, buf, n);
    if (Update.write(buf, n) != (size_t)n) {
      log_e("OTA: flash write failed at %u: %s", (unsigned)written, Update.errorString());
      io_ok = false;
      break;
    }
    written += n;
  }
  http.end();

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha_ctx, digest);
  mbedtls_sha256_free(&sha_ctx);

  char got[65];
  for (uint8_t i = 0; i < 32; i++) snprintf(got + i * 2, 3, "%02x", digest[i]);

  if (!io_ok || (len > 0 && written != (size_t)len)) {
    log_e("OTA: incomplete download (%u of %d bytes)", (unsigned)written, len);
    Update.abort();
    show_local("UPDATE", "FAILED", "download cut short", COL_RED);
    return;
  }

  // THE CHECK. A mismatch means the bytes are not the build that was published,
  // whether from truncation, a bad upload or the wrong file at that URL. Abort
  // discards the staged image; the unit carries on running what it has.
  if (!expected_sha.equalsIgnoreCase(got)) {
    log_e("OTA: sha256 MISMATCH - refusing. want %s got %s",
          expected_sha.c_str(), got);
    Update.abort();
    show_local("UPDATE", "REJECTED", "checksum mismatch", COL_RED);
    return;
  }

  if (!Update.end(true)) {
    log_e("OTA: Update.end failed: %s", Update.errorString());
    show_local("UPDATE", "FAILED", Update.errorString(), COL_RED);
    return;
  }

  log_i("OTA: verified %s and staged %s - restarting", got, version.c_str());
  ESP.restart();
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
  // Landscape, always. Which rotation gets there depends on the panel's native
  // orientation, so this reads it from the board's own DISPLAY_WIDTH/HEIGHT
  // rather than assuming portrait:
  //   - CYD (240x320, H>W): natively portrait, needs a 90 degree software
  //     rotation to reach landscape. Fine here BECAUSE the layout is
  //     alignment-based rather than absolutely positioned.
  //   - esp32-4827S043C (480x272, W>H): natively landscape already. Rotating
  //     it would turn a correct screen sideways.
  //
  // Do not "fix" this back to an unconditional 90 degree rotation on the
  // evidence of a photo of the CYD taken portrait: the text runs vertically in
  // that orientation and looks broken, but it is rendering correctly. Rotation
  // was pulled once on exactly that misreading and it turned a working screen
  // into a mangled one.
#if DISPLAY_HEIGHT > DISPLAY_WIDTH
  lv_display_set_rotation(lv_disp_get_default(), LV_DISPLAY_ROTATION_90);
#else
  lv_display_set_rotation(lv_disp_get_default(), LV_DISPLAY_ROTATION_0);
#endif
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

  if (now - last_poll_ms >= poll_interval_ms || last_poll_ms == 0) {
    last_poll_ms = now;
    if (poll_status()) {
      last_ok_ms = now;
      ever_connected = true;
    }
  }

  // Rotate. The device only counts here — which screens exist, what order they
  // are in, how long each sits, and whether to rotate at all are all decided by
  // the server. `hold` is how a red screen stops the carousel: parking on the
  // thing that needs attention is the entire reason page navigation was
  // rejected, so it must not become "rotate anyway, but slower".
  if (screen_count > 1 && !group_hold && now - last_rotate_ms >= dwell_ms) {
    last_rotate_ms = now;
    screen_idx = (screen_idx + 1) % screen_count;
    render_screen(screens[screen_idx]);
  }

  // THE DEVICE-SIDE RULE. Past the window we stop rendering whatever the last
  // successful poll returned, because we no longer know if it is true. This must
  // never be relaxed into "keep showing the last good state".
  if (now - last_ok_ms > OFFLINE_AFTER_MS) {
    // Stop the carousel. Rotating through screens we can no longer vouch for is
    // the stale-green failure with extra steps — it looks MORE alive than a
    // frozen screen, not less.
    screen_count = 0;

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
