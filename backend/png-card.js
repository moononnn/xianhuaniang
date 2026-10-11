// 鲜花酿 v2 · PNG 角色卡编码
// 把角色卡 JSON 写进标准 PNG 的 tEXt 块（chara + ccv3），酒馆导入时直接认这张图。
// 纯标准库实现：v2 App 子进程装不了 v1 那份 jimp 依赖，头像只收已经是 PNG 的字节。

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function isPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < PNG_SIGNATURE.length) return false;
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** 清掉角色卡和其他自定义元数据，只保留标准图像/色彩块。 */
export function stripPngRoleCardMetadata(png) {
  if (!isPng(png)) return null;
  const chunks = [PNG_SIGNATURE];
  const allowedChunks = new Set([
    "IHDR", "PLTE", "IDAT", "IEND",
    "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "bKGD", "pHYs",
    "tEXt", "iTXt", "zTXt", "eXIf", "tIME",
  ]);
  const droppedMetadata = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let hasHeader = false;
  let hasImageData = false;
  let hasEnd = false;
  while (offset + 12 <= png.length && ++chunkCount <= 10000) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) return null;
    const type = png.toString("ascii", offset + 4, offset + 8);
    const checksum = png.readUInt32BE(end - 4);
    if (crc32(png.subarray(offset + 4, end - 4)) !== checksum || !allowedChunks.has(type)) return null;
    if (!hasHeader && (type !== "IHDR" || offset !== PNG_SIGNATURE.length || length !== 13)) return null;
    if (type === "IHDR") {
      if (hasHeader) return null;
      const width = png.readUInt32BE(offset + 8);
      const height = png.readUInt32BE(offset + 12);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) return null;
      hasHeader = true;
    }
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || !hasImageData) return null;
      hasEnd = true;
      chunks.push(png.subarray(offset, end));
      break;
    }
    if (!droppedMetadata.has(type)) chunks.push(png.subarray(offset, end));
    offset = end;
  }
  return hasHeader && hasImageData && hasEnd ? Buffer.concat(chunks) : null;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuffer.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return out;
}

function makeTextChunk(keyword, value) {
  return makeChunk("tEXt", Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]),
    Buffer.from(value, "latin1"),
  ]));
}

/** 拆出 PNG 里的角色卡：优先 ccv3，回落 chara。 */
export function readEmbeddedCard(png) {
  if (!isPng(png)) return null;
  const found = new Map();
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) break;
    if (type === "tEXt") {
      const payload = png.subarray(offset + 8, end);
      const separator = payload.indexOf(0);
      if (separator > 0) {
        const keyword = payload.toString("latin1", 0, separator).toLowerCase();
        if (keyword === "chara" || keyword === "ccv3") {
          try {
            const json = Buffer.from(payload.toString("latin1", separator + 1), "base64").toString("utf8");
            found.set(keyword, JSON.parse(json));
          } catch {
            // 元数据坏了就当这张卡不存在，不猜内容。
          }
        }
      }
    }
    offset = end;
    if (type === "IEND") break;
  }
  return found.get("ccv3") || found.get("chara") || null;
}

/**
 * 把角色卡 JSON 嵌入头像 PNG。
 * 原有像素块原样保留，只换掉可能存在的旧 chara/ccv3 元数据。
 */
export function embedCharacterCardPng(avatarPng, card) {
  if (!isPng(avatarPng)) throw new Error("头像必须是 PNG。");
  const encoded = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  const v3Card = { ...card, spec: "chara_card_v3", spec_version: "3.0" };
  const encodedV3 = Buffer.from(JSON.stringify(v3Card), "utf8").toString("base64");

  const chunks = [];
  let offset = 8;
  let foundIend = false;
  while (offset + 12 <= avatarPng.length) {
    const length = avatarPng.readUInt32BE(offset);
    const type = avatarPng.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > avatarPng.length) throw new Error("PNG 结构不完整，无法写入角色卡。");
    if (type === "tEXt") {
      const payload = avatarPng.subarray(offset + 8, end);
      const separator = payload.indexOf(0);
      const keyword = separator > 0 ? payload.toString("latin1", 0, separator).toLowerCase() : "";
      if (keyword === "chara" || keyword === "ccv3") {
        offset = end; // 丢掉旧元数据
        continue;
      }
    }
    if (type === "IEND") {
      chunks.push(makeTextChunk("chara", encoded));
      chunks.push(makeTextChunk("ccv3", encodedV3));
      foundIend = true;
    }
    chunks.push(avatarPng.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  if (!foundIend) throw new Error("PNG 缺少 IEND，无法写入角色卡。");
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}
