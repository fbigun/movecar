addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { KV_TTL: 3600 }

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url);
  }

  if (path === '/api/get-location') {
    return handleGetLocation();
  }

  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request);
  }

  if (path === '/api/check-status') {
    const status = await MOVE_CAR_STATUS.get('notify_status');
    const ownerLocation = await MOVE_CAR_STATUS.get('owner_location');
    return new Response(JSON.stringify({
      status: status || 'waiting',
      ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/owner-confirm') {
    return renderOwnerPage();
  }

  return renderMainPage(url.origin);
}

// WGS-84 转 GCJ-02 (坐标转换，适配国内地图)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`
  };
}

async function handleNotify(request, url) {
  try {
    const body = await request.json();
    const message = body.message || '车旁有人等待';
    const location = body.location || null;
    const delayed = body.delayed || false;
    const confirmUrl = url.origin + '/owner-confirm';

    let notifyText = '🚗 挪车请求';
    let notifyDesp = '';
    if (message) notifyDesp += `留言: ${message}\n`;

    if (location && location.lat && location.lng) {
      const urls = generateMapUrls(location.lat, location.lng);
      notifyDesp += `位置: 对方已在车旁\n确认链接: ${confirmUrl}`;
      await MOVE_CAR_STATUS.put('requester_location', JSON.stringify({
        lat: location.lat,
        lng: location.lng,
        ...urls
      }), { expirationTtl: CONFIG.KV_TTL });
    } else {
      notifyDesp += `注意: 对方未提供位置\n确认链接: ${confirmUrl}`;
    }

    await MOVE_CAR_STATUS.put('notify_status', 'waiting', { expirationTtl: 600 });

    if (delayed) {
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    // 存储所有发送任务
    const pushTasks = [];

    // 1. Bark 推送
    if (typeof BARK_URL !== 'undefined' && BARK_URL) {
      const barkApi = `${BARK_URL}/挪车请求/${encodeURIComponent(notifyDesp)}?group=MoveCar&level=critical&call=1&url=${encodeURIComponent(confirmUrl)}`;
      pushTasks.push(fetch(barkApi));
    }

    // 2. Server酱推送
    if (typeof SERVER_CHAN_KEY !== 'undefined' && SERVER_CHAN_KEY) {
      const sctUrl = `https://sctapi.ftqq.com/${SERVER_CHAN_KEY}.send?title=${encodeURIComponent(notifyText)}&desp=${encodeURIComponent(notifyDesp)}`;
      pushTasks.push(fetch(sctUrl));
    }

    // 3. PushPlus推送
    if (typeof PUSH_PLUS_TOKEN !== 'undefined' && PUSH_PLUS_TOKEN) {
      pushTasks.push(fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: PUSH_PLUS_TOKEN,
          title: notifyText,
          content: notifyDesp.replace(/\n/g, '<br>'),
          template: 'html'
        })
      }));
    }

    // 并发执行所有推送
    await Promise.allSettled(pushTasks);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleGetLocation() {
  const data = await MOVE_CAR_STATUS.get('requester_location');
  if (data) return new Response(data, { headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ error: 'No location' }), { status: 404 });
}

async function handleOwnerConfirmAction(request) {
  try {
    const body = await request.json();
    const ownerLocation = body.location || null;
    if (ownerLocation) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
      await MOVE_CAR_STATUS.put('owner_location', JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...urls,
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL });
    }
    await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: 600 });
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: 600 });
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }
}

function renderMainPage(origin) {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>通知车主挪车</title><style>:root{--sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px)}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(160deg,#0093E9 0%,#80D0C7 100%);min-height:100vh;padding:20px;padding-top:calc(20px + var(--sat));display:flex;justify-content:center}.container{width:100%;max-width:500px;display:flex;flex-direction:column;gap:15px}.card{background:rgba(255,255,255,0.95);border-radius:24px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,0.1)}.header{text-align:center}.icon-wrap{width:80px;height:80px;background:linear-gradient(135deg,#0093E9 0%,#80D0C7 100%);border-radius:24px;display:flex;align-items:center;justify-content:center;margin:0 auto 15px;box-shadow:0 8px 20px rgba(0,147,233,0.3)}.icon-wrap span{font-size:40px}textarea{width:100%;height:100px;border:1px solid #eee;border-radius:15px;padding:15px;font-size:16px;resize:none;outline:none;background:#f9f9f9}.tags{display:flex;gap:8px;overflow-x:auto;padding:5px 0}.tag{background:#e0f7fa;color:#00796b;padding:8px 15px;border-radius:20px;font-size:14px;white-space:nowrap;cursor:pointer}.loc-card{display:flex;align-items:center;gap:12px;cursor:pointer}.loc-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;background:#f0f0f0}.btn-main{background:linear-gradient(135deg,#0093E9 0%,#80D0C7 100%);color:#fff;border:none;padding:18px;border-radius:18px;font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px}.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;padding:20px;z-index:100}.modal-overlay.show{display:flex}.modal-box{background:#fff;border-radius:20px;padding:24px;text-align:center;width:100%}.modal-btn{background:#0093E9;color:#fff;border:none;padding:12px 24px;border-radius:10px;margin-top:20px;width:100%;font-weight:600}#successView{display:none}.btn-phone{background:#ef4444;color:#fff;text-decoration:none;padding:15px;border-radius:15px;text-align:center;font-weight:600;display:block;margin-top:10px}</style></head><body><div id="locationTipModal" class="modal-overlay show"><div class="modal-box"><h2>📍 位置说明</h2><p style="margin-top:10px;color:#666">分享位置能让车主更快赶到<br>不分享将延迟30秒发送</p><button class="modal-btn" onclick="hideModal();requestLocation()">我知道了</button></div></div><div class="container" id="mainView"><div class="card header"><div class="icon-wrap"><span>🚗</span></div><h1>呼叫车主挪车</h1></div><div class="card"><textarea id="msgInput" placeholder="给车主留言..."></textarea><div class="tags"><div class="tag" onclick="addTag('您的车挡住我了')">🚧 挡路</div><div class="tag" onclick="addTag('麻烦尽快挪一下')">🙏 加急</div></div></div><div class="card loc-card" onclick="requestLocation()"><div id="locIcon" class="loc-icon">📍</div><div><div style="font-weight:600">我的位置</div><div id="locStatus" style="font-size:13px;color:#999">点击获取定位</div></div></div><button id="notifyBtn" class="btn-main" onclick="sendNotify()"><span>🔔</span>一键通知车主</button></div><div class="container" id="successView"><div class="card" style="text-align:center"><h1>✅ 通知已发出</h1><p id="waitText" style="margin:15px 0;color:#666">正在等待车主反馈...</p><div id="ownerInfo" style="display:none;background:#f0f9ff;padding:15px;border-radius:15px;margin-top:10px"><p style="color:#0093E9;font-weight:600">🎉 车主已出发！</p><div id="ownerMaps" style="display:flex;gap:10px;margin-top:10px"></div></div></div><div class="card"><h3>没反应？</h3><a href="tel:${phone}" class="btn-phone">📞 直接拨打电话</a></div></div><script>let userLoc=null;function hideModal(){document.getElementById('locationTipModal').classList.remove('show')}function addTag(t){document.getElementById('msgInput').value=t}function requestLocation(){navigator.geolocation.getCurrentPosition(p=>{userLoc={lat:p.coords.latitude,lng:p.coords.longitude};document.getElementById('locIcon').style.background='#d4edda';document.getElementById('locStatus').innerText='已获取位置✓';document.getElementById('locStatus').style.color='#28a745'},null)}async function sendNotify(){const btn=document.getElementById('notifyBtn');btn.disabled=true;btn.innerText='发送中...';const res=await fetch('/api/notify',{method:'POST',body:JSON.stringify({message:document.getElementById('msgInput').value,location:userLoc,delayed:!userLoc})});if(res.ok){document.getElementById('mainView').style.display='none';document.getElementById('successView').style.display='flex';startPolling()}else{alert('发送失败');btn.disabled=false}}function startPolling(){setInterval(async()=>{const res=await fetch('/api/check-status');const data=await res.json();if(data.status==='confirmed'){document.getElementById('waitText').style.display='none';document.getElementById('ownerInfo').style.display='block';if(data.ownerLocation){const maps=document.getElementById('ownerMaps');maps.innerHTML='<a href="'+data.ownerLocation.amapUrl+'" style="flex:1;background:#1890ff;color:#fff;padding:10px;border-radius:10px;text-decoration:none">高德地图</a>';}}},3000)}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderOwnerPage() {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>确认挪车</title><style>body{font-family:sans-serif;background:#667eea;padding:20px;display:flex;justify-content:center;align-items:center;min-height:100vh}.card{background:#fff;padding:30px;border-radius:24px;width:100%;max-width:400px;text-align:center}.btn{background:#10b981;color:#fff;border:none;padding:20px;border-radius:15px;width:100%;font-size:18px;font-weight:700;margin-top:20px;cursor:pointer}</style></head><body><div class="card"><h1>👋 收到挪车请求</h1><p style="margin-top:10px;color:#666">对方正在车旁等待</p><div id="requesterMap" style="display:none;margin-top:20px;padding:15px;background:#f0f0f0;border-radius:15px"></div><button id="cBtn" class="btn" onclick="confirm()">我已知晓，现在出发</button></div><script>async function confirm(){const b=document.getElementById('cBtn');b.disabled=true;b.innerText='处理中...';let loc=null;navigator.geolocation.getCurrentPosition(async p=>{loc={lat:p.coords.latitude,lng:p.coords.longitude};await send(loc)},async()=>{await send(null)})}async function send(l){await fetch('/api/owner-confirm',{method:'POST',body:JSON.stringify({location:l})});document.querySelector('.card').innerHTML='<h1>✅ 已通知对方</h1><p style="margin-top:15px">请尽快赶往现场</p>'}window.onload=async()=>{const res=await fetch('/api/get-location');if(res.ok){const d=await res.json();const m=document.getElementById('requesterMap');m.style.display='block';m.innerHTML='<p style="margin-bottom:10px">对方位置：</p><a href="'+d.amapUrl+'" style="color:#0093E9">在高德地图中查看</a>'}}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
