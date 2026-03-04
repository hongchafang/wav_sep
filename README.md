# 🎧 智能音频分析与目标提取终端

本项目是一个基于 **FastAPI + PyTorch** 的实时音频处理系统。它利用 6 通道麦克风阵列采集信号，通过深度学习模型实现声源定位 (DoA) 和指定目标的实时分离提取。

---

## 🌟 核心功能

* **实时流式处理**：基于 WebSocket 实现低延迟音频流传输，支持 0.5s 的切片级处理速度。
* **声源定位 (DoA)**：结合 SRP-PHAT 算法与深度学习模型，实时追踪声源角度并在雷达图中展示。
* **目标提取 (Target Separation)**：用户可从 AudioSet 的 527 类声音中指定目标（如：Speech），系统实时分离并强化该声音。
* **可视化监控**：
  * **2D 频谱图**：高对比度热力图展示频率分布。
  * **多通道波形**：同步展示 6 通道原始信号与分离后的目标信号。
  * **智能标签**：自动识别环境音类别，支持点击查看详细标签。
* **历史回溯与重处理**：支持录制结束后的完整回放，并允许更改目标类别对历史音频进行重新分离。

---

## 🛠️ 技术架构

### 后端 (Python)
- **FastAPI**: 异步 Web 服务与 WebSocket 通讯。
- **PyTorch (TorchScript)**：加载预训练的 `ss_model`、`tag_model` 和 `query_net` 进行推理。
- **ADB 控制**: 自动化管理远程嵌入式设备的录音生命周期。

### 前端 (JavaScript)
- **Canvas API**: 高性能的波形、频谱及雷达图实时渲染。
- **ES6 Modules**: 模块化管理配置、绘图逻辑与交互逻辑。

---

## 🚀 功能演示

SEDLoc 样机部署完成后，支持**本地**与**远程**两种访问方式：
- **本地使用**：需为 Nvidia Jetson Agx Orin 接入显示设备访问终端系统。
- **远程使用**：直接通过网络协议转发访问。

以下通过远程访问的形式，演示终端系统的各项核心能力（视频将在 GitHub 自动加载播放）：

### 📍 1. 声源定位与检测演示

以下演示了从选择检测目标到录制结束的完整流程。在输入 `M` 后，系统会弹出提示词功能以选取目标类别。点击“修改目标”完成切换并点击“启动”后，终端正式开始工作。

声源定位模块会动态显示目标方向及音量：检测到目标时雷达显示为红色，无目标时为蓝色，并实时指示音量最大的声源方向。终端工作时，波形下方会实时显示检测结果，当检测到目标类别时会进行高亮提示。

**🎤 “Speech” 类别定位与检测**
https://github.com/user-attachments/assets/fc1f13a2-77eb-438a-9391-2d9d469c09c2

**🎵 “Music” 类别定位与检测**
https://github.com/user-attachments/assets/b19d2055-4c94-48b0-9559-5dac4bc8fbfd


### 🎯 2. 目标音频提取演示

系统具备在复杂环境噪音（如语音、音乐混杂环境）下提取特定目标音频的能力。选定目标并启动后，目标音频的波形和频谱会与原始音频同步动态显示。

**🗣️ Speech 提取演示**
https://github.com/user-attachments/assets/a18facb0-4ec0-444e-a7bf-11b5864b1101

**🎸 Music 提取演示**
https://github.com/user-attachments/assets/bcc1ed7c-9104-4516-b1e2-61e196017d82

**🐶 Dog 提取演示**
https://github.com/user-attachments/assets/36af02e4-4387-4d9b-8cb6-7b33f3476b97

**🐦 Bird 提取演示**
https://github.com/user-attachments/assets/7e01bf9a-7c1f-4d2b-b9c1-58030175b2e4


### ⚙️ 3. 系统辅助功能演示

为了提升泛用性，系统内置了本地音频处理功能与硬件监控模块。

**📁 音频上传与处理下载**
> 支持将本地音频文件上传至系统，处理后的检测与分离结果会直接输出到信号可视化区域，并支持结果下载。
https://github.com/user-attachments/assets/8ef088e0-d752-43ae-a1c6-bd121d9d349c

**📊 麦克风阵列通道监控**
> 用于实时监控 6 通道硬件的健康状态及信号强度分布。
https://github.com/user-attachments/assets/b4f3ba18-9828-4c64-ab4a-cfdabd59bc8a
