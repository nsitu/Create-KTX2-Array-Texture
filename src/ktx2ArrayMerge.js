// ktx2ArrayMerge.browser.js
// ESM, browser-friendly. Assumes all inputs are UASTC and mutually compatible.
import { read, write } from 'ktx-parse';

/**
 * Merge multiple UASTC KTX2 buffers into a single 2D texture array.
 * Supports supercompression NONE (0) and ZSTD (2).
 * @param {Array<ArrayBuffer|Uint8Array>} buffers - List of KTX2 files as raw bytes.
 * @returns {ArrayBuffer} - A single KTX2 (UASTC) file as ArrayBuffer.
 */
export function mergeUASTCKTX2ToArray(buffers) {
    const containers = buffers.map((buf) => read(new Uint8Array(buf)));

    // Use first as reference and validate basics
    const ref = containers[0];
    const H = ref.header || ref;

    const w = H.pixelWidth;
    const h = H.pixelHeight;
    const lvls = H.levelCount;
    const scheme = H.supercompressionScheme; // 0 (NONE) or 2 (ZSTD)

    if (H.vkFormat !== 0) {
        throw new Error('vkFormat must be 0 (Basis Universal).');
    }
    if (scheme !== 0 && scheme !== 2) {
        throw new Error('Only supercompression NONE (0) or ZSTD (2) is supported.');
    }

    for (let i = 1; i < containers.length; i++) {
        const hi = containers[i].header || containers[i];
        if (
            hi.pixelWidth !== w ||
            hi.pixelHeight !== h ||
            hi.levelCount !== lvls ||
            hi.vkFormat !== 0 ||
            hi.supercompressionScheme !== scheme
        ) {
            throw new Error('All inputs must be BasisU KTX2 with identical size, mip count, and supercompression.');
        }
    }

    const layerCount = containers.length;
    const mergedLevels = new Array(lvls);

    // UASTC bytes per mip for one layer (no ZSTD), used as a fallback if needed.
    const uastcBytesPerLayerAtLevel = (level) => {
        const wL = Math.max(1, w >> level);
        const hL = Math.max(1, h >> level);
        const blocksX = Math.ceil(wL / 4);
        const blocksY = Math.ceil(hL / 4);
        return blocksX * blocksY * 16; // 16 bytes per 4x4 block
    };

    // Build levels (concatenate the per-layer payloads for each mip)
    for (let level = 0; level < lvls; level++) {
        const parts = [];
        let totalUnc = 0;

        for (let layer = 0; layer < layerCount; layer++) {
            const src = containers[layer];
            const sH = src.header || src;
            const lvl = sH.levels[level];

            const bytes = lvl.levelData;
            if (!bytes) {
                throw new Error(`Missing levelData for layer ${layer}, level ${level}.`);
            }
            parts.push(bytes);

            // For ZSTD inputs, uncompressedByteLength must be summed across layers.
            // For NONE, writer doesn't use it — omit in that case.
            if (scheme === 2) {
                const unc = lvl.uncompressedByteLength ?? uastcBytesPerLayerAtLevel(level);
                totalUnc += unc;
            }
        }

        // Concatenate compressed/uncompressed chunks (as they appear in inputs)
        let totalLen = 0;
        for (const p of parts) totalLen += p.byteLength;
        const merged = new Uint8Array(totalLen);
        let wptr = 0;
        for (const p of parts) {
            merged.set(p, wptr);
            wptr += p.byteLength;
        }

        mergedLevels[level] = (scheme === 2)
            ? { levelData: merged, uncompressedByteLength: totalUnc }
            : { levelData: merged };
    }

    // Output container with correct top-level header shape expected by ktx-parse v1.x
    const out = {
        vkFormat: 0,
        typeSize: H.typeSize || 1,
        pixelWidth: H.pixelWidth,
        pixelHeight: H.pixelHeight,
        pixelDepth: 0,
        layerCount,
        faceCount: 1,
        levelCount: lvls,
        supercompressionScheme: scheme,
        dataFormatDescriptor: H.dataFormatDescriptor,
        keyValue: H.keyValue || {},
        // For UASTC, globalData must be null (ETC1S uses globalData).
        globalData: null,
        levels: mergedLevels
    };

    const written = write(out);
    return written.buffer;
}
