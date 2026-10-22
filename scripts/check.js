'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = ['index.js', ...fs.readdirSync(path.join(root, 'lib')).filter(n => n.endsWith('.js')).map(n => `lib/${n}`)];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
for (const file of ['package.json', 'config.schema.json', 'config.example.json']) JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pkg = require(path.join(root, 'package.json'));
const schema = require(path.join(root, 'config.schema.json'));
if (!pkg.keywords.includes('homebridge-plugin') || schema.pluginAlias !== 'TesyNative' || schema.pluginType !== 'platform') throw Error('Invalid Homebridge plugin metadata.');
console.log('JavaScript syntax, JSON and plugin metadata are valid.');
