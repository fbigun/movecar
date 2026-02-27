/**
 * MoveCar 跨云终极适配版 + 强力诊断 (修复版)
 * 删除了重复声明的函数，确保阿里云 ESA 构建成功
 */

const CONFIG = {
  KV_TTL: 3600,         
  RATE_LIMIT_TTL: 60    
};

export default {
  async fetch(request, env, ctx) {
    try {
      let KV = null;
      if (env && env.MOVE_CAR_STATUS) {
        KV = env.MOVE_CAR_STATUS;
      } else if (typeof EdgeKV !== 'undefined') {
        try { KV = new EdgeKV({ namespace: "MOVE_CAR_STATUS" }); } catch(e) {}
      } else if (typeof globalThis !== 'undefined' && globalThis.MOVE_CAR_STATUS) {
        KV = globalThis.MOVE_CAR_STATUS;
      }

      if (!KV) {
         return new Response(JSON.stringify({ success: false, error: 'KV存储未就绪，请检查空间名是否为 MOVE_CAR_STATUS' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return await handleRequest(request, env, KV);
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { 
        status: 500, headers: { 'Content-Type': 'application/json' } 
      });
    }
  }
};

async function handleRequest(request, env, KV) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  let userParam = url.searchParams.get('u') || 'default';
  userParam = userParam.replace(/[^a-zA-Z0-9_-]/g, ''); 
  if (!userParam) userParam = 'default';
  const userKey = userParam.toLowerCase();

  if (path === '/api/notify' && request.method === 'POST') return handleNotify(request, url, userKey, env, KV);
  if (path === '/api/get-location') return handleGetLocation(userKey, KV);
  if (path === '/api/owner-confirm' && request.method === 'POST') return handleOwnerConfirmAction(request, userKey, KV);
  if (path === '/api/check-status') return handleCheckStatus(userKey, KV);
  if (path === '/owner-confirm') return renderOwnerPage(userKey, env);

  return renderMainPage(url.origin, userKey, env);
}

function escapeHtml(unsafe) {
  return (unsafe || '').toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function getUserConfig(userKey, envPrefix, env) {
  const specificKey = envPrefix + "_" + userKey.toUpperCase();
  let val = null;
  
  if (env && env[specificKey]) val = env[specificKey];
  else if (env && env[envPrefix]) val = env[envPrefix];
  
  if (!val && typeof globalThis !== 'undefined') {
    if (globalThis[specificKey]) val = globalThis[specificKey];
    else if (globalThis[envPrefix]) val = globalThis[envPrefix];
  }

  if (!val && typeof process !== 'undefined' && process.env) {
    if (process.env[specificKey]) val = process.env[specificKey];
    else if (process.env[envPrefix]) val = process.env[envPrefix];
  }
  return val;
}

// 坐标转换函数 (只保留一次)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0; const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
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
  return { amapUrl: "https://uri.amap.com/marker?position=" + gcj.lng + "," + gcj.lat + "&name=扫码者位置", appleUrl: "https://maps.apple.com/?ll=" + gcj.lat + "," + gcj.lng + "&q=扫码者位置" };
}

async function handleNotify(request, url, userKey, env, KV) {
  const ppToken = getUserConfig(userKey, 'PUSHPLUS_TOKEN', env);
  const barkUrl = getUserConfig(userKey, 'BARK_URL', env);
  const carTitle = escapeHtml(getUserConfig(userKey, 'CAR_TITLE', env) || '车主');
  
  if (!ppToken && !barkUrl) {
      let debugInfo = "env是空的";
      if (env) {
          try { debugInfo = "包含的键: " + Object.keys(env).join(', '); } 
          catch(e) { debugInfo = "env不可枚举"; }
      }
      throw new Error(`系统未配置推送渠道(BARK或PushPlus)。诊断信息: [${debugInfo}]`);
  }

  const lockKey = "lock_" + userKey;
  const isLocked = await KV.get(lockKey);
  if (isLocked) throw new Error('发送太频繁，请一分钟后再试');

  const body = await request.json();
  const rawMessage = body.message || '车旁有人等待';
  const safeMessage = escapeHtml(rawMessage);
  const location = body.location || null;
  const delayed = body.delayed || false;

  const externalUrlConfig = getUserConfig(userKey, 'EXTERNAL_URL', env);
  const baseDomain = externalUrlConfig ? externalUrlConfig.replace(/\/$/, "") : url.origin;
  const confirmUrl = baseDomain + "/owner-confirm?u=" + userKey;

  let plainTextMsg = "🚗 挪车请求【" + carTitle + "】\n💬 留言: " + rawMessage;
  let htmlMsg = "🚗 挪车请求【" + carTitle + "】<br>💬 留言: " + safeMessage;
  
  if (location && location.lat) {
    const maps = generateMapUrls(location.lat, location.lng);
    plainTextMsg += "\n📍 已附带对方位置";
    htmlMsg += "<br>📍 已附带对方位置";
    await KV.put("loc_" + userKey, JSON.stringify({ ...location, ...maps }), { expirationTtl: CONFIG.KV_TTL });
  }

  await KV.put("status_" + userKey, 'waiting', { expirationTtl: CONFIG.KV_TTL });
  await KV.delete("owner_loc_" + userKey);
  await KV.put(lockKey, '1', { expirationTtl: CONFIG.RATE_LIMIT_TTL });

  if (delayed) await new Promise(r => setTimeout(r, 30000));

  const tasks = [];
  if (ppToken) {
    const finalHtml = htmlMsg + '<br><br><a href="' + confirmUrl + '" style="font-weight:bold;color:#0093E9;font-size:18px;">【点击确认前往】</a>';
    tasks.push(fetch('http://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ppToken, title: "🚗 挪车请求：" + carTitle, content: finalHtml, template: 'html' })
    }));
  }
  if (barkUrl) {
    const cleanBarkUrl = barkUrl.replace(/\/$/, ""); 
    tasks.push(fetch(cleanBarkUrl + "/" + encodeURIComponent('挪车请求') + "/" + encodeURIComponent(plainTextMsg) + "?url=" + encodeURIComponent(confirmUrl)));
  }

  await Promise.all(tasks);
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCheckStatus(userKey, KV) {
  const status = await KV.get("status_" + userKey);
  const ownerLoc = await KV.get("owner_loc_" + userKey);
  return new Response(JSON.stringify({ status: status || 'waiting', ownerLocation: ownerLoc ? JSON.parse(ownerLoc) : null }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleGetLocation(userKey, KV) {
  const data = await KV.get("loc_" + userKey);
  return new Response(data || '{}', { headers: { 'Content-Type': 'application/json' } });
}

async function handleOwnerConfirmAction(request, userKey, KV) {
  const body = await request.json();
  if (body.location && body.location.lat) {
    const urls = generateMapUrls(body.location.lat, body.location.lng);
    await KV.put("owner_loc_" + userKey, JSON.stringify({ ...body.location, ...urls }), { expirationTtl: 600 });
  }
  await KV.put("status_" + userKey, 'confirmed', { expirationTtl: 600 });
  return new Response(JSON.stringify({ success: true }));
}

function renderMainPage(origin, userKey, env) {
  const phone = escapeHtml(getUserConfig(userKey, 'PHONE_NUMBER', env) || '');
  const carTitle = escapeHtml(getUserConfig(userKey, 'CAR_TITLE', env) || '车主');
  const phoneHtml = phone ? `<a href="tel:${phone}" class="btn-phone">📞 拨打车主电话</a>` : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
  <title>通知车主挪车</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 15px; }
    .card { background: white; border-radius: 24px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
    .header { text-align: center; }
    .icon-wrap { width: 70px; height: 70px; background: #0093E9; border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px; font-size: 36px; color: white; }
    textarea { width: 100%; min-height: 100px; border: none; font-size: 16px; outline: none; resize: none; margin-top: 10px; }
    .tag-box { display: flex; gap: 8px; overflow-x: auto; margin-top: 10px; padding-bottom: 5px; }
    .tag { background: #f0f4f8; padding: 8px 16px; border-radius: 20px; font-size: 14px; white-space: nowrap; cursor: pointer; border: 1px solid #e1e8ed; }
    .btn-main { background: #0093E9; color: white; border: none; padding: 18px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; width: 100%; }
    .btn-phone { background: #ef4444; color: white; border: none; padding: 15px; border-radius: 15px; text-decoration: none; text-align: center; font-weight: bold; display: block; margin-top: 10px; }
    .btn-retry { background: #f59e0b; color: white; padding: 15px; border-radius: 15px; text-align: center; font-weight: bold; display: block; margin-top: 10px; border: none; width: 100%; cursor: pointer; }
    .hidden { display: none !important; }
    .map-links { display: flex; gap: 10px; margin-top: 15px; }
    .map-btn { flex: 1; padding: 12px; border-radius: 12px; text-align: center; text-decoration: none; color: white; font-size: 14px; font-weight: bold; }
    .amap { background: #1890ff; } .apple { background: #000; }
  </style>
</head>
<body>
  <div class="container" id="mainView">
    <div class="card header">
      <div class="icon-wrap">🚗</div>
      <h1>呼叫车主挪车</h1>
      <p style="color:#666; margin-top:5px">联络对象：${carTitle}</p>
    </div>
    <div class="card">
      <textarea id="msgInput" placeholder="留言给车主..."></textarea>
      <div class="tag-box">
        <div class="tag" onclick="setTag('您的车挡住我了')">🚧 挡路</div>
        <div class="tag" onclick="setTag('临时停靠一下')">⏱️ 临停</div>
        <div class="tag" onclick="setTag('急事，麻烦尽快')">🙏 加急</div>
      </div>
    </div>
    <div class="card" id="locStatus" style="font-size:14px; color:#666; text-align:center;">正在获取您的位置...</div>
    <button id="notifyBtn" class="btn-main" onclick="sendNotify()">🔔 发送通知</button>
  </div>

  <div class="container hidden" id="successView">
    <div class="card" style="text-align:center">
      <div style="font-size:60px; margin-bottom:15px">✅</div>
      <h2 style="margin-bottom:8px">通知已发出</h2>
      <p id="waitingText" style="color:#666">车主已收到提醒，请稍候</p>
    </div>
    <div id="ownerFeedback" class="card hidden" style="text-align:center">
      <div style="font-size:40px">🏃‍♂️</div>
      <h3 style="color:#059669">车主正赶往现场</h3>
      <div class="map-links">
        <a id="ownerAmap" href="#" class="map-btn amap">高德地图</a>
        <a id="ownerApple" href="#" class="map-btn apple">苹果地图</a>
      </div>
    </div>
    <div>
      <button class="btn-retry" onclick="location.reload()">再次通知</button>
      ${phoneHtml}
    </div>
  </div>

  <script>
    let userLoc = null;
    const userKey = "${userKey}";
    
    window.onload = () => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => {
          userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
          document.getElementById('locStatus').innerText = '📍 位置已锁定';
          document.getElementById('locStatus').style.color = '#059669';
        }, () => {
          document.getElementById('locStatus').innerText = '⚠️ 未能获取位置 (将延迟发送)';
        });
      }
    };

    function setTag(t) { document.getElementById('msgInput').value = t; }

    async function sendNotify() {
      const btn = document.getElementById('notifyBtn');
      btn.disabled = true; btn.innerText = '发送中...';
      try {
        const res = await fetch('/api/notify?u=' + userKey, {
          method: 'POST',
          body: JSON.stringify({ message: document.getElementById('msgInput').value, location: userLoc, delayed: !userLoc })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('mainView').classList.add('hidden');
          document.getElementById('successView').classList.remove('hidden');
          pollStatus();
        } else { alert(data.error); btn.disabled = false; btn.innerText = '🔔 发送通知'; }
      } catch(e) { alert('系统忙，请稍后再试'); btn.disabled = false; }
    }

    function pollStatus() {
      setInterval(async () => {
        const res = await fetch('/api/check-status?u=' + userKey);
        const data = await res.json();
        if (data.status === 'confirmed') {
          document.getElementById('ownerFeedback').classList.remove('hidden');
          if (data.ownerLocation) {
            document.getElementById('ownerAmap').href = data.ownerLocation.amapUrl;
            document.getElementById('ownerApple').href = data.ownerLocation.appleUrl;
          }
        }
      }, 4000);
    }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderOwnerPage(userKey, env) {
  const carTitle = escapeHtml(getUserConfig(userKey, 'CAR_TITLE', env) || '车主');
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>车主确认</title>
  <style>
    body { font-family: sans-serif; background: #667eea; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin:0; padding:20px; }
    .card { background: white; padding: 30px; border-radius: 28px; text-align: center; width: 100%; max-width: 400px; }
    .btn { background: #10b981; color: white; border: none; width: 100%; padding: 20px; border-radius: 16px; font-size: 18px; font-weight: bold; cursor: margin-top: 20px; }
    .map-box { display: none; background: #f0f4ff; padding: 15px; border-radius: 15px; margin-top: 15px; }
    .map-btn { display: inline-block; padding: 10px 15px; background: #1890ff; color: white; text-decoration: none; border-radius: 10px; margin: 5px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:45px">📢</div>
    <h2 style="margin:10px 0">${carTitle}</h2>
    <div id="mapArea" class="map-box">
      <p style="font-size:14px; color:#1e40af; margin-bottom:10px">对方位置已送达 📍</p>
      <a id="amapLink" href="#" class="map-btn">高德地图</a>
      <a id="appleLink" href="#" class="map-btn" style="background:#000">苹果地图</a>
    </div>
    <button id="confirmBtn" class="btn" onclick="confirmMove()">🚀 我已知晓，马上过去</button>
  </div>
  <script>
    const userKey = "${userKey}";
    window.onload = async () => {
      const res = await fetch('/api/get-location?u=' + userKey);
      const data = await res.json();
      if(data.amapUrl) {
        document.getElementById('mapArea').style.display = 'block';
        document.getElementById('amapLink').href = data.amapUrl;
        document.getElementById('appleLink').href = data.appleUrl;
      }
    };
    async function confirmMove() {
      const btn = document.getElementById('confirmBtn');
      btn.innerText = '已同步给对方'; btn.disabled = true;
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async p => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: {lat: p.coords.latitude, lng: p.coords.longitude} }) });
        }, async () => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: null }) });
        });
      } else {
        await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: null }) });
      }
    }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
