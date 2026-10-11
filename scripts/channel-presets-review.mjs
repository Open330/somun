/** Browser verification with isolated SQLite and fixture generation; no production writes. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright-core';
import pino from 'pino';
import { openDb, schema } from '../dist/server/src/infra/db/index.js';
import { createApp } from '../dist/server/src/server/app.js';
import { loadConfig } from '../dist/server/src/server/config.js';
import { getSettings } from '../dist/server/src/app/settings.js';
import { buildPrompt, applyResult } from '../dist/server/src/app/pipeline.js';
const output = resolve(process.env.CHANNEL_REVIEW_OUT || '/tmp/somun-channel-presets-review');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const reports = [];
try {
 for (const width of [1440, 390]) {
  const db = openDb(':memory:');
  const ctx = { db, log: pino({ level: 'silent' }), env: {}, bus: new EventEmitter(), usage: { record() {} } };
  const app = createApp(ctx, loadConfig({ SOMUN_ALLOW_ANONYMOUS: 'true', WEB_DIST: './dist/web' }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening) await new Promise((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
   console.log('settings',width); await page.goto(`${base}/settings?tab=channels`);
   await page.getByRole('button', { name: '커스텀 채널 추가' }).click();
   await page.getByLabel('시작 프리셋').selectOption('show_hn');
   await page.getByLabel('채널 이름', { exact: true }).fill('개발 뉴스레터');
   await page.getByLabel('대상 독자').fill('프로젝트를 운영하는 개발자');
   await page.getByLabel('채널 목적').fill('이번 주 확인된 변경과 다음 작업 공유');
   await page.getByLabel('추가 작성 규칙').fill('근거가 있는 변경을 짧은 문단으로 작성합니다.');
   await page.getByLabel('링크 위치').selectOption('body');
   console.log('save',width); await page.getByRole('button', { name: '프리셋 저장', exact: true }).click();
   await page.getByLabel('채널 이름', { exact: true }).waitFor({ state: 'detached' });
   await page.reload();
   await page.getByText('개발 뉴스레터', { exact: true }).first().waitFor();
   const settings = getSettings(ctx, 'local');
   const preset = settings.customChannels[0];
   assert.equal(preset.identity.audience, '프로젝트를 운영하는 개발자');
   assert.equal(settings.channelLangs[preset.id][0], 'en');
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   await page.screenshot({ path: resolve(output, `channels-${width}.png`), fullPage: true });
   const now = Date.now();
   const candidateId = Number(db.insert(schema.candidates).values({ ownerId: 'local', repo: 'fixture/tool', title: 'Tool watch mode', type: 'release', key: 'fixture', evidence: { repo: 'fixture/tool', repoUrl: 'https://github.com/fixture/tool', highlights: ['Supports watch mode.'], highlightsAt: now }, createdAt: now, updatedAt: now }).run().lastInsertRowid);
   assert.match(buildPrompt(ctx, 'local', 'draft', candidateId, preset.id, 'en').user, /프로젝트를 운영하는 개발자/);
   applyResult(ctx, 'local', { kind: 'draft', candidateId, channel: preset.id, lang: 'en', model: 'fixture', result: { title: 'Watch mode', body: 'Tool supports watch mode. https://github.com/fixture/tool' } });
   await page.goto(`${base}/c/${candidateId}`);
   await page.getByText('Watch mode', { exact: false }).first().waitFor();
   await page.getByRole('button', { name: '초안 복사', exact: true }).click();
   await page.waitForTimeout(150);
   assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Watch mode\n\nTool supports watch mode. https://github.com/fixture/tool');
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   await page.screenshot({ path: resolve(output, `custom-draft-${width}.png`), fullPage: true });
   assert.deepEqual(errors, []);
   reports.push({ width, savedAndReloaded: true, customDraft: true, clipboard: true, horizontalOverflow: false, pageErrors: errors });
   console.log(`PASS ${width}: create/reload/generate/copy`);
  } catch(error) { console.error(error); await page.screenshot({path:resolve(output,`failure-${width}.png`)}); throw error; } finally { await context.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); db.$client.close(); }
 }
} finally { await browser.close(); writeFileSync(resolve(output, 'report.json'), JSON.stringify(reports, null, 2)); }
