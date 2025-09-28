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

    if (H.vkFormat !== 0) throw new Error('vkFormat must be 0 (Basis Universal).');
    if (scheme !== 0 && scheme !== 2) throw new Error('Only supercompression NONE (0) or ZSTD (2) is supported.');

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
    const imageDescs = [];

    // Exact UASTC bytes per mip for one image (scheme NONE)
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
        let offset = 0; // offset within the uncompressed stream for this level

        // For NONE we’ll trim each layer’s data to the exact UASTC image size to drop any level padding
        const exactUastc = (scheme === 0) ? uastcBytesPerLayerAtLevel(level) : undefined;

        for (let layer = 0; layer < layerCount; layer++) {
            const src = containers[layer];
            const sH = src.header || src;
            const lvl = sH.levels[level];
            const bytes = lvl.levelData;
            if (!bytes) throw new Error(`Missing levelData for layer ${layer}, level ${level}.`);

            if (scheme === 0) {
                if (bytes.byteLength < exactUastc) {
                    throw new Error(`Layer ${layer} level ${level} is smaller than expected UASTC size (${bytes.byteLength} < ${exactUastc}).`);
                }
                // Trim off any end-of-level padding from the source KTX2
                const trimmed = bytes.subarray(0, exactUastc);
                parts.push(trimmed);

                // Describe where this image lives in the (uncompressed) level stream
                imageDescs.push({
                    imageFlags: 0,
                    rgbByteOffset: offset,
                    rgbByteLength: exactUastc,
                    alphaByteOffset: 0,
                    alphaByteLength: 0
                });
                offset += exactUastc;
            } else {
                // ZSTD: use compressed bytes as-is, sum uncompressed size and record desc
                parts.push(bytes);
                const unc = lvl.uncompressedByteLength ?? uastcBytesPerLayerAtLevel(level);
                imageDescs.push({
                    imageFlags: 0,
                    rgbByteOffset: offset,
                    rgbByteLength: unc,
                    alphaByteOffset: 0,
                    alphaByteLength: 0
                });
                offset += unc;
                totalUnc += unc;
            }
        }

        // Concatenate chunks
        let totalLen = 0;
        for (const p of parts) totalLen += p.byteLength;
        const merged = new Uint8Array(totalLen);
        let wptr = 0;
        for (const p of parts) {
            merged.set(p, wptr);
            wptr += p.byteLength;
        }

        mergedLevels[level] = {
            levelData: merged,
            // Required: total bytes in the (uncompressed) level stream
            uncompressedByteLength: (scheme === 0) ? totalLen : totalUnc
        };
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
        // Critical for BasisU arrays: split the uncompressed level stream into per-image slices
        globalData: { imageDescs },
        levels: mergedLevels
    };

    const written = write(out);
    return written.buffer;
}
