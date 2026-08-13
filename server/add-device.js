#!/usr/bin/env node
// Register a screen: node add-device.js "Desk - CI" ci [stale_after_s]
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [label, agent, stale] = process.argv.slice(2);
if (!label || !agent) {
  console.error('usage: node add-device.js "<label>" <agent> [stale_after_s]');
  process.exit(2);
}
const file = path.join(__dirname, 'devices.json');
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { devices: [] };
cfg.devices = cfg.devices || [];
const key = crypto.randomBytes(16).toString('hex');
cfg.devices.push({
  key, title: agent.toUpperCase(), agent, stale_after_s: Number(stale) || 120,
  lines: [['Status', 'status'], ['Last run', 'last_run']],
});
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(`\n  ${label} -> agent "${agent}"`);
console.log(`  key:     ${key}`);
console.log(`  preview: http://localhost:${process.env.PORT || 8080}/status/${key}/screen\n`);
console.log('  Enter that key in the device setup portal. Edit devices.json to change the lines.');
