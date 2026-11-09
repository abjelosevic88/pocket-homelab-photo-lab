// README screenshots and a browser smoke test, against a demo instance (DEMO_DATA=true paints nine landscapes, some edited):
//
//   env -i PATH=$PATH DATA_DIR=/tmp/plab-demo DEMO_DATA=true ADMIN_EMAIL=demo@example.com ADMIN_PASSWORD=demodemo1 ADMIN_NAME=Maya PORT=18362 ./pocket-photolab
//   CDP=http://127.0.0.1:9362 BASE=http://127.0.0.1:18362 node scripts/screenshots.mjs   # any Chrome with remote debugging
//   SHOTS=0 … node scripts/screenshots.mjs                                                # checks only
// playwright-core comes from web/node_modules, or set PW_FROM to a package.json next to an install of it.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(process.env.PW_FROM || new URL('../web/package.json', import.meta.url))
let pw
try { pw = require('playwright') } catch { pw = require('playwright-core') }
const { chromium } = pw
const base = process.env.BASE || 'http://127.0.0.1:18362'
const shots = process.env.SHOTS !== '0'
const dir = process.env.OUT || new URL('../docs/screenshots/', import.meta.url).pathname
const only = process.env.ONLY || ''
const browser = process.env.CDP ? await chromium.connectOverCDP(process.env.CDP) : await chromium.launch()
const errors = []

async function session({ phone = false, dark = false } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: phone ? 3 : 2, isMobile: phone, hasTouch: phone, colorScheme: dark ? 'dark' : 'light',
    userAgent: phone ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' : undefined,
  })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(`pageerror: ${e}`))
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|pocket-ask/.test(m.text())) errors.push(m.text()) })
  await page.goto(base + '/login')
  const res = await page.evaluate(() => fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'demodemo1' }) }).then(r => r.status))
  assert.equal(res, 200, 'demo sign-in')
  return { ctx, page }
}
async function go(page, path, wait = 1500) {
  await page.goto(base + path, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(wait)
}
async function shot(page, name) { if (shots && (!only || name.includes(only))) await page.screenshot({ path: dir + name + '.png' }) }
async function ids(page) { return page.evaluate(() => fetch('/api/v1/images?sort=added&limit=50').then(r => r.json()).then(j => Object.fromEntries(j.items.map(i => [i.title, i.id])))) }

// ---- desktop ----
{
  const { ctx, page } = await session()
  const id = await ids(page)
  await go(page, '/')
  assert.ok((await page.content()).includes('Sunset over the lake'), 'the library lists the demo pictures')
  await shot(page, 'desktop-library')
  await go(page, `/edit/${id['Sunset over the lake']}?tool=adjust`, 2500)
  assert.ok(await page.locator('.stage-canvas canvas').count() > 0, 'the editor draws the picture')
  await shot(page, 'desktop-editor')
  await go(page, `/edit/${id['Beach, too dark']}?tool=crop`, 2500)
  await shot(page, 'desktop-crop')
  await go(page, `/edit/${id['Morning in the hills']}?tool=looks`, 3000)
  await shot(page, 'desktop-looks-panel')
  await go(page, `/edit/${id['Sunset over the lake']}?tool=text`, 2500)
  await page.locator('.ov-box.t-text').first().click()
  await page.waitForTimeout(600)
  await shot(page, 'desktop-text')
  await go(page, `/edit/${id['The city at night']}?tool=color`, 2500)
  await shot(page, 'desktop-color')
  await go(page, '/looks', 3000)
  await shot(page, 'desktop-looks')
  await go(page, `/collage?ids=${[id['Northern lights'], id['Morning in the hills'], id['Dunes at noon'], id['Harbour']].join(',')}`, 3000)
  await page.locator('.chip', { hasText: 'One big, left' }).click()
  await page.waitForTimeout(800)
  await shot(page, 'desktop-collage')
  await go(page, '/history', 1200)
  await shot(page, 'desktop-history')
  await go(page, '/settings/apps', 1200)
  await shot(page, 'desktop-settings')
  await ctx.close()
}

// ---- phone ----
{
  const { ctx, page } = await session({ phone: true })
  const id = await ids(page)
  await go(page, '/')
  await shot(page, 'phone-library')
  await go(page, `/edit/${id['Fog in the pines']}?tool=adjust`, 2500)
  await shot(page, 'phone-editor')
  await go(page, `/edit/${id['Sunset over the lake']}?tool=crop`, 2500)
  await shot(page, 'phone-crop')
  await ctx.close()
}

// ---- dark ----
{
  const { ctx, page } = await session({ dark: true })
  const id = await ids(page)
  await go(page, `/edit/${id['Northern lights']}?tool=effects`, 2500)
  await shot(page, 'desktop-dark')
  await ctx.close()
}

await browser.close()
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('ok')
