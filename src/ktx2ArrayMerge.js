// ktx2ArrayMerge.browser.js
// Merge multiple UASTC KTX2 buffers into a single 2D texture array.
// Supports supercompression NONE (0) and ZSTD (2).
import { read, write } from 'ktx-parse';

export function mergeUASTCKTX2ToArray(buffers) {
    const containers = buffers.map((buf) => read(new Uint8Array(buf)));

    const H = containers[0];
    const w = H.pixelWidth;
    const h = H.pixelHeight;
    const lvls = H.levelCount;
    const scheme = H.supercompressionScheme; // 0 (NONE) or 2 (ZSTD)

    if (H.vkFormat !== 0) throw new Error('vkFormat must be 0 (Basis UASTC).');
    if (scheme !== 0 && scheme !== 2) throw new Error('Only supercompression NONE (0) or ZSTD (2) is supported.');
    for (let i = 1; i < containers.length; i++) {
        const hi = containers[i];
        if (
            hi.pixelWidth !== w ||
            hi.pixelHeight !== h ||
            hi.levelCount !== lvls ||
            hi.vkFormat !== 0 ||
            hi.supercompressionScheme !== scheme
        ) throw new Error('All inputs must be UASTC KTX2 with identical size, mip count, and supercompression.');
    }

    const layerCount = containers.length;
    const mergedLevels = new Array(lvls);

    const uastcBytesPerImageAtLevel = (level) => {
        const wL = Math.max(1, w >> level);
        const hL = Math.max(1, h >> level);
        const blocksX = Math.ceil(wL / 4);
        const blocksY = Math.ceil(hL / 4);
        return blocksX * blocksY * 16; // 16 bytes per 4x4 block
    };
    const pad8 = (n) => (8 - (n % 8)) % 8; // KTX2 uses 8-byte alignment for image slices

    for (let level = 0; level < lvls; level++) {
        const parts = [];
        let totalUnc = 0;

        for (let layer = 0; layer < layerCount; layer++) {
            const src = containers[layer];
            const lvl = src.levels[level];
            const bytes = lvl.levelData;
            if (!bytes) throw new Error(`Missing levelData for layer ${layer}, level ${level}.`);

            if (scheme === 0) {
                const exact = uastcBytesPerImageAtLevel(level);
                if (bytes.byteLength < exact) {
                    throw new Error(`Layer ${layer} level ${level} smaller than expected UASTC size (${bytes.byteLength} < ${exact}).`);
                }
                const trimmed = bytes.subarray(0, exact);
                const p = pad8(trimmed.byteLength);
                if (p) {
                    const padded = new Uint8Array(trimmed.byteLength + p);
                    padded.set(trimmed, 0);
                    parts.push(padded);
                } else {
                    parts.push(trimmed);
                }
            } else {
                // ZSTD: keep compressed bytes; sum uncompressed
                parts.push(bytes);
                const unc = lvl.uncompressedByteLength ?? uastcBytesPerImageAtLevel(level);
                totalUnc += unc;
            }
        }

        // Concatenate layer payloads (order: layers → faces → depth)
        let totalLen = 0;
        for (const p of parts) totalLen += p.byteLength;
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.byteLength; }

        mergedLevels[level] = {
            levelData: merged,
            // Always set: for NONE equals concatenated size (including per-image 8B padding)
            uncompressedByteLength: (scheme === 0) ? totalLen : totalUnc
        };

        // Sanity log
        if (scheme === 0) {
            const expectPerImage = uastcBytesPerImageAtLevel(level);
            const perImageWithPad = expectPerImage + pad8(expectPerImage);
            const expectTotal = perImageWithPad * layerCount;
            if (merged.byteLength !== expectTotal) {
                console.warn(
                    `Level ${level} size mismatch: got ${merged.byteLength}, expected ${expectTotal} = ` +
                    `${layerCount} * (image ${expectPerImage} + pad ${pad8(expectPerImage)})`
                );
            } else {
                console.log(`Level ${level}: ${merged.byteLength} bytes OK (${layerCount} slices @ ${perImageWithPad}).`);
            }
        }
    }

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
        globalData: null,
        levels: mergedLevels
    };

    const written = write(out);
    return written.buffer;
}
