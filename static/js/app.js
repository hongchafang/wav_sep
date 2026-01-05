/**
 * app.js
 * 修复版：即时模式 GUI 实现 Tag 点击交互
 */
import { VIS_SR_RAW, VIS_SR_ARRAY, LAYOUT, TAG_OFFSET } from './config.js';
import * as Waveform from './waveform.js';
import * as Spectrogram from './spectrogram.js';

// ... (常量和变量定义保持不变) ...
const CHUNK_DUR = 0.5;
const CHUNKS_DISPLAYED = 16;
let ws;
let isRecording = false;
let isPlaybackReady = false;
let hasReceivedFirstFrame = false;
let totalChunksReceived = 0;

let historyBuffer = [];
let metadataBuffer = [];

let pbRaw, pbSep, pbArray;
let pbSpecRaw = [];
let pbSpecSep = [];
let currentArrayCh = 0;
let animationId;
let rawViewMode = 'wave';
let sepViewMode = 'wave';

// [新增] 交互状态
let expandedTagState = { chunkId: null, tagIndex: -1 };
let pendingClick = null; // 存储 {x, y, targetId}

const cvsRaw = document.getElementById('rawCanvas');
const cvsRawSpec = document.getElementById('rawSpecCanvas');
// ... (Canvas DOM 获取保持不变) ...
const cvsSep = document.getElementById('sepCanvas');
const cvsSepSpec = document.getElementById('sepSpecCanvas');
const cvsArray = document.getElementById('arrayCanvas');
const cvsRadar = document.getElementById('radarCanvas');

const ctxRaw = cvsRaw.getContext('2d');
const ctxRawSpec = cvsRawSpec.getContext('2d');
const ctxSep = cvsSep.getContext('2d');
const ctxSepSpec = cvsSepSpec.getContext('2d');
const ctxArray = cvsArray.getContext('2d');
const ctxRadar = cvsRadar.getContext('2d');

const audios = {
    raw: document.getElementById('audioRaw'),
    sep: document.getElementById('audioSep'),
    array: document.getElementById('audioArray')
};

document.addEventListener('DOMContentLoaded', () => {
    initAudioSet();
    initPlayers();
    initInteractions(); // 初始化点击
    resize();
});
window.addEventListener('resize', resize);

// [新增] 简单的点击监听：只记录“哪里被点了”
function initInteractions() {
    const recordClick = (e) => {
        const rect = e.target.getBoundingClientRect();
        // 记录点击坐标和点击的是哪个 Canvas
        pendingClick = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            targetId: e.target.id
        };
        // 立即重绘一帧来处理点击
        renderFrame();
    };

    cvsRaw.addEventListener('mousedown', recordClick);
    cvsRawSpec.addEventListener('mousedown', recordClick);
}

// ... (resize, switchView, initPlayers, connectWS, loopAnimation 保持不变) ...
function resize() {
    [cvsRaw, cvsRawSpec, cvsSep, cvsSepSpec, cvsArray].forEach(c => {
        if(c && c.parentElement) {
            c.width = c.parentElement.offsetWidth;
            c.height = c.parentElement.offsetHeight;
        }
    });
    const rp = cvsRadar.parentElement;
    const s = Math.min(rp.offsetWidth, rp.offsetHeight);
    cvsRadar.width = s; cvsRadar.height = s;
    if(!isRecording && !isPlaybackReady) Waveform.drawRadar(ctxRadar, null);
    requestAnimationFrame(renderFrame);
}
window.switchRawView = function(mode) {
    rawViewMode = mode;
    const btnWave = document.getElementById('btnRawWave');
    const btnSpec = document.getElementById('btnRawSpec');
    
    if (mode === 'wave') {
        btnWave.classList.add('active'); btnSpec.classList.remove('active');
        cvsRaw.style.display = 'block'; cvsRawSpec.style.display = 'none';
    } else {
        btnWave.classList.remove('active'); btnSpec.classList.add('active');
        cvsRaw.style.display = 'none'; cvsRawSpec.style.display = 'block';
    }
    resize();
};
window.switchSepView = function(mode) {
    sepViewMode = mode;
    const btnWave = document.getElementById('btnSepWave');
    const btnSpec = document.getElementById('btnSepSpec');
    
    if (mode === 'wave') {
        btnWave.classList.add('active'); btnSpec.classList.remove('active');
        cvsSep.style.display = 'block'; cvsSepSpec.style.display = 'none';
    } else {
        btnWave.classList.remove('active'); btnSpec.classList.add('active');
        cvsSep.style.display = 'none'; cvsSepSpec.style.display = 'block';
    }
    resize();
};
function initPlayers() {
    ['raw', 'sep', 'array'].forEach(key => {
        const aud = audios[key];
        const seek = document.getElementById('seek' + capitalize(key));
        aud.addEventListener('timeupdate', () => {
            if(isPlaybackReady && !aud.paused) {
                seek.value = aud.currentTime;
                updateTimeDisplay(key);
            }
        });
        aud.addEventListener('loadedmetadata', () => {
            seek.max = aud.duration;
            updateTimeDisplay(key);
        });
        aud.addEventListener('ended', () => {
            aud.pause();
            document.getElementById('play' + capitalize(key)).innerText = "▶";
        });
        seek.addEventListener('input', () => {
            aud.currentTime = seek.value;
            updateTimeDisplay(key);
            renderFrame();
        });
    });
}
function connectWS() {
    if(ws) ws.close();
    ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onopen = () => { isRecording = true; loopAnimation(); };
    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.error) {
            alert(data.error);
            isRecording = false;
            document.getElementById('startBtn').disabled = false;
            document.getElementById('stopBtn').disabled = true;
            document.getElementById('statusMsg').innerText = "设备异常，请检查连接后重试";
            const dot = document.getElementById('statusDot');
            if(dot) { dot.classList.remove('active'); dot.style.backgroundColor = "var(--danger)"; }
            if(ws) ws.close();
            return;
        }

        if (!hasReceivedFirstFrame) {
            hasReceivedFirstFrame = true;
            document.getElementById('statusMsg').innerText = "系统运行中 - 正在录制";
            const dot = document.getElementById('statusDot');
            if(dot) { dot.style.backgroundColor = ""; dot.classList.add('active'); }
        }

        historyBuffer.push(data);
        totalChunksReceived++;
        if(historyBuffer.length > 200) historyBuffer.shift();
    };
}
function loopAnimation() {
    if(!isRecording && !isPlaybackReady) return;
    const anyPlaying = Object.values(audios).some(a => !a.paused);
    if(isRecording || anyPlaying) {
        renderFrame();
        animationId = requestAnimationFrame(loopAnimation);
    }
}
function renderFrame() {
    if(isRecording) renderLive();
    else if(isPlaybackReady) renderPlayback();
    
    // [关键] 每一帧渲染结束后，清空点击事件
    // 这样不会导致一次点击被连续处理
    pendingClick = null;
}

function renderLive() {
    [ctxRaw, ctxRawSpec, ctxSep, ctxSepSpec, ctxArray].forEach(ctx => ctx.clearRect(0,0,ctx.canvas.width, ctx.canvas.height));
    if(historyBuffer.length === 0) return;

    const visibleCount = Math.min(historyBuffer.length, CHUNKS_DISPLAYED);
    const emptySlots = CHUNKS_DISPLAYED - visibleCount;
    const chunks = historyBuffer.slice(Math.max(0, historyBuffer.length - CHUNKS_DISPLAYED));
    const duration = CHUNKS_DISPLAYED * CHUNK_DUR;
    const startTime = Math.max(0, (totalChunksReceived - CHUNKS_DISPLAYED) * CHUNK_DUR);
    const targetTag = document.getElementById('targetInput').value.toLowerCase();

    // 1. Raw Card
    Waveform.drawTimeGrid(ctxRaw, ctxRaw.canvas.width, ctxRaw.canvas.height, duration, startTime);
    if (rawViewMode === 'wave') {
        Waveform.drawLiveLine(ctxRaw, chunks, 'raw_audio', '#9ca3af', emptySlots, true);
        Waveform.drawWaveAxes(ctxRaw, ctxRaw.canvas.width, ctxRaw.canvas.height);
    } else {
        Spectrogram.drawLiveSpectrogramByKey(ctxRawSpec, chunks, 'spectrogram', emptySlots);
    }
    
    // Tag [修改：处理点击]
    // 只有当点击发生在 'rawCanvas' 或 'rawSpecCanvas' 时才传进去
    let currentClick = null;
    if (pendingClick && (pendingClick.targetId === 'rawCanvas' || pendingClick.targetId === 'rawSpecCanvas')) {
        currentClick = pendingClick;
    }

    const activeRawCtx = (rawViewMode === 'wave') ? ctxRaw : ctxRawSpec;
    const newState = Waveform.drawLiveTags(activeRawCtx, chunks, emptySlots, targetTag, currentClick, expandedTagState);
    
    // 如果返回了新状态，说明点中了，更新全局状态
    if (newState) expandedTagState = newState;


    // 2. Target Card
    Waveform.drawTimeGrid(ctxSep, ctxSep.canvas.width, ctxSep.canvas.height, duration, startTime);
    if (sepViewMode === 'wave') {
        Waveform.drawLiveLine(ctxSep, chunks, 'separated_audio', '#3b82f6', emptySlots, false);
        Waveform.drawWaveAxes(ctxSep, ctxSep.canvas.width, ctxSep.canvas.height);
    } else {
        Spectrogram.drawLiveSpectrogramByKey(ctxSepSpec, chunks, 'separated_spectrogram', emptySlots);
    }

    // 3. Array & Radar
    Waveform.drawLiveArray(ctxArray, chunks, emptySlots);
    Waveform.drawTimeGrid(ctxArray, ctxArray.canvas.width, ctxArray.canvas.height, duration, startTime);

    const last = chunks[chunks.length-1];
    if(last) {
        // Radar update...
        const dbVal = last.voice_db !== undefined ? last.voice_db : -100;
        if(last.angle !== undefined && last.angle !== null) {
            Waveform.drawRadar(ctxRadar, last.angle, dbVal, last.angle_type);
            const el = document.getElementById('angleDisplay');
            el.innerText = Math.round(last.angle) + "°";
            el.style.color = (last.angle_type === 'target') ? "var(--danger)" : "";
            
        } else {
            Waveform.drawRadar(ctxRadar, null, dbVal);
            const el = document.getElementById('angleDisplay');
            el.innerText = "--°";
            el.style.color = "#9ca3af";
        }
        document.getElementById('dbDisplay').innerText = dbVal.toFixed(1) + " dB";
        if(last.energies) updateEnergyUI(last.energies);
    }
}

function renderPlayback() {
    let activeAudio = audios.raw;
    if(!audios.sep.paused) activeAudio = audios.sep;
    if(!audios.array.paused) activeAudio = audios.array;
    
    const t = activeAudio.currentTime;
    const targetTag = document.getElementById('targetInput').value.toLowerCase();
    
    const totalDur = (audios.raw.duration && audios.raw.duration !== Infinity)
                     ? audios.raw.duration
                     : (metadataBuffer.length * CHUNK_DUR);

    // Sync Radar ... (保持不变) ...
    const chunkIdx = Math.floor(t / CHUNK_DUR);
    if(metadataBuffer[chunkIdx]) {
        const meta = metadataBuffer[chunkIdx];
        const dbVal = meta.db !== undefined ? meta.db : -100;
        if(meta.angle !== undefined && meta.angle !== null) {
            Waveform.drawRadar(ctxRadar, meta.angle, dbVal, meta.angle_type);
            const el = document.getElementById('angleDisplay');
            el.innerText = Math.round(meta.angle) + "°";
            el.style.color = (meta.angle_type === 'target') ? "var(--danger)" : "";
        } else {
            Waveform.drawRadar(ctxRadar, null, dbVal);
            const el = document.getElementById('angleDisplay');
            el.innerText = "--°"; el.style.color = "#9ca3af";
        }
        document.getElementById('dbDisplay').innerText = dbVal.toFixed(1) + " dB";
        if(meta.energies) updateEnergyUI(meta.energies);
    }

    // Tag Click Processing
    let currentClick = null;
    if (pendingClick && (pendingClick.targetId === 'rawCanvas' || pendingClick.targetId === 'rawSpecCanvas')) {
        currentClick = pendingClick;
    }

    // 1. Raw Card
    if (rawViewMode === 'wave') {
        const newState = Waveform.renderPlaybackSingle(ctxRaw, audios.raw.currentTime, pbRaw, VIS_SR_RAW, '#9ca3af', '#4b5563', true, metadataBuffer, targetTag, totalDur, expandedTagState, currentClick);
        if (newState) expandedTagState = newState;
    } else {
        Spectrogram.renderPlaybackSpectrogram(ctxRawSpec, audios.raw.currentTime, pbSpecRaw, totalDur);
        // Playback Spectrogram 也支持点击
        const newState = Waveform.drawPlaybackTags(ctxRawSpec, ctxRawSpec.canvas.width, Math.max(0, audios.raw.currentTime - CHUNKS_DISPLAYED * CHUNK_DUR/2), CHUNKS_DISPLAYED * CHUNK_DUR, metadataBuffer, targetTag, currentClick, expandedTagState);
        if (newState) expandedTagState = newState;
    }

    // 2. Target Card
    if (sepViewMode === 'wave') {
        Waveform.renderPlaybackSingle(ctxSep, audios.sep.currentTime, pbSep, VIS_SR_RAW, '#93c5fd', '#2563eb', false, metadataBuffer, targetTag, totalDur, expandedTagState, null);
    } else {
        Spectrogram.renderPlaybackSpectrogram(ctxSepSpec, audios.sep.currentTime, pbSpecSep, totalDur);
    }

    // 3. Array
    Waveform.renderPlaybackArray(ctxArray, audios.array.currentTime, pbArray, VIS_SR_ARRAY, totalDur);
}

// ... (preparePlaybackData, updateEnergyUI, capitalize, formatTime, updateTimeDisplay, showToast, initAudioSet, manualUpdateTarget, startSystem, stopSystem, resetSystem, togglePlay, restartPlayer, setArrayCh, downloadAudio 等所有函数均保持原样，无需修改) ...
function preparePlaybackData() {
    if(historyBuffer.length === 0) return;
    const lenRaw = historyBuffer.reduce((s,c)=>s + (c.raw_audio ? c.raw_audio.length : 0), 0);
    const lenArray = historyBuffer.reduce((s,c)=>s + (c.all_channels?c.all_channels[0].length:0), 0);
    
    pbRaw = new Float32Array(lenRaw);
    pbSep = new Float32Array(lenRaw);
    pbArray = [new Float32Array(lenArray),new Float32Array(lenArray),new Float32Array(lenArray),new Float32Array(lenArray),new Float32Array(lenArray),new Float32Array(lenArray)];
    metadataBuffer = [];
    pbSpecRaw = []; pbSpecSep = [];

    let offRaw = 0;
    let offArray = 0;
    
    historyBuffer.forEach((c, idx) => {
        const currentTime = idx * CHUNK_DUR;
        metadataBuffer.push({
            time: currentTime,
            tags: c.tags,
            angle: c.angle,
            angle_type: c.angle_type,
            db: c.voice_db,
            energies: c.energies,
            chunk_id: c.chunk_id
        });

        if (c.spectrogram && Array.isArray(c.spectrogram)) pbSpecRaw.push(...c.spectrogram);
        if (c.separated_spectrogram && Array.isArray(c.separated_spectrogram)) pbSpecSep.push(...c.separated_spectrogram);

        if(c.raw_audio) {
            pbRaw.set(c.raw_audio, offRaw);
            pbSep.set(c.separated_audio, offRaw);
            offRaw += c.raw_audio.length;
        }
        if(c.all_channels) {
            for(let ch=0; ch<6; ch++) pbArray[ch].set(c.all_channels[ch], offArray);
            offArray += c.all_channels[0].length;
        }
    });
    console.log(`Prepared playback data: ${metadataBuffer.length} chunks.`);
}
function updateEnergyUI(energies) {
    const max = Math.max(...energies); const ch = energies.indexOf(max);
    document.getElementById('proximityText').innerHTML = `强信号: <b style="color:var(--danger)">CH${ch}</b>`;
    document.querySelectorAll('.ch-label').forEach((el,i) => {
        if(i===ch) el.classList.add('active'); else el.classList.remove('active');
    });
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function formatTime(s) { const m=Math.floor(s/60), sc=Math.floor(s%60); return m+":"+sc.toString().padStart(2,'0'); }
function updateTimeDisplay(key) {
    const aud = audios[key];
    const el = document.getElementById('time' + capitalize(key));
    el.innerText = formatTime(aud.currentTime) + " / " + formatTime(aud.duration || 0);
}
function showToast(msg) {
    const t = document.getElementById('toast');
    t.querySelector('span').innerText = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}
async function initAudioSet() {
    const list = document.getElementById('audioSetList');
    if (!list) return;
    try {
        const response = await fetch('/labels_list.txt');
        if (!response.ok) throw new Error("无法获取标签文件");
        const data = await response.text();
        const classes = data.split(',').map(item => item.trim()).filter(item => item.length > 0);
        list.innerHTML = "";
        classes.sort().forEach(c => { const o = document.createElement('option'); o.value = c; list.appendChild(o); });
    } catch (error) {
        console.error("加载 AudioSet 标签失败:", error);
        const fallback = ["Speech", "Music", "Dog", "Cat", "Siren"];
        fallback.forEach(c => { const o = document.createElement('option'); o.value = c; list.appendChild(o); });
    }
}
window.manualUpdateTarget = function() {
    const tag = document.getElementById('targetInput').value;
    const btn = document.querySelector('.btn-update');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "处理中...";
    fetch('/set_target', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tag})
    })
    .then(res => res.json())
    .then(data => {
        showToast(`目标类别已更新为: ${tag}`);
        document.getElementById('targetBadge').innerText = `Focus: ${tag}`;
        if (data.reprocessed && data.reprocessed_data) {
            console.log("收到重处理数据，数量:", data.reprocessed_data.length);
            const newDataList = data.reprocessed_data;
            let matchCount = 0;
            newDataList.forEach(newItem => {
                const bufferItem = historyBuffer.find(h => h.chunk_id === newItem.chunk_id);
                if (bufferItem) {
                    bufferItem.separated_audio = newItem.separated_audio;
                    bufferItem.separated_spectrogram = newItem.separated_spectrogram;
                    matchCount++;
                }
            });
            console.log(`匹配并更新了 ${matchCount} 个数据块`);
            preparePlaybackData();
            const ts = Date.now();
            if (audios.sep) {
                const currentTime = audios.sep.currentTime;
                const wasPaused = audios.sep.paused;
                audios.sep.src = `/audio/separated.wav?t=${ts}`;
                if (!wasPaused && isPlaybackReady) {
                    const onLoaded = () => {
                        audios.sep.currentTime = currentTime;
                        audios.sep.play().catch(e => console.warn(e));
                        audios.sep.removeEventListener('loadedmetadata', onLoaded);
                    };
                    audios.sep.addEventListener('loadedmetadata', onLoaded);
                }
            }
            if (isPlaybackReady) renderPlayback();
            showToast("历史音频已使用新目标重新分离");
        }
    })
    .catch(err => {
        console.error(err);
        showToast("更新失败");
    })
    .finally(() => {
        btn.disabled = false;
        btn.innerText = originalText;
    });
};
window.startSystem = function() {
    document.getElementById('startBtn').disabled = true;
    document.getElementById('resetBtn').disabled = true;
    document.querySelectorAll('.player-bar').forEach(b => b.classList.remove('active'));
    isPlaybackReady = false;
    isRecording = false;
    hasReceivedFirstFrame = false;
    historyBuffer = [];
    metadataBuffer = [];
    totalChunksReceived = 0;
    fetch('/start_system').then(() => {
        document.getElementById('stopBtn').disabled = false;
        document.getElementById('resetBtn').disabled = false;
        document.getElementById('statusMsg').innerText = "正在启动录音设备 (等待ADB流)...";
        const dot = document.getElementById('statusDot');
        dot.classList.remove('active');
        dot.style.backgroundColor = "#f59e0b";
        connectWS();
    });
};
window.stopSystem = function() {
    document.getElementById('statusMsg').innerText = "正在停止并生成音频文件，请稍候...";
    const dot = document.getElementById('statusDot');
    dot.style.backgroundColor = "var(--warning)";
    document.getElementById('stopBtn').disabled = true;
    return fetch('/stop_system').then(() => {
        document.getElementById('startBtn').disabled = false;
        document.getElementById('statusMsg').innerText = "已停止 | 音频准备就绪";
        dot.classList.remove('active');
        dot.style.backgroundColor = "";
        if(ws) ws.close();
        preparePlaybackData();
        isPlaybackReady = true; isRecording = false;
        const ts = Date.now();
        audios.raw.src = `/audio/raw_ch0.wav?t=${ts}`;
        audios.sep.src = `/audio/separated.wav?t=${ts}`;
        audios.array.src = `/audio/ch0.wav?t=${ts}`;
        document.querySelectorAll('.player-bar').forEach(b => b.classList.add('active'));
        renderPlayback();
    });
};
window.resetSystem = function() {
    const action = () => {
        if(ws) ws.close();
        isRecording = false; isPlaybackReady = false;
        if(animationId) cancelAnimationFrame(animationId);
        historyBuffer = []; metadataBuffer = []; pbRaw=null; pbSep=null;
        pbSpecRaw=[]; pbSpecSep=[];
        totalChunksReceived = 0;
        Object.values(audios).forEach(a => { a.pause(); a.src=""; a.load(); });
        document.querySelectorAll('.player-bar').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.play-btn').forEach(b => b.innerText="▶");
        document.querySelectorAll('.seek-bar').forEach(s => s.value=0);
        document.querySelectorAll('.time-code').forEach(t => t.innerText="0:00 / 0:00");
        [ctxRaw, ctxRawSpec, ctxSep, ctxSepSpec, ctxArray].forEach(c => c.clearRect(0,0,10000,10000));
        Waveform.drawRadar(ctxRadar, null);
        document.getElementById('angleDisplay').innerText = "--°";
        document.getElementById('dbDisplay').innerText = "-- dB";
        document.getElementById('proximityText').innerText = "等待数据...";
        fetch('/reset_system').then(() => {
            document.getElementById('statusMsg').innerText = "系统已重置";
            showToast("系统重置完成");
            document.getElementById('startBtn').disabled = false;
            document.getElementById('stopBtn').disabled = true;
        });
    };
    if(!document.getElementById('stopBtn').disabled) stopSystem().then(() => setTimeout(action, 200));
    else action();
};
window.togglePlay = function(key) {
    const aud = audios[key];
    const btn = document.getElementById('play' + capitalize(key));
    if(aud.paused) {
        Object.keys(audios).forEach(k => { if(k !== key) { audios[k].pause(); document.getElementById('play' + capitalize(k)).innerText = "▶"; } });
        aud.play(); btn.innerText = "⏸"; loopAnimation();
    } else {
        aud.pause(); btn.innerText = "▶";
    }
};
window.restartPlayer = function(key) {
    const aud = audios[key];
    aud.pause();
    aud.currentTime = 0;
    document.getElementById('play' + capitalize(key)).innerText = "▶";
    document.getElementById('seek' + capitalize(key)).value = 0;
    updateTimeDisplay(key);
    renderPlayback();
};
window.setArrayCh = function(ch, btn) {
    if(ch === currentArrayCh) return;
    document.querySelectorAll('.ch-pill').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    currentArrayCh = ch;
    const aud = audios.array;
    const wasPlaying = !aud.paused;
    aud.src = `/audio/ch${ch}.wav?t=${Date.now()}`;
    aud.currentTime = 0;
    document.getElementById('seekArray').value = 0;
    if(wasPlaying) aud.play(); else document.getElementById('playArray').innerText = "▶";
};
window.downloadAudio = function(key) {
    const aud = audios[key];
    if (!aud || !aud.src || aud.src === window.location.href) {
        showToast("暂无音频可下载");
        return;
    }
    let filename = "audio.wav";
    const ts = new Date().toISOString().slice(11,19).replace(/:/g,"-");
    if (key === 'raw') filename = `raw_signal_${ts}.wav`;
    else if (key === 'sep') filename = `target_speech_${ts}.wav`;
    else if (key === 'array') filename = `array_ch${currentArrayCh}_${ts}.wav`;
    const a = document.createElement('a');
    a.style.display = 'none'; a.href = aud.src; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); window.URL.revokeObjectURL(a.href); }, 100);
    showToast("开始下载...");
};
