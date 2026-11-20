import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getPan115PlayUrl } from '@/lib/netdisk/pan115.client';
import { getPan115NetdiskSession, refreshPan115NetdiskSession } from '@/lib/netdisk/pan115-session-cache';
import { resolvePan115Session } from '@/lib/netdisk/pan115-session-resolver';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo?.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id') || searchParams.get('session');
    const episodeIndexRaw = searchParams.get('episodeIndex');
    const format = searchParams.get('format');
    if (!id || episodeIndexRaw == null) {
      return NextResponse.json({ error: '缺少参数' }, { status: 400 });
    }

    const episodeIndex = Number.parseInt(episodeIndexRaw, 10);
    if (!Number.isInteger(episodeIndex) || episodeIndex < 0) {
      return NextResponse.json({ error: '无效的 episodeIndex' }, { status: 400 });
    }

    refreshPan115NetdiskSession(id) || getPan115NetdiskSession(id);
    const { session, cookie } = await resolvePan115Session(id);
    const file = session.files[episodeIndex];
    if (!file) {
      return NextResponse.json({ error: '播放文件不存在' }, { status: 404 });
    }

    const url = await getPan115PlayUrl(file, cookie);
    refreshPan115NetdiskSession(id);

    // 115 的在线播放地址是 m3u8，且必须带登录 Cookie 才能拉取：
    // 直接丢给前端会 403，统一走 /api/netdisk/115/proxy 转发 + 重写分片地址。
    const isHls = /\.m3u8(\?|$)/i.test(url);
    const playUrl = isHls
      ? `${request.nextUrl.origin}/api/netdisk/115/proxy?u=${Buffer.from(url, 'utf8').toString('base64url')}`
      : url;

    if (format === 'json') {
      return NextResponse.json({ url: playUrl, headers: {} });
    }

    return NextResponse.redirect(playUrl);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取播放地址失败' },
      { status: 500 }
    );
  }
}
