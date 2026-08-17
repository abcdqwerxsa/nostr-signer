const puppeteer = require('puppeteer');

(async () => {
  console.log('Launching browser to debug Coracle login...');
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=http://127.0.0.1:7897'
    ]
  });

  const page = await browser.newPage();
  
  // 捕获 Console 打印
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  
  // 捕获 Page Errors
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  // 监听 WebSocket 连线与消息
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  client.on('Network.webSocketCreated', params => {
    console.log('WS CREATED:', params.url);
  });
  client.on('Network.webSocketFrameSent', params => {
    console.log('WS SENT:', params.response.payloadData.slice(0, 200));
  });
  client.on('Network.webSocketFrameReceived', params => {
    console.log('WS RECV:', params.response.payloadData.slice(0, 200));
  });

  console.log('Navigating to Coracle...');
  await page.goto('https://coracle.social/login', { waitUntil: 'networkidle2' });

  console.log('Waiting for login options...');
  await page.waitForTimeout(3000);

  // 查找并点击 Nostr Connect / Bunker 登录
  const bunkerLink = "bunker://87b51f8642c9a83b71c09a0110a4755f4ab8db3249301666b70f71022eacbc1d?relay=wss://nostr.agh.ccwu.cc";

  console.log('Filling bunker URI...');
  // 页面寻找 input
  const inputs = await page.$$('input');
  console.log('Inputs count:', inputs.length);
  for (const input of inputs) {
    const placeholder = await page.evaluate(el => el.placeholder, input);
    console.log('Input placeholder:', placeholder);
  }

  await browser.close();
})();
