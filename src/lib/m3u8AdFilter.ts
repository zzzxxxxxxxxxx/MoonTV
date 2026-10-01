/**
 * HLS（m3u8）去广告工具。
 *
 * 部分采集源会在正片播放列表中插入与正片分离的广告分片（赌博广告等）。
 * 这些广告块具有稳定的结构特征：
 *   1. 被 `#EXT-X-DISCONTINUITY` 包围成独立分块；
 *   2. 分片 URL 的 host 或目录与正片不同；
 *   3. 在加密流中把 `#EXT-X-KEY` 重置为 `METHOD=NONE`。
 *
 * 本模块按上述结构特征识别并整块删除广告分片，不改动其它内容；
 * 任何不确定或异常的情况都原样返回，保证不误删正片。
 */

// 广告块所属（host + 目录）组合在全片中的占比低于该值时才认定为广告，
// 避免在“多 CDN 混排”的合法播放列表中误删。
const MINORITY_THRESHOLD = 0.25;

// 分片时长是整数帧，必为 1/fps 的整数倍。被拼接进来的广告来自另一次转码，
// 其帧率与正片不同，因此可用时长量化到的帧率来识别“同域同目录”的广告块。
const FPS_CANDIDATES = [23.976, 24, 25, 29.97, 30, 48, 50, 60];
// 播放列表会截断时长（如 6.208333 -> 6.208），换算成帧后需留少量容差。
const FPS_TOLERANCE = 0.06;
// 仅对“小块”做帧率判定，避免误伤整体换帧率的长片段。
const MAX_DIFFERENT_ENCODE_SEGMENTS = 16;
const MAX_DIFFERENT_ENCODE_SECONDS = 60;
// 全片需有稳定帧率基准时才启用该判定。
const DOMINANT_FPS_MIN_FIT = 0.9;

interface SegmentInfo {
  lineIndex: number;
  tagsBefore: number[];
  host: string;
  dir: string;
  duration: number;
  keyMethod: string | null;
  blockId: number;
}

function isDiscontinuity(line: string): boolean {
  const s = line.trim();
  return (
    s.startsWith('#EXT-X-DISCONTINUITY') &&
    !s.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')
  );
}

function isKeyTag(line: string): boolean {
  return line.trim().startsWith('#EXT-X-KEY');
}

function isExtinfTag(line: string): boolean {
  return line.trim().startsWith('#EXTINF');
}

function parseDuration(tags: number[], lines: string[]): number {
  for (let i = tags.length - 1; i >= 0; i--) {
    const s = lines[tags[i]].trim();
    if (s.startsWith('#EXTINF')) {
      const m = s.match(/#EXTINF:\s*([0-9.]+)/);
      if (m) {
        return parseFloat(m[1]);
      }
    }
  }
  return 0;
}

function fpsFitRate(durations: number[], fps: number): number {
  if (durations.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const d of durations) {
    if (d > 0 && Math.abs(d * fps - Math.round(d * fps)) <= FPS_TOLERANCE) {
      hits++;
    }
  }
  return hits / durations.length;
}

function bestFps(durations: number[]): number {
  let best = FPS_CANDIDATES[0];
  let bestRate = -1;
  for (const fps of FPS_CANDIDATES) {
    const rate = fpsFitRate(durations, fps);
    if (rate > bestRate) {
      bestRate = rate;
      best = fps;
    }
  }
  return best;
}

/**
 * 判断某分块是否来自与正片不同的转码（即被拼接进来的广告）：
 * 时长全部量化到另一个帧率，且几乎无法量化到正片帧率。
 */
function isDifferentEncodeBlock(
  durations: number[],
  dominantFps: number,
  dominantFit: number
): boolean {
  if (dominantFit < DOMINANT_FPS_MIN_FIT) {
    return false;
  }
  const total = durations.reduce((a, b) => a + b, 0);
  if (
    durations.length === 0 ||
    durations.length > MAX_DIFFERENT_ENCODE_SEGMENTS ||
    total > MAX_DIFFERENT_ENCODE_SECONDS
  ) {
    return false;
  }
  const blockFps = bestFps(durations);
  if (blockFps === dominantFps) {
    return false;
  }
  return (
    fpsFitRate(durations, blockFps) >= 0.9 &&
    fpsFitRate(durations, dominantFps) <= 0.5
  );
}

function resolveHostDir(
  uri: string,
  baseUrl: string
): { host: string; dir: string } {
  try {
    const url = baseUrl ? new URL(uri, baseUrl) : new URL(uri);
    const path = url.pathname;
    const idx = path.lastIndexOf('/');
    return { host: url.host, dir: idx >= 0 ? path.slice(0, idx) : '' };
  } catch {
    return { host: '', dir: '' };
  }
}

/**
 * 过滤 m3u8 内容，剔除结构上可判定为广告的分片。
 *
 * @param content m3u8 文本
 * @param baseUrl 请求该 m3u8 的地址，用于解析相对分片路径
 * @returns 过滤后的 m3u8 文本；无法判定或异常时返回原文
 */
export function filterAdsFromM3U8(content: string, baseUrl: string): string {
  if (!content) {
    return content;
  }

  // 必须以 #EXTM3U 开头才可能是媒体播放列表
  if (!content.trimStart().startsWith('#EXTM3U')) {
    return content;
  }

  // 主播放列表（多码率）只包含变体声明，不含分片，直接返回
  if (content.includes('#EXT-X-STREAM-INF')) {
    return content;
  }

  const lines = content.split('\n');
  const segments: SegmentInfo[] = [];
  let pendingTags: number[] = [];
  let pendingDiscontinuity = false;
  let keyMethod: string | null = null;
  let blockId = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // 空行或标签行：累积到 pendingTags，等待后续分片
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (isDiscontinuity(trimmed)) {
        pendingDiscontinuity = true;
      }
      if (isKeyTag(trimmed)) {
        const m = trimmed.match(/METHOD=([A-Z0-9-]+)/i);
        keyMethod = m ? m[1].toUpperCase() : null;
      }
      pendingTags.push(i);
      continue;
    }

    // 分片行
    if (segments.length === 0 || pendingDiscontinuity) {
      blockId++;
    }
    const { host, dir } = resolveHostDir(trimmed, baseUrl);
    segments.push({
      lineIndex: i,
      tagsBefore: pendingTags,
      host,
      dir,
      duration: parseDuration(pendingTags, lines),
      keyMethod,
      blockId,
    });
    pendingTags = [];
    pendingDiscontinuity = false;
  }

  if (segments.length === 0) {
    return content;
  }

  // 统计每个 host + 目录 组合的分片数量
  const signatureCount = new Map<string, number>();
  for (const seg of segments) {
    const sig = `${seg.host}${seg.dir}`;
    signatureCount.set(sig, (signatureCount.get(sig) ?? 0) + 1);
  }

  let dominantSig = '';
  let dominantCount = -1;
  signatureCount.forEach((count, sig) => {
    if (count > dominantCount) {
      dominantSig = sig;
      dominantCount = count;
    }
  });

  const globalHasAes = segments.some((s) => s.keyMethod === 'AES-128');

  // 全片帧率基准：时长量化一致的帧率
  const allDurations = segments.map((s) => s.duration);
  const dominantFps = bestFps(allDurations);
  const dominantFpsFit = fpsFitRate(allDurations, dominantFps);

  // 按块聚合（blockId 按出现顺序递增）
  const blocks = new Map<number, SegmentInfo[]>();
  for (const seg of segments) {
    const arr = blocks.get(seg.blockId);
    if (arr) {
      arr.push(seg);
    } else {
      blocks.set(seg.blockId, [seg]);
    }
  }

  // 判定广告块
  const adBlockIds = new Set<number>();
  blocks.forEach((segs, id) => {
    const blockSigCount = new Map<string, number>();
    for (const seg of segs) {
      const sig = `${seg.host}${seg.dir}`;
      blockSigCount.set(sig, (blockSigCount.get(sig) ?? 0) + 1);
    }
    let blockSig = '';
    let blockSigMax = -1;
    blockSigCount.forEach((count, sig) => {
      if (count > blockSigMax) {
        blockSig = sig;
        blockSigMax = count;
      }
    });

    const share = (signatureCount.get(blockSig) ?? 0) / segments.length;
    const foreign = blockSig !== dominantSig;
    const hasExplicitNone = segs.some((s) => s.keyMethod === 'NONE');
    const differentEncode = isDifferentEncodeBlock(
      segs.map((s) => s.duration),
      dominantFps,
      dominantFpsFit
    );

    if (
      (foreign && share < MINORITY_THRESHOLD) ||
      (hasExplicitNone && globalHasAes) ||
      differentEncode
    ) {
      adBlockIds.add(id);
    }
  });

  if (adBlockIds.size === 0) {
    return content;
  }

  // 计算需要删除的行
  const removedLines = new Set<number>();
  const blockOrder = Array.from(blocks.keys());

  for (let bi = 0; bi < blockOrder.length; bi++) {
    const id = blockOrder[bi];
    if (!adBlockIds.has(id)) {
      continue;
    }
    const segs = blocks.get(id) as SegmentInfo[];
    const first = segs[0];

    // 起始行：块内首个 splice 标签（DISCONTINUITY / KEY / EXTINF），
    // 否则退回到首个分片行。若无 splice 标签（如片头插入块），
    // 头部标签会被保留，仅删除 EXTINF 及其后的分片。
    let start = first.lineIndex;
    for (const li of first.tagsBefore) {
      const l = lines[li];
      if (isDiscontinuity(l) || isKeyTag(l) || isExtinfTag(l)) {
        start = li;
        break;
      }
    }
    const end = segs[segs.length - 1].lineIndex;
    for (let i = start; i <= end; i++) {
      removedLines.add(i);
    }

    // 广告块之后的正片块开头若带 DISCONTINUITY（广告回归边界），一并删除
    const nextId = blockOrder[bi + 1];
    if (nextId !== undefined && !adBlockIds.has(nextId)) {
      const nextFirst = (blocks.get(nextId) as SegmentInfo[])[0];
      for (const li of nextFirst.tagsBefore) {
        if (isDiscontinuity(lines[li])) {
          removedLines.add(li);
        }
      }
    }
  }

  // 兜底：不允许把全部分片都删光
  const keptSegments = segments.filter((s) => !removedLines.has(s.lineIndex));
  if (keptSegments.length === 0) {
    return content;
  }

  return lines.filter((_, i) => !removedLines.has(i)).join('\n');
}
