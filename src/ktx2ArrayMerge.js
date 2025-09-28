// ktx2ArrayMerge.browser.js
// ESM, browser-friendly. Assumes all inputs are UASTC and mutually compatible.
import { read, write } from 'ktx-parse';

/**
 * Merge multiple UASTC KTX2 buffers into a single 2D texture array.
 * Supports supercompression NONE (0) and ZSTD (2).
 */
export function mergeUASTCKTX2ToArray(buffers) {
    const containers = buffers.map((buf) => read(new Uint8Array(buf)));

    // Reference header (ktx-parse exposes fields at top-level)
    const H = containers[0];

    const w = H.pixelWidth;
    const h = H.pixelHeight;
    const lvls = H.levelCount;
    const scheme = H.supercompressionScheme; // 0 (NONE) or 2 (ZSTD)

    if (H.vkFormat !== 0) throw new Error('vkFormat must be 0 (Basis Universal/UASTC).');
    if (scheme !== 0 && scheme !== 2) throw new Error('Only supercompression NONE (0) or ZSTD (2) is supported.');

    // Validate compatibility
    for (let i = 1; i < containers.length; i++) {
        const hi = containers[i];
        if (
            hi.pixelWidth !== w ||
            hi.pixelHeight !== h ||
            hi.levelCount !== lvls ||
            hi.vkFormat !== 0 ||
            hi.supercompressionScheme !== scheme
        ) {
            throw new Error('All inputs must be UASTC KTX2 with identical size, mip count, and supercompression.');
        }
    }

    const layerCount = containers.length;
    const mergedLevels = new Array(lvls);

    // Exact UASTC bytes for one image at mip level (no ZSTD)
    const uastcBytesPerImageAtLevel = (level) => {
        const wL = Math.max(1, w >> level);
        const hL = Math.max(1, h >> level);
        const blocksX = Math.ceil(wL / 4);
        const blocksY = Math.ceil(hL / 4);
        return blocksX * blocksY * 16; // 16 bytes per 4x4 block
    };

    for (let level = 0; level < lvls; level++) {
        const parts = [];
        let totalUnc = 0;

        for (let layer = 0; layer < layerCount; layer++) {
            const src = containers[layer];
            const lvl = src.levels[level];
            const bytes = lvl.levelData;
            if (!bytes) throw new Error(`Missing levelData for layer ${layer}, level ${level}.`);

            if (scheme === 0) {
                // Trim to exact UASTC size (drop any end-of-level padding). Do NOT add per-image padding.
                const exact = uastcBytesPerImageAtLevel(level);
                if (bytes.byteLength < exact) {
                    throw new Error(`Layer ${layer} level ${level} smaller than expected UASTC size (${bytes.byteLength} < ${exact}).`);
                }
                parts.push(bytes.subarray(0, exact));
            } else {
                // ZSTD: keep compressed bytes; sum uncompressed
                parts.push(bytes);
                const unc = lvl.uncompressedByteLength ?? uastcBytesPerImageAtLevel(level);
                totalUnc += unc;
            }
        }

        // Concatenate layer payloads (order: layers → faces → depth; here layers only)
        let totalLen = 0;
        for (const p of parts) totalLen += p.byteLength;
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const p of parts) {
            merged.set(p, off);
            off += p.byteLength;
        }

        mergedLevels[level] = {
            levelData: merged,
            // Always set; for NONE this is exact concatenated size, for ZSTD the sum of uncompressed sizes
            uncompressedByteLength: (scheme === 0)
                ? totalLen
                : totalUnc
        };
    }

    // Build output container
    const out = {
        vkFormat: 0,
        typeSize: H.typeSize || 1,
        pixelWidth: w,
        pixelHeight: h,
        pixelDepth: 0,
        layerCount,
        faceCount: 1,
        levelCount: lvls,
        supercompressionScheme: scheme,
        dataFormatDescriptor: H.dataFormatDescriptor,
        keyValue: H.keyValue || {},
        globalData: null, // UASTC: no supercompression global data
        levels: mergedLevels
    };

    // Optional sanity check for NONE: each level should equal layerCount * exact UASTC size
    if (scheme === 0) {
        for (let level = 0; level < lvls; level++) {
            const expect = layerCount * uastcBytesPerImageAtLevel(level);
            if (out.levels[level].levelData.byteLength !== expect) {
                console.warn(`Level ${level} size mismatch: got ${out.levels[level].levelData.byteLength}, expected ${expect}`);
            }
        }
    }

    const written = write(out);
    return written.buffer;
}
