/** Role-based browser review. Synthetic data, real local API/SQLite, fixture worker responses.
 * Run after npm run build: node scripts/persona-review.mjs [minseo|alex|jisu]
 * No production data, external publishing, OAuth, or paid model calls.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright-core';
import pino from 'pino';
import { openDb, schema } from '../dist/server/src/infra/db/index.js';
import { createApp } from '../dist/server/src/server/app.js';
import { loadConfig } from '../dist/server/src/server/config.js';
import { updateSettings } from '../dist/server/src/app/settings.js';
import { pendingJobs, claimJob, completeJob } from '../dist/server/src/app/jobs.js';

const audit = process.argv[2]?.startsWith('audit_');
const output = resolve(process.env.PERSONA_OUT || `docs/ux/personas/2026-09-27/${audit ? 'followup/verified' : 'after'}`);
mkdirSync(output, { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return Promise.reject(new Error('Persona review blocks external server requests'));
  return originalFetch(input, init);
};
const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
  res.end(`<rss><channel><title>FormLeaf development journal</title><item><title>FormLeaf 첫 소개</title><link>https://example.test/formleaf</link><pubDate>${new Date().toUTCString()}</pubDate><description>FormLeaf는 개인 개발자가 피드백 양식을 만들고 응답을 CSV로 내려받는 서비스입니다. 로그인 없이 양식에 응답할 수 있습니다. 파일 첨부는 지원하지 않습니다.</description></item></channel></rss>`);
});
await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
const feed = `http://127.0.0.1:${fixture.address().port}/feed.xml`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn) {
  for (let i = 0; i < 160; i++) { if (await fn()) return; await pause(50); }
  throw new Error('Timed out waiting for local application state');
}

async function run(name, mobile, scenario) {
  const db = openDb(':memory:');
  const ctx = { db, log: pino({ level: 'silent' }), env: {}, bus: new EventEmitter(), usage: { record() {} } };
  const app = createApp(ctx, loadConfig({ SOMUN_ALLOW_ANONYMOUS: 'true', WEB_DIST: './dist/web' }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening) await new Promise((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const report = { persona: name, commit, viewport: mobile ? '390x844' : '1440x1000', environment: 'anonymous local app; isolated SQLite; synthetic feed; fixture worker responses', steps: [], findings: [], pageErrors: [], dialogs: [], requests: [], screenshots: [] };
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('dialog', async (dialog) => { report.dialogs.push(dialog.message()); await dialog.dismiss(); });
  page.on('response', (response) => { if (response.url().includes('/api/') && response.status() >= 400) report.requests.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  async function snap(label) {
    const file = `${name}-${label}.png`;
    await page.screenshot({ path: resolve(output, file), fullPage: false, animations: 'disabled' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    report.screenshots.push({ file, overflow });
  }
  async function step(label, fn) {
    const start = Date.now();
    try { await fn(); report.steps.push({ label, status: 'pass', automationMs: Date.now() - start }); console.log(`${name}: PASS ${label}`); }
    catch (error) { report.steps.push({ label, status: 'fail', error: error.message, automationMs: Date.now() - start }); throw error; }
  }
  function seed() {
    updateSettings(ctx, 'local', { channelLangs: { x: ['en', 'ko'], linkedin: ['ko'] }, llm: { provider: 'local-agent' }, trackLinks: false });
    const now = Date.now();
    return Number(db.insert(schema.candidates).values({ ownerId: 'local', repo: 'persona/formleaf', title: 'FormLeaf CSV export', type: 'release', key: name, evidence: { repo: 'persona/formleaf', repoUrl: 'https://example.test/formleaf', description: 'A feedback form service for independent developers.', highlights: ['Exports responses as CSV.'], highlightsAt: now, limitations: ['File attachments are not supported.'] }, status: 'judged', createdAt: now, updatedAt: now }).run().lastInsertRowid);
  }
  function addDraft(cid, { version = 1, lang = 'en', channel = 'x', purpose = 'introduction' } = {}) {
    return Number(db.insert(schema.drafts).values({ ownerId: 'local', candidateId: cid, channel, lang, purpose, version, body: lang === 'ko' ? 'FormLeaf는 피드백 양식을 만들고 응답을 CSV로 내려받는 서비스입니다. https://example.test/formleaf' : 'FormLeaf collects feedback through forms and exports responses as CSV. https://example.test/formleaf', status: 'proposed', lint: [], model: 'fixture/persona-review', createdAt: Date.now(), updatedAt: Date.now() }).run().lastInsertRowid);
  }
  async function worker() {
    await until(() => pendingJobs(ctx, 'local').some((j) => j.kind === 'draft'));
    for (const job of pendingJobs(ctx, 'local').filter((j) => j.kind === 'draft')) {
      const claim = claimJob(ctx, 'local', job.id, 'persona-fixture');
      const body = job.lang === 'ko' ? 'FormLeaf는 개인 개발자가 피드백 양식을 만들고 응답을 CSV로 내려받는 서비스입니다. 파일 첨부는 지원하지 않습니다. https://example.test/formleaf' : 'FormLeaf collects feedback through forms and exports responses as CSV. File attachments are not supported. https://example.test/formleaf';
      completeJob(ctx, 'local', job.id, { claimToken: claim.claimToken, resultJson: JSON.stringify({ title: '', body }), model: 'fixture-not-quality-evaluation' });
    }
  }
  async function publish(slug) {
    await page.getByRole('textbox', { name: /게시글 링크/ }).fill(`https://example.test/${slug}`);
    await page.getByRole('button', { name: '게시 링크 저장', exact: true }).click();
    await page.getByRole('heading', { name: '게시 기록을 남겼어요' }).waitFor();
  }
  try { await scenario({ ctx, db, page, base, report, snap, step, seed, addDraft, worker, publish }); }
  catch (error) { process.exitCode = 1; report.executionError = error.message; report.lastVisibleText = (await page.locator('body').innerText()).slice(0, 9000); await snap('failure').catch(() => undefined); console.log(`${name}: STOP ${error.message}`); }
  finally {
    writeFileSync(resolve(output, `${name}.json`), JSON.stringify(report, null, 2) + '\n');
    await context.close();
    server.closeAllConnections(); await new Promise((done) => server.close(done)); db.$client.close();
  }
}

const scenarios = {
  audit_link: async ({ db, page, base, report, snap, step, seed, addDraft, publish }) => {
    const cid = seed(); addDraft(cid);
    await page.goto(`${base}/c/${cid}`);
    await step('게시 직후 링크 수정 결과와 저장 데이터 비교', async () => {
      await publish('original-post');
      await page.getByRole('button', { name: '링크 고치기', exact: true }).click();
      await page.getByRole('textbox', { name: '게시글 링크', exact: true }).fill('https://example.test/corrected-post');
      const refreshed = page.waitForResponse((r) => r.url() === `${base}/api/candidates/${cid}` && r.request().method() === 'GET');
      await page.getByRole('button', { name: '링크 저장', exact: true }).click();
      await refreshed;
      assert.equal(db.select().from(schema.publications).get().url, 'https://example.test/corrected-post');
      await page.getByRole('button', { name: '링크 고치기', exact: true }).waitFor();
      const stale = await page.getByRole('link', { name: 'https://example.test/original-post', exact: true }).count();
      assert.equal(stale, 0);
      await page.getByRole('link', { name: 'https://example.test/corrected-post', exact: true }).waitFor();
      report.findings.push({ kind: 'verified-publication-link', observed: 'DB와 게시 완료 카드 모두 corrected-post로 갱신된다.' });
      await snap('corrected-link');
      await page.reload();
      await page.getByRole('link', { name: 'https://example.test/corrected-post', exact: true }).waitFor();
    });
  },
  audit_edit: async ({ db, ctx, page, base, report, snap, step, seed, addDraft, worker }) => {
    const cid = seed(); const firstId = addDraft(cid);
    await page.goto(`${base}/c/${cid}`);
    await step('편집 중 새 버전 도착 시 저장 대상 비교', async () => {
      await page.getByRole('button', { name: '다시 쓰기', exact: true }).click();
      await page.getByRole('button', { name: '같은 문체로 다시 쓰기', exact: true }).click();
      await until(() => pendingJobs(ctx, 'local').length > 0);
      await page.getByRole('button', { name: '수정', exact: true }).click();
      const edit = 'My edit of version one. https://example.test/formleaf';
      await page.getByRole('textbox', { name: '초안 본문', exact: true }).fill(edit);
      const refreshed = page.waitForResponse((r) => r.url() === `${base}/api/candidates/${cid}` && r.request().method() === 'GET');
      await worker(); await refreshed;
      const second = db.select().from(schema.drafts).all().find((d) => d.id !== firstId);
      assert(second);
      await page.getByRole('button', { name: '변경 저장', exact: true }).click();
      await until(() => db.select().from(schema.drafts).all().some((d) => d.body === edit));
      const rows = db.select().from(schema.drafts).all();
      assert.equal(rows.find((d) => d.id === firstId).body, edit);
      assert.equal(rows.find((d) => d.id === second.id).body, second.body);
      report.findings.push({ kind: 'verified-edit-target', observed: 'v1 편집 중 v2 생성 완료 후 저장해도 수정은 v1에만 반영되고 v2는 보존된다.', firstId, preservedId: second.id });
      await page.getByRole('textbox', { name: '초안 본문', exact: true }).waitFor({ state: 'hidden' });
      await page.getByText(edit, { exact: true }).waitFor();
      assert.equal(await page.getByTitle('버전', { exact: true }).inputValue(), String(firstId));
      await snap('preserved-version');
    });
  },
  audit_published: async ({ db, page, base, report, snap, step, seed, addDraft }) => {
    const cid = seed(); const did = addDraft(cid); addDraft(cid, { lang: 'ko' }); addDraft(cid, { version: 2 });
    db.insert(schema.publications).values({ ownerId: 'local', candidateId: cid, draftId: did, channel: 'x', lang: 'en', url: 'https://example.test/english-post', publishedAt: Date.now() }).run();
    await step('발행 기록에서 해당 게시 초안으로 돌아가기', async () => {
      await page.goto(`${base}/published`);
      await page.getByRole('link', { name: 'FormLeaf CSV export', exact: true }).click();
      await page.getByRole('heading', { name: '게시 기록을 남겼어요' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'EN', exact: true }).getAttribute('aria-pressed'), 'true');
      report.findings.push({ kind: 'verified-publication-navigation', observed: '영어 발행 기록에서 해당 영어 초안의 게시 기록이 열린다.' });
      await page.getByRole('button', { name: '초안 다시 보기', exact: true }).click();
      assert.equal(await page.getByTitle('버전', { exact: true }).inputValue(), String(did));
      await snap('correct-target');
    });
  },
  minseo: async ({ db, page, base, snap, step, worker, publish }) => {
    await step('빈 계정에서 첫 소스 연결 발견', async () => { await page.goto(base); await page.getByRole('link', { name: /첫 소스 연결하기/ }).click(); await page.getByRole('heading', { name: '연결 관리', exact: true }).waitFor(); });
    await step('블로그 연결과 실제 RSS 수집', async () => {
      await page.getByRole('textbox', { name: '블로그 피드 주소' }).fill(feed);
      await page.getByRole('button', { name: '블로그 연결', exact: true }).click();
      await page.getByRole('link', { name: /글감 가져오러 가기/ }).click();
      await page.getByRole('button', { name: /첫 글감 가져오기/ }).click();
      await until(() => db.select().from(schema.candidates).all().length > 0);
      await page.getByRole('link', { name: 'FormLeaf 첫 소개', exact: true }).click();
      await snap('first-candidate');
    });
    await step('생성 전에 모델 설정 안내와 불필요한 작업 방지', async () => {
      await page.getByText('초안을 만들기 전에 모델 설정에서 API 키를 등록하거나 로컬 에이전트를 선택해 주세요.', { exact: true }).waitFor();
      await snap('model-setup');
      await page.getByRole('button', { name: '서비스 처음 소개하기' }).click();
      await page.getByRole('alert').waitFor();
      assert.equal(db.select().from(schema.llmJobs).all().length, 0);
    });
    await step('모델 설정에서 로컬 워커로 전환', async () => {
      await page.getByRole('link', { name: '모델 설정 확인', exact: true }).click();
      await page.getByRole('button', { name: '로컬 에이전트', exact: true }).click();
      await page.getByRole('button', { name: '저장', exact: true }).click();
      await page.getByText('저장하지 않은 설정 변경이 있습니다.', { exact: true }).waitFor({ state: 'hidden' });
      const cid = db.select().from(schema.candidates).get().id;
      await page.goto(`${base}/c/${cid}`);
      await page.getByRole('button', { name: '서비스 처음 소개하기', exact: true }).click();
      await page.getByText('로컬 워커 대기', { exact: true }).waitFor();
      await worker();
      await page.getByRole('button', { name: '초안 복사', exact: true }).waitFor();
    });
    await step('소개글 수정과 복사', async () => {
      await page.getByRole('button', { name: '수정', exact: true }).click();
      await page.getByRole('textbox', { name: '초안 본문' }).fill('FormLeaf는 피드백 양식을 만들고 응답을 CSV로 내려받는 서비스입니다. https://example.test/formleaf');
      await page.getByRole('button', { name: '저장하고 복사' }).click();
      await until(() => db.select().from(schema.drafts).get()?.status === 'copied');
      assert((await page.evaluate(() => navigator.clipboard.readText())).includes('CSV'));
    });
    await step('게시 링크 기록과 새로고침 유지', async () => { await publish('minseo-intro'); await page.reload(); await page.getByRole('heading', { name: '게시 기록을 남겼어요' }).waitFor(); await snap('published'); assert.equal(db.select().from(schema.publications).all().length, 1); });
  },
  alex: async ({ db, page, base, report, snap, step, seed, addDraft, worker, publish }) => {
    const cid = seed(), did = addDraft(cid);
    db.insert(schema.publications).values({ ownerId: 'local', candidateId: cid, draftId: did, channel: 'x', lang: 'en', url: 'https://example.test/alex-old', publishedAt: Date.now() }).run();
    db.$client.prepare("UPDATE candidates SET status = 'published' WHERE id = ?").run(cid);
    await step('게시 완료 화면에서 한국어로 전환', async () => { await page.goto(`${base}/c/${cid}`); await page.getByRole('heading', { name: '게시 기록을 남겼어요' }).waitFor(); await page.getByRole('button', { name: 'KO', exact: true }).click(); await page.getByRole('button', { name: '서비스 처음 소개하기' }).waitFor(); });
    await step('다른 언어 소개글 생성과 검토 목록 복귀', async () => {
      await page.getByRole('button', { name: '서비스 처음 소개하기' }).click(); await worker();
      await page.getByRole('button', { name: '초안 복사', exact: true }).waitFor();
      await page.goto(base); await page.getByRole('link', { name: 'FormLeaf CSV export', exact: true }).waitFor();
      await until(async () => await page.locator('nav a[href="/"] .count').textContent() === '1');
      const navCount = await page.locator('nav a[href="/"] .count').count();
      assert.equal(navCount, 1);
      report.findings.push({ kind: 'navigation-count', observed: `미게시 초안은 검토 목록에 있지만 탐색 메뉴의 초안 개수 표시 요소는 ${navCount}개다.` });
      await snap('review-inbox');
      await page.getByRole('link', { name: '초안 검토', exact: true }).click();
      await page.getByRole('button', { name: 'EN', exact: true }).waitFor();
      const opensPublished = await page.getByRole('heading', { name: '게시 기록을 남겼어요' }).isVisible();
      report.findings.push({ kind: 'review-entry', observed: opensPublished ? '검토할 초안 링크로 들어왔지만 미게시 한국어 초안 대신 게시된 영어 화면이 먼저 열린다. KO 전환이 필요하다.' : '검토할 초안으로 진입했다.' });
      await snap('review-entry');
      assert.equal(opensPublished, false, 'Review must open the unpublished Korean draft');
      await page.getByRole('button', { name: '초안 복사', exact: true }).waitFor();
    });
    await step('한국어 게시 후 같은 언어 새 버전 생성', async () => {
      await publish('alex-ko-v1'); await page.getByRole('button', { name: '초안 다시 보기' }).click();
      await page.getByRole('button', { name: '다시 쓰기', exact: true }).click();
      await page.getByRole('button', { name: '같은 문체로 다시 쓰기' }).click(); await worker();
      await page.getByRole('button', { name: '게시 링크 저장', exact: true }).waitFor();
      assert.equal(await page.getByText('이미 게시한 초안입니다.', { exact: true }).count(), 0);
      await snap('new-version'); await publish('alex-ko-v2');
      assert.equal(db.select().from(schema.publications).all().length, 3);
      assert(db.select().from(schema.drafts).all().filter((d) => d.lang === 'ko').every((d) => d.purpose === 'introduction'));
    });
    await step('LinkedIn 추가 채널 생성', async () => { await page.getByRole('button', { name: /LinkedIn/ }).click(); await page.getByRole('button', { name: '서비스 처음 소개하기' }).click(); await worker(); await page.getByRole('button', { name: '게시 링크 저장', exact: true }).waitFor(); await snap('linkedin'); });
  },
  jisu: async ({ db, page, base, report, snap, step, seed, addDraft, publish }) => {
    const cid = seed(); addDraft(cid, { lang: 'ko' });
    const edited = '모바일에서 수정한 소개입니다. FormLeaf는 피드백 양식과 CSV 내보내기를 제공합니다. https://example.test/formleaf';
    await step('설정 조회 실패에도 초안 확인과 설정 재시도', async () => {
      await page.route('**/api/settings', (route) => route.abort('connectionfailed'));
      await page.goto(`${base}/c/${cid}`);
      await page.getByText('설정을 불러오지 못했습니다. 기존 초안은 계속 확인할 수 있습니다.', { exact: true }).waitFor();
      await page.getByRole('button', { name: '초안 복사', exact: true }).waitFor();
      await snap('settings-error');
      await page.unroute('**/api/settings');
      await page.getByRole('button', { name: '설정 다시 불러오기', exact: true }).click();
      await until(async () => await page.getByRole('button', { name: '설정 다시 불러오기', exact: true }).count() === 0);
    });
    await step('390px 모바일에서 수정 시작', async () => { await page.goto(`${base}/c/${cid}`); await page.getByRole('button', { name: 'KO', exact: true }).click(); await page.getByRole('button', { name: '수정', exact: true }).click(); await page.getByRole('textbox', { name: '초안 본문' }).fill(edited); await snap('editing'); });
    await step('저장 실패에도 입력 보존', async () => {
      await page.route('**/api/drafts/*/edit', (route) => route.abort('connectionfailed'), { times: 1 });
      await page.getByRole('button', { name: '변경 저장' }).click();
      await page.getByRole('alert').filter({ hasText: '저장하지 못했습니다.' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: '초안 본문' }).inputValue(), edited);
      await page.getByRole('alert').filter({ hasText: '저장하지 못했습니다.' }).scrollIntoViewIfNeeded();
      await snap('save-error');
    });
    await step('저장 전 언어 전환 취소 시 입력 보존', async () => {
      await page.getByRole('button', { name: 'EN', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: '초안 본문' }).inputValue(), edited);
      assert(report.dialogs.some((m) => m.includes('저장하지 않은')));
    });
    await step('오류 해소 후 재저장과 게시 기록', async () => {
      await page.getByRole('button', { name: '변경 저장' }).click();
      await until(() => db.select().from(schema.drafts).get().body === edited);
      await publish('jisu-mobile'); await snap('published');
      await page.getByRole('button', { name: 'EN', exact: true }).click();
      await page.getByRole('button', { name: '초안 쓰기', exact: true }).waitFor();
      await snap('other-language');
    });
  },
};
try { for (const [name, scenario] of Object.entries(scenarios)) if ((!process.argv[2] && !name.startsWith('audit_')) || process.argv[2] === name) await run(name, name === 'jisu', scenario); }
finally { await browser.close(); await new Promise((done) => fixture.close(done)); globalThis.fetch = originalFetch; }
