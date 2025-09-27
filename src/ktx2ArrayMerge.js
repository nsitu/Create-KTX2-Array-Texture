// ktx2ArrayMerge.browser.js
// ESM, browser-friendly. Assumes all inputs are UASTC and mutually compatible.
import { read, write } from "ktx-parse";

/**
 * Merge multiple UASTC KTX2 buffers into a single 2D texture array.
 * @param {Array<ArrayBuffer|Uint8Array>} buffers - List of KTX2 files as raw bytes.
 * @returns {ArrayBuffer} - A single KTX2 (UASTC) file as ArrayBuffer.
 */
export function mergeUASTCKTX2ToArray(buffers) {
    if (!buffers || buffers.length === 0) {
        throw new Error("Provide at least one KTX2 buffer.");
    }

    // Normalize to Uint8Array and parse
    const inputs = buffers.map((b, i) => {
        const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
        try {
            return read(u8);
        } catch (e) {
            throw new Error(`Failed to read KTX2 at index ${i}: ${e.message}`);
        }
    });

    validateCompatibility(inputs);

    const outContainer = buildArrayContainer(inputs);

    // write() returns Uint8Array; convert to ArrayBuffer for three.js KTX2Loader.parse
    const outU8 = write(outContainer);
    return outU8.buffer.slice(outU8.byteOffset, outU8.byteOffset + outU8.byteLength);
}

/* -------------------------- internals --------------------------- */

function u8eq(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
}

function describeHeader(h) {
    return JSON.stringify(
        {
            pixelWidth: h.pixelWidth,
            pixelHeight: h.pixelHeight,
            pixelDepth: h.pixelDepth,
            layerCount: h.layerCount,
            faceCount: h.faceCount,
            levelCount: h.levelCount,
            supercompressionScheme: h.supercompressionScheme,
            vkFormat: h.vkFormat,
            typeSize: h.typeSize,
        },
        null,
        0
    );
}

function validateCompatibility(ktxs) {
    // console.log(ktxs);
    const ref = ktxs[0];
    // ktx-parse v1.x exposes header fields at top-level; older shapes may use container.header
    const H = ref.header || ref;

    if (H.faceCount !== 1) throw new Error("Only 2D textures supported (faceCount must be 1).");
    if (H.pixelDepth !== 0 && H.pixelDepth !== 1)
        throw new Error("Only 2D textures supported (pixelDepth must be 0/1).");

    const refDFD = ref.dataFormatDescriptor || ref.dfd || null;

    for (let i = 1; i < ktxs.length; i++) {
        const K = ktxs[i];
        const h = K.header || K;

        const mismatch =
            h.pixelWidth !== H.pixelWidth ||
            h.pixelHeight !== H.pixelHeight ||
            h.pixelDepth !== H.pixelDepth ||
            h.levelCount !== H.levelCount ||
            h.vkFormat !== H.vkFormat ||
            h.supercompressionScheme !== H.supercompressionScheme ||
            h.typeSize !== H.typeSize ||
            h.faceCount !== 1;

        if (mismatch) {
            throw new Error(
                `Header mismatch at input #${i}: got ${describeHeader(h)} vs ref ${describeHeader(H)}`
            );
        }

        const dfd = K.dataFormatDescriptor || K.dfd || null;
        if (!!refDFD !== !!dfd || (refDFD && dfd && !u8eq(refDFD, dfd))) {
            throw new Error(`DFD mismatch at input #${i}.`);
        }
    }
}

function buildArrayContainer(ktxs) {
    const ref = ktxs[0];
    const H = ref.header || ref;
    const levelCount = H.levelCount;
    const layerCount = ktxs.length;

    const outLevels = new Array(levelCount).fill(null).map(() => ({ levelData: null, uncompressedByteLength: 0 }));

    // For each mip level, concatenate payloads across layers (order: layer -> face(0) -> z(0))
    for (let lvl = 0; lvl < levelCount; lvl++) {
        const chunks = [];
        let total = 0;
        let totalUncompressed = 0;
        for (let l = 0; l < layerCount; l++) {
            const srcLevel = ktxs[l].levels[lvl];
            if (!srcLevel || !srcLevel.levelData) {
                throw new Error(`Missing level ${lvl} data in input layer ${l}.`);
            }
            chunks.push(srcLevel.levelData);
            total += srcLevel.levelData.byteLength;
            if (typeof srcLevel.uncompressedByteLength === 'number') {
                totalUncompressed += srcLevel.uncompressedByteLength;
            }
        }
        const merged = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
            merged.set(c, o);
            o += c.byteLength;
        }
        const outLevel = { levelData: merged };
        if (totalUncompressed > 0) outLevel.uncompressedByteLength = totalUncompressed;
        outLevels[lvl] = outLevel;
    }

    // Build container in the shape expected by ktx-parse v1.x (fields at top-level)
    return {
        // Header fields
        vkFormat: H.vkFormat,
        typeSize: H.typeSize,
        pixelWidth: H.pixelWidth,
        pixelHeight: H.pixelHeight,
        pixelDepth: 0, // ensure 2D array
        layerCount,
        faceCount: 1,
        levelCount,
        supercompressionScheme: H.supercompressionScheme,

        // Data blocks
        dataFormatDescriptor: ref.dataFormatDescriptor || ref.dfd || null,
        keyValue: ref.keyValue || null, // copy KV from first source (customize as needed)
        globalData: null, // UASTC doesn't use BasisLZ global codebooks
        levels: outLevels,
    };
}
