/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';

const UPSTREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ALLOW_HOST = /(^|\.)(115\.com|115cdn\.com|115vod\.com)$/i;

function decodeTarget(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function encodeTarget(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function rewritePlaylist(text: string, baseUrl: string) {
  const proxify = (raw: string) => {
    try {
      const abs = new URL(raw, baseUrl).toString();
      return `/api/netdisk/115/proxy?u=${encodeTarget(abs)}`;
    } catch {
      return raw;
    }
  };
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${proxify(uri)}"`);
      }
      return proxify(trimmed);
    })
    .join('\n');
}

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const encoded = request.nextUrl.searchParams.get('u');
  if (!encoded) {
    return NextResponse.json({ error: '缺少参数' }, { status: 400 });
  }

  let target: string;
  try {
    target = decodeTarget(encoded);
  } catch {
    return NextResponse.json({ error: '参数无效' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: '参数无效' }, { status: 400 });
  }
  if (!ALLOW_HOST.test(parsed.hostname)) {
    return NextResponse.json({ error: '仅支持 115 域名' }, { status: 400 });
  }

  const config = await getConfig();
  const cookie = config.NetDiskConfig?.Pan115?.Cookie || '';
  const range = request.headers.get('range') || '';

  const headers: Record<string, string> = {
    'User-Agent': UPSTREAM_UA,
    Referer: 'https://115.com/',
    Origin: 'https://115.com',
  };
  if (cookie) headers.Cookie = cookie;
  if (range) headers.Range = range;

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers, cache: 'no-store', redirect: 'follow' });
  } catch (error) {
    return NextResponse.json(
      { error: `115 上游请求失败：${error instanceof Error ? error.message : '未知错误'}` },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(parsed.pathname + parsed.search);
  const buffer = Buffer.from(await upstream.arrayBuffer());
  const head = buffer.subarray(0, 16).toString('utf8');

  if (isPlaylist || head.startsWith('#EXTM3U')) {
    const rewritten = rewritePlaylist(buffer.toString('utf8'), target);
    return new NextResponse(rewritten, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const outHeaders = new Headers();
  if (contentType) outHeaders.set('content-type', contentType);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) outHeaders.set('content-range', contentRange);
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) outHeaders.set('content-length', contentLength);
  outHeaders.set('accept-ranges', 'bytes');
  outHeaders.set('cache-control', 'no-store');

  return new NextResponse(buffer, { status: upstream.status, headers: outHeaders });
}
