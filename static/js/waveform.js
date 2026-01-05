/**
 * waveform.js
 * 修复版：Tag防重叠 + 折叠/展开 + 内置点击检测
 */

import { CHUNKS_DISPLAYED, CHUNK_DUR, LAYOUT } from './config.js';

// ... (drawWaveAxes, drawTimeGrid 保持不变，请保留) ...
// --------------------------------------------------------------------
// 请保留 drawWaveAxes 和 drawTimeGrid 函数
// --------------------------------------------------------------------
export function drawWaveAxes(ctx, w, h) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const drawH = h - paddingBottom;
    ctx.save();
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px Inter";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(paddingLeft, 0); ctx.lineTo(paddingLeft, drawH); ctx.stroke();
    const ticks = [1.0, 0.5, 0.0, -0.5, -1.0];
    ticks.forEach(val => {
        const y = (drawH / 2) - (val * (drawH / 2) * 0.9);
        ctx.fillText(val.toFixed(1), paddingLeft - 6, y);
        ctx.beginPath(); ctx.moveTo(paddingLeft - 4, y); ctx.lineTo(paddingLeft, y); ctx.stroke();
    });
    ctx.beginPath(); ctx.moveTo(paddingLeft, drawH); ctx.lineTo(w, drawH); ctx.stroke();
    ctx.restore();
}

export function drawTimeGrid(ctx, w, h, duration, timeOffset = 0) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const drawW = w - paddingLeft;
    const step = 0.5;
    const pxPerSec = drawW / duration;
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(0,0,0,0.05)";
    ctx.fillStyle = "#9ca3af"; ctx.font = "9px Inter"; ctx.textAlign = "center";
    const epsilon = 0.001;
    let t = Math.ceil((timeOffset - epsilon) / step) * step;
    while(t <= timeOffset + duration + epsilon) {
        const x = paddingLeft + (t - timeOffset) * pxPerSec;
        if(x >= paddingLeft - 1 && x <= w + 1) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - paddingBottom); ctx.stroke();
            if (Math.abs(t % 2) < 0.1) ctx.fillText(Math.round(t) + "s", x, h - 8);
        }
        t += step;
    }
    ctx.restore();
}

// ==============================
// 3. Tag 核心逻辑 (折叠 + 点击 + 防重叠)
// ==============================

// 辅助：获取短文本 (折叠态)
function getShortLabel(text) {
    const firstWord = text.split(' ')[0];
    return text.includes(' ') ? firstWord + ".." : firstWord;
}

// 绘制单个 Label 并返回其宽度
function drawTagBox(ctx, x, y, text, isHit, isExpanded) {
    ctx.save();
    ctx.font = "500 10px Inter, sans-serif";
    const tm = ctx.measureText(text);
    const p = 6;
    const labelW = tm.width + p*2;
    const labelH = 16;
    
    // 如果需要居中：x = x - labelW / 2
    // 但为了防重叠排列简单，我们这里使用【左对齐】递增模式
    // 如果你坚持要居中且不重叠，计算会非常复杂。
    // 建议方案：第一个Tag居中，后续Tag紧跟其后。
    
    // 样式：Hit为蓝色，展开为深灰，普通为白
    if (isHit) {
        ctx.fillStyle = "#3b82f6"; ctx.strokeStyle = "#3b82f6";
    } else if (isExpanded) {
        ctx.fillStyle = "#e5e7eb"; ctx.strokeStyle = "#d1d5db"; // 展开态背景稍灰
    } else {
        ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#e5e7eb";
    }
    
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(x, y, labelW, labelH, 6); // 胶囊圆角
    else ctx.rect(x, y, labelW, labelH);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.stroke();
    
    ctx.fillStyle = isHit ? "#ffffff" : "#374151";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + p, y + labelH/2 + 1);
    
    ctx.restore();
    
    // 返回尺寸用于碰撞检测和排版
    return { w: labelW, h: labelH };
}

/**
 * 统一的 Tag 绘制与交互函数
 * @param clickInput: {x, y} | null —— 这一帧鼠标有没有点击
 * @param expandedState: 当前展开的是哪个 {id, index}
 * @returns: 如果发生了有效点击，返回新的 {chunkId, tagIndex}，否则返回 null
 */
function drawTagsLogic(ctx, chunks, offsetSlots, targetTag, clickInput, expandedState, isPlayback, tStart, duration) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const drawW = w - paddingLeft;
    const chunkW = drawW / CHUNKS_DISPLAYED;
    const pxPerSec = drawW / duration; // playback 用
    
    const tagY = h - paddingBottom + 4;
    let newExpandState = null; // 这一帧如果触发了点击，由于返回值

    chunks.forEach((c, i) => {
        // 1. 筛选奇数秒 (chunk_id % 4 == 2)
        // 兼容 playback 的 metadataBuffer 结构(有time字段) 和 live chunks 结构
        let chunkId = c.chunk_id !== undefined ? c.chunk_id : i;
        let timeCheck = false;

        if (isPlayback) {
            // Playback 使用 time 判断
            if (Math.abs((c.time % 2) - 1.0) < 0.1) timeCheck = true;
        } else {
            // Live 使用 chunkId 判断
            if (chunkId % 4 === 2) timeCheck = true;
        }

        if (!timeCheck) return;
        if (!c.tags || c.tags.length === 0) return;

        // 2. 计算起始 X
        let currentX;
        if (isPlayback) {
            currentX = paddingLeft + (c.time - tStart) * pxPerSec;
        } else {
            currentX = paddingLeft + (i + offsetSlots) * chunkW;
        }

        // 居中修正：先把 X 往左移一点，让第一个 Tag 看起来居中
        // (粗略估算：假设第一个折叠Tag宽40px，向左移20px)
        currentX -= 20;

        // 3. 遍历 Tag
        c.tags.forEach((tag, idx) => {
            if (tag === 'Silence') return;
            
            // 状态判断
            const isHit = tag.toLowerCase().includes(targetTag);
            const isExpanded = (expandedState.chunkId === chunkId && expandedState.tagIndex === idx);
            
            // 文本内容：展开显示全称，折叠显示首词
            const displayText = isExpanded ? tag : getShortLabel(tag);

            // 边界优化：如果超出屏幕太远就不画了
            if (currentX > w || currentX < paddingLeft - 100) return;

            // **核心绘制**
            const size = drawTagBox(ctx, currentX, tagY, displayText, isHit, isExpanded);
            
            // **核心交互：即时点击检测**
            // 既然我们知道了 currentX, tagY, size.w, size.h，直接判断鼠标 clickInput 是否在这里
            if (clickInput) {
                if (clickInput.x >= currentX && clickInput.x <= currentX + size.w &&
                    clickInput.y >= tagY && clickInput.y <= tagY + size.h) {
                    
                    // 命中了！
                    // 如果已经是展开的，就折叠；否则展开
                    if (isExpanded) {
                        newExpandState = { chunkId: null, tagIndex: -1 };
                    } else {
                        newExpandState = { chunkId: chunkId, tagIndex: idx };
                    }
                }
            }

            // **防重叠核心**：画完这个，X 坐标往右移，下一个 Tag 紧贴着画
            currentX += (size.w + 4); // +4px 间距
        });
    });

    return newExpandState;
}

// 导出 Live 接口
export function drawLiveTags(ctx, chunks, offsetSlots, targetTag, clickInput, expandedState) {
    return drawTagsLogic(ctx, chunks, offsetSlots, targetTag, clickInput, expandedState, false, 0, 0);
}

// 导出 Playback 接口
export function drawPlaybackTags(ctx, w, tStart, duration, metadataBuffer, targetTag, clickInput, expandedState) {
    return drawTagsLogic(ctx, metadataBuffer, 0, targetTag, clickInput, expandedState, true, tStart, duration);
}

// ... (drawRadar, drawLiveLine, drawLiveArray 保持不变) ...
// --------------------------------------------------------------------
// 请保留 drawRadar, drawLiveLine, drawLiveArray, renderPlaybackSingle 等函数
// --------------------------------------------------------------------
export function drawRadar(ctx, angle, db, type) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const cx = w/2, cy = h/2;
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle='#e9ecef'; ctx.lineWidth=1;
    [0.33, 0.66, 0.9].forEach(r => { ctx.beginPath(); ctx.arc(cx, cy, (w/2-20)*r, 0, Math.PI*2); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(cx,20); ctx.lineTo(cx,h-20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(20,cy); ctx.lineTo(w-20,cy); ctx.stroke();
    ctx.font="11px Inter"; ctx.fillStyle="#9ca3af"; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("90°(前)", cx, 10); ctx.fillText("0°", w-10, cy); ctx.fillText("180°", 10, cy);

    if(angle !== null && angle !== undefined) {
        const maxR = w/2 - 25;
        const minDb = -60; const maxDb = -5;
        const val = db !== undefined ? db : minDb;
        let ratio = (val - minDb) / (maxDb - minDb);
        ratio = Math.max(0, Math.min(1, ratio));
        const lenFactor = 0.3 + (0.7 * ratio);
        const currentR = maxR * lenFactor;
        const rad = -1 * angle * (Math.PI/180);
        
        // 如果 type 是 'target' 则使用红色 (danger)，否则使用蓝色 (primary)
        const isTarget = (type === 'target');
        const fillColor = isTarget ? "rgba(239, 68, 68, 0.2)" : "rgba(59,130,246,0.2)";
        const strokeColor = isTarget ? "var(--danger)" : "var(--primary)";
        
        
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rad);
        ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0, 0, currentR, -0.1, 0.1); ctx.fillStyle = fillColor; ctx.fill();
        ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(currentR, 0); ctx.strokeStyle = strokeColor; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
        return true;
    }
    return false;
}

export function drawLiveLine(ctx, chunks, key, color, offsetSlots, isRaw) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const drawW = w - paddingLeft;
    const drawH = h - paddingBottom;
    const chunkW = drawW / CHUNKS_DISPLAYED;
    const cy = drawH / 2;

    ctx.save(); ctx.beginPath(); ctx.rect(paddingLeft, 0, drawW, drawH); ctx.clip();
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    chunks.forEach((c, i) => {
        const data = c[key]; if(!data) return;
        const xOffset = paddingLeft + (i + offsetSlots) * chunkW;
        const step = chunkW / data.length;
        for(let j=0; j<data.length; j++) {
            const x = xOffset + j*step;
            const y = cy - (data[j] * (drawH/2) * 0.9);
            if(i===0 && j===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
    });
    ctx.stroke(); ctx.restore();
}

export function drawLiveArray(ctx, chunks, offsetSlots) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const drawW = w - paddingLeft;
    const drawH = h - paddingBottom;
    const hp = drawH / 6;

    ctx.beginPath(); ctx.strokeStyle = "rgba(0,0,0,0.03)";
    for(let i=1; i<6; i++) { ctx.moveTo(paddingLeft, i*hp); ctx.lineTo(w, i*hp); }
    ctx.stroke();

    const chunkW = drawW / CHUNKS_DISPLAYED;
    ctx.save(); ctx.beginPath(); ctx.rect(paddingLeft, 0, drawW, drawH); ctx.clip();
    chunks.forEach((c, i) => {
        if(!c.all_channels) return;
        const xOffset = paddingLeft + (i + offsetSlots) * chunkW;
        for(let ch=0; ch<6; ch++) {
            const data = c.all_channels[ch];
            const cy = ch*hp + hp/2;
            const step = chunkW / data.length;
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(156, 163, 175, 0.4)';
            ctx.lineWidth = 1;
            for(let j=0; j<data.length; j++) {
                const x = xOffset + j*step;
                const y = cy - (data[j]*(hp/2)*1.1);
                if(j===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
            }
            ctx.stroke();
        }
    });
    ctx.restore();
}

export function renderPlaybackSingle(ctx, currentTime, buffer, sr, cFut, cPast, showTags, metadataBuffer, targetTag, totalDuration, expandedState, clickInput) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const drawW = w - paddingLeft;
    const drawH = h - paddingBottom;
    const cy = drawH / 2;
    
    ctx.clearRect(0,0,w,h);
    drawWaveAxes(ctx, w, h);
    if(!buffer) return null;

    const win = CHUNKS_DISPLAYED * CHUNK_DUR;
    const tStart = Math.max(0, currentTime - win/2);
    const tEnd = tStart + win;
    
    drawTimeGrid(ctx, w, h, win, tStart);
    
    // [关键] 调用 Tag 绘制逻辑，传入点击输入，获取新的状态
    let newExpandState = null;
    if(showTags && metadataBuffer) {
        newExpandState = drawPlaybackTags(ctx, w, tStart, win, metadataBuffer, targetTag, clickInput, expandedState);
    }

    const actualSR = (totalDuration && totalDuration > 0) ? (buffer.length / totalDuration) : sr;
    const iStart = Math.floor(tStart * actualSR);
    const iEnd = Math.min(buffer.length, Math.floor(tEnd * actualSR));
    const slice = buffer.subarray(iStart, iEnd);
    const step = drawW / (win * actualSR);
    const iCurr = Math.floor(currentTime * actualSR);
    const phX = paddingLeft + (iCurr - iStart) * step;

    ctx.save(); ctx.beginPath(); ctx.rect(paddingLeft, 0, drawW, drawH); ctx.clip();
    ctx.beginPath(); ctx.strokeStyle = cFut; ctx.lineWidth = 1.2;
    for(let i=0; i<slice.length; i++) {
        const x = paddingLeft + i*step;
        const y = cy - (slice[i]*(drawH/2)*0.9);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();

    ctx.save(); ctx.beginPath(); ctx.rect(paddingLeft, 0, phX - paddingLeft, drawH); ctx.clip();
    ctx.beginPath(); ctx.strokeStyle = cPast;
    for(let i=0; i<slice.length; i++) {
        const x = paddingLeft + i*step;
        const y = cy - (slice[i]*(drawH/2)*0.9);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke(); ctx.restore(); ctx.restore();

    if(phX >= paddingLeft && phX <= w) {
        ctx.beginPath(); ctx.moveTo(phX,0); ctx.lineTo(phX,drawH);
        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    
    return newExpandState;
}

export function renderPlaybackArray(ctx, currentTime, buffers, sr, totalDuration) {
    const { paddingLeft, paddingBottom } = LAYOUT;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const drawH = h - paddingBottom;
    const hp = drawH / 6;

    ctx.clearRect(0,0,w,h);
    
    const win = CHUNKS_DISPLAYED * CHUNK_DUR;
    const tStart = Math.max(0, currentTime - win/2);
    const tEnd = tStart + win;
    
    drawTimeGrid(ctx, w, h, win, tStart);
    ctx.beginPath(); ctx.strokeStyle = "#e5e7eb"; ctx.moveTo(paddingLeft, 0); ctx.lineTo(paddingLeft, drawH); ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = "rgba(0,0,0,0.03)"; for(let i=1; i<6; i++) { ctx.moveTo(paddingLeft, i*hp); ctx.lineTo(w, i*hp); } ctx.stroke();

    if(!buffers[0]) return;
    
    const actualSR = (totalDuration && totalDuration > 0) ? (buffers[0].length / totalDuration) : sr;

    const iStart = Math.floor(tStart * actualSR);
    const iEnd = Math.min(buffers[0].length, Math.floor(tEnd * actualSR));
    const iCurr = Math.floor(currentTime * actualSR);
    const drawW = w - paddingLeft;
    
    const step = drawW / (win * actualSR);
    const phX = paddingLeft + (iCurr - iStart) * step;

    ctx.save(); ctx.beginPath(); ctx.rect(paddingLeft, 0, drawW, drawH); ctx.clip();

    for(let ch=0; ch<6; ch++) {
        const slice = buffers[ch].subarray(iStart, iEnd);
        const cy = ch*hp + hp/2;
        ctx.beginPath(); ctx.strokeStyle = "rgba(156, 163, 175, 0.3)"; ctx.lineWidth = 1;
        for(let i=0; i<slice.length; i++) {
            const x = paddingLeft + i*step;
            const y = cy - (slice[i]*(hp/2)*1.1);
            if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();

        ctx.save(); ctx.beginPath(); ctx.rect(paddingLeft, ch*hp, phX - paddingLeft, hp); ctx.clip();
        ctx.beginPath(); ctx.strokeStyle = "#4b5563";
        for(let i=0; i<slice.length; i++) {
            const x = paddingLeft + i*step;
            const y = cy - (slice[i]*(hp/2)*1.1);
            if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke(); ctx.restore();
    }
    ctx.restore();
    
    if(phX >= paddingLeft) {
        ctx.beginPath(); ctx.moveTo(phX,0); ctx.lineTo(phX,drawH);
        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5; ctx.stroke();
    }
}
