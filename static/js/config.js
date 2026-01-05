/**
 * config.js
 * 系统常量配置
 */

export const VIS_SR_RAW = 1600;
export const VIS_SR_ARRAY = 1600;
export const CHUNKS_DISPLAYED = 16;
export const CHUNK_DUR = 0.5;

// [新增] 绘图区域布局常量
export const LAYOUT = {
    paddingLeft: 40,   // 左侧留给 Y 轴文字
    paddingBottom: 24, // 底部留给 Tag
    sampleRate: 16000  // 假设音频采样率 16k，用于频谱 Y 轴标记
};
export const TAG_OFFSET = 0;
