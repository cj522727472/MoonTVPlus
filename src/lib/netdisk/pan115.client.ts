/* ---------- 115 网页版 API 播放链路 ----------
 * App 域接口 pro.api.115.com 只认 App 登录态，网页 Cookie 会返回 99 0001 登录超时；
 * 网页版 Cookie 在 webapi.115.com 上完全有效，所以优先走：
 *   转存分享 -> 在自己网盘里找到该文件(pick_code) -> /files/video 拿在线播放 m3u8
 */
const WEB_API_BASE = 'https://webapi.115.com';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function webHeaders(cookie: string) {
  return {
    Cookie: cookie,
    Referer: 'https://115.com/',
    Origin: 'https://115.com',
    'User-Agent': WEB_UA,
  };
}

async function webJson(url: string, cookie: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...webHeaders(cookie),
      ...((init?.headers as Record<string, string>) || {}),
    },
    cache: 'no-store',
  });
  return parseJson(response);
}

/** 转存分享（幂等）：已转存过时 115 返回失败提示，这里忽略 */
async function receiveShareToDrive(file: Pan115ShareVideoFile, cookie: string) {
  const body = new URLSearchParams({
    share_code: file.shareCode,
    receive_code: file.receiveCode,
    cid: '0',
  });
  const data = await webJson(`${WEB_API_BASE}/share/receive`, cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (data?.state === false) {
    const msg = String(data?.error || data?.msg || '');
    if (!/已转存|已经转存|已接收|请勿重复/.test(msg)) {
      throw new Error(`115 转存失败：${msg || '未知错误'}`);
    }
  }
  return String(data?.data?.receive_title || '');
}

async function listDrive(cid: string, cookie: string) {
  const data = await webJson(
    `${WEB_API_BASE}/files?aid=1&cid=${encodeURIComponent(cid)}&show_dir=1&limit=1000&offset=0&o=user_ptime&asc=0`,
    cookie
  );
  return Array.isArray(data?.data) ? data.data : [];
}

/** 转存后在网盘里定位这个文件的 pick_code */
async function findDrivePickCode(file: Pan115ShareVideoFile, cookie: string, folderTitle: string) {
  const rootItems = await listDrive('0', cookie);
  const direct = rootItems.find((item: any) => String(item.n || '') === file.name);
  if (direct?.pc) return String(direct.pc);

  const folders = rootItems
    .filter((item: any) => Number(item.fc) === 0)
    .sort((a: any, b: any) => {
      const sa = String(a.n || '') === folderTitle ? 1 : 0;
      const sb = String(b.n || '') === folderTitle ? 1 : 0;
      return sb - sa;
    })
    .slice(0, 6);

  for (const folder of folders) {
    const folderCid = String(folder.cid || folder.fid || '');
    if (!folderCid) continue;
    const items = await listDrive(folderCid, cookie);
    const hit = items.find((item: any) => String(item.n || '') === file.name);
    if (hit?.pc) return String(hit.pc);
  }
  throw new Error('115 已转存但未在网盘里找到该文件');
}

async function getPan115PlayUrlByWebApi(file: Pan115ShareVideoFile, cookie: string) {
  const folderTitle = await receiveShareToDrive(file, cookie);
  const pickCode = await findDrivePickCode(file, cookie, folderTitle);
  const info = await webJson(
    `${WEB_API_BASE}/files/video?pick_code=${encodeURIComponent(pickCode)}`,
    cookie
  );
  const playUrl = info?.video_url || info?.data?.video_url;
  if (!playUrl) {
    throw new Error(`115 未返回在线播放地址（${String(info?.error || info?.msg || '未知')}）`);
  }
  return String(playUrl);
}

/** 优先网页 API；失败再退回 App 域接口 */
export async function getPan115PlayUrl(file: Pan115ShareVideoFile, cookie: string) {
  const safeCookie = assertPan115CookieHeaderSafe(cookie);
  try {
    return await getPan115PlayUrlByWebApi(file, safeCookie);
  } catch (primaryError) {
    try {
      return await getPan115PlayUrlByAppApi(file, safeCookie);
    } catch {
      throw primaryError;
    }
  }
}

async function getPan115PlayUrlByAppApi(file: Pan115ShareVideoFile, cookie: string) {
  const safeCookie = assertPan115CookieHeaderSafe(cookie);
  const payload = `data=${encodeURIComponent(encrypt115(JSON.stringify({
    share_code: file.shareCode,
    receive_code: file.receiveCode,
    file_id: file.fileId,
  })))}`;

  const response = await fetch(PLAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: safeCookie,
    },
    body: payload,
    cache: 'no-store',
  });

  const responseData = await parseJson(response);
  if (!responseData) {
    throw new Error('115盘无响应数据');
  }
  if (responseData.state === false) {
    const errorMsg = responseData.msg || responseData.error || '未知错误';
    if (String(errorMsg).includes('登录')) {
      throw new Error('115 Cookie 无效，请重新填写');
    }
    throw new Error(`115盘错误: ${errorMsg}`);
  }
  if (!responseData.data || typeof responseData.data !== 'string') {
    throw new Error('115 Cookie 无效，请重新填写');
  }
  const parsed = JSON.parse(decrypt115(responseData.data));
  const playUrl = parsed?.url?.url;
  if (!playUrl) throw new Error('未获取到115播放地址');
  return playUrl as string;
}
