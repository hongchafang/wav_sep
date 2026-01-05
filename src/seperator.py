import numpy as np
from pathlib import Path
import os
import subprocess
import time
import re
import torch
import threading
import queue
from collections import deque
import asyncio
from recorder import Receiver
import torchaudio.transforms as T
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import torchaudio
import pandas as pd
import pickle

CURRENT_WORK_DIR = os.getcwd()
AUDIO_DIR = os.path.join(CURRENT_WORK_DIR, "audio_output")
if not os.path.exists(AUDIO_DIR):
    os.makedirs(AUDIO_DIR)
    print(f"Created audio directory: {AUDIO_DIR}")
else:
    print(f"Using audio directory: {AUDIO_DIR}")
    
class Separator:
    def __init__(self, receiver, output_queue):
        self.receiver = receiver
        self.output_queue = output_queue
        self.is_processing = False
        self.processed_chunks = deque(maxlen=100)
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f"Initializing models on {self.device}...")
        start_time = time.time()
        self.ss_model = torch.jit.load("ss_model_traced.pt", map_location=self.device).eval()
        self.tag_model = torch.jit.load("tag_model_traced.pt", map_location=self.device).eval()
        self.query_net = torch.jit.load("query_net_traced.pt", map_location=self.device).eval()
        self.resampler = T.Resample(orig_freq=16000, new_freq=32000).to(self.device)
        self.downsampler = T.Resample(orig_freq=32000, new_freq=16000).to(self.device)
        self.spectrogram_transform = T.Spectrogram(
                                            n_fft=512,
                                            hop_length=320,
                                            power=2.0
                                        ).to(self.device)
        self.AtodB = T.AmplitudeToDB().to(self.device)
        self.rt_context_buffer = deque(maxlen=4)
        
        self._warmup_models()

        self.num_mics = 6
        MIC_DISTANCE = 0.015
        
        self.array_aperture = MIC_DISTANCE * (self.num_mics - 1)
        
        df = pd.read_csv('metadata/class_labels_indices.csv')
        self.index_to_name = dict(zip(df['index'], df['display_name']))
        self.name_to_index = {}
        for idx, name in zip(df['index'], df['display_name']):
            processed_name = str(name).replace(',', ' ').strip()
            self.name_to_index[processed_name] = idx
        
        self.target_tag = "Speech"
        self.target_index = self.name_to_index.get(self.target_tag, 0)
        self.set_target(self.target_tag)
        print(f"Models initialized and warmed up in {time.time()-start_time:.2f}s")
        
        self.buffer_raw_ch0 = []
        self.buffer_sep = []
        self.buffer_multichan = []
        self.buffer_chunk_ids = []
        self.default_tags = ['Speech','Computer tying tying']
        self.history_maxlen = 4  # 窗口大小：2.0s / 0.5s = 4帧
        self.probs_history = deque(maxlen=self.history_maxlen)
        
    def _warmup_models(self):
        print("Warming up models...")
        for i in range(2):
            with torch.no_grad():
                dummy_audio = torch.randn(1, 16000*2, dtype=torch.float32).to(self.device)
                dummy_query = torch.randn(1, 527, dtype=torch.float32).to(self.device)
                resampled = self.resampler(dummy_audio)
                tag_out = self.tag_model(dummy_audio)
                query_vec = self.query_net(resampled)
                ss_out = self.ss_model(resampled.unsqueeze(0), dummy_query)
        print("Finished warm up")

    def reset_buffers(self):
        
        self.buffer_raw_ch0 = []
        self.buffer_sep = []
        self.buffer_multichan = []
        self.buffer_chunk_ids = []
        self.rt_context_buffer.clear()
        self.probs_history.clear()

    def save_wav_files(self):
        print("Saving WAV files...")
        if not self.buffer_raw_ch0:
            return False
        
        # [安全对齐]
        len_raw = len(self.buffer_raw_ch0)
        len_sep = len(self.buffer_sep)
        min_len = min(len_raw, len_sep)
        
        if len_raw != len_sep:
            print(f"Warning: Buffer mismatch! Raw: {len_raw}, Sep: {len_sep}. Truncating to {min_len}.")
            
        raw_to_save = list(self.buffer_raw_ch0)[:min_len]
        sep_to_save = list(self.buffer_sep)[:min_len]

        try:
            if raw_to_save:
                raw_tensor = torch.cat(raw_to_save)
                torchaudio.save(f"{AUDIO_DIR}/raw_ch0.wav", raw_tensor.unsqueeze(0), 16000)

            if sep_to_save:
                sep_tensor = torch.cat(sep_to_save)
                if sep_tensor.dim() == 1:
                    sep_tensor = sep_tensor.unsqueeze(0)
                torchaudio.save(f"{AUDIO_DIR}/separated.wav", sep_tensor, 16000)

            if self.buffer_multichan:
                multichan_to_save = list(self.buffer_multichan)[:min_len]
                all_ch_tensor = torch.cat(multichan_to_save, dim=0)
                for ch in range(min(6, all_ch_tensor.shape[1])):
                    ch_data = all_ch_tensor[:, ch]
                    torchaudio.save(f"{AUDIO_DIR}/ch{ch}.wav", ch_data.unsqueeze(0), 16000)
            
            print(f"WAV files saved successfully ({min_len} chunks).")
            return True
        except Exception as e:
            print(f"Error saving WAV: {e}")
            import traceback
            traceback.print_exc()
            return False
            
    def set_target(self, tag):
        self.target_tag = tag
        self.target_index = self.name_to_index.get(tag, 0)
        query = pickle.load(open(f'embeding/label={self.target_index}.pkl', 'rb'))
        self.dummy_query = torch.Tensor(query).to(self.device).unsqueeze(dim=0)
        print(f"Target switched to: {self.target_tag} (Index: {self.target_index})")

    def calculate_doa_srp_fast(self, data_np, fs=16000):
        """
        优化后的 SRP-PHAT
        data_np: [Samples, 6]
        """
        if data_np.shape[1] > 6:
            data_np = data_np[:, :6]
        n_samples = data_np.shape[0]
        n_fft = n_samples + 512
        freqs = np.fft.rfftfreq(n_fft, 1/fs)
        
        # 1. 物理参数
        d = 0.015  # 15mm
        c = 343.0
        mic_x = np.arange(6) * d  # [0, 0.015, 0.030, 0.045, 0.060, 0.075]
        
        # 2. 频域转换与 PHAT 加权预处理
        FFTs = np.fft.rfft(data_np, n=n_fft, axis=0)
        # 预计算所有通道对的归一化互功率谱 (只计算上三角部分)
        # 这样可以极大减少搜索循环内的计算量
        cross_specs = []
        pairs = []
        for i in range(6):
            for j in range(i + 1, 6):
                R = FFTs[:, i] * np.conj(FFTs[:, j])
                R_phat = R / (np.abs(R) + 1e-6) # PHAT 归一化
                cross_specs.append(R_phat)
                pairs.append((i, j))
        
        # 3. 空间搜索 (间隔 5 度)
        search_angles = np.arange(5, 176, 5)
        scores = np.zeros(len(search_angles))
        
        for idx, angle in enumerate(search_angles):
            theta_rad = np.radians(angle)
            cos_theta = np.cos(theta_rad)
            
            total_power = 0
            for p_idx, (i, j) in enumerate(pairs):
                # 计算该角度下 i 和 j 麦克风的时延差
                # tau = (dist_i - dist_j) * cos(theta) / c
                delta_tau = (mic_x[i] - mic_x[j]) * cos_theta / c
                
                # 相位补偿并求和
                # 根据移位定理：f(t-tau) <=> F(w)e^(-j*w*tau)
                phase_shift = np.exp(-1j * 2 * np.pi * freqs * delta_tau)
                total_power += np.real(np.sum(cross_specs[p_idx] * phase_shift))
                
            scores[idx] = total_power

        # 4. 获取最佳角度
        best_idx = np.argmax(scores)
        return int(search_angles[best_idx])


    def calculate_target_doa_audio(self, data_tensor):
        device_data = data_tensor.to(self.device)
        if device_data.shape[1] > 6:
            device_data = device_data[:, :6]
        n_samples = device_data.shape[0]
        
        angles = torch.arange(0, 181, 15, device=self.device)
        batch_size = len(angles)
        
        data_fft = torch.fft.rfft(device_data, dim=0)
        freqs = torch.fft.rfftfreq(n_samples, d=1/16000, device=self.device)
        omega = 2 * np.pi * freqs
        
        mic_pos = torch.arange(6, device=self.device) * 0.015
        theta = torch.deg2rad(angles)
        cos_theta = torch.cos(theta)
        taus = (mic_pos.unsqueeze(0) * cos_theta.unsqueeze(1)) / 343.4
        phase_shift = torch.exp(-1j * omega.view(1, 1, -1) * taus.view(batch_size, 6, 1))
        
        input_fft = data_fft.T.unsqueeze(0)
        beam_fft = torch.sum(input_fft * phase_shift, dim=1) / 6.0
        beam_audio = torch.fft.irfft(beam_fft, n=n_samples, dim=1)
        
        with torch.no_grad():
            tag_out = self.tag_model(beam_audio)
            if self.target_index is not None:
                scores = tag_out[:, self.target_index]
            else:
                scores = torch.zeros(batch_size, device=self.device)

        best_idx = torch.argmax(scores)
        best_score = scores[best_idx].item()
        best_audio_tensor = beam_audio[best_idx]
        
        if best_score < 0.05:
            best_angle = None
        else:
            best_angle = int(angles[best_idx].item())
        
        
        
        
        return best_angle, best_audio_tensor

    def audio_to_db(self, audio_signal, sensitivity=-38, ref_voltage=1.0, ref_pressure=20e-6):
        voltage = np.abs(np.max(audio_signal))
        dbv = 20 * np.log10(voltage / ref_voltage + 1e-9)
        return dbv

    def get_filtered_labels(self, scores, threshold=0.15, top_k=3):
        """
        Input scores: 当前帧(0.5s)的模型原始输出, shape: (527,) 或 (1, 527)
        Output: 经过2s滑动窗口平均后的 Top-K 标签列表
        """
        
        # 1. 数据格式标准化：转为一维 numpy 数组
        if isinstance(scores, torch.Tensor):
            if scores.device.type != 'cpu':
                scores = scores.cpu()
            scores = scores.detach().numpy()
            
        if isinstance(scores, list):
            scores = np.array(scores)
            
        # 压扁为 (527,) 向量
        if scores.ndim > 1:
            scores = scores.squeeze()

        # 2. [核心逻辑] 滑动窗口记录
        # deque 会自动处理溢出，当长度超过 4 时，最旧的会自动弹出
        self.probs_history.append(scores)

        # 3. [核心逻辑] 计算平均概率
        # 这里的逻辑涵盖了 "第1s" 和 "最后1s"：
        # - 刚开始(0.5s): history有1个，avg = 它自己
        # - 第1.0s: history有2个，avg = 前2个平均
        # - 第2.0s及以后: history有4个，avg = 前2s内的平均 (最稳定)
        current_buffer = np.array(self.probs_history)
        avg_scores = np.mean(current_buffer, axis=0)

        # 4. 下面使用 avg_scores 进行筛选 (原逻辑不变)
        top_indices = avg_scores.argsort()[-top_k:][::-1]
        
        final_tags = []
        for idx in top_indices:
            score = avg_scores[idx]
            if score >= threshold:
                tag_name = self.index_to_name.get(idx, f"Class_{idx}")
                final_tags.append(tag_name)
        if final_tags == []:
            final_tags = self.default_tags
        return final_tags

    def wav2spec(self, wav_data):
        spec = self.spectrogram_transform(wav_data)
        spec = torch.abs(spec)
        spec = torch.log1p(spec)
        if spec.max() > 0:
            spec = spec / spec.max() * 255
        return spec.t().cpu().numpy().astype(int).tolist()

    def process_data(self, chunk_id, data_np):
        """在这里实现你的数据处理和分析逻辑"""
        # 1. 预处理数据
        data_float = data_np.astype(np.float32) / 32768.0
        data_tensor = torch.from_numpy(data_float).float() # [Samples, 8]
        
        # [核心修复] 获取当前输入块的真实长度
        current_len = data_tensor.shape[0]
        print(current_len)

        # 2. 更新滑窗
        self.rt_context_buffer.append(data_tensor.to(self.device))
        
        # 3. 拼接 2s 数据
        context_tensors = list(self.rt_context_buffer)
        current_context = torch.cat(context_tensors, dim=0)
        target_len = 32000
        if current_context.shape[0] < target_len:
            padding = torch.zeros(target_len - current_context.shape[0], current_context.shape[1], device=self.device)
            full_input = torch.cat([padding, current_context], dim=0)
        else:
            full_input = current_context
        angle_type = "target"
        try:
            # DoA 计算
            doa_angle, beamformed_audio_2s = self.calculate_target_doa_audio(full_input)
            # [新增] 如果没有检测到目标角度，使用 SRP-PHAT 计算通用声源角度
            if doa_angle is None:
                # 取前6个通道进行 SRP 计算
                srp_angle = self.calculate_doa_srp_fast(data_np[:, :6])
                doa_angle = srp_angle
                angle_type = "general"  # 标记为通用声源（非目标）
                
            wav_data_2s = beamformed_audio_2s
            angle_str = f"{doa_angle}°" if doa_angle is not None else "N/A"
            print(f"Target: {self.target_tag}, Best Angle: {angle_str}")
        except Exception as e:
            print(f"DoA/Beamforming Error: {e}")
            doa_angle = 90
            wav_data_2s = full_input[:, 0]

        re_wav_data = self.resampler(wav_data_2s.unsqueeze(0))

        tags = []
        with torch.no_grad():
            tag_out = self.tag_model(wav_data_2s.unsqueeze(0))
            
            # [修复] 传递 2D
            query_input = re_wav_data
            query_out = self.query_net(query_input)
            
            masked_condition = torch.zeros(1, 527, device=self.device)
            should_separate = True
            
            if self.target_index is not None:
                cond_val = query_out[0, self.target_index].item()
                if cond_val < 0.1: should_separate = False
                else: masked_condition[:, self.target_index] = query_out[:, self.target_index]
            self.dummy_query = masked_condition

            if should_separate:
                input_tensor = re_wav_data.unsqueeze(0)
                max_val = torch.max(torch.abs(input_tensor))
                headroom = 0.9
                
                if max_val > 1e-8: norm_input = (input_tensor / max_val) * headroom
                else: norm_input = input_tensor

                ss_out = self.ss_model(norm_input, self.dummy_query)
                if max_val > 1e-8: ss_out = (ss_out / headroom) * max_val
                sep_audio_2s = ss_out.squeeze()
                sep_audio_2s = self.downsampler(sep_audio_2s)
            else:
                sep_audio_2s = torch.zeros_like(wav_data_2s)
            
        # [核心修复] 根据输入块的实际长度 current_len 进行截取
        # 这样无论最后一块是否完整（如只有 0.3s），Raw 和 Sep 的长度都完全匹配
        sep_audio_slice = sep_audio_2s[-current_len:]
        raw_audio_slice = wav_data_2s[-current_len:]
        print(len(sep_audio_slice), len(raw_audio_slice))
        
        # [原子性保存] 所有 Buffer 操作在最后一次性完成
        self.buffer_multichan.append(data_tensor.cpu())
        self.buffer_raw_ch0.append(data_tensor[:, 0].cpu())
        self.buffer_chunk_ids.append(chunk_id)
        self.buffer_sep.append(sep_audio_slice.cpu())
        
        spec_list = self.wav2spec(raw_audio_slice)
        sep_spec_list = self.wav2spec(sep_audio_slice)
        
        voice_db = self.audio_to_db(data_np[:, 0])
        channel_energies = np.sqrt(np.mean(data_float[:, :6]**2, axis=0)).tolist()
        all_channels_data = data_float[::10, 0:6].T.tolist()
        tags = self.get_filtered_labels(tag_out)
        print(tags)
        
        result_packet = {
            "chunk_id": chunk_id,
            "raw_audio": raw_audio_slice.cpu().numpy().tolist()[::10],
            "separated_audio": sep_audio_slice.cpu().numpy().tolist()[::10],
            "tags": tags,
            "target": self.target_tag,
            "angle": doa_angle,
            "angle_type": angle_type,
            "all_channels": all_channels_data,
            "energies": channel_energies,
            "spectrogram": spec_list,
            "separated_spectrogram": sep_spec_list,
            "voice_db": voice_db,
        }
        self.output_queue.append(result_packet)
        
    def check_state(self):
        # [核心] 只有当停止信号置起且队列处理完毕时，才退出
        if (self.receiver.stop_event.is_set() and self.receiver.data_queue.empty()):
            self.is_processing = False
        return self.is_processing

    def processing_loop(self):
        while self.check_state():
            try:
                chunk, data = self.receiver.data_queue.get(timeout=0.1)
                
                if chunk == -1 and data == "DEVICE_ERROR":
                    self.output_queue.append({"error": "麦克风设备异常：连接超时或设备离线"})
                    self.is_processing = False
                    break

                self.process_data(chunk, data)
                
            except queue.Empty:
                time.sleep(0.01)
                continue
            except Exception as e:
                print(f"Error processing data: {e}")
                import traceback
                traceback.print_exc()
                break
        self.is_processing = False

    def start_processing(self):
        if not self.is_processing:
            self.is_processing = True
            self.processing_thread = threading.Thread(target=self.processing_loop)
            self.processing_thread.start()

    def stop_processing(self):
        # [修改] 使用 join 等待线程自然结束，确保队列排空
        if hasattr(self, 'processing_thread'):
            self.processing_thread.join()
        
        self.save_wav_files()
        
    def reprocess_stored_audio(self):
        if not self.buffer_raw_ch0:
            return None
        
        new_buffer_sep = []
        new_data_list = []
        temp_buffer = deque(maxlen=4)
        
        try:
            for chunk_id, raw_tensor in zip(self.buffer_chunk_ids, self.buffer_raw_ch0):
                # 获取当前块的长度
                current_len = raw_tensor.shape[0]

                temp_buffer.append(raw_tensor.to(self.device))
                current_context = torch.cat(list(temp_buffer), dim=0)
                target_len = 32000
                if current_context.shape[0] < target_len:
                    padding = torch.zeros(target_len - current_context.shape[0], device=self.device)
                    full_input = torch.cat([padding, current_context], dim=0)
                else:
                    full_input = current_context
                    
                wav_data_2s = full_input
                re_wav_data = self.resampler(wav_data_2s.unsqueeze(0))
                
                with torch.no_grad():
                    query_input = re_wav_data
                    query_out = self.query_net(query_input)
                    should_separate = True
                    masked_condition = torch.zeros(1, 527, device=self.device)
                    if self.target_index is not None:
                        cond_val = query_out[0, self.target_index].item()
                        if cond_val < 1: should_separate = False
                        else: masked_condition[:, self.target_index] = query_out[:, self.target_index]
                    
                    if should_separate:
                        input_tensor = re_wav_data.unsqueeze(0)
                        max_val = torch.max(torch.abs(input_tensor))
                        headroom = 0.9
                        if max_val > 1e-8: norm_input = (input_tensor / max_val) * headroom
                        else: norm_input = input_tensor
                        ss_out = self.ss_model(norm_input, masked_condition)
                        if max_val > 1e-8: ss_out = (ss_out / headroom) * max_val
                        sep_audio_2s = ss_out.squeeze()
                        sep_audio_2s = self.downsampler(sep_audio_2s)
                    else:
                        sep_audio_2s = torch.zeros_like(wav_data_2s)
                
                # [核心] 同样动态截取
                sep_audio_slice = sep_audio_2s[-current_len:]
                new_buffer_sep.append(sep_audio_slice.cpu())
                
                sep_spec_list = self.wav2spec(sep_audio_slice)
                sep_audio_vis = sep_audio_slice.cpu().numpy().tolist()[::10]
                
                new_data_list.append({
                    "chunk_id": chunk_id,
                    "separated_audio": sep_audio_vis,
                    "separated_spectrogram": sep_spec_list
                })

            self.buffer_sep = new_buffer_sep
            self.save_wav_files()
            return new_data_list

        except Exception as e:
            print(f"Reprocessing failed: {e}")
            import traceback
            traceback.print_exc()
            return None
