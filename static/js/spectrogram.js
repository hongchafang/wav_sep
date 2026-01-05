/**
 * spectrogram.js
 * 负责绘制 2D 频谱图 (含坐标轴) - 修复回放拉伸 Bug
 */

import { CHUNKS_DISPLAYED, CHUNK_DUR, LAYOUT } from './config.js';
import { drawTimeGrid } from './waveform.js';

// === 1. 颜色渐变 (保持不变) ===
const COLOR_STOPS = [
    [0.00, 255, 255, 255],
    [0.25, 186, 230, 253],
    [0.50, 59,  130, 246],
    [0.75, 124, 58,  237],
    [1.00, 220, 38,  38]
];

function lerp(start, end, t) { return start + (end - start) * t; }

function getGradientColor(value) {
    const v = Math.max(0, Math.min(1, value));
    let lower = COLOR_STOPS[0];
    let upper = COLOR_STOPS[COLOR_STOPS.length - 1];
    
    for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
        if (v >= COLOR_STOPS[i][0] && v <= COLOR_STOPS[i+1][0]) {
            lower = COLOR_STOPS[i];
            upper = COLOR_STOPS[i+1];
            break;
        }
    }
    const range = upper[0] - lower[0];
    const t = range === 0 ? 0 : (v - lower[0]) / range;
    const r = Math.floor(lerp(lower[1], upper[1], t));
    const g = Math.floor(lerp(lower[2], upper[2], t));
    const b = Math.floor(lerp(lower[3], upper[3], t));
    return `rgb(${r},${g},${b})`;
}

// === 2. 坐标轴绘制 (保持不变) ===
function drawSpecAxes(ctx, w, h) {
    const { paddingLeft, paddingBottom, sampleRate } = LAYOUT;
    const drawH = h - paddingBottom;
    const maxFreq = sampleRate / 2;

    ctx.save();
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px Inter";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#e5e7eb";

    ctx.beginPath(); ctx.moveTo(paddingLeft, 0); ctx.lineTo(paddingLeft, drawH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(paddingLeft, drawH); ctx.lineTo(w, drawH); ctx.stroke();

    const labels = [
        { val: maxFreq, y: 0, text: (maxFreq/1000) + "k" },
        { val: maxFreq/2, y: drawH/2, text: (maxFreq/2000) + "k" },
        { val: 0, y: drawH, text: "0" }
    ];

    labels.forEach(lbl => {
        let ty = lbl.y;
        if(ty === 0) ty += 6;
        if(ty === drawH) ty -= 6;
        
        ctx.fillText(lbl.text, paddingLeft - 6, ty);
        ctx.beginPath(); ctx.moveTo(paddingLeft-4, lbl.y); ctx.lineTo(paddingLeft, lbl.y); ctx.stroke();
    });
    
    ctx.restore();
}

// === 3. 核心绘制逻辑 ===
function drawSpectrogramRects(ctx, dataCols, xStart, width, height) {
    if (!dataCols || dataCols.length === 0) return;

    const numTimeSteps = dataCols.length;
    // pixelWidth 是根据传入的 width 和 数据长度计算的
    // 在修复后，传入的 width 将与 length 成正比，保证 pixelWidth 恒定
    const pixelWidth = width / numTimeSteps;
    const drawW = pixelWidth < 0.5 ? 0.5 : pixelWidth + 0.8;

    for (let t = 0; t < numTimeSteps; t++) {
        const freqs = dataCols[t];
        if (!freqs) continue;
        const numFreqs = freqs.length;
        const cellHeight = height / numFreqs;
        const x = xStart + t * pixelWidth;

        for (let f = 0; f < numFreqs; f++) {
            const val = freqs[f];
            const y = height - (f + 1) * cellHeight;
            
            ctx.fillStyle = getGradientColor(val);
            ctx.fillRect(x, y, drawW, cellHeight + 0.5);
        }
    }
}

// === 4. 实时模式 (保持不变) ===
export function drawLiveSpectrogramByKey(ctx, chunks, key, offsetSlots) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const drawW = w - paddingLeft;
    const drawH = h - paddingBottom;
    
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    
    drawSpecAxes(ctx, w, h);

    const chunkW = drawW / CHUNKS_DISPLAYED;
    
    ctx.save();
    ctx.beginPath(); ctx.rect(paddingLeft, 0, drawW, drawH); ctx.clip();

    chunks.forEach((c, i) => {
        const spec = c[key];
        if (!spec || spec.length === 0) return;
        const xOffset = paddingLeft + (i + offsetSlots) * chunkW;
        drawSpectrogramRects(ctx, spec, xOffset, chunkW, drawH);
    });
    ctx.restore();
}

// === 5. 回放模式 (修复拉伸 Bug) ===
export function renderPlaybackSpectrogram(ctx, currentTime, fullSpecData, totalDuration) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const drawW = w - paddingLeft;
    const drawH = h - paddingBottom;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    drawSpecAxes(ctx, w, h);

    const win = CHUNKS_DISPLAYED * CHUNK_DUR;
    const tStart = Math.max(0, currentTime - win/2);
    
    if (fullSpecData && fullSpecData.length > 0) {
        const totalSteps = fullSpecData.length;
        const safeDur = totalDuration > 0 ? totalDuration : 1;
        
        // 1. 计算总的频谱采样率 (steps per second)
        const specSR = totalSteps / safeDur;

        // 2. 计算当前可视窗口 (Window) 理论上应该包含多少个 TimeStep
        // 这样可以得出一个固定的“每步宽度”
        const winSteps = win * specSR;

        // 3. 计算每个 TimeStep 在屏幕上的像素宽度
        // drawW 是整个视窗的像素宽
        const pixelWidth = drawW / winSteps;

        const iStart = Math.floor(tStart * specSR);
        const iEnd = Math.floor((tStart + win) * specSR);
        
        // 4. 获取实际数据切片 (可能比 winSteps 少，比如在结尾时)
        const slice = fullSpecData.slice(Math.max(0, iStart), Math.min(totalSteps, iEnd));
        
        // 5. [关键修复] 计算这个 slice 实际应该占据的屏幕宽度
        // 而不是让它填满整个 drawW
        const drawWidthForSlice = slice.length * pixelWidth;

        ctx.save();
        ctx.beginPath(); ctx.rect(paddingLeft, 0, drawW, drawH); ctx.clip();
        
        // 传入计算出的比例宽度
        drawSpectrogramRects(ctx, slice, paddingLeft, drawWidthForSlice, drawH);
        
        ctx.restore();
    }

    drawTimeGrid(ctx, w, h, win, tStart);
    
    const pxPerSec = drawW / win;
    const phX = paddingLeft + (currentTime - tStart) * pxPerSec;

    if(phX >= paddingLeft) {
        ctx.beginPath();
        ctx.moveTo(phX, 0); ctx.lineTo(phX, drawH);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}
