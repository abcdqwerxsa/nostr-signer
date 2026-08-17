import { chromium } from 'playwright'

const bunkerUri = 'bunker://77141f82272a10de69eeda3a243bfda281f68c283c4e65ec16c2689d2f80702c?relay=wss://nos.lol&relay=wss://relay.primal.net'

async function debugCoracleInBrowser() {
  console.log('Launching headless browser to inspect Coracle login...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:7897']
  })
  const page = await browser.newPage()

  page.on('console', msg => {
    console.log(`[Browser Console ${msg.type()}]`, msg.text())
  })

  page.on('pageerror', err => {
    console.error(`[Browser PageError]`, err.message)
  })

  console.log('Navigating to https://coracle.social/login ...')
  await page.goto('https://coracle.social/login', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('Goto warning:', e.message))

  await page.waitForTimeout(3000)

  // 截图看页面
  await page.screenshot({ path: 'coracle_page1.png' })
  console.log('Saved coracle_page1.png')

  // 寻找输入框或按钮
  const inputs = await page.$$('input')
  console.log(`Found ${inputs.length} input elements`)

  for (let i = 0; i < inputs.length; i++) {
    const placeholder = await inputs[i].getAttribute('placeholder')
    const type = await inputs[i].getAttribute('type')
    console.log(`Input #${i}: type=${type}, placeholder=${placeholder}`)
  }

  await browser.close()
}

debugCoracleInBrowser().catch(console.error)
