import { filterAdsFromM3U8 } from '@/lib/m3u8AdFilter';

const BASE = 'https://main.example.com/path/to/index.m3u8';

function header(): string[] {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
}

function contentSegs(prefix: string, count: number, start = 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push('#EXTINF:2.0,');
    out.push(`${prefix}/seg${start + i}.ts`);
  }
  return out;
}

function adSegs(prefix: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push('#EXTINF:5,');
    out.push(`${prefix}/ad${i + 1}.ts`);
  }
  return out;
}

const countMatches = (text: string, re: RegExp): number =>
  text.match(re)?.length ?? 0;

describe('filterAdsFromM3U8', () => {
  it('剔除换域名 + KEY 重置为 NONE 的中插与片尾广告块', () => {
    const key = '#EXT-X-KEY:METHOD=AES-128,URI="/path/to/key.key"';
    const lines = [
      ...header(),
      key,
      ...contentSegs('/path/to/hls', 20),
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      ...adSegs('https://ad.example.net/20260917/xxxx/hls', 4),
      '#EXT-X-DISCONTINUITY',
      key,
      ...contentSegs('/path/to/hls', 20, 21),
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      ...adSegs('https://ad.example.net/20260917/xxxx/hls', 4),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = filterAdsFromM3U8(lines, BASE);

    expect(out).not.toContain('ad.example.net');
    expect(out).not.toContain('METHOD=NONE');
    expect(countMatches(out, /\/path\/to\/hls\/seg/g)).toBe(40);
    expect(out).toContain('#EXT-X-ENDLIST');
    expect(out.trimStart().startsWith('#EXTM3U')).toBe(true);
  });

  it('剔除同域名、不同目录的中插广告块', () => {
    const content = 'https://cdn.example.com:65/20250821/AAA/6329kb/hls';
    const ad = 'https://cdn.example.com:65/20260916/BBB/10149kb/hls';
    const lines = [
      ...header(),
      ...contentSegs(content, 30),
      '#EXT-X-DISCONTINUITY',
      ...adSegs(ad, 6),
      '#EXT-X-DISCONTINUITY',
      ...contentSegs(content, 30, 31),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = filterAdsFromM3U8(lines, BASE);

    expect(out).not.toContain('20260916');
    expect(countMatches(out, /\/6329kb\/hls\/seg/g)).toBe(60);
  });

  it('剔除相对路径换目录 + KEY NONE 的广告块', () => {
    const content = '/20240828/AAA/2000kb/hls';
    const ad = '/20260830/BBB/10092kb/hls';
    const lines = [
      ...header(),
      ...contentSegs(content, 30),
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      ...adSegs(ad, 9),
      '#EXT-X-DISCONTINUITY',
      ...contentSegs(content, 30, 31),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = filterAdsFromM3U8(
      lines,
      'https://play.example.com/20240828/AAA/index.m3u8'
    );

    expect(out).not.toContain('20260830');
    expect(out).not.toContain('METHOD=NONE');
    expect(countMatches(out, /\/2000kb\/hls\/seg/g)).toBe(60);
  });

  it('剔除片头单段换域广告', () => {
    const lines = [
      ...header(),
      '#EXTINF:5.25,',
      'https://ts1.adhost.com/index2.ts',
      '#EXT-X-DISCONTINUITY',
      ...contentSegs('https://v11.cdn.com/wjv11/202511/19/x/hls', 30),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = filterAdsFromM3U8(
      lines,
      'https://v11.cdn.com/wjv11/index.m3u8'
    );
    const outLines = out.split('\n');

    expect(out).not.toContain('ts1.adhost.com');
    expect(countMatches(out, /\/hls\/seg/g)).toBe(30);
    // 第一个分片应为正片
    const firstSeg = outLines.find(
      (l) => !l.startsWith('#') && l.trim() !== ''
    );
    expect(firstSeg).toContain('v11.cdn.com');
  });

  it('保留合法（非广告）的 DISCONTINUITY，内容不变', () => {
    const segs: string[] = [];
    for (let b = 0; b < 20; b++) {
      if (b > 0) segs.push('#EXT-X-DISCONTINUITY');
      segs.push(...contentSegs('/x/hls', 5, b * 5 + 1));
    }
    const input = [...header(), ...segs, '#EXT-X-ENDLIST'].join('\n');

    expect(filterAdsFromM3U8(input, BASE)).toBe(input);
  });

  it('剔除同域同目录、但来自另一次转码（帧率不同）的广告块', () => {
    // 正片 25fps：时长均为 1/25 的整数倍
    const contentDurs = [
      '4.000000',
      '4.320000',
      '4.080000',
      '5.280000',
      '3.760000',
      '1.560000',
      '5.400000',
      '2.960000',
      '4.440000',
      '3.040000',
    ];
    // 广告片段 30fps：时长均为 1/30 的整数倍，且不是 1/25 的整数倍
    const adDurs = ['5.566667', '2.933333', '5.700000', '3.333333', '1.533333'];

    const content = (offset: number): string[] => {
      const out: string[] = [];
      for (let i = 0; i < 30; i++) {
        out.push(`#EXTINF:${contentDurs[i % contentDurs.length]},`);
        out.push(`/x/hls/seg${offset + i}.ts`);
      }
      return out;
    };
    const ad = adDurs.flatMap((d, i) => [`#EXTINF:${d},`, `/x/hls/ad${i}.ts`]);
    const lines = [
      ...header(),
      ...content(0),
      '#EXT-X-DISCONTINUITY',
      ...ad,
      '#EXT-X-DISCONTINUITY',
      ...content(30),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = filterAdsFromM3U8(lines, BASE);

    expect(out).not.toContain('/x/hls/ad');
    expect(countMatches(out, /\/x\/hls\/seg/g)).toBe(60);
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('同帧率的短分块（合法段落）不会被误删', () => {
    const contentDurs = ['4.000000', '4.320000', '4.080000', '5.280000'];
    const seg = (prefix: string, offset: number, n: number): string[] => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        out.push(`#EXTINF:${contentDurs[i % contentDurs.length]},`);
        out.push(`${prefix}/seg${offset + i}.ts`);
      }
      return out;
    };
    const lines = [
      ...header(),
      ...seg('/x/hls', 0, 30),
      '#EXT-X-DISCONTINUITY',
      ...seg('/x/hls', 30, 4),
      '#EXT-X-DISCONTINUITY',
      ...seg('/x/hls', 34, 30),
      '#EXT-X-ENDLIST',
    ].join('\n');

    expect(filterAdsFromM3U8(lines, BASE)).toBe(lines);
  });

  it('干净的单目录流保持不变', () => {
    const input = [
      ...header(),
      '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
      ...contentSegs('/hls/a/b', 40),
      '#EXT-X-ENDLIST',
    ].join('\n');

    expect(filterAdsFromM3U8(input, BASE)).toBe(input);
  });

  it('多 CDN 混排（各占约一半）时不做任何删除', () => {
    const lines = [
      ...header(),
      ...contentSegs('/dirA/hls', 10),
      '#EXT-X-DISCONTINUITY',
      ...contentSegs('/dirB/hls', 10),
      '#EXT-X-DISCONTINUITY',
      ...contentSegs('/dirA/hls', 10, 11),
      '#EXT-X-DISCONTINUITY',
      ...contentSegs('/dirB/hls', 10, 11),
      '#EXT-X-ENDLIST',
    ].join('\n');

    expect(filterAdsFromM3U8(lines, BASE)).toBe(lines);
  });

  it('主播放列表（含 STREAM-INF）原样返回', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1472000,RESOLUTION=720x1280',
      '/20260923/x/y/1472kb/hls/index.m3u8',
    ].join('\n');

    expect(filterAdsFromM3U8(input, BASE)).toBe(input);
  });

  it('非 m3u8 文本与空串原样返回', () => {
    const html = '<html><body>403 Forbidden</body></html>';
    expect(filterAdsFromM3U8(html, BASE)).toBe(html);
    expect(filterAdsFromM3U8('', BASE)).toBe('');
  });
});
