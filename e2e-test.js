const { chromium } = require(require.resolve('playwright', { paths: ['/home/claude', process.cwd()] }));
const BASE = 'http://localhost:' + (process.env.PORT || 3918);
const URL = BASE + '/app';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const mk = async (name) => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(String(e)));
    page.on('dialog', (d) => { page.errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.goto(URL);
    await page.fill('#name', name);
    await page.click('text=শুরু করুন');
    await page.waitForSelector('#home.on', { timeout: 5000 });
    return page;
  };

  // সাইটের পেজ ও কনফিগ
  const probe = await browser.newPage();
  const land = await probe.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  check('ল্যান্ডিং পেজ খোলে', land.status() === 200 && (await probe.textContent('h1')).includes('ভিডিও কল'));
  await probe.click('text=এখনই কল করুন');
  await probe.waitForSelector('#login.on', { timeout: 4000 });
  check('ল্যান্ডিং থেকে অ্যাপে যাওয়া যায়', probe.url().endsWith('/app'));
  const cfg = await (await probe.request.get(BASE + '/config')).json();
  check('/config-এ ICE সার্ভার আছে', Array.isArray(cfg.iceServers) && cfg.iceServers.length >= 1);
  const man = await probe.request.get(BASE + '/manifest.webmanifest');
  check('PWA manifest ও আইকন আছে', man.ok() && (await probe.request.get(BASE + '/icon.svg')).ok());
  const nf = await probe.request.get(BASE + '/nope');
  check('অজানা পাথে 404', nf.status() === 404);
  await probe.close();

  const A = await mk('alice');
  const B = await mk('bob');
  await A.waitForFunction(() => document.querySelectorAll('#users .user').length === 1);
  await B.waitForFunction(() => document.querySelectorAll('#users .user').length === 1);
  check('দুজন ইউজার একে অপরকে দেখছে', true);

  // নাম ডুপ্লিকেট
  const ctx3 = await browser.newContext();
  const C = await ctx3.newPage();
  await C.goto(URL); await C.fill('#name', 'alice'); await C.click('text=শুরু করুন');
  await C.waitForFunction(() => document.querySelector('#err').textContent.length > 0, null, { timeout: 4000 });
  check('একই নাম দ্বিতীয়বার নেওয়া যায় না', true);
  await ctx3.close();

  // ভিডিও কল: alice -> bob
  await A.click('#users .user .ib[title="ভিডিও কল"]');
  await B.waitForSelector('#incoming.on', { timeout: 5000 });
  check('bob-এর কাছে ইনকামিং কল স্ক্রিন এসেছে', (await B.textContent('#itype')).includes('ভিডিও'));
  await B.click('#incoming .acc');
  await A.waitForFunction(() => /^\d\d:\d\d$/.test(document.querySelector('#cstat').textContent), null, { timeout: 15000 });
  await B.waitForFunction(() => /^\d\d:\d\d$/.test(document.querySelector('#cstat').textContent), null, { timeout: 15000 });
  check('দুই পক্ষেই কল সংযুক্ত (টাইমার চালু)', true);

  await sleep(1500);
  const vinfo = (p) => p.evaluate(() => {
    const v = document.querySelector('#remote');
    const s = v.srcObject;
    return { w: v.videoWidth, h: v.videoHeight, audio: s ? s.getAudioTracks().length : 0, video: s ? s.getVideoTracks().length : 0, t: v.currentTime };
  });
  const va = await vinfo(A), vb = await vinfo(B);
  check('alice রিমোট ভিডিও দেখছে', va.w > 0 && va.video === 1 && va.t > 0, JSON.stringify(va));
  check('bob রিমোট ভিডিও দেখছে', vb.w > 0 && vb.video === 1 && vb.t > 0, JSON.stringify(vb));
  check('উভয় দিকে অডিও ট্র্যাক আছে', va.audio === 1 && vb.audio === 1);

  // মিডিয়া সত্যিই বইছে কিনা (bytes received)
  const stats = (p) => p.evaluate(async () => {
    const r = await pc.getStats(); let a = 0, v = 0;
    r.forEach((s) => { if (s.type === 'inbound-rtp') { if (s.kind === 'audio') a += s.bytesReceived; if (s.kind === 'video') v += s.bytesReceived; } });
    return { a, v };
  });
  const sa = await stats(A), sb = await stats(B);
  check('alice-এ অডিও+ভিডিও প্যাকেট আসছে', sa.a > 0 && sa.v > 0, JSON.stringify(sa));
  check('bob-এ অডিও+ভিডিও প্যাকেট আসছে', sb.a > 0 && sb.v > 0, JSON.stringify(sb));

  // চ্যাট
  await A.click('.ctrls .cb:nth-child(4)'); // 💬
  await A.fill('#ci', 'হ্যালো বব');
  await A.press('#ci', 'Enter');
  await B.waitForFunction(() => document.querySelector('#msgs').textContent.includes('হ্যালো বব'), null, { timeout: 4000 });
  check('কলের ভেতরে চ্যাট মেসেজ পৌঁছেছে', true);

  // মিউট
  await A.click('#bMute');
  check('মিউট কাজ করছে', await A.evaluate(() => !localStream.getAudioTracks()[0].enabled));
  await A.click('#bMute');

  // ক্যামেরা ফ্লিপ (ফেক ডিভাইসে কাজ করে কিনা, এরর ছাড়া)
  await A.click('#bFlip'); await sleep(800);
  check('ক্যামেরা ফ্লিপে ভিডিও ট্র্যাক বহাল', await A.evaluate(() => localStream.getVideoTracks().length === 1 && localStream.getVideoTracks()[0].readyState === 'live'));

  // হ্যাংআপ
  await A.click('.ctrls .cb.end');
  await B.waitForSelector('#home.on', { timeout: 5000 });
  await A.waitForSelector('#home.on', { timeout: 5000 });
  check('alice হ্যাংআপ করলে bob-এর কল শেষ হয়', true);
  check('হ্যাংআপের পর ক্যামেরা বন্ধ (ট্র্যাক stop)', await A.evaluate(() => localStream === null));

  // ভয়েস কল: bob -> alice, alice প্রত্যাখ্যান
  await B.click('#users .user .ib[title="ভয়েস কল"]');
  await A.waitForSelector('#incoming.on', { timeout: 5000 });
  check('ভয়েস কলের ইনকামিং লেবেল', (await A.textContent('#itype')).includes('ভয়েস'));
  await A.click('#incoming .end');
  await B.waitForSelector('#home.on', { timeout: 5000 });
  check('প্রত্যাখ্যান করলে কলার জানতে পারে', (await B.textContent('#st')).includes('প্রত্যাখ্যান'));

  // ভয়েস কল সংযুক্ত
  await B.click('#users .user .ib[title="ভয়েস কল"]');
  await A.waitForSelector('#incoming.on'); await A.click('#incoming .acc');
  await A.waitForFunction(() => /^\d\d:\d\d$/.test(document.querySelector('#cstat').textContent), null, { timeout: 15000 });
  await B.waitForFunction(() => /^\d\d:\d\d$/.test(document.querySelector('#cstat').textContent), null, { timeout: 15000 });
  await sleep(1000);
  const s2 = await stats(A);
  check('ভয়েস কলে অডিও আসছে, ভিডিও নেই', s2.a > 0 && s2.v === 0, JSON.stringify(s2));

  // এক পক্ষ ট্যাব বন্ধ করলে অন্যজনের কল শেষ হয়
  await A.close({ runBeforeUnload: true });
  await B.waitForSelector('#home.on', { timeout: 8000 });
  check('ট্যাব বন্ধ করলে অন্য পক্ষের কল শেষ হয়', true);

  const errs = [...(B.errors || [])];
  check('পেজে কোনো JS এরর নেই', errs.length === 0, errs.join(' | '));

  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} পাস`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
